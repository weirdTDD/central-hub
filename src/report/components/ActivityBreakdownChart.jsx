"use client"

import * as React from "react"
import { Label, Pie, PieChart, Sector } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card"
import {
  ChartContainer,
  ChartStyle,
  ChartTooltip,
  ChartTooltipContent,
} from "../../components/ui/chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select"
import { formatDurationFromSeconds } from "../../dashboard/logUtils"

const CHART_CONFIG = {
  time: {
    label: "Time",
  },
  coding: {
    label: "Coding",
    color: "var(--progress)",
  },
  learning: {
    label: "Learning",
    color: "var(--teal)",
  },
  workLogs: {
    label: "Work Logs",
    color: "var(--chart-1)",
  },
}

export default function ActivityBreakdownChart({ codingSeconds = 0, learningSeconds = 0, workLogSeconds = 0 }) {
  const id = "activity-breakdown"

  const categories = React.useMemo(() => {
    const list = []
    const c = Number(codingSeconds) || 0
    const l = Number(learningSeconds) || 0
    const w = Number(workLogSeconds) || 0
    if (c > 0) list.push({ type: "coding", seconds: c, fill: "var(--color-coding)" })
    if (l > 0) list.push({ type: "learning", seconds: l, fill: "var(--color-learning)" })
    if (w > 0) list.push({ type: "workLogs", seconds: w, fill: "var(--color-workLogs)" })
    return list
  }, [codingSeconds, learningSeconds, workLogSeconds])

  const totalSeconds = React.useMemo(
    () => categories.reduce((sum, item) => sum + item.seconds, 0),
    [categories]
  )

  const [activeCategory, setActiveCategory] = React.useState(
    categories.length > 0 ? categories[0].type : "coding"
  )

  const activeIndex = React.useMemo(
    () => categories.findIndex((item) => item.type === activeCategory),
    [categories, activeCategory]
  )

  const renderPieShape = React.useCallback(
    ({ index, outerRadius = 0, ...props }) => {
      if (index === activeIndex) {
        return (
          <g>
            <Sector {...props} outerRadius={outerRadius + 10} />
            <Sector
              {...props}
              outerRadius={outerRadius + 25}
              innerRadius={outerRadius + 12}
            />
          </g>
        )
      }
      return <Sector {...props} outerRadius={outerRadius} />
    },
    [activeIndex]
  )

  if (categories.length === 0) {
    return (
      <Card className="bg-card-peach">
        <CardHeader>
          <CardTitle>Time Breakdown</CardTitle>
          <CardDescription>
            Coding, learning, and work-log durations for the selected range.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 justify-center pb-0">
          <p className="py-8 text-center text-sm text-muted-foreground">
            No time recorded in the selected range.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card data-chart={id} className="flex flex-col bg-card-peach">
      <ChartStyle id={id} config={CHART_CONFIG} />
      <CardHeader className="flex-row items-start space-y-0 pb-0">
        <div className="grid gap-1">
          <CardTitle>Time Breakdown</CardTitle>
          <CardDescription>
            Coding, learning, and work-log durations for the selected range
          </CardDescription>
        </div>
        <Select value={activeCategory} onValueChange={setActiveCategory}>
          <SelectTrigger
            className="ml-auto h-7 sm:w-48 rounded-lg pl-2.5"
            aria-label="Select a category"
          >
            <SelectValue placeholder="Select category" />
          </SelectTrigger>
          <SelectContent align="end" className="rounded-xl">
            {categories.map((item) => {
              const config = CHART_CONFIG[item.type]
              return (
                <SelectItem
                  key={item.type}
                  value={item.type}
                  className="rounded-lg [&_span]:flex"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className="flex h-3 w-3 shrink-0 rounded-xs"
                      style={{ backgroundColor: `var(--color-${item.type})` }}
                    />
                    {config?.label}
                  </div>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="flex flex-1 justify-center pb-0">
          <ChartContainer
            id={id}
            config={CHART_CONFIG}
            className="mx-auto aspect-square w-full max-w-[240px]"
          >
          <PieChart>
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent hideLabel />}
            />
            <Pie
              data={categories}
              dataKey="seconds"
              nameKey="type"
              innerRadius={60}
              strokeWidth={5}
              shape={renderPieShape}
            >
              <Label
                content={({ viewBox }) => {
                  if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                    return (
                      <text
                        x={viewBox.cx}
                        y={viewBox.cy}
                        textAnchor="middle"
                        dominantBaseline="middle"
                      >
                        <tspan
                          x={viewBox.cx}
                          y={viewBox.cy}
                          className="fill-foreground text-3xl font-bold"
                        >
                          {formatDurationFromSeconds(totalSeconds)}
                        </tspan>
                        <tspan
                          x={viewBox.cx}
                          y={(viewBox.cy || 0) + 24}
                          className="fill-muted-foreground"
                        >
                          Total
                        </tspan>
                      </text>
                    )
                  }
                }}
              />
            </Pie>
          </PieChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
