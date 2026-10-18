export function formatDuration(minutes) {
  const safe = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  return `${hours}h ${String(mins).padStart(2, "0")}m`;
}

export function parseDuration(value) {
  if (!value?.trim()) return 0;
  const hoursMatch = value.match(/(\d+)\s*h/i);
  const minsMatch = value.match(/(\d+)\s*m/i);
  const hours = hoursMatch ? Number(hoursMatch[1]) : 0;
  const mins = minsMatch ? Number(minsMatch[1]) : 0;
  if (hours || mins) return hours * 60 + mins;

  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? Math.round(asNumber * 60) : 0;
}

export function formatDisplayDate(isoDate) {
  if (!isoDate) return "";
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) return isoDate;
  return `${month}-${day}-${year}`;
}

export function downloadCsv(rows, filename = "work-logs.csv") {
  const header = ["Team Member", "Task", "Date", "Time Spent", "Note"];
  const lines = rows.map((log) =>
    [
      log.user?.name ?? "",
      log.task ?? "",
      formatDisplayDate(log.date),
      log.duration ?? "",
      (log.note ?? "").replaceAll('"', '""'),
    ]
      .map((cell) => `"${cell}"`)
      .join(",")
  );

  const blob = new Blob([[header.join(","), ...lines].join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
