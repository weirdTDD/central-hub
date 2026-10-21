import { useState } from "react";
import { format } from "date-fns";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

function parseCivil(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined;
  }
  return date;
}

function toCivil(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * A single civil date, chosen from the rounded calendar.
 *
 * The value stays 'YYYY-MM-DD'. An empty string means no date.
 */
export function DateField({ id, value, onChange, placeholder = "Pick a date" }) {
  const [open, setOpen] = useState(false);
  const selected = parseCivil(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          className="h-11 w-full justify-between rounded-xl px-3 font-normal"
        >
          {selected ? format(selected, "MMM d, yyyy") : <span className="text-muted-foreground">{placeholder}</span>}
          <CalendarDays className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" collisionPadding={16}>
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) => {
            onChange(date ? toCivil(date) : "");
            if (date) setOpen(false);
          }}
        />
        {selected ? (
          <div className="border-t border-border px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              className="h-11 w-full rounded-xl"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Clear date
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
