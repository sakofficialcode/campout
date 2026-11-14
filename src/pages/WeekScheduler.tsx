import { useState, useRef, useMemo, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import 'gapi-script';
import type { AvailabilityMap, AvailabilityStatus } from '../lib/types';
import { coverageLabel, formatClockHour, isCoveredHour, type Coverage } from '../lib/coverage';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_API_KEY;

const DISCOVERY_DOCS = ['https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'];
const SCOPES = 'https://www.googleapis.com/auth/calendar.events.readonly';

type WeekSchedulerProps = {
  slotMinutes?: 15 | 30 | 60;
  initialAvailability?: AvailabilityMap;
  initialStartDateTime?: string | null;
  initialEndDateTime?: string | null;
  onAvailabilityChange?: (availability: AvailabilityMap) => void;
  onDateRangeChange?: (start: Date | null, end: Date | null) => void;
  readOnly?: boolean;
  nightShifts?: boolean;
  nightShiftStart?: number | null;
  nightShiftEnd?: number | null;
  // Daily window the group is scheduled in; both null = around the clock.
  coverageStart?: number | null;
  coverageEnd?: number | null;
};

function getStatus(availability: AvailabilityMap, key: string): AvailabilityStatus {
  return availability[key] ?? 'available';
}

function isNightHour(hour: number, nightStart: number, nightEnd: number): boolean {
  return nightStart <= nightEnd ? hour >= nightStart && hour < nightEnd : hour >= nightStart || hour < nightEnd;
}

function dateStrOf(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Night hours are all-or-nothing: painting any cell inside a night's window
// snaps every slot in that same night (which may span into the next
// calendar day) to the same status.
function nightBlockKeys(
  dateStr: string,
  minutes: number,
  nightStart: number,
  nightEnd: number,
  slotMinutes: number
): string[] {
  const wrapped = nightStart > nightEnd;
  const [year, month, day] = dateStr.split('-').map(Number);

  // Anchor on the calendar day the night started on — early-morning hours
  // after midnight belong to the night that began the previous day.
  const anchor = new Date(year, month - 1, day);
  if (wrapped && minutes / 60 < nightEnd) {
    anchor.setDate(anchor.getDate() - 1);
  }

  const startMinutes = nightStart * 60;
  const endMinutes = wrapped ? nightEnd * 60 + 24 * 60 : nightEnd * 60;

  const keys: string[] = [];
  for (let m = startMinutes; m < endMinutes; m += slotMinutes) {
    const dayOffset = Math.floor(m / (24 * 60));
    const minuteOfDay = m % (24 * 60);
    const d = new Date(anchor);
    d.setDate(d.getDate() + dayOffset);
    keys.push(`${dateStrOf(d)}-${minuteOfDay}`);
  }
  return keys;
}

const STATUS_LABEL: Record<AvailabilityStatus, string> = {
  available: 'Available',
  not_preferred: 'Not Preferred',
  unavailable: 'Unavailable',
};

const STATUS_CELL_CLASS: Record<AvailabilityStatus, string> = {
  available: 'bg-green-500',
  not_preferred: 'bg-amber-400',
  unavailable: 'bg-red-500',
};

const STATUS_CELL_HOVER_CLASS: Record<AvailabilityStatus, string> = {
  available: 'bg-green-500 hover:bg-green-600 cursor-pointer',
  not_preferred: 'bg-amber-400 hover:bg-amber-500 cursor-pointer',
  unavailable: 'bg-red-500 hover:bg-red-600 cursor-pointer',
};

interface SelectedDate {
  dateStr: string;
  hour: number;
}

interface DayItem {
  name: string;
  dateStr: string;
  date: Date;
}

export default function WeekScheduler({
  slotMinutes = 60,
  initialAvailability = {},
  initialStartDateTime = null,
  initialEndDateTime = null,
  onAvailabilityChange,
  onDateRangeChange,
  readOnly = false,
  nightShifts = false,
  nightShiftStart = null,
  nightShiftEnd = null,
  coverageStart = null,
  coverageEnd = null,
}: WeekSchedulerProps) {
  const coverage: Coverage | null =
    coverageStart != null && coverageEnd != null ? { start: coverageStart, end: coverageEnd } : null;
  const isCoveredMinute = (minutes: number) => isCoveredHour(Math.floor(minutes / 60), coverage);
  // Keys look like "YYYY-MM-DD-<minuteOfDay>".
  const isCoveredKey = (key: string) => isCoveredMinute(Number(key.slice(key.lastIndexOf('-') + 1)));
  const [availability, setAvailability] = useState<AvailabilityMap>(initialAvailability);
  const [isDragging, setIsDragging] = useState(false);
  const [paintMode, setPaintMode] = useState<AvailabilityStatus>('unavailable');
  const [currentWeekOffset, setCurrentWeekOffset] = useState(0);
  const dragStartRef = useRef<SelectedDate | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const tokenClientRef = useRef<ReturnType<typeof window.google.accounts.oauth2.initTokenClient> | null>(null);
  const [gisLoaded, setGisLoaded] = useState(false);

  const getDefaultStart = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today.toISOString().slice(0, 16);
  };

  const getDefaultEnd = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const twoWeeksLater = new Date(today);
    twoWeeksLater.setDate(twoWeeksLater.getDate() + 13);
    twoWeeksLater.setHours(23, 59, 59, 999);
    return twoWeeksLater.toISOString().slice(0, 16);
  };

  const [startDateTime, setStartDateTime] = useState(initialStartDateTime || getDefaultStart());
  const [endDateTime, setEndDateTime] = useState(initialEndDateTime || getDefaultEnd());

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        setGisLoaded(true);
        window.clearInterval(interval);

        tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPES,
          callback: (tokenResponse) => {
            if (!tokenResponse.access_token) return;
            window.gapi.client.setToken({ access_token: tokenResponse.access_token });
            setAuthorized(true);
            fetchEvents();
          },
        });
      }
    }, 50);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!gisLoaded) return;
    window.gapi.load('client', async () => {
      await window.gapi.client.init({
        apiKey: GOOGLE_API_KEY,
        discoveryDocs: DISCOVERY_DOCS,
      });
    });
  }, [gisLoaded]);

  const signIn = () => tokenClientRef.current?.requestAccessToken();

  const fetchEvents = async () => {
    const response = await window.gapi.client.calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date(initialStartDateTime!).toISOString(),
      timeMax: new Date(initialEndDateTime!).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const fetchedEvents = response.result.items || [];

    const googleAvailability: AvailabilityMap = {};

    fetchedEvents.forEach((event) => {
      const eventStart = new Date(event.start!.dateTime!);
      const eventEnd = new Date(event.end!.dateTime!);

      const dayCursor = new Date(eventStart);
      dayCursor.setHours(0, 0, 0, 0);

      while (dayCursor <= eventEnd) {
        const dateStr =
          dayCursor.getFullYear() +
          '-' +
          String(dayCursor.getMonth() + 1).padStart(2, '0') +
          '-' +
          String(dayCursor.getDate()).padStart(2, '0');

        for (let minutes = 0; minutes < 1440; minutes += slotMinutes) {
          const slotStart = new Date(
            dayCursor.getFullYear(),
            dayCursor.getMonth(),
            dayCursor.getDate(),
            Math.floor(minutes / 60),
            minutes % 60,
            0,
            0
          );

          const slotEnd = new Date(slotStart);
          slotEnd.setMinutes(slotEnd.getMinutes() + slotMinutes);

          const overlaps = slotStart < eventEnd && slotEnd > eventStart;

          if (overlaps) {
            googleAvailability[`${dateStr}-${minutes}`] = 'unavailable';
          }
        }

        dayCursor.setDate(dayCursor.getDate() + 1);
      }
    });

    setAvailability((prev) => ({ ...prev, ...googleAvailability }));
  };

  useEffect(() => {
    if (initialAvailability && Object.keys(initialAvailability).length > 0) {
      setAvailability(initialAvailability);
    }
  }, [initialAvailability]);

  useEffect(() => {
    if (initialStartDateTime) {
      setStartDateTime(initialStartDateTime);
    }
  }, [initialStartDateTime]);

  useEffect(() => {
    if (initialEndDateTime) {
      setEndDateTime(initialEndDateTime);
    }
  }, [initialEndDateTime]);

  useEffect(() => {
    onDateRangeChange?.(new Date(startDateTime), new Date(endDateTime));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDateTime, endDateTime]);

  const slotsPerHour = 60 / slotMinutes;
  const totalSlots = 24 * slotsPerHour;

  const rowHeight = Math.max(20, 600 / totalSlots);

  const timeSlots = useMemo(() => {
    return Array.from({ length: (24 * 60) / slotMinutes }, (_, i) => i * slotMinutes);
  }, [slotMinutes]);

  const { totalWeeks, daysInCurrentWeek, weekStartDate } = useMemo(() => {
    const start = new Date(startDateTime);
    const end = new Date(endDateTime);

    const diffMs = end.getTime() - start.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1;
    const weeks = Math.ceil(diffDays / 7);

    const weekStart = new Date(start);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() + currentWeekOffset * 7);

    const daysInWeek = Math.min(7, diffDays - currentWeekOffset * 7);

    return {
      totalDays: diffDays,
      totalWeeks: weeks,
      daysInCurrentWeek: Math.max(0, daysInWeek),
      weekStartDate: weekStart,
    };
  }, [startDateTime, endDateTime, currentWeekOffset]);

  const daysToDisplay = useMemo(() => {
    const days = [];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (let i = 0; i < 7; i++) {
      const date = new Date(weekStartDate);
      date.setDate(date.getDate() + i);

      days.push({
        name: dayNames[date.getDay()],
        date,
        dateStr:
          date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'),
        isInRange: date >= new Date(startDateTime) && date <= new Date(endDateTime),
      });
    }

    return days;
  }, [weekStartDate, startDateTime, endDateTime]);

  const isCellValid = (dateStr: string, minutes: number) => {
    const [year, month, day] = dateStr.split('-').map(Number);
    const cellStart = new Date(year, month - 1, day, 0, minutes, 0, 0); // local time
    const cellEnd = new Date(cellStart);
    cellEnd.setMinutes(cellEnd.getMinutes() + slotMinutes);
    cellEnd.setMilliseconds(cellEnd.getMilliseconds() - 1);

    const start = new Date(startDateTime);
    const end = new Date(endDateTime);

    return cellStart >= start && cellEnd <= end && isCoveredMinute(minutes);
  };

  const getCellKey = (dateStr: string, minutes: number) => `${dateStr}-${minutes}`;

  const formatTime = (minutes: number) => {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const period = h >= 12 ? 'PM' : 'AM';
    const displayHour = h % 12 || 12;

    return `${displayHour}:${m.toString().padStart(2, '0')} ${period}`;
  };

  const groupedSlots = useMemo(() => {
    const map = new Map<number, number[]>();

    timeSlots.forEach((minutes) => {
      if (!isCoveredMinute(minutes)) return;
      const hour = Math.floor(minutes / 60);
      if (!map.has(hour)) map.set(hour, []);
      map.get(hour)!.push(minutes);
    });

    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- coverage is derived from the two props below
  }, [timeSlots, coverageStart, coverageEnd]);

  const updateAvailability = (newAvailability: AvailabilityMap) => {
    setAvailability(newAvailability);
    if (onAvailabilityChange) {
      onAvailabilityChange(newAvailability);
    }
  };

  const paintCell = (dateStr: string, minutes: number) => {
    if (nightShifts && nightShiftStart != null && nightShiftEnd != null && isNightHour(minutes / 60, nightShiftStart, nightShiftEnd)) {
      const keys = nightBlockKeys(dateStr, minutes, nightShiftStart, nightShiftEnd, slotMinutes).filter(isCoveredKey);
      const updates: AvailabilityMap = {};
      for (const k of keys) updates[k] = paintMode;
      updateAvailability({ ...availability, ...updates });
      return;
    }

    const key = getCellKey(dateStr, minutes);
    updateAvailability({ ...availability, [key]: paintMode });
  };

  const handleMouseDown = (dateStr: string, minutes: number) => {
    if (!isCellValid(dateStr, minutes) || readOnly) return;

    setIsDragging(true);
    paintCell(dateStr, minutes);
  };

  const handleMouseEnter = (dateStr: string, minutes: number) => {
    if (!isDragging || !isCellValid(dateStr, minutes) || readOnly) return;

    paintCell(dateStr, minutes);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    dragStartRef.current = null;
  };

  const clearAll = () => {
    updateAvailability({});
  };

  const getStatusCounts = () => {
    let notPreferred = 0;
    let unavailable = 0;
    for (const [key, status] of Object.entries(availability)) {
      if (!isCoveredKey(key)) continue;
      if (status === 'not_preferred') notPreferred += 1;
      else if (status === 'unavailable') unavailable += 1;
    }
    return { notPreferred, unavailable };
  };

  const goToPreviousWeek = () => {
    if (currentWeekOffset > 0) {
      setCurrentWeekOffset((prev) => prev - 1);
    }
  };

  const goToNextWeek = () => {
    if (currentWeekOffset < totalWeeks - 1) {
      setCurrentWeekOffset((prev) => prev + 1);
    }
  };

  const exportToCSV = () => {
    const start = new Date(startDateTime);
    const end = new Date(endDateTime);
    const allDays: DayItem[] = [];

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      allDays.push({
        name: dayNames[d.getDay()],
        dateStr: dateStr,
        date: new Date(d),
      });
    }

    let csv = 'Time,' + allDays.map((d) => `${d.name} (${d.dateStr})`).join(',') + '\n';

    timeSlots.forEach((minutes) => {
      if (!isCoveredMinute(minutes)) return;
      const row = [formatTime(minutes)];

      allDays.forEach((day) => {
        if (isCellValid(day.dateStr, minutes)) {
          const key = getCellKey(day.dateStr, minutes);
          row.push(STATUS_LABEL[getStatus(availability, key)]);
        } else {
          row.push('');
        }
      });

      csv += row.join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scheduler-availability.csv';
    a.click();
    window.URL.revokeObjectURL(url);
  };

  return (
    <div className="p-4" onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
      <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={goToPreviousWeek}
            disabled={currentWeekOffset === 0}
            className="p-2 rounded-md bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <span className="text-sm font-medium text-gray-700">
            Week {currentWeekOffset + 1} of {totalWeeks}
          </span>
          <button
            onClick={goToNextWeek}
            disabled={currentWeekOffset >= totalWeeks - 1}
            className="p-2 rounded-md bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        <div className="flex gap-3 items-center flex-wrap">
          <div className="text-sm text-gray-700">
            <span className="font-semibold">{getStatusCounts().notPreferred}</span> not preferred ·{' '}
            <span className="font-semibold">{getStatusCounts().unavailable}</span> unavailable
          </div>
          {!readOnly && (
            <>
              {!authorized ? (
                <button onClick={signIn} className="ui-btn-secondary text-sm">
                  Import from Google
                </button>
              ) : (
                <button onClick={fetchEvents} className="ui-btn-secondary text-sm">
                  Fetch Events
                </button>
              )}
              <button onClick={exportToCSV} className="ui-btn-primary text-sm">
                Export to CSV
              </button>
              <button onClick={clearAll} className="ui-btn-danger-outline text-sm">
                Clear All
              </button>
            </>
          )}
        </div>
      </div>

      {!readOnly && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm font-medium text-gray-700 mr-1">Paint mode:</span>
          {(['available', 'not_preferred', 'unavailable'] as AvailabilityStatus[]).map((status) => (
            <button
              key={status}
              onClick={() => setPaintMode(status)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                paintMode === status
                  ? `${STATUS_CELL_CLASS[status]} text-white border-transparent`
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {STATUS_LABEL[status]}
            </button>
          ))}
        </div>
      )}

      {daysInCurrentWeek > 0 ? (
        <div className="rounded-md border border-gray-200 overflow-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-gray-50 border border-gray-200 p-3 text-sm font-semibold text-gray-700"></th>
                {daysToDisplay.map((day) => (
                  <th key={day.dateStr} className="bg-gray-50 border border-gray-200 p-3 text-sm font-semibold text-gray-700 min-w-24">
                    <div>{day.name}</div>
                    <div className="text-xs font-normal text-gray-500">{day.dateStr}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from(groupedSlots.entries()).map(([hour, slots], groupIdx, groups) => {
                // An overnight window hides a block in the middle of the day;
                // mark it so the jump from e.g. 7 AM to 6 PM isn't confusing.
                const prevHour = groupIdx > 0 ? groups[groupIdx - 1][0] : null;
                const gap =
                  prevHour !== null && hour > prevHour + 1 ? (
                    <tr key={`gap-${hour}`}>
                      <td
                        colSpan={daysToDisplay.length + 1}
                        className="border border-gray-200 bg-gray-50 px-3 py-1.5 text-center text-xs text-gray-500"
                      >
                        {formatClockHour(prevHour + 1)} – {formatClockHour(hour)} · not scheduled
                      </td>
                    </tr>
                  ) : null;
                return [
                  gap,
                  ...slots.map((minutes, idx) => (
                  <tr key={`${hour}-${minutes}`}>
                    {idx === 0 && (
                      <td
                        rowSpan={slots.length}
                        className="sticky left-0 z-10 bg-gray-50 border border-gray-200 px-2 text-xs text-gray-600 text-right font-medium"
                        style={{ height: `${rowHeight * slots.length}px` }}
                      >
                        {formatTime(hour * 60)}
                      </td>
                    )}

                    {daysToDisplay.map((day) => {
                      const key = getCellKey(day.dateStr, minutes);
                      const status = getStatus(availability, key);
                      const isValid = day.isInRange && isCellValid(day.dateStr, minutes);

                      return (
                        <td
                          key={key}
                          style={{ height: `${rowHeight}px` }}
                          title={STATUS_LABEL[status]}
                          className={`border border-gray-200 h-10 transition-colors select-none ${
                            !isValid ? 'bg-gray-100 cursor-not-allowed' : readOnly ? STATUS_CELL_CLASS[status] : STATUS_CELL_HOVER_CLASS[status]
                          }`}
                          onMouseDown={() => handleMouseDown(day.dateStr, minutes)}
                          onMouseEnter={() => handleMouseEnter(day.dateStr, minutes)}
                        />
                      );
                    })}
                  </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-md border border-gray-200 p-8 text-center text-gray-500">No days to display in this week range.</div>
      )}

      <div className="mt-4 p-4 bg-blue-50 rounded-md border border-blue-200">
        <h3 className="font-semibold text-blue-900 mb-2">Instructions:</h3>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>• Use arrow buttons to navigate between weeks</li>
          {!readOnly && <li>• Pick a paint mode above, then click and drag on cells to mark them</li>}
          {!readOnly && nightShifts && (
            <li>• Night hours are all-or-nothing: clicking any cell in the night window marks the whole night at once</li>
          )}
          {coverage && (
            <li>
              • Only the group's scheduled hours ({coverageLabel(coverage)}) are shown — nobody is put on shift outside them
            </li>
          )}
          <li>• Gray cells are outside the specified time range</li>
          <li>• Green = available, Amber = not preferred, Red = unavailable</li>
          {!readOnly && <li>• Export to CSV downloads only valid time slots within your range</li>}
        </ul>
      </div>
    </div>
  );
}
