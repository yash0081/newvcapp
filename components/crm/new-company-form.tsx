"use client";

import { useState } from "react";
import { StageSelect } from "@/components/crm/stage-select";

type Stage = "screened" | "in_process" | "invested" | "passed";

export function NewCompanyForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData(e.currentTarget);
      const company_name = String(fd.get("company_name") || "").trim();
      const website = String(fd.get("website") || "").trim();
      const crm_stage = String(fd.get("crm_stage") || "screened") as Stage;
      const res = await fetch("/api/crm/companies/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_name, website: website || null, crm_stage }),
      });
      const json = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <form onSubmit={onSubmit} className="flex flex-col md:flex-row gap-2 md:items-end">
        <div className="flex-1 min-w-0">
          <label className="block text-xs text-zinc-600 mb-1">Name</label>
          <input name="company_name" required className="crm-input" placeholder="Acme AI" />
        </div>
        <div className="flex-1 min-w-0">
          <label className="block text-xs text-zinc-600 mb-1">Website (optional)</label>
          <input name="website" className="crm-input" placeholder="https://acme.com" />
        </div>
        <div className="w-full md:w-44">
          <label className="block text-xs text-zinc-600 mb-1">Stage</label>
          <StageSelect name="crm_stage" defaultValue="screened" />
        </div>
        <button className="crm-button" disabled={busy} type="submit">
          {busy ? "Creating…" : "Create"}
        </button>
      </form>
      {error ? <p className="text-xs text-rose-700">{error}</p> : null}
    </div>
  );
}

