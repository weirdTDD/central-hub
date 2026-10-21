"use client"

import { useMemo } from "react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../components/ui/card"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "../../components/ui/chart"

export const description = "Log entries recorded per day of the week"

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

const chartConfig = {
  completed: {
    label: "Log Entries",
    color: "var(--progress)",
  },
}

/**
 * Counts real log entries per weekday.
 * A log entry is an observation of recorded work, not proof of a completed task.
 */
export function ChartLineDots({ logs = [] }) {
  const chartData = useMemo(() => {
    const counts = new Array(7).fill(0)
    const list = Array.isArray(logs) ? logs : []

    list.forEach((log) => {
      if (!log?.date) return
      const parsed = new Date(`${log.date}T00:00:00`)
      if (Number.isNaN(parsed.getTime())) return
      // getDay() is Sunday-based; shift so Monday is index 0.
      counts[(parsed.getDay() + 6) % 7] += 1
    })

    return DAY_LABELS.map((day, index) => ({ day, completed: counts[index] }))
  }, [logs])

  const totalEntries = chartData.reduce((sum, day) => sum + day.completed, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Log Entries by Day of Week</CardTitle>
        <CardDescription>
          {totalEntries === 0
            ? "No log entries recorded in the selected range"
            : `${totalEntries} log entr${totalEntries === 1 ? "y" : "ies"} recorded in the selected range`}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div style={{
          width: "100%",
          height: "250px",
          minHeight: "250px",
          minWidth: "0",
          position: "relative"
        }}>
          <ChartContainer config={chartConfig} className="h-full w-full min-w-0 rounded-xl">
            <LineChart
              accessibilityLayer
              data={chartData}
              margin={{ left: 0, right: 12 }}
            >
              <CartesianGrid vertical={false} strokeDasharray=" 6 6" stroke="var(--border)" />
              <YAxis
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                tickFormatter={(data) => `${data}`}
              />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "var(--muted-foreground)", fontSize: 14 }}
              />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent formatter={(value) => `${value} log entr${value === 1 ? "y" : "ies"}`} />}
              />
              <Line
                dataKey="completed"
                type="natural"
                stroke="var(--color-completed)"
                strokeWidth={2}
                dot={{ r: 4, strokeWidth: 2 }}
                activeDot={{ r: 8 }}
              />
            </LineChart>
          </ChartContainer>
        </div>
      </CardContent>

      <CardFooter className="flex-col items-start gap-2 text-sm">
        <div className="text-muted-foreground leading-none">
          Counts log entries only. Time spent is not a measure of completion or progress.
        </div>
      </CardFooter>
    </Card>
  )
}
