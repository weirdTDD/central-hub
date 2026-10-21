import { useState } from "react";
import { format } from "date-fns";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function keepCalendarOpen(event) {
  const target = event.target;
  if (target instanceof Element && target.closest("[data-slot=select-content]")) {
    event.preventDefault();
  }
}

const DateRangePicker = ({ value, onChange, toDate, className, align = "start" }) => {
  const [open, setOpen] = useState(false);
  const label =
    value?.from && value?.to
      ? `${format(value.from, "MMM d, yyyy")} – ${format(value.to, "MMM d, yyyy")}`
      : "Select date range";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn("h-11 justify-start gap-2 rounded-xl px-3 font-normal", className)}
        >
          <CalendarDays className="text-muted-foreground" />
          <span>{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0"
        align={align}
        collisionPadding={16}
        onInteractOutside={keepCalendarOpen}
        onFocusOutside={keepCalendarOpen}
      >
        <Calendar
          mode="range"
          selected={value}
          captionLayout="dropdown"
          startMonth={new Date(2024, 0)}
          endMonth={toDate ?? new Date(2034, 11)}
          disabled={toDate ? { after: toDate } : undefined}
          onSelect={(range) => {
            onChange(range);
            if (range?.from && range?.to) setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
};

export default DateRangePicker;
