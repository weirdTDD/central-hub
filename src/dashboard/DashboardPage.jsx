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
import Sidebar from "../report/components/Sidebar";
import { useLogs } from "./LogsContext";
import { downloadCsv, formatDisplayDate } from "./logUtils";

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

export default function DashboardPage() {
  const navigate = useNavigate();
  const { logs } = useLogs();
  const [query, setQuery] = useState("");
  const [dense, setDense] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(() => new Set());
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
  const allPageSelected = pageLogs.length > 0 && pageLogs.every((log) => selected.has(log.id));

  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allPageSelected) {
        pageLogs.forEach((log) => next.delete(log.id));
      } else {
        pageLogs.forEach((log) => next.add(log.id));
      }
      return next;
    });
  };

  const toggleOne = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExport = () => {
    const rows =
      selected.size > 0
        ? filteredLogs.filter((log) => selected.has(log.id))
        : filteredLogs;
    downloadCsv(rows);
  };

  return (
    <div className="min-h-screen bg-[#f6f7fb] text-gray-900 dark:bg-zinc-950 dark:text-gray-100">
      <Sidebar currentPath="/dashboard" />

      <main className="min-h-screen px-4 py-6 sm:px-8 md:ml-72 md:px-10">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Manage and view your daily work logs
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleExport}
                className="inline-flex items-center gap-2 rounded-lg border border-[#5B16E1]/30 bg-white px-4 py-2 text-sm font-semibold text-[#5B16E1] hover:bg-violet-50 dark:border-violet-500/40 dark:bg-zinc-900 dark:hover:bg-zinc-800"
              >
                <TbShare2 className="h-5 w-5" />
                Export as CSV
              </button>
              <button
                type="button"
                onClick={() => navigate("/logs/new")}
                className="rounded-lg bg-[#5B16E1] px-4 py-2 text-sm font-semibold text-white hover:bg-[#4a11c0]"
              >
                Generate
              </button>
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center">
            <label className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Search by task or description"
                className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-10 pr-3 text-sm outline-none focus:border-[#5B16E1] focus:ring-2 focus:ring-[#5B16E1]/20 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <DateRangePicker
              value={dateRange}
              onChange={(range) => {
                setDateRange(range ?? { from: undefined, to: undefined });
                setPage(1);
              }}
            />
          </div>

          <section className="mt-6 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-gray-100 bg-gray-50 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-gray-400">
                  <tr>
                    <th className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={allPageSelected}
                        onChange={toggleAll}
                        aria-label="Select all logs on this page"
                        className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                      />
                    </th>
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
                      <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                        No work logs match your filters.
                      </td>
                    </tr>
                  ) : (
                    pageLogs.map((log) => {
                      const checked = selected.has(log.id);
                      return (
                        <tr
                          key={log.id}
                          className="border-b border-gray-100 last:border-0 dark:border-zinc-800"
                        >
                          <td className={dense ? "px-4 py-2" : "px-4 py-4"}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleOne(log.id)}
                              aria-label={`Select ${log.task}`}
                              className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                            />
                          </td>
                          <td className={dense ? "px-4 py-2" : "px-4 py-4"}>
                            <div className="flex items-center gap-3">
                              <img
                                src={log.user.avatar}
                                alt=""
                                className="h-9 w-9 rounded-full object-cover"
                              />
                              <span className="font-medium text-gray-900 dark:text-gray-100">
                                {log.user.name}
                              </span>
                            </div>
                          </td>
                          <td className={`max-w-xs truncate text-gray-700 dark:text-gray-300 ${dense ? "px-4 py-2" : "px-4 py-4"}`}>
                            {log.task}
                          </td>
                          <td className={`whitespace-nowrap text-gray-600 dark:text-gray-400 ${dense ? "px-4 py-2" : "px-4 py-4"}`}>
                            {formatDisplayDate(log.date)}
                          </td>
                          <td className={`whitespace-nowrap text-gray-600 dark:text-gray-400 ${dense ? "px-4 py-2" : "px-4 py-4"}`}>
                            {log.duration}
                          </td>
                          <td className={dense ? "px-4 py-2" : "px-4 py-4"}>
                            <div className="flex items-center gap-2 text-gray-400">
                              <Link
                                to={`/logs/${log.id}/edit`}
                                className="rounded-md p-1.5 hover:bg-gray-100 hover:text-[#5B16E1] dark:hover:bg-zinc-800"
                                aria-label={`Edit ${log.task}`}
                              >
                                <Pencil className="h-4 w-4" />
                              </Link>
                              <button
                                type="button"
                                className="rounded-md p-1.5 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-zinc-800"
                                aria-label={`More actions for ${log.task}`}
                              >
                                <MoreVertical className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-4 border-t border-gray-100 px-4 py-4 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-800">
              <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                <button
                  type="button"
                  role="switch"
                  aria-checked={dense}
                  onClick={() => setDense((value) => !value)}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    dense ? "bg-[#5B16E1]" : "bg-gray-300 dark:bg-zinc-600"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
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
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-zinc-800"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </button>
                {pageItems(currentPage, totalPages).map((item, index) =>
                  item === "…" ? (
                    <span key={`ellipsis-${index}`} className="px-2 text-sm text-gray-400">
                      …
                    </span>
                  ) : (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setPage(item)}
                      className={`min-w-8 rounded-lg px-2 py-1.5 text-sm font-medium ${
                        item === currentPage
                          ? "bg-[#5B16E1] text-white"
                          : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-zinc-800"
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
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-zinc-800"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </section>

          {dateRange?.from && dateRange?.to ? (
            <p className="mt-3 text-xs text-gray-500">
              Showing logs from {format(dateRange.from, "MMM d, yyyy")} to{" "}
              {format(dateRange.to, "MMM d, yyyy")}
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
