import { useMemo } from "react";
import { calculateKPIs } from "../utils/KpiUtils";

const KPICard = ({ title, value, unit, subText }) => {
  return (
    <div className="flex min-h-32 flex-col justify-between rounded-2xl border border-border bg-card px-4 py-3 shadow-sm">
      <div>
        <h3 className="mb-1 text-sm font-medium text-muted-foreground">{title}</h3>
        <div className="mb-1 text-3xl font-bold text-card-foreground">
          {value}
          {unit ? (
            <span className="ml-1 text-lg font-normal text-muted-foreground">{unit}</span>
          ) : null}
        </div>
        <div className="mt-2 text-xs font-medium text-nowrap text-muted-foreground">{subText}</div>
      </div>
    </div>
  );
};

const KpiSummary = ({ logs = [] }) => {
  const kpiData = useMemo(() => calculateKPIs(logs), [logs]);
  const missing = kpiData.logsMissingDuration;

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <KPICard
          title="Total Time Logged"
          value={kpiData.totalTimeLogged}
          unit="hrs"
          subText="Sum of recorded durations"
        />
        <KPICard
          title="Log Entries"
          value={kpiData.totalLogEntries}
          subText="Work log entries in range"
        />
        <KPICard
          title="Average Daily Hours"
          value={kpiData.avgDailyHours}
          unit="hrs"
          subText={`Across ${kpiData.activeDays} active day${kpiData.activeDays === 1 ? "" : "s"}`}
        />
      </div>

      {missing > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {missing} of {kpiData.totalLogEntries} log entries have no recorded duration
          and are excluded from the time totals above.
        </p>
      ) : null}
    </div>
  );
};

export default KpiSummary;
