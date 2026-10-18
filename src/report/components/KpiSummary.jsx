

import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';


import { calculateKPIs } from '../utils/KpiUtils'; 
import { WORK_LOGS } from '../mockData'; 



const KPICard = ({ title, value, subText, trend, trendDirection }) => {
  return (
    <div className="bg-white py-3 px-4 rounded-xl border border-gray-200 shadow-md flex flex-col justify-between min-h-32 hover:border-purple-600 hover:scale-105 transition-all">
      <div>
        <h3 className="text-gray-400 text-sm font-medium mb-1">{title}</h3>
        <div className="text-3xl font-bold text-gray-800 mb-1">
          {value} <span className="text-lg text-gray-400 font-normal">{subText.split(' ')[0] === value ? '' : subText.replace('Total', '').replace('Avg. Daily hours', 'hr').replace('Time Logged', 'hrs').replace('Tasks', '')}</span>
        </div>
        

        <div className="flex items-center justify-between mt-2">
          <div className="text-gray-400 font-medium text-xs text-nowrap">{subText}</div>
          
          <span className={`inline-flex items-center px-3 py-1 rounded-3xl text-xs font-medium gap-2 ${
            trendDirection === 'up'
              ? 'bg-green-200 text-green-700' 
              : 'bg-red-200 text-red-700'
          }`}>
            {trendDirection === 'up' ? <TrendingUp size={14}/> : <TrendingDown size={14} />} {trend}
          </span>
        </div>
      </div>
      
      
    </div>
  );
};


const KpiSummary = ({ logs = WORK_LOGS }) => { 
  const [kpiData, setKpiData] = useState(calculateKPIs(logs));

  useEffect(() => {
    setKpiData(calculateKPIs(logs));
  }, [logs]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <KPICard 
        title="Total Time Logged" 
        value={kpiData.totalTimeLogged} 
        subText="Total Time Logged" 
        trend={kpiData.trendTime} 
        trendDirection={kpiData.trendDirection.totalTimeLogged}
      />
      <KPICard 
        title="Task Completed" 
        value={kpiData.totalTasksCompleted} 
        subText={`of ${kpiData.totalTasks} Tasks`} 
        trend={kpiData.trendTasks} 
        trendDirection={kpiData.trendDirection.totalTasksCompleted}
      />
      <KPICard 
        title="Average Daily Hours" 
        value={kpiData.avgDailyHours} 
        subText="Total Avg. Daily hours" 
        trend={kpiData.trendAvg} 
        trendDirection={kpiData.trendDirection.avgDailyHours}
      />
    </div>
  );
};

export default KpiSummary;