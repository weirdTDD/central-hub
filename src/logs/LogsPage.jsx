import { format, isWithinInterval, parseISO } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Pencil,
  Search,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TbShare2 } from "react-icons/tb";
import DateRangePicker from "../report/components/DateRangePicker";
import AppShell from "../components/AppShell";
import { useLogs } from "../dashboard/LogsContext";
import { downloadCsv, formatDisplayDate } from "../dashboard/logUtils";

const PAGE_SIZE = 8;

function pageItems(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

  const pages = new Set([1, total, current - 1, current, current + 1].filter((page) => page >= 1 && page <= total));
  const sorted = [...pages].sort((a, b) => a - b);
  const result = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const page = sorted[index];
    const previous = sorted[index - 1];
    if (previous && page - previous > 1) result.push("…");
    result.push(page);
  }

  return result;
}

export default function LogsPage() {
  const navigate = useNavigate();
  const { logs, loading, error, isConfigured, totalLogs, truncated } = useLogs();
  const [query, setQuery] = useState("");
  const [dense, setDense] = useState(false);
  const [page, setPage] = useState(1);
  const [dateRange, setDateRange] = useState({ from: undefined, to: undefined });

  const filteredLogs = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return logs.filter((log) => {
      const matchesQuery =
        !needle ||
        log.task.toLowerCase().includes(needle) ||
        (log.note ?? "").toLowerCase().includes(needle) ||
        log.user.name.toLowerCase().includes(needle);

      const matchesDate =
        !dateRange?.from ||
        !dateRange?.to ||
        isWithinInterval(parseISO(log.date), {
          start: dateRange.from,
          end: dateRange.to,
        });

      return matchesQuery && matchesDate;
    });
  }, [logs, query, dateRange]);

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageLogs = filteredLogs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const handleExport = () => {
    downloadCsv(filteredLogs);
  };

  const emptyMessage = (() => {
    if (loading) return "Loading work logs...";
    if (error) return "Could not load work logs.";
    if (!isConfigured) return "Not connected. Configure Supabase to load work logs.";
    if (logs.length === 0) return "No work logs yet. Create your first log entry.";
    return "No work logs match your filters.";
  })();

  return (
    <AppShell currentPath="/logs">
        <div className="mx-auto min-w-0 max-w-6xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Work logs</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Manage and view your daily work logs
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-3">
              <button
                type="button"
                onClick={handleExport}
                className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 rounded-lg border border-primary/30 bg-card px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/10 dark:border-primary/40 sm:px-4 sm:text-sm"
              >
                <TbShare2 className="h-4 w-4 shrink-0 sm:h-5 sm:w-5" />
                <span className="truncate">Export as CSV</span>
              </button>
              <button
                type="button"
                onClick={() => navigate("/logs/new")}
                className="min-h-10 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 sm:px-4 sm:text-sm"
              >
                Generate
              </button>
            </div>
          </div>

          <div className="mt-5 flex min-w-0 flex-col gap-3 sm:mt-6 lg:flex-row lg:items-center">
            <label className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Search by task or description"
                className="w-full rounded-xl border border-border bg-card py-2.5 pl-10 pr-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </label>
            <DateRangePicker
              align="end"
              value={dateRange}
              className="w-full justify-center sm:justify-start lg:w-auto"
              onChange={(range) => {
                setDateRange(range ?? { from: undefined, to: undefined });
                setPage(1);
              }}
            />
          </div>

          {truncated ? (
            <div
              role="status"
              className="mt-6 rounded-2xl border border-border bg-muted px-4 py-3 text-sm text-foreground"
            >
              <p className="font-semibold">Showing the most recent {logs.length} logs</p>
              <p className="mt-1">
                {totalLogs} work logs are stored, but only the most recent{" "}
                {logs.length} are loaded. Older entries are not included in the
                table, the totals or the exports.
              </p>
            </div>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="mt-6 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              <p className="font-semibold">Could not load work logs</p>
              <p className="mt-1">{error}</p>
            </div>
          ) : null}

          {!isConfigured ? (
            <div
              role="status"
              className="mt-6 rounded-2xl border border-border bg-card-gold px-4 py-3 text-sm text-foreground"
            >
              <p className="font-semibold">Not connected</p>
              <p className="mt-1">
                Work logs are not persisted. Configure Supabase in your .env file to
                enable storage.
              </p>
            </div>
          ) : null}

          <section className="mt-5 overflow-hidden rounded-2xl border border-border bg-card shadow-sm sm:mt-6">
            <div className="divide-y divide-border lg:hidden">
              {pageLogs.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {emptyMessage}
                </p>
              ) : (
                pageLogs.map((log) => (
                  <article key={log.id} className="min-w-0 p-3 sm:p-4">
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <h2 className="min-w-0 flex-1 break-words text-sm font-semibold text-foreground">
                        {log.task}
                      </h2>
                      <div className="flex shrink-0 items-center gap-1">
                        <Link
                          to={`/logs/${log.id}/edit`}
                          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Edit ${log.task}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Link>
                        <button
                          type="button"
                          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`More actions for ${log.task}`}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    <div className="mt-3 flex min-w-0 items-center gap-2">
                      <img
                        src={log.user.avatar}
                        alt=""
                        className="h-8 w-8 shrink-0 rounded-full object-cover"
                      />
                      <span className="min-w-0 truncate text-sm font-medium text-foreground">
                        {log.user.name}
                      </span>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">Date</dt>
                        <dd className="mt-0.5 text-foreground">{formatDisplayDate(log.date)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">Time spent</dt>
                        <dd className="mt-0.5 text-foreground">{log.duration}</dd>
                      </div>
                    </dl>
                    {log.note ? (
                      <p className="mt-3 line-clamp-3 break-words text-xs text-muted-foreground">
                        {log.note}
                      </p>
                    ) : null}
                  </article>
                ))
              )}
            </div>
            <div className="hidden overflow-x-auto lg:block">
              <table className="min-w-[760px] w-full text-left text-sm">
                <thead className="border-b border-border bg-muted text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Team Members</th>
                    <th className="px-4 py-3">Task Worked On</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Time Spent</th>
                    <th className="px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pageLogs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                        {emptyMessage}
                      </td>
                    </tr>
                  ) : (
                    pageLogs.map((log) => (
                        <tr
                          key={log.id}
                          className="border-b border-border last:border-0"
                        >
                          <td className={dense ? "px-4 py-2" : "px-4 py-4"}>
                            <div className="flex items-center gap-3">
                              <img
                                src={log.user.avatar}
                                alt=""
                                className="h-9 w-9 rounded-full object-cover"
                              />
                              <span className="font-medium text-foreground">
                                {log.user.name}
                              </span>
                            </div>
                          </td>
                          <td className={`max-w-xs truncate text-foreground  ${dense ? "px-4 py-2" : "px-4 py-4"}`}>
                            {log.task}
                          </td>
                          <td className={`whitespace-nowrap text-muted-foreground  ${dense ? "px-4 py-2" : "px-4 py-4"}`}>
                            {formatDisplayDate(log.date)}
                          </td>
                          <td className={`whitespace-nowrap text-muted-foreground  ${dense ? "px-4 py-2" : "px-4 py-4"}`}>
                            {log.duration}
                          </td>
                          <td className={dense ? "px-4 py-2" : "px-4 py-4"}>
                            <div className="flex items-center gap-2 text-muted-foreground">
                                <Link
                                  to={`/logs/${log.id}/edit`}
                                  className="rounded-md p-1.5 hover:bg-accent hover:text-primary"
                                  aria-label={`Edit ${log.task}`}
                              >
                                <Pencil className="h-4 w-4" />
                              </Link>
                              <button
                                type="button"
                                className="rounded-md p-1.5 hover:bg-accent hover:text-foreground"
                                aria-label={`More actions for ${log.task}`}
                              >
                                <MoreVertical className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-3 border-t border-border px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-4">
              <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <button
                  type="button"
                  role="switch"
                  aria-checked={dense}
                  onClick={() => setDense((value) => !value)}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    dense ? "bg-progress" : "bg-muted "
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-card shadow transition-transform ${
                      dense ? "translate-x-5" : ""
                    }`}
                  />
                </button>
                Dense
              </label>

              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  disabled={currentPage === 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent disabled:opacity-40"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </button>
                {pageItems(currentPage, totalPages).map((item, index) =>
                  item === "…" ? (
                    <span key={`ellipsis-${index}`} className="px-2 text-sm text-muted-foreground">
                      …
                    </span>
                  ) : (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setPage(item)}
                      className={`min-w-8 rounded-lg px-2 py-1.5 text-sm font-medium ${
                        item === currentPage
                          ? "bg-progress text-progress-foreground"
                          : "text-muted-foreground hover:bg-accent  "
                      }`}
                    >
                      {item}
                    </button>
                  )
                )}
                <button
                  type="button"
                  disabled={currentPage === totalPages}
                  onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent disabled:opacity-40"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </section>

          {dateRange?.from && dateRange?.to ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing logs from {format(dateRange.from, "MMM d, yyyy")} to{" "}
              {format(dateRange.to, "MMM d, yyyy")}
            </p>
          ) : null}
        </div>
    </AppShell>
  );
}
