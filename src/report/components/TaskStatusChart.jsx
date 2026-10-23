import { useMemo, useSyncExternalStore } from "react";
import ReactECharts from "echarts-for-react";
import { hasRecordedDuration } from "../../dashboard/logUtils";
import { subscribeTheme, isDark } from "../../settings/theme";

/**
 * Reads a design token from the document so charts follow the active theme
 * instead of hard-coding a colour literal in this component.
 */
function readToken(name, fallback) {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/**
 * Data coverage for the selected range.
 *
 * Work logs have no task status until task management exists, so this chart
 * reports what the data actually supports: how many log entries carry a
 * recorded duration and how many do not. It never invents progress.
 */
const TaskStatusChart = ({ logs = [] }) => {
  const themeSnapshot = useSyncExternalStore(subscribeTheme, isDark);

  const { option, hasData } = useMemo(() => {
    void themeSnapshot; // re-read DOM tokens on theme change

    const list = Array.isArray(logs) ? logs : [];
    const withDuration = list.filter(hasRecordedDuration).length;
    const withoutDuration = list.length - withDuration;

    const accent = readToken("--progress", "#2563eb");
    const muted = readToken("--muted-foreground", "#3d4d66");

    const data = [];
    if (withDuration > 0) {
      data.push({ value: withDuration, name: "Duration recorded", itemStyle: { color: accent } });
    }
    if (withoutDuration > 0) {
      data.push({ value: withoutDuration, name: "No duration recorded", itemStyle: { color: muted } });
    }

    return {
      hasData: data.length > 0,
      option: {
        tooltip: { trigger: "item" },
        legend: {
          orient: "vertical",
          top: "middle",
          right: -5,
          itemGap: 10,
        },
        series: [
          {
            name: "Data coverage",
            type: "pie",
            center: ["29%", "42%"],
            radius: ["41%", "58%"],
            right: 10,
            avoidLabelOverlap: true,
            padAngle: 5,
            itemStyle: { borderRadius: 10 },
            label: { show: false, position: "center" },
            emphasis: {
              label: {
                show: true,
                fontSize: 18,
                fontWeight: "bold",
              },
            },
            labelLine: { show: true },
            fontSize: 16,
            fontWeight: "bold",
            data,
          },
        ],
      },
    };
  }, [logs, themeSnapshot]);

  return (
    <div className="h-full rounded-2xl border border-black/5 bg-card-sky p-6 shadow-lift md:h-90 dark:border-white/10">
      <h3 className="text-lg font-semibold text-card-foreground">Data Coverage</h3>
      {hasData ? (
        <ReactECharts option={option} style={{ height: 400 }} />
      ) : (
        <p className="py-24 text-center text-sm text-muted-foreground">
          No data collected for the selected range.
        </p>
      )}
    </div>
  );
};

export default TaskStatusChart;
