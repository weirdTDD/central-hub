import React from "react";
import ReactECharts from "echarts-for-react";

const TaskStatusChart = () => {

  const option = {
    tooltip: { trigger: "item" },
    legend: {
      orient: "vertical",
      top: "middle",
      right: -5,
      itemGap: 10,
    },
    series: [
      {
        name: "",
        type: "pie",
        center:["29%", "42%"],
        radius: ["41%", "58%"],
        right:10,
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
        fontSize:16,
        fontWeight: "bold",
        data: [
          { value: 30, name: "30 Drafted" },
          { value: 80, name: "80 in Progress" },
          { value: 30, name: "30 completed" },
          { value: 3, name: "3 Launched" },
        ],
      },
    ],
  };

  return (
    <div className="contentContainer border border-gray-200 rounded-xl shadow-xl h-full md:h-90 p-6 hover:border-purple-400">
      <h3 className="text-gray-700 font-semibold text-lg">Task by Status</h3>
      <ReactECharts option={option} style={{ height: 400 }} />
    </div>
  );
};

export default TaskStatusChart;
