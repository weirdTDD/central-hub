import { useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { format } from 'date-fns';
import { CalendarDays } from 'lucide-react';

const DateRangePicker = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 border border-gray-200 rounded-lg bg-white px-3 py-3"
      >
        <span className="text-sm text-gray-700">
          {value?.from && value?.to
            ? `${format(value.from, 'MMM d, yyyy')} – ${format(value.to, 'MMM d, yyyy')}`
            : 'Select date range'}
        </span>
        <CalendarDays className="w-4 h-4 text-gray-700 " />
      </button>

      {open && (
        <div className="absolute z-50 mt-2 bg-white border rounded-xl shadow-lg p-4 ">
          <DayPicker
            mode="range"
            selected={value}
              onSelect={(range) => {
                onChange(range);

                if (range?.from && range?.to) {
                  setOpen(false);
                }
              }}
            captionLayout="dropdown"
            fromYear={2024}
            toYear={2034}
            className=' text-gray-600'
          />
        </div>
      )}
    </div>
  );
};

export default DateRangePicker;
