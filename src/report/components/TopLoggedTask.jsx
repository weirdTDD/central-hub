import React, { useMemo } from 'react';
import { getTopLoggedTasks } from '../utils/TaskLogged';
import { WORK_LOGS } from '../mockData';

const TopLoggedTasks = ({ logs = WORK_LOGS }) => {

  const topTasks = useMemo(
    () => getTopLoggedTasks(logs),
    [logs]
  );


  return (
    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-xl h-full md:h-90 flex flex-col hover:border-purple-400">
      <div className="flex justify-between items-center mb-8">
        <h3 className="text-lg font-semibold text-gray-700">
          Top Logged Tasks
        </h3>
        <button className="text-sm font-medium text-violet-400 hover:text-violet-700 hover:-translate-y-1.5 transition-all cursor-pointer">
          View All
        </button>
      </div>

      <div className="grow space-y-8 ">
        {topTasks.length === 0 ? (
          <p className="text-center text-gray-400 py-10">
            No task data available.
          </p>
        ) : (
          topTasks.map(task => (
            <div key={task.id || task.name} className="space-y-2 hover:translate-1.5 transition-all ">
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="text-md font-medium text-gray-600">
                    {task.name}
                  </h4>
                  <p className="text-sm text-gray-400">
                    {task.count} tasks completed
                  </p>
                </div>
                <span className="text-sm font-semibold text-gray-600">
                  {task.formattedTime}
                </span>
              </div>

              <div className="w-full bg-gray-100 h-2 rounded-full overflow-hidden">
                <div
                  className="bg-violet-500 h-full rounded-full transition-[width] duration-1000"
                  style={{
                    width: `${Math.min(100, Math.max(0, task.percentage))}%`
                  }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default TopLoggedTasks;
