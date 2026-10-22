import { ChevronDown, } from 'lucide-react';
import { TbShare2 } from 'react-icons/tb';
import Heatmap from '../heatmap/Heatmap';
import DateRangePicker from '../components/DateRangePicker';
import { isWithinInterval, parseISO } from 'date-fns';
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLogs } from '../../dashboard/LogsContext';
import { downloadCsv } from '../../dashboard/logUtils';
import KpiSummary from './KpiSummary';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select"
import { ChartLineDots } from './TaskCompletionChart';
import TaskStatusChart from './TaskStatusChart';
import TopLoggedTasks from './TopLoggedTask';
import PlannedVsActualPanel from '../../features/tracking/PlannedVsActualPanel';
import CodingReportPanel from '../../features/coding/CodingReportPanel';
import InsightsPanel from '../../features/ai/InsightsPanel';
import AskPanel from '../../features/ai/AskPanel';

const START_OF_DAY = (date) => {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
};

const ProductivityReport = () => {
  const { logs, totalLogs, truncated } = useLogs();
  const navigate = useNavigate();

  // Default to a range that actually contains the recorded data, so the report
  // does not silently hide real entries behind a hardcoded year.
  const defaultRange = useMemo(() => {
    const dates = logs
      .map((log) => log.date)
      .filter(Boolean)
      .map((date) => parseISO(date))
      .filter((date) => !Number.isNaN(date.getTime()));

    const earliest = dates.length ? new Date(Math.min(...dates)) : new Date();
    const latest = dates.length ? new Date(Math.max(...dates)) : new Date();
    const today = new Date();

    const from = START_OF_DAY(earliest < today ? earliest : today);
    const to = START_OF_DAY(latest > today ? latest : today);

    return { from, to };
  }, [logs]);

  // `dateRange` stays null until the user picks a range, so the applied range
  // always follows the loaded data instead of freezing at the first render
  // (when the log list was still empty).
  const [userRange, setUserRange] = useState(null);
  const dateRange = userRange ?? defaultRange;

  const filteredLogs = useMemo(
    () =>
      logs.filter((log) => {
        if (!log.date) return false;
        const logDate = parseISO(log.date);
        if (Number.isNaN(logDate.getTime())) return false;
        return dateRange?.from && dateRange?.to
          ? isWithinInterval(logDate, {
              start: dateRange.from,
              end: dateRange.to,
            })
          : true;
      }),
    [logs, dateRange]
  );

  const selectedYear = dateRange?.from
    ? dateRange.from.getFullYear()
    : new Date().getFullYear();

  // The heatmap renders one calendar per year that actually holds data. Rendering a
  // single year would silently drop every log from the other years of the range,
  // while the KPI cards, charts and CSV export would still include them.
  const heatmapYears = useMemo(() => {
    const years = new Set();
    for (const log of filteredLogs) {
      const year = Number(log.date?.slice(0, 4));
      if (Number.isInteger(year) && year > 0) years.add(year);
    }
    if (years.size === 0) years.add(selectedYear);
    return [...years].sort((a, b) => a - b);
  }, [filteredLogs, selectedYear]);

  const handleDayClick = (dayData) => {
    console.log('Clicked day:', dayData);
  };

  const handleExport = () => {
    downloadCsv(filteredLogs);
  };

  return (
    <div className="mx-auto max-w-6xl font-sans">
      
      <div className="mb-8 grid items-center gap-6 sm:grid-cols-1 md:grid-cols-2">
        <div>
          <h1 className="py-3 text-3xl font-bold text-foreground">Productivity Report</h1>
          <p className="mt-1 font-medium text-muted-foreground">View and export your recorded work activity.</p>
        </div>
        <div className='flex items-center md:justify-end gap-4 mb-5'>
          <button
            type="button"
            onClick={handleExport}
            className="flex items-center gap-2 text-nowrap rounded-xl border border-border px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-accent"
          >
            <TbShare2 className='w-6 h-6' strokeWidth={2} /> Export as CSV
          </button>
          <button
            type="button"
            onClick={() => navigate("/logs/new")}
            className='bg-primary text-lg rounded-xl font-semibold text-primary-foreground px-4 py-2 hover:opacity-90'
          >
            New Log Entry
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 mb-8 ">
        <div className="grid items-center gap-4 rounded-2xl border border-border bg-card sm:grid-cols-1 md:grid-cols-2">
          <div className="flex items-center px-3 py-2">
            <span className="mr-2 text-sm font-semibold text-muted-foreground">Date Range</span>
            <div  > 
              <DateRangePicker
                value={dateRange}
                onChange={setUserRange}
                toDate={new Date()}
                className = ""
              />
            </div>
          </div>

          <div className="flex items-center gap-4    min-w-45 justify-end">
            <span className="mr-2 text-sm font-semibold text-muted-foreground">Department</span>
            <div className="flex items-center gap-4 ">
              <span className="text-sm text-gray-600 p-1">
                <Select>
                  <SelectTrigger className="w-45 ">
                    <SelectValue placeholder="All Departments" />
                  </SelectTrigger>
                  <SelectContent >
                    <SelectItem value="Software Engineering">Software Engineering</SelectItem>
                    <SelectItem value="Product Design">Product Design</SelectItem>
                    <SelectItem value="Marketing">Marketing</SelectItem>
                  </SelectContent>
                </Select>
              </span>
            </div>
          </div>
        </div>
      </div>

      {heatmapYears.map((year) => (
        <div key={year} className="mb-6">
          {heatmapYears.length > 1 ? (
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{year}</h2>
          ) : null}
          <Heatmap
            logs={filteredLogs}
            year={year}
            onDayClick={handleDayClick}
            onDayHover={() => {}}
          />
        </div>
      ))}

      {truncated ? (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          {totalLogs} work logs are stored, but only the most recent {logs.length}{" "}
          are loaded. Every number, chart and export on this page covers the loaded
          subset only.
        </div>
      ) : null}

      <KpiSummary logs={filteredLogs} />

      {/* The analysis panel. It is run by the user, never by a background
          refresh, and it states which provider answered: the on-device
          provider by default, and only the provider the user selected
          otherwise. */}
      <div className="mt-6">
        <InsightsPanel
          logs={filteredLogs}
          from={dateRange?.from?.toISOString() ?? null}
          to={dateRange?.to?.toISOString() ?? null}
        />
      </div>

      {/* The plan against the recorded time, for the same range as the rest
          of this report. The panel reads the recorded sessions and the tasks
          itself — the work logs above are a different stream and are never
          mixed into these totals (docs/DECISIONS.md D-007). */}
      <div className="mt-6">
        <PlannedVsActualPanel from={dateRange?.from} to={dateRange?.to} />
      </div>

      <div className="mt-6">
        <CodingReportPanel from={dateRange?.from} to={dateRange?.to} />
      </div>

      <div className="mt-6">
        <AskPanel from={dateRange?.from} to={dateRange?.to} />
      </div>
     <div className='mt-10'>
       <ChartLineDots logs={filteredLogs} />
     </div>

     <div className='grid grid-cols-1 md:grid-cols-2 items-center gap-6 mt-10'>
      <div className=''>
        <TaskStatusChart logs={filteredLogs} />
      </div>

      <div className=''>
        <TopLoggedTasks logs={filteredLogs} />
      </div>
     </div>

    </div>
  );
};

export default ProductivityReport;
