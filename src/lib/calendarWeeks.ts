// Calendar math for the availability grid. Everything here is in the
// browser's local time, matching WeekScheduler's cell keys (see the UTC note
// in server/scheduler.ts: the grid is self-consistent within one browser).
//
// Rule of thumb: an event's start/end are *moments* (often mid-day), while a
// grid column is a whole *day*. Never compare the two directly; use overlap.

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days); // local-time arithmetic, so DST-safe
  return r;
}

// Midnight of the Sunday on or before `d`.
export function sundayOf(d: Date): Date {
  const s = startOfDay(d);
  return addDays(s, -s.getDay());
}

// The last day an event actually touches. An event ending exactly at midnight
// doesn't touch the day that midnight begins.
function lastTouchedInstant(start: Date, end: Date): Date {
  return new Date(Math.max(start.getTime(), end.getTime() - 1));
}

// Number of Sunday-aligned calendar weeks the event touches (always >= 1).
export function countCalendarWeeks(start: Date, end: Date): number {
  const first = sundayOf(start);
  const last = sundayOf(lastTouchedInstant(start, end));
  // Round, not floor: across a DST change the gap is an hour off whole weeks.
  return Math.round((last.getTime() - first.getTime()) / (7 * DAY_MS)) + 1;
}

// Does any part of the calendar day containing `day` fall inside [start, end)?
export function dayOverlapsEvent(day: Date, start: Date, end: Date): boolean {
  const dayStart = startOfDay(day);
  return dayStart < end && addDays(dayStart, 1) > start;
}

// Every calendar day (as local midnight) the event touches, in order.
export function eventDays(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const last = startOfDay(lastTouchedInstant(start, end));
  for (let d = startOfDay(start); d <= last; d = addDays(d, 1)) days.push(d);
  return days;
}

export function toDateStr(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
