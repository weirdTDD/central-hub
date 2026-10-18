
import { useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';


// --- 1. Utility: Process Real Data into Heatmap Structure ---
// This function remains the core logic to convert the flat log array into 
// a calendar grid structure that React can easily render.
const processWorkLogs = (logs,year) => {
  // 1. Map logs to dates and aggregate total time
  const logsByDate = logs.reduce((acc, log) => {
    if (!acc[log.date]) acc[log.date] = [];
    acc[log.date].push(log);
    return acc;
  }, {});

  // 2. Generate a continuous stream of days for the calendar year
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
 
  const calendarStructure = [];

  for (let mIndex = 0; mIndex < 12; mIndex++) {
    const monthName = months[mIndex];
    const daysInMonth = new Date(year, mIndex + 1, 0).getDate();
    const weeks = [];
    let currentWeek = []; 

    const firstDayOfWeek = new Date(year, mIndex, 1).getDay();

    // Fill initial empty slots (padding)
    for (let i = 0; i < firstDayOfWeek; i++) {
        currentWeek.push({ level: 0, hasData: false, date: null, logs: [] });
    }

    // Iterate through all days in the month
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(mIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dayLogs = logsByDate[dateStr];
      const hasRealData = !!dayLogs && dayLogs.length > 0;
      
      let level = 0;
      if (hasRealData) {
        const totalMinutes = dayLogs.reduce((sum, item) => sum + item.timeSpentMinutes, 0);
        // Intensity calculation logic
        if (totalMinutes > 300) level = 4;
        else if (totalMinutes > 180) level = 3; 
        else if (totalMinutes > 60) level = 2;  
        else level = 1;
      } else {
        // Simple random background activity or level 0
        level = Math.random() > 0.9 ? 1 : 0; 
      }
      
      const dayData = {
        level,
        hasData: hasRealData,
        date: dateStr, // Every cell has a date for the hover tooltip
        logs: dayLogs || [] 
      };

      currentWeek.push(dayData);

      // Check if the week is full (7 days)
      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
    }
    
    // Pad the last week
    while (currentWeek.length > 0 && currentWeek.length < 7) {
      currentWeek.push({ level: 0, hasData: false, date: null, logs: [] });
    }
    if (currentWeek.length > 0) {
      weeks.push(currentWeek);
    }
    
    calendarStructure.push({ name: monthName, weeks });
  }

  return calendarStructure.slice(0, 12);
};

// --- 2. Sub-Component: Tooltip Card (Needs to be defined here or imported) ---
const TooltipCard = ({ data, position }) => {
  if (!data || !position || !data.date) return null;
  
  const displayDate = new Date(data.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  // Tooltip for days with no activity
  if (!data.hasData || data.logs.length === 0) {
      return (
          <div 
              className="fixed z-50 bg-white p-2 rounded-lg shadow-md border border-gray-100 text-xs text-gray-500 pointer-events-none"
              style={{ 
                  left: position.x, 
                  top: position.y,
                  transform: 'translate(-50%, -120%)'
              }}
          >
              No activity recorded on {displayDate}.
          </div>
      );
  }

  // Tooltip for days WITH activity
  const primaryLog = data.logs[0]; 
  const extraCount = data.logs.length - 1;
  const totalDuration = data.logs.reduce((sum, log) => sum + log.timeSpentMinutes, 0);
  const hours = Math.floor(totalDuration / 60);
  const minutes = totalDuration % 60;
  const totalDurationString = `${hours > 0 ? `${hours}h ` : ''}${minutes > 0 ? `${minutes}m` : ''}`.trim();


  return (
    <div 
      className="fixed z-50 bg-white p-4 rounded-xl shadow-xl border border-gray-100 w-72 pointer-events-none transition-opacity duration-200"
      style={{ 
        left: position.x, 
        top: position.y,
        transform: 'translate(-10%, -110%)'
      }}
    >
      <div className="flex items-start gap-3 mb-3">
        <img 
          src={primaryLog.user.avatar} 
          alt={primaryLog.user.name} 
          className="w-10 h-10 rounded-full object-cover border border-gray-200"
        />
        <div>
          <h4 className="text-sm font-bold text-gray-800 leading-tight">{primaryLog.user.name}</h4>
          <p className="text-xs text-gray-400">{primaryLog.user.role}</p>
        </div>
        <span className="ml-auto text-xs font-mono bg-gray-50 text-gray-500 px-2 py-1 rounded">
          {totalDurationString}
        </span>
      </div>
      
      <p className="text-xs text-gray-600 mb-3 leading-relaxed border-l-2 border-purple-500 pl-3">
        {primaryLog.task}
      </p>

      {extraCount > 0 && (
        <div className="mb-3 text-xs text-purple-600 font-medium bg-purple-50 px-2 py-1 rounded-md inline-block">
          + {extraCount} other tasks recorded this day
        </div>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-gray-50">
        <div className="flex gap-2">
           <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
           <span className="text-xs text-gray-400">Edit Log</span>
        </div>
        <span className="text-xs text-gray-400 font-medium">{displayDate}</span>
      </div>
    </div>
  );
};


// --- 3. The Dedicated Heatmap Component ---
const Heatmap = ({ logs, year, onDayClick, onDayHover }) => {
  
  // State for the calendar grid structure
  const [calendarData, setCalendarData] = useState([]);
  
  // State for Tooltip control
  const [hoveredData, setHoveredData] = useState(null);
  const [hoverPosition, setHoverPosition] = useState(null);

  const scrollContainerRef = useRef(null);

  // Re-process the logs whenever the 'logs' prop changes (e.g., from DateRangePicker)
  useEffect(() => {
    const processedData = processWorkLogs(logs, year);
    setCalendarData(processedData);
  }, [logs, year]);

  const scrollLeft = () => scrollContainerRef.current?.scrollBy({ left: -300, behavior: 'smooth' });
  const scrollRight = () => scrollContainerRef.current?.scrollBy({ left: 300, behavior: 'smooth' });

  const getColorClass = (level) => {
    switch (level) {
      case 0: return 'bg-gray-200';
      case 1: return 'bg-green-200';
      case 2: return 'bg-green-300';
      case 3: return 'bg-green-400';
      case 4: return 'bg-green-600';
      default: return 'bg-gray-100';
    }
  };

  const handleMouseEnter = (dayData, e) => {
    if (!dayData.date) return; 
    
    const rect = e.target.getBoundingClientRect();
    setHoverPosition({ x: rect.left + (rect.width / 2), y: rect.top });
    setHoveredData(dayData);
    
    // Call the parent's onDayHover prop if needed
    onDayHover(dayData); 
  };

  const handleMouseLeave = () => {
    setHoveredData(null);
    onDayHover(null); 
  };
  
  const handleDayClick = (dayData) => {
    if (dayData.date) {
      // Pass the full day data back up to the parent component
      onDayClick(dayData); 
    }
  };


  return (
    <>
      {/* TOOLTIP COMPONENT (Renders fixed above the component) */}
      <TooltipCard data={hoveredData} position={hoverPosition} />

      {/* Navigation Arrows & Container */}
      <div className="flex items-center justify-end gap-4 lg:mr-16 mb-4">
        
        <div className="flex gap-2">
          <button 
            onClick={scrollLeft}
            className="w-8 h-8 rounded-full bg-gray-100 border border-gray-300 flex items-center justify-center hover:bg-gray-200 transition active:scale-95"
          >
            <ChevronLeft className="w-4 h-4 text-gray-400 hover:text-gray-700" />
          </button>
          <button 
            onClick={scrollRight}
            className="w-8 h-8 rounded-full bg-gray-100 border border-gray-300 flex items-center justify-center hover:bg-gray-200 transition active:scale-95"
          >
            <ChevronRight className="w-4 h-4 text-gray-400 group-hover:text-gray-700" />
          </button>
        </div>
      </div>

      {/* HEATMAP VISUALIZATION */}
      <div 
        ref={scrollContainerRef}
        className="mb-10 overflow-hidden pb-4 scroll-smooth" // Use overflow-x-scroll instead of hidden
      >
        <div className="flex gap-4 min-w-max">
          {calendarData.map((month, mIndex) => (
            <div key={mIndex} className="flex flex-col gap-2">
              <span className="text-xs text-gray-500 font-medium ml-1">{month.name}</span>
              <div className="flex gap-0.5"> 
                {month.weeks.map((week, wIndex) => (
                  <div key={wIndex} className="grid grid-rows-7 gap-0.5">
                    {week.map((dayData, dIndex) => (
                      <div 
                        key={`${mIndex}-${wIndex}-${dIndex}`}
                        onMouseEnter={(e) => handleMouseEnter(dayData, e)}
                        onMouseLeave={handleMouseLeave}
                        onClick={() => handleDayClick(dayData)} // Triggers DayDetailDrawer
                        className={`w-3 h-3 rounded-[2px] ${getColorClass(dayData.level)} ${dayData.date ? 'hover:opacity-80 cursor-pointer' : ''} transition`}
                      ></div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

export default Heatmap;