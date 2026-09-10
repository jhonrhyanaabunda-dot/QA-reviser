"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Dealership {
  id: string;
  name: string;
  primary_domain: string;
}

/**
 * Submit form for a new audit.
 *
 * Posting returns as soon as the job row exists — the audit itself runs in the
 * background pipeline, so this navigates straight to the progress view rather
 * than holding the request open.
 */
export function AuditForm() {
  const router = useRouter();
  const [dealerships, setDealerships] = useState<Dealership[]>([]);
  const [url, setUrl] = useState("");
  const [dealershipId, setDealershipId] = useState("");
  const [applyFixes, setApplyFixes] = useState(true);
  const [skipFactCheck, setSkipFactCheck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dealerships")
      .then((r) => (r.ok ? r.json() : { dealerships: [] }))
      .then((data) => {
        if (cancelled) return;
        setDealerships(data.dealerships ?? []);
        if (data.dealerships?.length === 1) setDealershipId(data.dealerships[0].id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/audits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          dealershipId: dealershipId || null,
          applyFixes,
          skipFactCheck,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not start the audit.");
      router.push(`/audits/${data.audit.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel space-y-4 p-5">
      <div>
        <label className="label" htmlFor="url">Article URL</label>
        <input
          id="url"
          className="input"
          type="text"
          inputMode="url"
          placeholder="https://dealership.com/blog/2025-model-review"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="dealership">Dealership</label>
        <select
          id="dealership"
          className="input"
          value={dealershipId}
          onChange={(e) => setDealershipId(e.target.value)}
        >
          <option value="">None — skip dealership crawl and fact-checking</option>
          {dealerships.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.primary_domain})
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs muted">
          {dealerships.length === 0
            ? "Add a dealership to enable internal-link checks and fact verification."
            : "Only the dealership's approved domains are crawled."}
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="label">Options</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={applyFixes}
            onChange={(e) => setApplyFixes(e.target.checked)}
          />
          Apply safe auto-fixes to produce a revised article
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={skipFactCheck}
            onChange={(e) => setSkipFactCheck(e.target.checked)}
          />
          Skip fact verification (faster and cheaper)
        </label>
      </fieldset>

      {error && (
        <p className="text-sm" style={{ color: "var(--critical)" }} role="alert">
          {error}
        </p>
      )}

      <button className="btn btn-primary" type="submit" disabled={busy || !url.trim()}>
        {busy ? "Starting…" : "Start audit"}
      </button>
    </form>
  );
}
