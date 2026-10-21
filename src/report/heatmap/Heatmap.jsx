
import { useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  durationSecondsOf,
  formatDurationFromSeconds,
  hasRecordedDuration,
} from '../../dashboard/logUtils';


// --- 1. Utility: Process Real Data into Heatmap Structure ---
// This function remains the core logic to convert the flat log array into 
// a calendar grid structure that React can easily render.
const processWorkLogs = (logs,year) => {
  // 1. Map logs to dates and aggregate total time
  const logsByDate = logs.reduce((acc, log) => {
    if (!log.date) return acc;
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

      // Only entries with a recorded duration contribute. A missing duration
      // is missing, not zero. The total is summed from the canonical seconds.
      const totalSeconds = hasRealData
        ? dayLogs.reduce(
            (sum, item) => sum + (durationSecondsOf(item) ?? 0),
            0
          )
        : 0;

      // A day can hold log entries without any recorded duration. That is
      // "data present, time unknown" — it must not be painted as activity.
      const hasRecordedDurationDay = hasRealData && dayLogs.some(hasRecordedDuration);

      let level = 0;
      if (hasRecordedDurationDay) {
        // Intensity calculation logic (thresholds in seconds)
        if (totalSeconds > 5 * 3600) level = 4;
        else if (totalSeconds > 3 * 3600) level = 3;
        else if (totalSeconds > 3600) level = 2;
        else level = 1;
      }

      const dayData = {
        level,
        hasData: hasRealData,
        hasRecordedDuration: hasRecordedDurationDay,
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
              className="pointer-events-none fixed z-50 rounded-xl border border-border bg-popover p-2 text-xs text-muted-foreground shadow-md"
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
  const totalDuration = data.logs.reduce(
    (sum, log) => sum + (durationSecondsOf(log) ?? 0),
    0
  );
  const totalDurationString = data.hasRecordedDuration
    ? formatDurationFromSeconds(totalDuration)
    : "Not recorded";


  return (
    <div 
      className="pointer-events-none fixed z-50 w-72 rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
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
          className="w-10 h-10 rounded-full object-cover border border-border"
        />
        <div>
          <h4 className="text-sm font-bold text-gray-800 leading-tight">{primaryLog.user.name}</h4>
          <p className="text-xs text-gray-400">{primaryLog.user.role}</p>
        </div>
        <span className="ml-auto text-xs font-mono bg-gray-50 text-gray-500 px-2 py-1 rounded">
          {totalDurationString}
        </span>
      </div>
      
      <p className="text-xs text-gray-600 mb-3 leading-relaxed border-l-2 border-primary pl-3">
        {primaryLog.task}
      </p>

      {extraCount > 0 && (
        <div className="mb-3 text-xs text-blue-black font-medium bg-blue-100 px-2 py-1 rounded-md inline-block">
          + {extraCount} other tasks recorded this day
        </div>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-border">
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
  
  // Tooltip control
  const [hoveredData, setHoveredData] = useState(null);
  const [hoverPosition, setHoverPosition] = useState(null);

  const scrollContainerRef = useRef(null);

  // Re-process the logs whenever the 'logs' prop changes (e.g., from DateRangePicker)
  const calendarData = useMemo(() => processWorkLogs(logs, year), [logs, year]);

  const scrollLeft = () => scrollContainerRef.current?.scrollBy({ left: -300, behavior: 'smooth' });
  const scrollRight = () => scrollContainerRef.current?.scrollBy({ left: 300, behavior: 'smooth' });

  const getColorClass = (dayData) => {
    // Entries exist but none has a recorded duration: shown in amber so it is
    // distinguishable from recorded activity and from an empty day.
    if (dayData.hasData && !dayData.hasRecordedDuration) return 'bg-amber-200';
    switch (dayData.level) {
      case 0: return 'bg-muted';
      case 1: return 'bg-heat-1';
      case 2: return 'bg-heat-2';
      case 3: return 'bg-heat-3';
      case 4: return 'bg-heat-4';
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

      {/* Legend: distinguishes no activity, activity without duration, and recorded time */}
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-muted" />
          No activity
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-amber-200" />
          Log entries, no duration recorded
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-heat-1" />
          Recorded time
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-heat-4" />
          5h+
        </span>
      </div>

      {/* Navigation Arrows & Container */}
      <div className="flex items-center justify-end gap-4 lg:mr-16 mb-4">
        
        <div className="flex gap-2">
          <button 
            onClick={scrollLeft}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:bg-accent"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button 
            onClick={scrollRight}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:bg-accent"
          >
            <ChevronRight className="h-4 w-4" />
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
              <span className="ml-1 text-xs font-medium text-muted-foreground">{month.name}</span>
              <div className="flex gap-0.5"> 
                {month.weeks.map((week, wIndex) => (
                  <div key={wIndex} className="grid grid-rows-7 gap-0.5">
                    {week.map((dayData, dIndex) => (
                      <div 
                        key={`${mIndex}-${wIndex}-${dIndex}`}
                        onMouseEnter={(e) => handleMouseEnter(dayData, e)}
                        onMouseLeave={handleMouseLeave}
                        onClick={() => handleDayClick(dayData)} // Triggers DayDetailDrawer
                        className={`w-3 h-3 rounded-[2px] ${getColorClass(dayData)} ${dayData.date ? 'hover:opacity-80 cursor-pointer' : ''} transition`}
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