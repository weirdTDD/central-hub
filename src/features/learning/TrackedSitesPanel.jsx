// The allowlist, edited here and read by the browser extension.
//
// An empty saved list means nothing is tracked. Until a list is saved, the
// extension uses the freeCodeCamp curriculum default.

import { useState } from "react";
import {
  DEFAULT_SITES,
  SUGGESTED_SITES,
  normalizeSiteList,
  parseSiteInput,
  patternText,
} from "../../../extensions/learning-tracker/lib/sites.js";
import { isSupabaseConfigured } from "../../lib/supabase";
import { saveTrackedSites } from "./saveSites.js";

export default function TrackedSitesPanel({ connection, onChanged }) {
  const explicit = Array.isArray(connection?.config?.sites);
  const list = explicit ? normalizeSiteList(connection.config.sites) : DEFAULT_SITES;
  const [label, setLabel] = useState("");
  const [pattern, setPattern] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const persist = async (next) => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveTrackedSites(next);
      setNotice(next.length === 0 ? "No sites are tracked." : "Tracked sites saved.");
      onChanged?.();
    } catch (caught) {
      setError(caught?.message || "Could not save tracked sites.");
    } finally {
      setSaving(false);
    }
  };

  const add = async (text, name) => {
    if (!isSupabaseConfigured) return;
    let site;
    try {
      site = parseSiteInput(text, name);
    } catch (caught) {
      setNotice("");
      setError(caught?.message || "That site could not be added.");
      return;
    }
    if (list.some((item) => item.id === site.id)) {
      setNotice("");
      setError("That site is already tracked.");
      return;
    }
    await persist([...list, site]);
    setLabel("");
    setPattern("");
  };

  return (
    <section aria-labelledby="tracked-sites-heading" className="rounded-2xl border border-border bg-card px-4 py-4">
      <h2 id="tracked-sites-heading" className="text-lg font-semibold">Tracked sites</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Only these sites are timed. A page that is not on this list is ignored, and its address is not stored.
        The browser extension reads this list.
      </p>

      {!isSupabaseConfigured ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Not connected. Add Supabase to .env before this list can be saved. Until then the extension uses freeCodeCamp's curriculum pages.
        </p>
      ) : null}

      {!explicit && isSupabaseConfigured ? (
        <p className="mt-3 text-sm text-muted-foreground">
          freeCodeCamp's curriculum is the default until you save a list.
        </p>
      ) : null}

      {list.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No sites are tracked. Time in the browser is not recorded.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {list.map((site) => (
            <li key={site.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{site.label}</p>
                <p className="truncate text-xs text-muted-foreground">{patternText(site)}</p>
              </div>
              <button
                type="button"
                disabled={!isSupabaseConfigured || saving}
                onClick={() => {
                  const confirmed = window.confirm(`Stop tracking ${site.label}? Time on that site will no longer be recorded.`);
                  if (!confirmed) return;
                  persist(list.filter((item) => item.id !== site.id));
                }}
                className="inline-flex min-h-11 shrink-0 items-center rounded-xl border border-border px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {isSupabaseConfigured ? (
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            add(pattern, label);
          }}
        >
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Name</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="freeCodeCamp"
              className="min-h-11 rounded-xl border border-border bg-background px-3"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Site</span>
            <input
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              placeholder="freecodecamp.org/learn"
              required
              className="min-h-11 rounded-xl border border-border bg-background px-3"
            />
          </label>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            {saving ? "Saving…" : "Add site"}
          </button>
        </form>
      ) : null}

      {isSupabaseConfigured ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTED_SITES.filter((site) => !list.some((item) => item.id === site.id)).map((site) => (
            <button
              key={site.id}
              type="button"
              disabled={saving}
              onClick={() => persist([...list, site])}
              className="inline-flex min-h-11 items-center rounded-xl border border-border px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              Add {site.label}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">{notice}</p>
      ) : null}
    </section>
  );
}
