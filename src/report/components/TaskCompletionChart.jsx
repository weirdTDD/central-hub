"use client"

import { TrendingUp } from "lucide-react"
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

export const description = "A line chart with dots"




const mockData = [
  { day: "Mon", completed: 10 },
  { day: "Tue", completed: 95 },
  { day: "Wed", completed: 20 },
  { day: "Thu", completed: 70 },
  { day: "Fri", completed: 5 },
  { day: "Sat", completed: 5 },
  { day: "Sun", completed: 5 },
]


const chartConfig = {
  completed: {
    label: "Tasks Completed",
    color: "#5520b1",
  },
}


export function ChartLineDots() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Total Task Completions</CardTitle>
        <CardDescription>40 task completed</CardDescription>
      </CardHeader>

      <CardContent>
        <div style={{ 
          width: "100%", 
          height: "250px", 
          minHeight: "250px",
          minWidth: "0", // This fixes flexbox issues
          position: "relative"
          }}>
          <ChartContainer config={chartConfig} className="h-full w-full min-w-0 rounded-xl">
            <LineChart
              accessibilityLayer
              data={mockData}
              margin={{ left: 0, right: 12 }}
            >
              <CartesianGrid vertical={false} strokeDasharray=" 6 6"   stroke="#d1d5db" />
              <YAxis 
                tickLine={false}
                axisLine={false}
                tickFormatter={(data) => `${data}`}
              />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "#6b7280", fontSize: 14 }}
                tickFormatter={(value) => value.slice(0, 3)}
              />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent formatter={(completed) => `${completed} Task Completed`} />}
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
        <div className="flex gap-2 leading-none font-medium">
          Trending up by 5.2% this week
          <TrendingUp className="h-4 w-4" />
        </div>
        <div className="text-muted-foreground leading-none">
          Showing total task completions for the last 7 days
        </div>
      </CardFooter>
    </Card>
  )
}
