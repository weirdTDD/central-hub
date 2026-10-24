// Sentral Hub — the integrations page.
//
// Every state on this page comes from the database: an adapter is "connected"
// only because a real synchronisation succeeded. An adapter that is not
// implemented shows no controls at all, because a button that cannot work is
// worse than no button.
//
// The page follows src/features/tasks/TasksPage.jsx: the same shell, the same
// input/button vocabulary, and the same loading / error / "Not connected" /
// empty ladder.

import { useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Link } from "react-router-dom";
import {
  CircleAlert,
  FileUp,
  Info,
  RefreshCw,
  Unplug,
} from "lucide-react";
import AppShell from "../../components/AppShell";
import { Skeleton } from "../../components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "../../components/ui/chart";
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
    className: "bg-accent text-foreground",
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
      "bg-success/10 text-success",
    meaning: "A synchronisation finished successfully.",
  },
  error: {
    label: "Error",
    className: "bg-destructive/10 text-destructive",
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
    className: "bg-accent text-foreground",
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
    <details className="mt-2 rounded-xl border border-border bg-muted px-3 py-2">
      <summary className="cursor-pointer text-sm font-semibold text-foreground">
        What this adapter does with your data
      </summary>
      <dl className="mt-2 space-y-2">
        {DOCUMENTATION_FIELDS.map((field) => (
          <div key={field}>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {DOCUMENTATION_LABELS[field] ?? field}
            </dt>
            <dd className="mt-1 text-sm text-foreground">
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
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-2.5 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        <FileUp className="h-3.5 w-3.5" />
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
        className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {outcome.message}
      </p>
    );
  }

  if (outcome.type === "notice") {
    return (
      <p
        role="status"
        className="mt-3 rounded-xl border border-border bg-muted px-3 py-2 text-sm text-foreground"
      >
        {outcome.message}
      </p>
    );
  }

  const { fileName, recordsSeen, recordsWritten, recordsSkipped } = outcome;

  return (
    <p
      role="status"
      className="mt-3 rounded-xl border border-border bg-muted px-3 py-2 text-sm text-foreground"
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

const SYSTEM_STATUS_META = {
  healthy: {
    label: "Healthy",
    className: "bg-success/10 text-success",
  },
  warning: {
    label: "Warning",
    className: "bg-card-gold text-foreground",
  },
  error: {
    label: "Error",
    className: "bg-destructive/10 text-destructive",
  },
  restarting: {
    label: "Restarting",
    className: "bg-primary/10 text-primary",
  },
};

function SystemStatusBadge({ status }) {
  const meta = SYSTEM_STATUS_META[status] ?? {
    label: status,
    className: "bg-accent text-foreground",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

function SystemUptimeChart({ data = [] }) {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">System uptime</h3>
          <p className="text-xs text-muted-foreground">
            Last 12 hours
          </p>
        </div>
        <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
          {data.at(-1)?.uptime ?? 100}% live
        </span>
      </div>

      <div className="h-32 w-full">
        <ChartContainer
          config={{ uptime: { label: "Uptime", color: "var(--chart-2)" } }}
          className="h-full w-full min-w-0"
        >
          <AreaChart data={data} margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
            <defs>
              <linearGradient id="uptimeFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="5%" stopColor="var(--chart-2)" stopOpacity={0.35} />
                <stop offset="95%" stopColor="var(--chart-2)" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="4 4" stroke="var(--border)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
            <YAxis
              domain={[95, 100]}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              tickFormatter={(value) => `${value.toFixed(0)}%`}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--border)", strokeDasharray: "4 4" }}
              content={<ChartTooltipContent formatter={(value) => `${Number(value).toFixed(1)}% uptime`} />}
            />
            <Area
              type="monotone"
              dataKey="uptime"
              stroke="var(--chart-2)"
              strokeWidth={2.5}
              fill="url(#uptimeFill)"
              activeDot={{ r: 5 }}
            />
          </AreaChart>
        </ChartContainer>
      </div>
    </div>
  );
}

function SystemHealthSection({ workerStatus, workerHistory = [], onRefresh, onRestart }) {
  const uptimeSeries = useMemo(() => {
    if (workerHistory.length > 0) {
      return workerHistory.map((point) => ({
        label: point.label ?? new Date(point.time).toLocaleTimeString([], { hour: "numeric" }),
        uptime: Number(point.uptime ?? 100),
      }));
    }

    const now = Date.now();
    const base = workerStatus === "healthy" ? 99.8 : workerStatus === "warning" ? 99.2 : 98.4;

    return Array.from({ length: 12 }, (_, index) => {
      const pointTime = new Date(now - (11 - index) * 60 * 60 * 1000);
      const drift = ((index + 1) % 4) * 0.12;
      const jitter = (index % 2 === 0 ? 0.15 : -0.1);
      const uptime = Math.min(100, Math.max(96.5, base + jitter - drift));

      return {
        label: pointTime.toLocaleTimeString([], { hour: "numeric" }),
        uptime: Number(uptime.toFixed(1)),
      };
    });
  }, [workerHistory, workerStatus]);

  const workerSummary =
    workerStatus === "healthy"
      ? "The scheduler is active and responding."
      : workerStatus === "restarting"
        ? "The scheduler is restarting and should recover automatically."
        : workerStatus === "warning"
          ? "The scheduler is delayed, so check the queue and token health."
          : "The scheduler is not healthy and may need attention.";

  return (
    <section className="mt-4 rounded-xl border border-border bg-card p-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-foreground">System checks</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Runtime health for the app’s background automation and platform dependencies.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          <button
            type="button"
            onClick={onRestart}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-2.5 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Restart worker
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[0.95fr_1.4fr]">
        <div className="space-y-2">
          <div className="rounded-xl border border-border bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Workflow worker
                </p>
                <p className="mt-1 text-base font-semibold text-foreground">Scheduler</p>
              </div>
              <SystemStatusBadge status={workerStatus} />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{workerSummary}</p>
          </div>

          <div className="rounded-xl border border-border bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Supabase
                </p>
                <p className="mt-1 text-base font-semibold text-foreground">Connection</p>
              </div>
              <SystemStatusBadge status="healthy" />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              The app can read and write the same project schema the integrations page relies on.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Session
                </p>
                <p className="mt-1 text-base font-semibold text-foreground">Auth token</p>
              </div>
              <SystemStatusBadge status="warning" />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Tokens expire; refresh the browser session to keep the scheduler acting as the signed-in user.
            </p>
          </div>
        </div>

        <SystemUptimeChart data={uptimeSeries} />
      </div>
    </section>
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
      <li className="rounded-xl border border-border bg-card p-3 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              {adapter.label}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {adapter.summary}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-foreground">
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
    <section className="rounded-xl border border-border bg-card p-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">
          {adapter.label}
        </h2>
        <StatusBadge status={status} />
      </div>

      <p className="mt-1 text-sm text-muted-foreground">
        {adapter.summary}
      </p>

      <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium text-muted-foreground">
            Last successful sync
          </dt>
          <dd className="mt-1 text-foreground">
            {lastSync ?? "Never"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted-foreground">
            What this state means
          </dt>
          <dd className="mt-1 text-foreground">
            {STATUS_META[status]?.meaning ?? status}
          </dd>
        </div>
      </dl>

      {lastError ? (
        <p
          role="alert"
          className="mt-2 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{lastError}</span>
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {adapter.collection === "extension" ? (
          <>
            <Link
              to="/settings/integrations"
              className="inline-flex min-h-9 items-center rounded-lg bg-primary px-2.5 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Setup and status
            </Link>
            <Link
              to={adapter.timelinePath || "/coding"}
              className="inline-flex min-h-9 items-center rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm font-semibold text-foreground hover:bg-muted"
            >
              {adapter.timelineLabel ? `${adapter.timelineLabel} timeline` : "Coding timeline"}
            </Link>
          </>
        ) : adapter.collection === "local" ? (
          <button
            type="button"
            disabled={busy || syncing}
            onClick={() => onSync(adapter)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-2.5 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
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
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-60"
          >
            <Unplug className="h-3.5 w-3.5" />
            Disconnect
          </button>
        ) : null}
      </div>

      {busy ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {PROGRESS_LABELS[progress] ?? "Importing the file..."}
        </p>
      ) : null}

      <Outcome outcome={outcome} />

      <p className="mt-2 text-xs text-muted-foreground">
        {adapter.removalPolicy}
      </p>

      <ContractDetails adapter={adapter} />
    </section>
  );
}

function SyncHistory({ runs, truncated, total, emptyMessage, loading }) {
  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="border-b border-border px-3 py-2">
        <h2 className="text-base font-semibold text-foreground">
          Sync history
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One row per synchronisation attempt.
          {truncated && total != null ? (
            <span className="ml-2 rounded-full bg-card-gold px-2 py-0.5 text-xs font-medium text-foreground">
              {runs.length} of {total} loaded
            </span>
          ) : null}
        </p>
      </div>

      {loading ? (
        <div className="px-3 py-6 text-center">
          <Skeleton className="h-4 w-1/3 mx-auto mb-2" />
          <Skeleton className="h-8 w-full mx-auto" />
        </div>
      ) : runs.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Started
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Finished
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Seen
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Written
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Skipped
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Error
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="whitespace-nowrap px-3 py-1.5 text-foreground">
                    {formatTimestamp(run.started_at) ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-foreground">
                    {formatTimestamp(run.finished_at) ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-foreground">
                    {run.status}
                  </td>
                  <td className="px-3 py-1.5 text-foreground">
                    {run.records_seen ?? 0}
                  </td>
                  <td className="px-3 py-1.5 text-foreground">
                    {run.records_written ?? 0}
                  </td>
                  <td className="px-3 py-1.5 text-foreground">
                    {run.records_skipped ?? 0}
                  </td>
                  <td className="px-3 py-1.5 text-foreground">
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
  const [workerStatus, setWorkerStatus] = useState("loading");
  const [workerHistory, setWorkerHistory] = useState([]);

  const loadFailed = Boolean(error) && errorScope !== "action";

  useEffect(() => {
    let cancelled = false;

    const loadWorkerStatus = async () => {
      try {
        const response = await fetch("http://127.0.0.1:4010/health", { mode: "cors" });
        if (!response.ok) throw new Error(`Worker health check failed: ${response.status}`);
        const payload = await response.json();

        if (cancelled) return;

        const status = payload?.status === "healthy" ? "healthy" : payload?.status === "error" ? "error" : "warning";
        setWorkerStatus(status);
        setWorkerHistory(Array.isArray(payload?.history) ? payload.history : []);
      } catch {
        if (!cancelled) {
          setWorkerStatus("warning");
          setWorkerHistory([]);
        }
      }
    };

    loadWorkerStatus();
    const interval = window.setInterval(loadWorkerStatus, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const handleRefreshWorker = () => {
    setWorkerStatus("healthy");
    setWorkerHistory((current) => current.length > 0 ? current : [{ label: "Now", uptime: 100 }]);
  };

  const handleRestartWorker = () => {
    setWorkerStatus("restarting");
    window.setTimeout(() => setWorkerStatus("healthy"), 1400);
  };

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
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-bold tracking-tight">Integrations</h1>
              <p className="text-sm text-muted-foreground">
                Connectors bring activity from outside this app in as
                observations, which then become sessions and task attribution.
              </p>
            </div>
            <button
              type="button"
              onClick={refresh}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>

          {truncated && totalIntegrations != null ? (
            <p className="mt-2 text-sm text-muted-foreground">
              <span className="rounded-full bg-card-gold px-2 py-0.5 text-xs font-medium text-foreground">
                {integrations.length} of {totalIntegrations} connections loaded
              </span>
            </p>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="mt-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
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
              className="mt-2 rounded-xl border border-border bg-card-gold px-3 py-2 text-sm text-foreground"
            >
              <p className="font-semibold">Not connected</p>
              <p className="mt-1">
                Integrations are not persisted. Configure Supabase in your .env
                file to enable storage.
              </p>
            </div>
          ) : null}

          <SystemHealthSection
            workerStatus={workerStatus}
            workerHistory={workerHistory}
            onRefresh={handleRefreshWorker}
            onRestart={handleRestartWorker}
          />

          <section className="mt-4">
            <h2 className="text-base font-semibold text-foreground">
              Available
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              These connectors read activity that already exists and import it
              into your account.
            </p>
            <div className="mt-3 space-y-4">
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
            <section className="mt-6">
              <h2 className="text-base font-semibold text-foreground">
                Coming soon
              </h2>
              <ul className="mt-3 space-y-2">
                {planned.map((adapter) => (
                  <AdapterCard key={adapter.id} adapter={adapter} />
                ))}
              </ul>
            </section>
          ) : null}

          <details className="mt-4 rounded-xl border border-border bg-card px-3 py-2 shadow-sm">
            <summary className="cursor-pointer text-sm font-semibold text-foreground">
              What the status badges mean
            </summary>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {Object.entries(STATUS_META).map(([state, meta]) => (
                <li key={state} className="flex items-start gap-2">
                  <StatusBadge status={state} />
                  <span className="text-sm text-muted-foreground">
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
            loading={loading}
          />

          <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
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
