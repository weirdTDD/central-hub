import { Link } from "react-router-dom";
import { Code2, FileJson, Globe, Shield } from "lucide-react";
import { listAdapters } from "../../features/integrations/contract.js";
import CodingTrackerCard from "./CodingTrackerCard.jsx";
import LearningTrackerCard from "./LearningTrackerCard.jsx";

// The account providers this build does not have.
//
// They are listed so the user knows what does not exist yet. A provider that is
// not configured must never look like a connected one, so none of these rows
// carries a connected state and none of them offers a connect button.
const UNAVAILABLE_PROVIDERS = [
  {
    id: "google",
    name: "Google Workspace",
    detail: "Account sign-in",
  },
  {
    id: "microsoft",
    name: "Microsoft Entra ID",
    detail: "Account sign-in",
  },
  {
    id: "saml",
    name: "SAML 2.0",
    detail: "Custom SSO, service provider",
  },
];

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5c-.3 1.5-1.1 2.8-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1C3.4 21.3 7.4 24 12 24z" />
      <path fill="#FBBC05" d="M5.4 14.4c-.2-.7-.4-1.4-.4-2.4s.1-1.7.4-2.4V6.5H1.4C.5 8.3 0 10.1 0 12s.5 3.7 1.4 5.5l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.5 1.8l3.4-3.4C17.9 1.1 15.2 0 12 0 7.4 0 3.4 2.7 1.4 6.5l4 3.1C6.3 6.8 8.9 4.8 12 4.8z" />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
      <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
      <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </svg>
  );
}

const ICONS = {
  google: GoogleIcon,
  microsoft: MicrosoftIcon,
  saml: () => <Shield className="h-5 w-5 text-muted-foreground" />,
};

const CONNECTOR_ICONS = {
  local_activity_file: FileJson,
  vscode: Code2,
  browser: Globe,
};

export default function IntegrationScreen() {
  const available = listAdapters().filter(
    (adapter) =>
      adapter.implemented &&
      adapter.id !== "coding_tracker" &&
      adapter.id !== "learning_tracker"
  );

  return (
    <div className="space-y-6">
    <CodingTrackerCard />
    <LearningTrackerCard />
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <h2 className="text-base font-semibold text-foreground">Connectors</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A connector is an independent, documented bridge between an outside
        source of activity and Sentral Hub. It brings records in as observations,
        which then become sessions and task attribution.
      </p>

      <h3 className="mt-6 text-sm font-semibold text-foreground">Available</h3>
      <ul className="mt-3 space-y-3">
        {available.map((adapter) => {
          const Icon = CONNECTOR_ICONS[adapter.id] ?? FileJson;
          return (
            <li
              key={adapter.id}
              className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background px-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {adapter.label}
                  </p>
                  <p className="text-sm text-muted-foreground">{adapter.summary}</p>
                </div>
              </div>
              <Link
                to="/integrations"
                className="inline-flex shrink-0 items-center rounded-xl bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Open
              </Link>
            </li>
          );
        })}
      </ul>

      <h3 className="mt-6 text-sm font-semibold text-foreground">
        Account and single sign-on
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Google, Microsoft and SAML are not configured in this build, so none of
        them is connected. They are listed as coming soon.
      </p>

      <ul className="mt-4 space-y-3">
        {UNAVAILABLE_PROVIDERS.map((provider) => {
          const Icon = ICONS[provider.id];
          return (
            <li
              key={provider.id}
              className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card">
                  <Icon />
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {provider.name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {provider.detail}
                  </p>
                </div>
              </div>
              <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                Coming soon
              </span>
            </li>
          );
        })}
      </ul>

    </section>
    </div>
  );
}
