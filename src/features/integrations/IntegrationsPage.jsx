// Central Hub — the integrations page.
//
// Every state on this page comes from the database: an adapter is "connected"
// only because a real synchronisation succeeded. An adapter that is not
// implemented shows no controls at all, because a button that cannot work is
// worse than no button.
//
// The page follows src/features/tasks/TasksPage.jsx: the same shell, the same
// input/button vocabulary, and the same loading / error / "Not connected" /
// empty ladder.

import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CircleAlert,
  FileUp,
  Info,
  RefreshCw,
  Unplug,
} from "lucide-react";
import AppShell from "../../components/AppShell";
import { DOCUMENTATION_FIELDS, listAdapters } from "./contract.js";
import { useIntegrations } from "./IntegrationsContext";

/**
 * The five documented states, with the plain-language meaning of each.
 *
 * The badge always carries the state's NAME, so the state is never conveyed by
 * colour alone.
 */
const STATUS_META = {
  disconnected: {
    label: "Disconnected",
    className: "bg-gray-100 text-gray-700 dark:bg-zinc-800 dark:text-gray-300",
    meaning: "No connection exists, so nothing has been imported yet.",
  },
  connecting: {
    label: "Connecting",
    className: "bg-primary/10 text-primary",
    meaning: "The connection is being opened right now.",
  },
  syncing: {
    label: "Syncing",
    className: "bg-progress/10 text-progress",
    meaning: "A synchronisation is running.",
  },
  connected: {
    label: "Connected",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    meaning: "A synchronisation finished successfully.",
  },
  error: {
    label: "Error",
    className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    meaning: "The last attempt failed. The reason is shown with the connection.",
  },
};

/** Plain-language titles for the ten documented contract fields. */
const DOCUMENTATION_LABELS = {
  canAccess: "What it can access",
  permissions: "Permissions and configuration",
  authentication: "Authentication",
  reads: "What it reads",
  writes: "What it writes",
  synchronisation: "Synchronisation",
  deduplication: "Deduplication",
  errors: "Errors and retries",
  retention: "Retention",
  removalOnDisconnect: "Removal on disconnect",
};

/** What the engine is doing, in the user's words. */
const PROGRESS_LABELS = {
  reading: "Reading the file...",
  parsing: "Reading the file...",
  ingesting: "Writing the imported observations...",
  done: "Finishing up...",
};

/**
 * @param {string} value an ISO timestamp
 * @returns {string|null} a readable local timestamp, or null when there is none
 */
function formatTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * How many observations a connection imported.
 *
 * The number comes from the successful runs of that connection: every run
 * reports how many records it actually WROTE, so the sum is the number of
 * observations the connection brought in.
 *
 * @param {string} integrationId
 * @param {Array<object>} syncRuns
 * @returns {number}
 */
