import { Shield } from "lucide-react";
import { useState } from "react";

const INITIAL_PROVIDERS = [
  {
    id: "google",
    name: "Google Workspace",
    connected: true,
    detail: "Connected",
  },
  {
    id: "microsoft",
    name: "Microsoft Entra ID",
    connected: false,
    detail: "Not connected",
  },
  {
    id: "saml",
    name: "SAML 2.0",
    connected: false,
    detail: "Custom SSO, service provider",
    configureOnly: true,
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
  saml: () => <Shield className="h-5 w-5 text-gray-500" />,
};

export default function IntegrationScreen() {
  const [providers, setProviders] = useState(INITIAL_PROVIDERS);

  const connect = (id) => {
    setProviders((current) =>
      current.map((provider) =>
        provider.id === id
          ? { ...provider, connected: true, detail: "Connected" }
          : provider
      )
    );
  };

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-base font-semibold">SSO Integrations</h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Connect your organizational identity providers
      </p>

      <ul className="mt-5 space-y-3">
        {providers.map((provider) => {
          const Icon = ICONS[provider.id];
          const connected = provider.connected;
          const showConfigure = connected || provider.configureOnly;
          return (
            <li
              key={provider.id}
              className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 ${
                connected
                  ? "border-emerald-300 bg-emerald-50/60 dark:border-emerald-700/60 dark:bg-emerald-500/10"
                  : "border-gray-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 bg-white dark:border-zinc-700 dark:bg-zinc-950">
                  <Icon />
                </span>
                <div>
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{provider.name}</p>
                  <p className={`text-sm ${connected ? "text-emerald-600 dark:text-emerald-400" : "text-gray-500 dark:text-gray-400"}`}>
                    {provider.detail}
                  </p>
                </div>
              </div>
              {showConfigure ? (
                <button
                  type="button"
                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-gray-200 dark:hover:bg-zinc-800"
                >
                  Configure
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => connect(provider.id)}
                  className="rounded-lg bg-[#5B16E1] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#4a11c0]"
                >
                  Connect
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
