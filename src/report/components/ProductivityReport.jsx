import { ChevronDown, } from 'lucide-react';
import { TbShare2 } from 'react-icons/tb';
import Heatmap from '../heatmap/Heatmap';
import DateRangePicker from '../components/DateRangePicker';
import { isWithinInterval, parseISO } from 'date-fns';
import { useState } from 'react';
import { useLogs } from '../../dashboard/LogsContext';
import KpiSummary from './KpiSummary';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select"
import { ChartLineDots } from './TaskCompletionChart';
import TaskStatusChart from './TaskStatusChart';
import TopLoggedTasks from './TopLoggedTask';





const ProductivityReport = () => {
  const { logs } = useLogs();

  const [dateRange, setDateRange] = useState({
    from: new Date(2025, 0, 1),
    to: new Date(2025, 11, 31),
  });

  const filteredLogs = logs.filter(log => {
  const logDate = parseISO(log.date);
  return dateRange?.from && dateRange?.to
    ? isWithinInterval(logDate, {
        start: dateRange.from,
        end: dateRange.to,
      })
    : true;
  });
    const selectedYear = dateRange?.from
    ? dateRange.from.getFullYear()
    : new Date().getFullYear();


  const handleDayClick = (dayData) => {
    console.log('Clicked day:', dayData);
  };
  

  return (
    <div className="p-8 min-h-screen max-w-6xl mx-auto font-sans relative">
      
      <div className="mb-8 grid items-center gap-6 sm:grid-cols-1 md:grid-cols-2">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 py-3">Productivity Report</h1>
          <p className="text-gray-500 font-medium mt-1">Generate, view, and export detailed team activity logs.</p>
        </div>
        <div className='flex items-center md:justify-end gap-4 mb-5'>
          <button className='text-lg text-nowrap rounded-lg font-semibold text-gray-400 px-3 py-2 border border-gray-200 flex items-center gap-2 hover:bg-gray-200 hover:shadow-xl'>
            <TbShare2 className='w-6 h-6' strokeWidth={2} /> Export as CSV
          </button>
          <button className='bg-violet-600 text-lg rounded-xl font-semibold text-white px-4 py-2 hover:bg-purple-800 hover:shadow-xl'>
            Generate
          </button>
        </div>
      </div>
{/* Filter Bar (Unchanged) */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-8 ">
        <div className="grid sm:grid-cols-1 md:grid-cols-2 items-center gap-4 bg-gray-50  rounded-xl border border-gray-200">
          {/* Date Range Input Mockup */}
          <div className="flex items-center px-3 py-2">
            <span className="text-sm font-bold text-gray-600 mr-2 ">Date Range</span>
            <div  > 
            
              <DateRangePicker
                value={dateRange}
                onChange={setDateRange}
                toDate={new Date()}
                className = ""

              />

            </div>
          </div>

          {/* Department Dropdown Mockup */}
          <div className="flex items-center px-3 py-2    min-w-45 justify-end">
            <span className="text-sm font-bold text-gray-600 mr-2">Department</span>
            <div className="flex items-center gap-4 ">
              <span className="text-sm text-gray-600 p-1">
                <Select>
                  <SelectTrigger className="w-45 ">
                    <SelectValue placeholder="All Departments" />
                  </SelectTrigger>
                  <SelectContent >
                    <SelectItem value="Software Engineering<">Software Engineering</SelectItem>
                    <SelectItem value="Product Design">Product Design</SelectItem>
                    <SelectItem value="Marketing">Marketing</SelectItem>
                  </SelectContent>
                </Select>
              </span>
            </div>
          </div>
        </div>


        
      </div>
      {/* HEATMAP VISUALIZATION */}
      <Heatmap
        logs={filteredLogs}
        year={selectedYear}
        onDayClick={handleDayClick}
        onDayHover={() => {}}
      />

      {/* KPI Cards */}
      <KpiSummary logs={filteredLogs} /> 
     <div className='mt-10'>
       <ChartLineDots />
     </div>

     <div className='grid grid-cols-1 md:grid-cols-2 items-center gap-6 mt-10'>
      <div className=''>
        <TaskStatusChart />
      </div>

      <div className=''>
        <TopLoggedTasks />
      </div>
     </div>

     
    </div>
  );
};

export default ProductivityReport;