function importedObservationCount(integrationId, syncRuns) {
  return syncRuns
    .filter(
      (run) => run.integration_id === integrationId && run.status === "success"
    )
    .reduce((total, run) => total + (Number(run.records_written) || 0), 0);
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] ?? {
    label: status,
    className: "bg-gray-100 text-gray-700 dark:bg-zinc-800 dark:text-gray-300",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

function ContractDetails({ adapter }) {
  return (
    <details className="mt-4 rounded-xl border border-border bg-gray-50 px-4 py-3 dark:bg-zinc-950">
      <summary className="cursor-pointer text-sm font-semibold text-gray-700 dark:text-gray-200">
        What this adapter does with your data
      </summary>
      <dl className="mt-3 space-y-3">
        {DOCUMENTATION_FIELDS.map((field) => (
          <div key={field}>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {DOCUMENTATION_LABELS[field] ?? field}
            </dt>
            <dd className="mt-1 text-sm text-gray-700 dark:text-gray-200">
              {adapter.documentation?.[field] ?? "Not documented."}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function FilePicker({ adapterId, label, disabled, onFile }) {
  const inputRef = useRef(null);
  const inputId = `activity-file-${adapterId}`;

  return (
    <>
      <label htmlFor={inputId} className="sr-only">
        Activity file (JSON) to import into {label}
      </label>
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        tabIndex={-1}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          // The value is cleared so picking the same file twice fires a change
          // event again — a repeated import is a normal thing to do.
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        <FileUp className="h-4 w-4" />
        Choose activity file
      </button>
    </>
  );
}

function Outcome({ outcome }) {
  if (!outcome) return null;

  if (outcome.type === "error") {
    return (
      <p
        role="alert"
        className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
      >
        {outcome.message}
      </p>
    );
  }

  if (outcome.type === "notice") {
    return (
      <p
        role="status"
        className="mt-3 rounded-xl border border-border bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:bg-zinc-950 dark:text-gray-200"
      >
        {outcome.message}
      </p>
    );
  }

  const { fileName, recordsSeen, recordsWritten, recordsSkipped } = outcome;

  return (
    <p
      role="status"
      className="mt-3 rounded-xl border border-border bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:bg-zinc-950 dark:text-gray-200"
    >
      <span className="font-semibold">{fileName}</span> was read: {recordsSeen}{" "}
      record{recordsSeen === 1 ? "" : "s"} seen, {recordsWritten} written,{" "}
      {recordsSkipped} skipped.
      {recordsWritten === 0 && recordsSkipped > 0 ? (
        <>
          {" "}
          Nothing new was added: every record was already imported, so the same
          file was not counted twice.
        </>
      ) : null}
    </p>
  );
}

function AdapterCard({
  adapter,
  integration,
  outcome,
  busy,
  syncing,
  progress,
  onFile,
  onSync,
  onDisconnect,
}) {
  // A connector that does not work yet must not look like a working
  // connection, so it carries no state badge and no controls at all.
  if (!adapter.implemented) {
    return (
      <li className="rounded-2xl border border-border bg-white p-4 shadow-sm dark:bg-zinc-900">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {adapter.label}
            </h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {adapter.summary}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-zinc-800 dark:text-gray-300">
            Coming soon
          </span>
        </div>
        <ContractDetails adapter={adapter} />
      </li>
    );
  }

  const status = integration?.status ?? "disconnected";
  const lastSync = formatTimestamp(integration?.last_sync_at);
  const lastError = integration?.last_error ?? null;

  return (
    <section className="rounded-2xl border border-border bg-white p-5 shadow-sm dark:bg-zinc-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {adapter.label}
        </h2>
        <StatusBadge status={status} />
      </div>

      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        {adapter.summary}
      </p>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Last successful sync
          </dt>
          <dd className="mt-1 text-gray-800 dark:text-gray-100">
            {lastSync ?? "Never"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">
            What this state means
          </dt>
          <dd className="mt-1 text-gray-800 dark:text-gray-100">
            {STATUS_META[status]?.meaning ?? status}
          </dd>
        </div>
      </dl>

      {lastError ? (
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{lastError}</span>
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {adapter.collection === "extension" ? (
          <>
            <Link
              to="/settings/integrations"
              className="inline-flex min-h-11 items-center rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Setup and status
            </Link>
            {adapter.timelinePath ? (
              <Link
                to={adapter.timelinePath}
                className="inline-flex min-h-11 items-center rounded-lg border border-border bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:bg-zinc-900 dark:text-gray-200 dark:hover:bg-zinc-800"
              >
                {adapter.timelineLabel || "Timeline"}
              </Link>
            ) : null}
          </>
        ) : adapter.collection === "local" ? (
          <button
            type="button"
            disabled={busy || syncing}
            onClick={() => onSync(adapter)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
            Sync this computer
          </button>
        ) : (
          <FilePicker
            adapterId={adapter.id}
            label={adapter.label}
            disabled={busy || syncing}
            onFile={(file) => onFile(adapter, file)}
          />
        )}

        {integration ? (
          <button
            type="button"
            disabled={busy || syncing}
            onClick={() => onDisconnect(adapter, integration)}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:bg-zinc-900 dark:text-gray-200 dark:hover:bg-zinc-800"
          >
            <Unplug className="h-4 w-4" />
            Disconnect
          </button>
        ) : null}
      </div>

      {busy ? (
        <p role="status" className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          {PROGRESS_LABELS[progress] ?? "Importing the file..."}
        </p>
      ) : null}

      <Outcome outcome={outcome} />

      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        {adapter.removalPolicy}
      </p>

      <ContractDetails adapter={adapter} />
    </section>
  );
}

function SyncHistory({ runs, truncated, total, emptyMessage }) {
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-zinc-900">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Sync history
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          One row per synchronisation attempt.
          {truncated && total != null ? (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              {runs.length} of {total} loaded
            </span>
          ) : null}
        </p>
      </div>

      {runs.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-gray-500">
          {emptyMessage}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-zinc-950 dark:text-gray-400">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Started
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Finished
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Seen
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Written
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Skipped
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Error
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-700 dark:text-gray-200">
                    {formatTimestamp(run.started_at) ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-700 dark:text-gray-200">
                    {formatTimestamp(run.finished_at) ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">
                    {run.status}
                  </td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">
                    {run.records_seen ?? 0}
                  </td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">
                    {run.records_written ?? 0}
                  </td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">
                    {run.records_skipped ?? 0}
                  </td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">
                    {run.error ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function IntegrationsPage() {
  const {
    integrations,
    syncRuns,
    loading,
    error,
    errorScope,
    isConfigured,
    totalIntegrations,
    truncated,
    totalSyncRuns,
    syncRunsTruncated,
    syncing,
    syncProgress,
    syncFromFile,
    syncLocal,
    disconnect,
    refresh,
  } = useIntegrations();

  const adapters = useMemo(() => listAdapters(), []);
  const available = adapters.filter((adapter) => adapter.implemented);
  const planned = adapters.filter((adapter) => !adapter.implemented);
  const [outcomes, setOutcomes] = useState({});
  const [busyAdapterId, setBusyAdapterId] = useState(null);

  const loadFailed = Boolean(error) && errorScope !== "action";

  const handleFile = async (adapter, file) => {
    setBusyAdapterId(adapter.id);
    try {
      const result = await syncFromFile(file);
      setOutcomes((current) => ({
        ...current,
        [adapter.id]:
          result.status === "error"
            ? { type: "error", message: result.error }
            : {
                type: "success",
                fileName: file.name,
                recordsSeen: result.recordsSeen,
                recordsWritten: result.recordsWritten,
                recordsSkipped: result.recordsSkipped,
              },
      }));
    } catch (err) {
      setOutcomes((current) => ({
        ...current,
        [adapter.id]: {
          type: "error",
          message: err?.message || "The activity file could not be imported.",
        },
      }));
    } finally {
      setBusyAdapterId(null);
    }
  };

  const handleSync = async (adapter) => {
    setBusyAdapterId(adapter.id);
    try {
      const result = await syncLocal(adapter);
      setOutcomes((current) => ({
        ...current,
        [adapter.id]:
          result.status === "error"
            ? { type: "error", message: result.error }
            : {
                type: "success",
                fileName: adapter.label,
                recordsSeen: result.recordsSeen,
                recordsWritten: result.recordsWritten,
                recordsSkipped: result.recordsSkipped,
              },
      }));
    } catch (err) {
      setOutcomes((current) => ({
        ...current,
        [adapter.id]: {
          type: "error",
          message: err?.message || "The connector could not sync.",
        },
      }));
    } finally {
      setBusyAdapterId(null);
    }
  };

  const handleDisconnect = async (adapter, integration) => {
    const imported = importedObservationCount(integration.id, syncRuns);
    const confirmed = window.confirm(
      `Disconnecting removes the ${imported} imported observations as well as this connection, and its sync history. This cannot be undone.`
    );
    if (!confirmed) return;

    setBusyAdapterId(adapter.id);
    try {
      const result = await disconnect(integration);
      setOutcomes((current) => ({
        ...current,
        [adapter.id]:
          result.ok === false
            ? { type: "error", message: result.error }
            : {
                type: "notice",
                message:
                  "The connection was removed, together with the observations it had imported.",
              },
      }));
    } finally {
      setBusyAdapterId(null);
    }
  };

  const emptyMessage = (() => {
    if (loading) return "Loading integrations...";
    if (loadFailed) return "Could not load integrations.";
    if (!isConfigured)
      return "Not connected. Configure Supabase to load integrations.";
    if (syncRuns.length === 0)
      return "No sync runs yet. Import an activity file to create one.";
    return "No sync runs to show.";
  })();

  return (
    <AppShell currentPath="/integrations">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h1 className="text-3xl font-bold tracking-tight">Integrations</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Connectors bring activity from outside this app in as
                observations, which then become sessions and task attribution.
              </p>
            </div>
            <button
              type="button"
              onClick={refresh}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:bg-zinc-900 dark:text-gray-200 dark:hover:bg-zinc-800"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>

          {truncated && totalIntegrations != null ? (
            <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                {integrations.length} of {totalIntegrations} connections loaded
              </span>
            </p>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            >
              <p className="font-semibold">
                {loadFailed
                  ? "Could not load integrations"
                  : "The last integration action failed"}
              </p>
              <p className="mt-1">{error}</p>
            </div>
          ) : null}

          {!isConfigured ? (
            <div
              role="status"
              className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              <p className="font-semibold">Not connected</p>
              <p className="mt-1">
                Integrations are not persisted. Configure Supabase in your .env
                file to enable storage.
              </p>
            </div>
          ) : null}

          <section className="mt-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Available
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              These connectors read activity that already exists and import it
              into your account.
            </p>
            <div className="mt-4 space-y-6">
              {available.map((adapter) => {
                const integration = integrations.find(
                  (row) => row.provider === adapter.id
                );

                return (
                  <AdapterCard
                    key={adapter.id}
                    adapter={adapter}
                    integration={integration}
                    outcome={outcomes[adapter.id]}
                    busy={busyAdapterId === adapter.id}
                    syncing={syncing}
                    progress={busyAdapterId === adapter.id ? syncProgress : null}
                    onFile={handleFile}
                    onSync={handleSync}
                    onDisconnect={handleDisconnect}
                  />
                );
              })}
            </div>
          </section>

          {planned.length > 0 ? (
            <section className="mt-8">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Coming soon
              </h2>
              <ul className="mt-4 space-y-3">
                {planned.map((adapter) => (
                  <AdapterCard key={adapter.id} adapter={adapter} />
                ))}
              </ul>
            </section>
          ) : null}

          <details className="mt-6 rounded-2xl border border-border bg-white px-5 py-4 shadow-sm dark:bg-zinc-900">
            <summary className="cursor-pointer text-sm font-semibold text-gray-900 dark:text-gray-100">
              What the status badges mean
            </summary>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {Object.entries(STATUS_META).map(([state, meta]) => (
                <li key={state} className="flex items-start gap-3">
                  <StatusBadge status={state} />
                  <span className="text-sm text-gray-600 dark:text-gray-400">
                    {meta.meaning}
                  </span>
                </li>
              ))}
            </ul>
          </details>

          <SyncHistory
            runs={syncRuns}
            truncated={syncRunsTruncated}
            total={totalSyncRuns}
            emptyMessage={emptyMessage}
          />

          <p className="mt-6 flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              A connection is shown as connected only when a real
              synchronisation succeeded. Missing data is reported as missing,
              never as zero.
            </span>
          </p>
        </div>
    </AppShell>
  );
}
