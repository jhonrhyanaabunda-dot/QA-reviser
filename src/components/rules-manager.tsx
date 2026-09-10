"use client";

import { useEffect, useMemo, useState } from "react";

interface Rule {
  id: string;
  user_id: string | null;
  code: string;
  title: string;
  description: string;
  category: string;
  kind: string;
  severity: string;
  pattern: string | null;
  guidance: string | null;
  fix_mode: string;
  is_active: boolean;
  is_builtin: boolean;
  feedback: { accept: number; reject: number; modify: number };
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--critical)",
  high: "var(--high)",
  medium: "var(--medium)",
  low: "var(--low)",
  info: "var(--info)",
};

export function RulesManager() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("all");
  const [showForm, setShowForm] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/rules");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setRules(data.rules ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /**
   * A user-owned rule with the same code overrides the built-in, matching how
   * the pipeline resolves them — so the list shows what will actually run.
   */
  const effective = useMemo(() => {
    const byCode = new Map<string, Rule>();
    for (const rule of rules) {
      const existing = byCode.get(rule.code);
      if (!existing || (existing.user_id === null && rule.user_id !== null)) {
        byCode.set(rule.code, rule);
      }
    }
    return [...byCode.values()];
  }, [rules]);

  const categories = useMemo(
    () => ["all", ...new Set(effective.map((r) => r.category))].sort(),
    [effective],
  );

  const shown = effective.filter((r) => category === "all" || r.category === category);

  async function toggle(rule: Rule) {
    setError(null);
    const response = await fetch("/api/rules", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rule.id, isActive: !rule.is_active }),
    });
    if (!response.ok) {
      const data = await response.json();
      setError(data.error);
      return;
    }
    await load();
  }

  async function remove(rule: Rule) {
    if (rule.user_id === null) return;
    if (!confirm(`Delete your rule ${rule.code}?`)) return;
    await fetch(`/api/rules?id=${rule.id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">QA rules</h1>
          <p className="mt-1 text-sm muted">
            {effective.filter((r) => r.is_active).length} active of {effective.length}.
            Built-in rules can be switched off or re-tuned; doing so creates your own copy.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "New rule"}
        </button>
      </div>

      {error && (
        <p className="panel mb-4 p-3 text-sm" style={{ color: "var(--critical)" }} role="alert">
          {error}
        </p>
      )}

      {showForm && (
        <NewRuleForm
          onCreated={async () => {
            setShowForm(false);
            await load();
          }}
          onError={setError}
        />
      )}

      <div className="mb-4 flex flex-wrap gap-1">
        {categories.map((c) => (
          <button
            key={c}
            className="btn text-xs"
            onClick={() => setCategory(c)}
            style={category === c ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
          >
            {c}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm muted">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((rule) => {
            const total = rule.feedback.accept + rule.feedback.reject;
            const rejectRate = total > 0 ? rule.feedback.reject / total : 0;

            return (
              <li
                key={rule.id}
                className="panel p-4"
                style={{ opacity: rule.is_active ? 1 : 0.55 }}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase"
                        style={{
                          color: SEVERITY_COLOR[rule.severity],
                          border: `1px solid ${SEVERITY_COLOR[rule.severity]}`,
                        }}
                      >
                        {rule.severity}
                      </span>
                      <code className="text-xs muted">{rule.code}</code>
                      <span className="text-xs muted">{rule.kind}</span>
                      {rule.fix_mode === "safe" && (
                        <span className="text-xs" style={{ color: "var(--good)" }}>
                          auto-fix
                        </span>
                      )}
                      {rule.user_id !== null && (
                        <span className="text-xs" style={{ color: "var(--accent)" }}>yours</span>
                      )}
                    </div>

                    <h3 className="mt-1.5 text-sm font-medium">{rule.title}</h3>
                    <p className="mt-0.5 text-sm muted">{rule.description}</p>

                    {total >= 3 && (
                      <p className="mt-1.5 text-xs" style={{
                        color: rejectRate > 0.5 ? "var(--critical)" : "var(--ink-muted)",
                      }}>
                        {rule.feedback.accept} valid / {rule.feedback.reject} wrong
                        {rejectRate > 0.5 && " — this rule is misfiring more often than not"}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 gap-1">
                    <button className="btn text-xs" onClick={() => toggle(rule)}>
                      {rule.is_active ? "Disable" : "Enable"}
                    </button>
                    {rule.user_id !== null && (
                      <button className="btn text-xs" onClick={() => remove(rule)}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NewRuleForm({
  onCreated,
  onError,
}: {
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState({
    code: "",
    title: "",
    description: "",
    category: "style",
    kind: "ai",
    severity: "medium",
    pattern: "",
    replacement: "",
    guidance: "",
    fixMode: "suggest",
  });
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => setForm((f) => ({ ...f, [key]: event.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          pattern: form.kind === "regex" ? form.pattern : null,
          replacement: form.replacement || null,
          guidance: form.guidance || null,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      onCreated();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel mb-5 space-y-3 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="r-code">Code (UPPER_SNAKE_CASE)</label>
          <input
            id="r-code"
            className="input"
            required
            value={form.code}
            onChange={set("code")}
            placeholder="BRAND_TAGLINE_REQUIRED"
          />
        </div>
        <div>
          <label className="label" htmlFor="r-title">Title</label>
          <input id="r-title" className="input" required value={form.title} onChange={set("title")} />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="r-desc">Description</label>
        <textarea
          id="r-desc"
          className="input"
          rows={2}
          required
          value={form.description}
          onChange={set("description")}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className="label" htmlFor="r-kind">Kind</label>
          <select id="r-kind" className="input" value={form.kind} onChange={set("kind")}>
            <option value="ai">ai (judgment)</option>
            <option value="regex">regex</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="r-cat">Category</label>
          <input id="r-cat" className="input" value={form.category} onChange={set("category")} />
        </div>
        <div>
          <label className="label" htmlFor="r-sev">Severity</label>
          <select id="r-sev" className="input" value={form.severity} onChange={set("severity")}>
            {["info", "low", "medium", "high", "critical"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="r-fix">Fix mode</label>
          <select id="r-fix" className="input" value={form.fixMode} onChange={set("fixMode")}>
            <option value="suggest">suggest</option>
            <option value="safe">safe (auto-apply)</option>
            <option value="none">none</option>
          </select>
        </div>
      </div>

      {form.kind === "regex" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="r-pattern">Pattern (JavaScript regex)</label>
            <input
              id="r-pattern"
              className="input"
              style={{ fontFamily: "var(--font-mono)" }}
              value={form.pattern}
              onChange={set("pattern")}
              placeholder="\\bpre-owned\\b"
            />
          </div>
          <div>
            <label className="label" htmlFor="r-repl">Replacement (for safe auto-fix)</label>
            <input
              id="r-repl"
              className="input"
              style={{ fontFamily: "var(--font-mono)" }}
              value={form.replacement}
              onChange={set("replacement")}
            />
          </div>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="r-guide">
            Guidance — tells the model exactly how to apply this rule
          </label>
          <textarea
            id="r-guide"
            className="input"
            rows={3}
            value={form.guidance}
            onChange={set("guidance")}
            placeholder="Flag any paragraph that mentions a price without naming the trim level it applies to."
          />
        </div>
      )}

      <button className="btn btn-primary" disabled={busy}>
        {busy ? "Saving…" : "Create rule"}
      </button>
    </form>
  );
}
