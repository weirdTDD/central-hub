/**
 * Priority grades for recorded hours (0–6).
 *
 * When an average is provided (heatmap), thresholds are relative to the
 * average of active days so the scale adapts to the user's typical load:
 *   1 = very low  (< 10% of average)
 *   2 = low       (10%–25%)
 *   3 = below avg (25%–50%)
 *   4 = near avg  (50%–100%)
 *   5 = above avg (100%–200%)
 *   6 = peak      (200%+)
 *
 * Without an average (KPI card, dashboard), thresholds are fixed:
 *   1 = very low  (< 1h)
 *   2 = low       (1–2h)
 *   3 = below avg (2–3h)
 *   4 = near avg  (3–5h)
 *   5 = above avg (5–8h)
 *   6 = peak      (8h+)
 *
 * Heat colors are all blue: light (low activity) → dark (high activity)
 * in light mode, and dark → light in dark mode.
 */

export function hoursGradeFromSeconds(seconds, averageSeconds = null) {
  if (seconds == null || !Number.isFinite(Number(seconds)) || Number(seconds) <= 0) {
    return 0;
  }
  const value = Number(seconds);

  if (averageSeconds != null && averageSeconds > 0) {
    if (value <= averageSeconds * 0.10) return 1;
    if (value <= averageSeconds * 0.25) return 2;
    if (value <= averageSeconds * 0.50) return 3;
    if (value <= averageSeconds) return 4;
    if (value <= averageSeconds * 2.0) return 5;
    return 6;
  }

  if (value <= 3600) return 1;
  if (value <= 2 * 3600) return 2;
  if (value <= 3 * 3600) return 3;
  if (value <= 5 * 3600) return 4;
  if (value <= 8 * 3600) return 5;
  return 6;
}

export function hoursGradeFromHours(hours) {
  return hoursGradeFromSeconds(Number(hours) * 3600);
}

export function hoursGradeSurface(grade) {
  switch (grade) {
    case 1: return "bg-heat-1";
    case 2: return "bg-heat-2";
    case 3: return "bg-heat-3";
    case 4: return "bg-heat-4";
    case 5: return "bg-heat-5";
    case 6: return "bg-heat-6";
    default: return "bg-muted";
  }
}

export function hoursGradeLabel(grade) {
  switch (grade) {
    case 1:
      return "Very Low";
    case 2:
      return "Low";
    case 3:
      return "Below Average";
    case 4:
      return "Near Average";
    case 5:
      return "Above Average";
    case 6:
      return "Peak";
    default:
      return "None";
  }
}

function formatHoursShort(seconds) {
  const hours = seconds / 3600;
  if (hours < 1) {
    const mins = Math.round(hours * 60);
    return `${mins}m`;
  }
  return `${hours.toFixed(1)}h`;
}

export function hoursGradeCaption(grade, averageSeconds = null) {
  const avgAvailable = averageSeconds != null && averageSeconds > 0;

  if (avgAvailable) {
    const avg = averageSeconds;
    switch (grade) {
      case 1:
        return `Very Low · under ${formatHoursShort(avg * 0.10)}`;
      case 2:
        return `Low · ${formatHoursShort(avg * 0.10)}–${formatHoursShort(avg * 0.25)}`;
      case 3:
        return `Below Average · ${formatHoursShort(avg * 0.25)}–${formatHoursShort(avg * 0.50)}`;
      case 4:
        return `Near Average · ${formatHoursShort(avg * 0.50)}–${formatHoursShort(avg)}`;
      case 5:
        return `Above Average · ${formatHoursShort(avg)}–${formatHoursShort(avg * 2)}`;
      case 6:
        return `Peak · ${formatHoursShort(avg * 2)}+`;
      default:
        return null;
    }
  }

  switch (grade) {
    case 1:
      return "Very Low · under 1h";
    case 2:
      return "Low · 1–2h";
    case 3:
      return "Below Average · 2–3h";
    case 4:
      return "Near Average · 3–5h";
    case 5:
      return "Above Average · 5–8h";
    case 6:
      return "Peak · 8h+";
    default:
      return null;
  }
}

export function computeAverageSeconds(calendarData) {
  if (!calendarData || !Array.isArray(calendarData)) return null;

  let totalSeconds = 0;
  let activeDayCount = 0;

  for (const month of calendarData) {
    for (const week of month.weeks) {
      for (const day of week) {
        if (day.paintSeconds != null && day.paintSeconds > 0) {
          totalSeconds += day.paintSeconds;
          activeDayCount++;
        }
      }
    }
  }

  if (activeDayCount === 0) return null;
  return totalSeconds / activeDayCount;
}
