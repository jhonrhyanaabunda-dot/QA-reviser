"use client";

import { useEffect, useState } from "react";

interface Domain {
  id: string;
  domain: string;
  label: string | null;
  is_approved: boolean;
  max_pages: number;
}

interface Dealership {
  id: string;
  name: string;
  primary_domain: string;
  city: string | null;
  state: string | null;
  dealership_domains: Domain[];
}

export function DealershipsManager() {
  const [dealerships, setDealerships] = useState<Dealership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/dealerships");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setDealerships(data.dealerships ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/dealerships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          primaryDomain: domain,
          city: city || undefined,
          state: state || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setName("");
      setDomain("");
      setCity("");
      setState("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setError(null);
    const response = await fetch(`/api/dealerships/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const data = await response.json();
      setError(data.error);
      return;
    }
    await load();
  }

  async function remove(id: string) {
    if (!confirm("Delete this dealership? Its audits stay, but lose their dealership link.")) {
      return;
    }
    await fetch(`/api/dealerships/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div>
        <h1 className="text-lg font-semibold">Dealerships</h1>
        <p className="mb-5 mt-1 text-sm muted">
          The crawler visits <strong>only</strong> the domains approved here. Add inventory
          or microsite subdomains so their pages count as internal links.
        </p>

        {error && (
          <p className="panel mb-4 p-3 text-sm" style={{ color: "var(--critical)" }} role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="text-sm muted">Loading…</p>
        ) : dealerships.length === 0 ? (
          <p className="panel p-5 text-sm muted">No dealerships yet.</p>
        ) : (
          <ul className="space-y-3">
            {dealerships.map((dealership) => (
              <li key={dealership.id} className="panel p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">{dealership.name}</h2>
                    <p className="text-xs muted">
                      {dealership.primary_domain}
                      {dealership.city ? ` · ${dealership.city}` : ""}
                      {dealership.state ? `, ${dealership.state}` : ""}
                    </p>
                  </div>
                  <button className="btn text-xs" onClick={() => remove(dealership.id)}>
                    Delete
                  </button>
                </div>

                <div className="mt-3">
                  <p className="label">Approved domains</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {dealership.dealership_domains?.map((d) => (
                      <li
                        key={d.id}
                        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs"
                        style={{ border: "1px solid var(--border-strong)" }}
                      >
                        {d.domain}
                        {d.label && <span className="muted">({d.label})</span>}
                        <button
                          className="muted hover:opacity-70"
                          aria-label={`Remove ${d.domain}`}
                          onClick={() => patch(dealership.id, { removeDomainId: d.id })}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>

                  <AddDomain onAdd={(value) => patch(dealership.id, { addDomain: value })} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <aside>
        <h2 className="mb-3 text-sm font-semibold">Add a dealership</h2>
        <form onSubmit={create} className="panel space-y-3 p-4">
          <div>
            <label className="label" htmlFor="d-name">Name</label>
            <input
              id="d-name"
              className="input"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Riverside Toyota"
            />
          </div>
          <div>
            <label className="label" htmlFor="d-domain">Primary domain</label>
            <input
              id="d-domain"
              className="input"
              required
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="riversidetoyota.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label" htmlFor="d-city">City</label>
              <input
                id="d-city"
                className="input"
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="d-state">State</label>
              <input
                id="d-state"
                className="input"
                value={state}
                onChange={(e) => setState(e.target.value)}
              />
            </div>
          </div>
          <button className="btn btn-primary w-full" disabled={busy}>
            {busy ? "Adding…" : "Add dealership"}
          </button>
        </form>
      </aside>
    </div>
  );
}

function AddDomain({ onAdd }: { onAdd: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="mt-2 flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim()) return;
        onAdd(value.trim());
        setValue("");
      }}
    >
      <input
        className="input text-xs"
        placeholder="inventory.example.com"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Additional approved domain"
      />
      <button className="btn text-xs" type="submit">Add</button>
    </form>
  );
}
