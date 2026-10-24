// Clickable week bars and comparative course bars.
//
// The fill is a share of the longest recorded value. An empty track means
// nothing was recorded. The components do not draw a zero for missing time.

import { durationText } from "../../dashboard/todayView";
import { peakScale } from "./scale.js";

const FILLS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

/**
 * Seven days. Clicking a column selects that day.
 *
 * @param {object} props
 * @param {Array<{key: string, weekday: string, dayNumber: number|string, seconds: number|null}>} props.days
 * @param {string} props.selectedKey
 * @param {(key: string) => void} props.onSelect
 * @param {string} [props.recordedWord] word used in the accessible name when time exists
 */
export function WeekChart({ days = [], selectedKey, onSelect, recordedWord = "recorded" }) {
  const scales = peakScale(days.map((day) => day.seconds));
  if (days.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-3 sm:p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">This week</h2>
        <p className="text-xs text-muted-foreground">Taller is more active time. No bar means nothing recorded.</p>
      </div>
      <div className="mt-3 grid grid-cols-7 gap-1 sm:gap-1.5" role="group" aria-label="Days this week">
        {days.map((day, index) => {
          const scale = scales[index];
          const selected = day.key === selectedKey;
          const known = day.seconds != null && day.seconds > 0;
          const label = known
            ? `${day.weekday} ${day.dayNumber}, ${durationText(day.seconds)} ${recordedWord}`
            : `${day.weekday} ${day.dayNumber}, nothing recorded`;
          return (
            <button
              key={day.key}
              type="button"
              aria-pressed={selected}
              aria-label={label}
              onClick={() => onSelect(day.key)}
              className="flex min-h-9 min-w-0 flex-col items-center gap-1 rounded-xl px-0.5 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex h-24 w-full items-end rounded-xl bg-muted px-1 pb-1 sm:h-28">
                <span
                  className="block w-full rounded-xl"
                  style={{
                    height: known && scale != null ? `${Math.max(scale, 10)}%` : "0%",
                    background: known ? (selected ? "var(--primary)" : "var(--progress)") : "transparent",
                  }}
                />
              </span>
              <span className={`text-xs font-medium uppercase tracking-wide ${selected ? "text-primary" : "text-muted-foreground"}`}>
                {day.weekday}
              </span>
              <span
                className={`flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-sm font-semibold ${
                  selected ? "bg-primary text-primary-foreground" : "text-foreground"
                }`}
              >
                {day.dayNumber}
              </span>
              <span className="max-w-full truncate text-xs leading-tight text-muted-foreground">
                {known ? durationText(day.seconds) : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Rows compared with the longest row. Clicking a row toggles it.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {Array<{key: string, activeSeconds: number|null}>} props.rows
 * @param {string|null} [props.selectedKey]
 * @param {(key: string) => void} [props.onSelect]
 * @param {(row: {key: string}) => string} [props.labelOf]
 */
/**
 * The bars alone, for a card that already has a heading.
 *
 * @param {object} props
 * @param {Array<{key: string, activeSeconds: number|null}>} props.rows
 * @param {(row: {key: string}) => string} [props.labelOf]
 */
export function MeterRows({ rows = [], labelOf }) {
  const scales = peakScale(rows.map((row) => row.activeSeconds));
  const label = labelOf ?? ((row) => row.key);
  if (rows.length === 0) return null;
  return (
    <ul className="mt-3 space-y-2">
      {rows.map((row, index) => {
        const scale = scales[index];
        return (
          <li key={row.key}>
            <span className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{label(row)}</span>
              <span className="shrink-0 text-muted-foreground">{durationText(row.activeSeconds)}</span>
            </span>
            <span className="mt-1.5 block h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span
                className="block h-full rounded-full"
                style={{
                  width: scale == null ? "0%" : `${Math.max(scale, row.activeSeconds > 0 ? 6 : 0)}%`,
                  background: FILLS[index % FILLS.length],
                }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ShareBars({ title, rows = [], selectedKey = null, onSelect, labelOf }) {
  if (rows.length === 0) return null;
  const scales = peakScale(rows.map((row) => row.activeSeconds));
  const label = labelOf ?? ((row) => row.key);
  return (
    <section className="rounded-xl border border-border bg-card p-3 sm:p-3" aria-label={title}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">Compared with the longest. Not a completion grade.</p>
      </div>
      <ul className="mt-2 space-y-1.5">
        {rows.map((row, index) => {
          const scale = scales[index];
          const selected = selectedKey === row.key;
          const name = label(row);
          const interactive = typeof onSelect === "function";
          const body = (
            <>
              <span className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 truncate font-medium">{name}</span>
                <span className="shrink-0 text-muted-foreground">{durationText(row.activeSeconds)}</span>
              </span>
              <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: scale == null ? "0%" : `${Math.max(scale, row.activeSeconds > 0 ? 4 : 0)}%`,
                    background: FILLS[index % FILLS.length],
                  }}
                />
              </span>
            </>
          );
          return (
            <li key={row.key}>
              {interactive ? (
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(row.key)}
                  className={`min-h-9 w-full rounded-xl px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    selected ? "bg-primary/10 ring-1 ring-primary" : "hover:bg-muted"
                  }`}
                >
                  {body}
                </button>
              ) : (
                <div className="px-1 py-1">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
