import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";

import { isSupabaseConfigured } from "../../lib/supabase.js";
import { pingGrok } from "../../lib/grok.js";

/**
 * Whether the grok-chat function is deployed and the xAI key is set.
 *
 * The check does not call the model. A failed check is not shown as connected.
 */
export default function GrokCard() {
  const [state, setState] = useState(isSupabaseConfigured ? "loading" : "unconfigured");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;
    pingGrok()
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setState("connected");
          setModel(result.model || "");
          setError("");
          return;
        }
        setState("error");
        setError(result.error || "Grok is not connected.");
      })
      .catch((caught) => {
        if (!active) return;
        setState("error");
        setError(caught?.message || "Grok is not connected.");
      });
    return () => {
      active = false;
    };
  }, []);

  const label =
    state === "connected" ? "Connected" : state === "loading" ? "Checking" : "Not connected";

  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-foreground">Grok</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Chat and task reminders. The xAI key stays in the grok-chat function. This page only asks that function if it is configured.
            </p>
          </div>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            state === "connected"
              ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {label}
        </span>
      </div>

      {state === "unconfigured" ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Not connected. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env first.
        </p>
      ) : null}
      {state === "loading" ? <p className="mt-4 text-sm text-muted-foreground">Checking the function…</p> : null}
      {state === "connected" ? (
        <p className="mt-4 text-sm text-foreground">
          Connected. The function will use {model || "its configured model"} unless you pick another model in the chat.
        </p>
      ) : null}
      {state === "error" ? (
        <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>
      ) : null}

      <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
        <li>Create an API key at the xAI console.</li>
        <li>
          Apply <code className="text-foreground">supabase/migrations/20261022160000_grok_chat_alerts.sql</code>, then reload the API schema.
        </li>
        <li>
          Set the secret: <code className="text-foreground">supabase secrets set XAI_API_KEY=your-key</code>. Optional: <code className="text-foreground">XAI_CHAT_MODEL=grok-4.7</code>.
        </li>
        <li>
          Deploy <code className="text-foreground">supabase functions deploy grok-chat</code>. The key is not part of the app build.
        </li>
      </ol>

      <div className="mt-4">
        <Link
          to="/grok"
          className="inline-flex min-h-11 items-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open Grok
        </Link>
      </div>
    </section>
  );
}
