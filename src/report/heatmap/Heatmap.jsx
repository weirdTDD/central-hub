
import { useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  durationSecondsOf,
  formatDurationFromSeconds,
  hasRecordedDuration,
} from '../../dashboard/logUtils';
import { hoursGradeFromSeconds, hoursGradeCaption, computeAverageSeconds } from '../../lib/hoursGrade';


// --- 1. Utility: Process Real Data into Heatmap Structure ---
// This function remains the core logic to convert the flat log array into 
// a calendar grid structure that React can easily render.
const processWorkLogs = (logs, year, activityByDate = {}) => {
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
      const tracked = activityByDate[dateStr] ?? null;
      const codingSeconds = positiveSeconds(tracked?.coding);
      const learningSeconds = positiveSeconds(tracked?.learning);

      // Only entries with a recorded duration contribute. A missing duration
      // is missing, not zero. The total is summed from the canonical seconds.
      const logSeconds = hasRealData
        ? dayLogs.reduce(
            (sum, item) => sum + (durationSecondsOf(item) ?? 0),
            0
          )
        : 0;

      // A day can hold log entries without any recorded duration. That is
      // "data present, time unknown" — it must not be painted as activity.
      // Coding and learning seconds are their own records and do paint the day.
      const hasRecordedDurationDay = hasRealData && dayLogs.some(hasRecordedDuration);
      const hasTracked = codingSeconds != null || learningSeconds != null;
      const paintSeconds =
        (hasRecordedDurationDay ? logSeconds : 0) +
        (codingSeconds ?? 0) +
        (learningSeconds ?? 0);

      let level = 0;

      const dayData = {
        level,
        hasData: hasRealData || hasTracked,
        hasRecordedDuration: hasRecordedDurationDay || hasTracked,
        codingSeconds,
        learningSeconds,
        logSeconds: hasRecordedDurationDay ? logSeconds : null,
        paintSeconds,
        date: dateStr,
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
  

  // Compute the average paintSeconds across active days and re-grade each
  // day relative to that average. This makes the color scale adaptive: the
  // highest days always land at level 4 (amber) and the lowest at level 1 (pink)
  // regardless of absolute hours. Days with no data stay at 0 (muted).
  const averageSeconds = computeAverageSeconds(calendarStructure);

  for (const month of calendarStructure) {
    for (const week of month.weeks) {
      for (const day of week) {
        if (day.hasRecordedDuration || day.hasTracked) {
          day.level = Math.max(1, hoursGradeFromSeconds(day.paintSeconds, averageSeconds));
        }
      }
    }
  }

  return calendarStructure.slice(0, 12);
};

// --- 2. Sub-Component: Tooltip Card (Needs to be defined here or imported) ---
const TooltipCard = ({ data, position }) => {
  if (!data || !position || !data.date) return null;
  
  const displayDate = new Date(data.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  // Tooltip for days with no activity
  if (!data.hasData) {
      return (
          <div 
              className="pointer-events-none fixed z-50 rounded-xl border border-border bg-popover p-2 text-xs text-muted-foreground shadow-sm"
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

  const trackedLines = [
    data.codingSeconds != null ? `Coding ${formatDurationFromSeconds(data.codingSeconds)}` : null,
    data.learningSeconds != null ? `Learning ${formatDurationFromSeconds(data.learningSeconds)}` : null,
  ].filter(Boolean);

  if (data.logs.length === 0) {
    return (
      <div
        className="pointer-events-none fixed z-50 w-48 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-sm"
        style={{
          left: position.x,
          top: position.y,
          transform: 'translate(-10%, -110%)'
        }}
      >
        <p className="text-xs font-medium text-muted-foreground">{displayDate}</p>
        <ul className="mt-1 space-y-1 text-xs">
          {trackedLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    );
  }

  // Tooltip for days WITH a work log. Coding and learning stay labeled apart from it.
  const primaryLog = data.logs[0];
  const extraCount = data.logs.length - 1;
  const totalDurationString = data.logSeconds != null
    ? formatDurationFromSeconds(data.logSeconds)
    : "Not recorded";


  return (
    <div 
      className="pointer-events-none fixed z-50 w-64 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-sm"
      style={{ 
        left: position.x, 
        top: position.y,
        transform: 'translate(-10%, -110%)'
      }}
    >
      <div className="flex items-start gap-2 mb-2">
        <img 
          src={primaryLog.user.avatar} 
          alt={primaryLog.user.name} 
          className="w-8 h-8 rounded-full object-cover border border-border"
        />
        <div>
          <h4 className="text-sm font-bold text-foreground leading-tight">{primaryLog.user.name}</h4>
          <p className="text-xs text-muted-foreground">{primaryLog.user.role}</p>
        </div>
        <span className="ml-auto text-xs font-mono bg-muted text-muted-foreground px-2 py-1 rounded">
          {totalDurationString}
        </span>
      </div>
      
      <p className="text-xs text-muted-foreground mb-2 leading-relaxed border-l-2 border-primary pl-2">
        {primaryLog.task}
      </p>

      {extraCount > 0 && (
        <div className="mb-2 text-xs font-medium bg-card-gold/50 px-2 py-1 rounded inline-block">
          + {extraCount} other tasks recorded this day
        </div>
      )}

      {trackedLines.length > 0 ? (
        <ul className="mb-2 space-y-1 text-xs text-muted-foreground">
          {trackedLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center justify-between pt-1 border-t border-border">
        <div className="flex gap-1">
           <svg className="w-3 h-3 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
          <span className="text-xs text-muted-foreground">Edit Log</span>
        </div>
        <span className="text-xs text-muted-foreground font-medium">{displayDate}</span>
      </div>
    </div>
  );
};


// --- 3. The Dedicated Heatmap Component ---
const Heatmap = ({ logs, year, activityByDate = {}, onDayClick, onDayHover }) => {
  
  // Tooltip control
  const [hoveredData, setHoveredData] = useState(null);
  const [hoverPosition, setHoverPosition] = useState(null);

  const scrollContainerRef = useRef(null);

  // Re-process the logs whenever the 'logs' prop changes (e.g., from DateRangePicker)
  const calendarData = useMemo(
    () => processWorkLogs(logs, year, activityByDate),
    [logs, year, activityByDate]
  );

  const averageSeconds = useMemo(
    () => computeAverageSeconds(calendarData),
    [calendarData]
  );

  const scrollLeft = () => scrollContainerRef.current?.scrollBy({ left: -300, behavior: 'smooth' });
  const scrollRight = () => scrollContainerRef.current?.scrollBy({ left: 300, behavior: 'smooth' });

  const getColorClass = (dayData) => {
    if (dayData.hasData && !dayData.hasRecordedDuration) return 'bg-card-gold';
    switch (dayData.level) {
      case 0: return 'bg-muted';
      case 1: return 'bg-heat-1';
      case 2: return 'bg-heat-2';
      case 3: return 'bg-heat-3';
      case 4: return 'bg-heat-4';
      case 5: return 'bg-heat-5';
      case 6: return 'bg-heat-6';
      default: return 'bg-muted';
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

      {/* Legend: blue gradient — light (low) to dark (high),
          thresholds shift with the average so the scale is always relative. */}
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-muted" />
          No activity
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-card-gold" />
          Log entries, no duration recorded
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-heat-1" />
          {hoursGradeCaption(1, averageSeconds) || "Very Low"}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-heat-2" />
          {hoursGradeCaption(2, averageSeconds) || "Low"}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-heat-3" />
          {hoursGradeCaption(3, averageSeconds) || "Below Average"}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-heat-4" />
          {hoursGradeCaption(4, averageSeconds) || "Near Average"}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-heat-5" />
          {hoursGradeCaption(5, averageSeconds) || "Above Average"}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-heat-6" />
          {hoursGradeCaption(6, averageSeconds) || "Peak"}
        </span>
      </div>

      {/* Navigation Arrows & Container */}
      <div className="flex items-center justify-end gap-3 lg:mr-12 mb-3">
        
        <div className="flex gap-2">
          <button 
            onClick={scrollLeft}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-accent"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button 
            onClick={scrollRight}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-accent"
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
                        onClick={() => handleDayClick(dayData)}
                        title={dayData.date ? dayTitle(dayData) : undefined}
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

function dayTitle(dayData) {
  if (!dayData?.date) return undefined;
  const parts = [dayData.date];
  if (dayData.logSeconds != null) parts.push(`work log ${formatDurationFromSeconds(dayData.logSeconds)}`);
  if (dayData.codingSeconds != null) parts.push(`coding ${formatDurationFromSeconds(dayData.codingSeconds)}`);
  if (dayData.learningSeconds != null) parts.push(`learning ${formatDurationFromSeconds(dayData.learningSeconds)}`);
  if (parts.length === 1 && dayData.hasData) parts.push("log entries, duration not recorded");
  return parts.join(", ");
}

function positiveSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds;
}

export default Heatmap;
