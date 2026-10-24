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

const KPICard = ({ title, value, unit, subText, caption, completeness, tone = "coral" }) => {
  return (
    <div className={`flex min-h-32 flex-col justify-between rounded-xl border border-border px-3 py-2.5 shadow-sm ${TONES[tone] ?? TONES.coral}`}>
      <div>
        <h3 className="mb-1 text-xs font-medium text-foreground">{title}</h3>
        <div className="mb-1 text-3xl font-serif font-bold text-foreground">
          {value}
          {unit ? (
            <span className="ml-1 text-base tracking-tight font-serif italic text-foreground">{unit}</span>
          ) : null}
        </div>
        <div className="mt-2 text-xs font-medium text-nowrap text-foreground">{subText}</div>
        <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
        {completeness ? <p className="mt-1 text-xs text-muted-foreground">{completeness}</p> : null}
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
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <KPICard
          title="Total Time Logged"
          value={kpiData.totalTimeLogged}
          unit="hrs"
          subText="Sum of recorded durations"
          caption="Source: work log durations in the selected date range."
          completeness={missing > 0 ? "Entries without a recorded duration are excluded." : null}
          tone="coral"
        />
        <KPICard
          title="Log Entries"
          value={kpiData.totalLogEntries}
          subText="Work log entries in range"
          caption="Source: work log rows dated within the selected range."
          tone="gold"
        />
        <div className={`flex min-h-32 flex-col justify-between rounded-xl border border-border px-3 py-2.5 shadow-sm ${hoursGradeSurface(hoursGrade)}`}>
          <div>
            <h3 className="mb-1 text-xs font-medium text-foreground">Average Daily Hours</h3>
            <div className="mb-1 text-3xl font-serif font-bold text-foreground">
              {kpiData.avgDailyHours}
              <span className="ml-1 text-base font-serif italic font-normal text-foreground">hrs</span>
            </div>
            <div className="mt-3 text-xs font-medium text-foreground">
              {hoursCaption
                ? `${hoursCaption} · ${kpiData.activeDays} active day${kpiData.activeDays === 1 ? "" : "s"}`
                : `Across ${kpiData.activeDays} active day${kpiData.activeDays === 1 ? "" : "s"}`}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Source: recorded work log duration divided by days with recorded time.</p>
            {missing > 0 ? <p className="mt-1 text-xs text-muted-foreground">Entries without a recorded duration are excluded.</p> : null}
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
