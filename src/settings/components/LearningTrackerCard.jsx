// Connection status for the learning extension, read from the integrations row.
//
// The row is written by the extension, or by saving a site list. No row means
// it has not connected. This card does not invent a connected state.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { GraduationCap } from "lucide-react";
import { browserLabel, patternText } from "../../../extensions/learning-tracker/lib/sites.js";
import { getIntegrationByProvider } from "../../lib/integrations";
import { isSupabaseConfigured } from "../../lib/supabase";

const LEARNING_PROVIDER = "learning_tracker";

const STATUS_LABEL = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  connected: "Connected",
  syncing: "Syncing",
  error: "Error",
};

export default function LearningTrackerCard() {
  const [state, setState] = useState(isSupabaseConfigured ? "loading" : "unconfigured");
  const [connection, setConnection] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;
    getIntegrationByProvider(LEARNING_PROVIDER)
      .then((row) => {
        if (!active) return;
        setConnection(row);
        setState("ready");
      })
      .catch((caught) => {
        if (!active) return;
        setState("error");
        setError(caught?.message || "Could not load the learning tracker.");
      });
    return () => {
      active = false;
    };
  }, []);

  const status = connection?.status ?? "disconnected";
  const synced = connection?.last_sync_at ? new Date(connection.last_sync_at).toLocaleString() : null;
  const paused = connection?.config?.paused === true;
  const browser = connection?.config?.browser ? browserLabel(connection.config.browser) : null;
  const sites = Array.isArray(connection?.config?.sites) ? connection.config.sites : null;

  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground">
            <GraduationCap className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-foreground">Learning tracker</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Active time on the learning sites you choose. The browser extension sends heartbeats to this account.
            </p>
          </div>
        </div>
        <Status state={state} status={connection ? status : "disconnected"} />
      </div>

      {state === "unconfigured" ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Not connected. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env before the extension can store heartbeats.
        </p>
      ) : null}
      {state === "loading" ? <p className="mt-4 text-sm text-muted-foreground">Loading tracker status…</p> : null}
      {state === "error" ? (
        <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>
      ) : null}
      {state === "ready" && !connection ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Not connected. Load the extension, then sign in from its options page. freeCodeCamp's curriculum is the default until you save a list.
        </p>
      ) : null}
      {state === "ready" && connection ? (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Last heartbeats sent</dt>
            <dd className="mt-1 text-foreground">{synced ?? "None yet"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Browser</dt>
            <dd className="mt-1 text-foreground">
              {browser ?? "Unknown"}
              {paused ? " · paused" : ""}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium text-muted-foreground">Tracked sites</dt>
            <dd className="mt-1 text-foreground">
              {sites == null
                ? "Default list until you save one."
                : sites.length === 0
                  ? "No sites are tracked."
                  : sites
                      .map((site) => site.label || patternText(site))
                      .filter(Boolean)
                      .join(", ")}
            </dd>
          </div>
        </dl>
      ) : null}
      {connection?.last_error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">{connection.last_error}</p>
      ) : null}

      <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
        <li>Apply <code className="text-foreground">supabase/migrations/20261022150000_learning_activity.sql</code> after the coding migration.</li>
        <li>Load <code className="text-foreground">extensions/learning-tracker</code> in Chrome, Edge, or Firefox. The README has the steps.</li>
        <li>Open the extension options and sign in with the same account as this app. The URL and anon key are the values in .env.</li>
        <li>Add sites on the Learning page. Only those sites are timed.</li>
      </ol>

      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          to="/learning"
          className="inline-flex min-h-11 items-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open learning
        </Link>
        <Link
          to="/integrations"
          className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Connection details
        </Link>
      </div>
    </section>
  );
}

function Status({ state, status }) {
  if (state === "loading") return <Badge>Loading</Badge>;
  if (state === "unconfigured" || state === "error") return <Badge>Not connected</Badge>;
  return <Badge>{STATUS_LABEL[status] ?? status}</Badge>;
}

function Badge({ children }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}
