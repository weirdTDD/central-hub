import { useMemo } from "react";
import { calculateKPIs } from "../utils/KpiUtils";
import {
  hoursGradeCaption,
  hoursGradeFromHours,
  hoursGradeSurface,
} from "../../lib/hoursGrade";

const TONES = {
  coral: "bg-card-coral",
  gold: "bg-card-gold",
  rose: "bg-card-rose",
  sky: "bg-card-sky",
};

const KPICard = ({ title, value, unit, subText, tone = "coral" }) => {
  return (
    <div className={`flex min-h-32 flex-col justify-between rounded-2xl border border-black/5 px-4 py-3 shadow-lift dark:border-white/10 ${TONES[tone] ?? TONES.coral}`}>
      <div>
        <h3 className="mb-1 text-sm font-medium text-foreground">{title}</h3>
        <div className="mb-1 text-5xl font-serif font-bold text-foreground">
          {value}
          {unit ? (
            <span className="ml-1 text-lg tracking-tight font-serif italic text-foreground">{unit}</span>
          ) : null}
        </div>
        <div className="mt-4 text-xs font-medium text-nowrap text-foreground">{subText}</div>
      </div>
    </div>
  );
};

const KpiSummary = ({ logs = [] }) => {
  const kpiData = useMemo(() => calculateKPIs(logs), [logs]);
  const missing = kpiData.logsMissingDuration;
  const hoursGrade = hoursGradeFromHours(kpiData.avgDailyHours);
  const hoursCaption = hoursGradeCaption(hoursGrade);

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <KPICard
          title="Total Time Logged"
          value={kpiData.totalTimeLogged}
          unit="hrs"
          subText="Sum of recorded durations"
          tone="coral"
        />
        <KPICard
          title="Log Entries"
          value={kpiData.totalLogEntries}
          subText="Work log entries in range"
          tone="gold"
        />
        <div className={`flex min-h-32 flex-col justify-between rounded-2xl border border-black/5 px-4 py-3 shadow-lift dark:border-white/10 ${hoursGradeSurface(hoursGrade)}`}>
          <div>
            <h3 className="mb-1 text-sm font-medium text-foreground">Average Daily Hours</h3>
            <div className="mb-1 text-5xl font-serif font-bold text-foreground">
              {kpiData.avgDailyHours}
              <span className="ml-1 text-lg font-serif italic font-normal text-foreground">hrs</span>
            </div>
            <div className="mt-4 text-xs font-medium text-nowrap text-foreground">
              {hoursCaption
                ? `${hoursCaption} · ${kpiData.activeDays} active day${kpiData.activeDays === 1 ? "" : "s"}`
                : `Across ${kpiData.activeDays} active day${kpiData.activeDays === 1 ? "" : "s"}`}
            </div>
          </div>
        </div>
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
