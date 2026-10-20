import { useMemo, useRef, useState } from 'react';
import type { ScheduleResult, SwapRequest, UnderstaffedRange } from '../lib/types';
import { getMemberColor, UNDERSTAFFED_COLOR } from '../lib/colors';

// Tall enough that a single 15-minute slot (20px) still fits a one-line label.
const HOUR_HEIGHT_PX = 80;
const DAY_MS = 24 * 60 * 60 * 1000;

// `generatedAt` is a real instant, so it renders in the viewer's local
// timezone — unlike shift/swap times, which are UTC-anchored wall clock.
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Shift/swap timestamps are UTC-anchored wall clock (see server/scheduler.ts's
// parseWallClock), so every member sees the configured hours wherever they are.
function formatShiftDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatTimeOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const displayHour = h % 12 || 12;
  return m === 0 ? `${displayHour} ${period}` : `${displayHour}:${m.toString().padStart(2, '0')} ${period}`;
}

// "2:00 – 2:30 PM", or "11:45 AM – 1:45 PM" when the range crosses noon/midnight.
function formatTimeRange(startMin: number, endMin: number): string {
  const clock = (minutes: number) => {
    const h = Math.floor(minutes / 60) % 24;
    return `${h % 12 || 12}:${(minutes % 60).toString().padStart(2, '0')}`;
  };
  const period = (minutes: number) => (Math.floor(minutes / 60) % 24 >= 12 ? 'PM' : 'AM');
  return period(startMin) === period(endMin)
    ? `${clock(startMin)} – ${clock(endMin)} ${period(endMin)}`
    : `${clock(startMin)} ${period(startMin)} – ${clock(endMin)} ${period(endMin)}`;
}

// Day boundaries and calendar keys read UTC too — local getters would shift
// which calendar day a slot lands on by the viewer's timezone offset.
function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function dateKey(d: Date): string {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Start of the slot `minuteOfDay` minutes into `dayDate` (a UTC midnight);
// setUTCMinutes handles hour/day rollover.
function cellTime(dayDate: Date, minuteOfDay: number): string {
  const d = new Date(dayDate);
  d.setUTCMinutes(minuteOfDay);
  return d.toISOString();
}

function addMinutesIso(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

interface DaySegment {
  key: string;
  startMin: number;
  endMin: number;
  memberName: string;
  assignmentStart: string;
  assignmentEnd: string;
}

interface LaidOutSegment extends DaySegment {
  col: number;
  colCount: number;
}

// Greedy column packing: overlapping events sit side-by-side. `requiredRanges`
// widens a cluster past its occupant count so the understaffed hatch stays
// visible instead of blocks stretching to fill the gap.
function layoutDaySegments(
  segments: DaySegment[],
  requiredRanges: Array<{ startMin: number; endMin: number; required: number }> = []
): LaidOutSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out: LaidOutSegment[] = [];
  let cluster: Array<DaySegment & { col: number }> = [];
  let colEnds: number[] = [];
  let clusterMaxEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    const clusterStart = Math.min(...cluster.map((e) => e.startMin));
    const clusterEnd = Math.max(...cluster.map((e) => e.endMin));
    const naturalColCount = Math.max(...cluster.map((e) => e.col)) + 1;
    const requiredOverlap = requiredRanges
      .filter((r) => r.startMin < clusterEnd && r.endMin > clusterStart)
      .reduce((max, r) => Math.max(max, r.required), 0);
    const colCount = Math.max(naturalColCount, requiredOverlap);
    for (const e of cluster) out.push({ ...e, colCount });
    cluster = [];
    colEnds = [];
    clusterMaxEnd = -Infinity;
  };

  for (const seg of sorted) {
    if (seg.startMin >= clusterMaxEnd) flush();
    let col = colEnds.findIndex((end) => end <= seg.startMin);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(seg.endMin);
    } else {
      colEnds[col] = seg.endMin;
    }
    cluster.push({ ...seg, col });
    clusterMaxEnd = Math.max(clusterMaxEnd, seg.endMin);
  }
  flush();
  return out;
}

// Splits a range into per-day minutes-of-day segments (shifts cross midnight).
function splitByDay(start: string, end: string): Map<string, { startMin: number; endMin: number }> {
  const result = new Map<string, { startMin: number; endMin: number }>();
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (endDate <= startDate) return result;

  let cursor = startOfDay(startDate);
  while (cursor < endDate) {
    const dayEnd = new Date(cursor.getTime() + DAY_MS);
    const segStart = cursor > startDate ? cursor : startDate;
    const segEnd = dayEnd < endDate ? dayEnd : endDate;
    const startMin = (segStart.getTime() - cursor.getTime()) / 60_000;
    const endMin = (segEnd.getTime() - cursor.getTime()) / 60_000;
    if (endMin > startMin) {
      result.set(dateKey(cursor), { startMin, endMin });
    }
    cursor = dayEnd;
  }
  return result;
}

type SelectionSlot = 'from' | 'to';

interface RangeSelection {
  slot: SelectionSlot;
  memberName: string;
  start: string;
  end: string;
}

// Kept in a ref so per-cell mouseenter handlers, reattached every render,
// always see the live drag value.
interface DragInfo {
  slot: SelectionSlot;
  memberName: string;
  assignmentStart: string;
  assignmentEnd: string;
  anchor: string;
  touchedOtherCell: boolean;
}

export interface SwapProposal {
  toMember: string;
  fromStart: string;
  fromEnd: string;
  toStart: string | null;
  toEnd: string | null;
  message: string | null;
}

export interface InteractiveConfig {
  viewerName: string;
  otherMembers: string[];
  snapMinutes: number;
  onSubmit: (proposal: SwapProposal) => Promise<void>;
}

interface ProposalState {
  toMember: string;
  includeReciprocal: boolean;
  message: string;
  submitting: boolean;
  error: string | null;
}

const EMPTY_PROPOSAL: ProposalState = {
  toMember: '',
  includeReciprocal: false,
  message: '',
  submitting: false,
  error: null,
};

interface Props {
  result: ScheduleResult;
  interactive?: InteractiveConfig;
  previewRequest?: SwapRequest | null;
}

export default function ScheduleResults({ result, interactive, previewRequest }: Props) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [selections, setSelections] = useState<Partial<Record<SelectionSlot, RangeSelection>>>({});
  const [proposal, setProposal] = useState<ProposalState>(EMPTY_PROPOSAL);

  const dragRef = useRef<DragInfo | null>(null);
  const snapMinutes = interactive?.snapMinutes ?? 15;

  const memberColor = useMemo(() => {
    const names = [...new Set(result.assignments.map((a) => a.memberName))].sort((a, b) => a.localeCompare(b));
    const map = new Map<string, string>();
    names.forEach((name, i) => map.set(name, getMemberColor(i)));
    return map;
  }, [result.assignments]);

  const { days, segmentsByDay, understaffedByDay, windowStartMin, windowEndMin } = useMemo(() => {
    const dayKeys = new Set<string>();
    let minMinuteOfDay = 24 * 60;
    let maxMinuteOfDay = 0;

    const noteRange = (start: string, end: string) => {
      const segs = splitByDay(start, end);
      for (const [key, { startMin, endMin }] of segs) {
        dayKeys.add(key);
        minMinuteOfDay = Math.min(minMinuteOfDay, startMin);
        maxMinuteOfDay = Math.max(maxMinuteOfDay, endMin);
      }
    };
    for (const a of result.assignments) noteRange(a.start, a.end);
    for (const u of result.understaffed) noteRange(u.start, u.end);

    const sortedKeys = [...dayKeys].sort();
    const days = sortedKeys.map((key) => {
      const [y, m, d] = key.split('-').map(Number);
      return { key, date: new Date(Date.UTC(y, m - 1, d)) };
    });

    const understaffedByDay = new Map<string, Array<{ startMin: number; endMin: number; range: UnderstaffedRange }>>();
    for (const u of result.understaffed) {
      const segs = splitByDay(u.start, u.end);
      for (const [key, { startMin, endMin }] of segs) {
        const list = understaffedByDay.get(key) ?? [];
        list.push({ startMin, endMin, range: u });
        understaffedByDay.set(key, list);
      }
    }

    const segmentsByDay = new Map<string, LaidOutSegment[]>();
    const rawByDay = new Map<string, DaySegment[]>();
    for (const a of result.assignments) {
      const segs = splitByDay(a.start, a.end);
      for (const [key, { startMin, endMin }] of segs) {
        const list = rawByDay.get(key) ?? [];
        list.push({
          key: `${a.memberName}-${a.start}`,
          startMin,
          endMin,
          memberName: a.memberName,
          assignmentStart: a.start,
          assignmentEnd: a.end,
        });
        rawByDay.set(key, list);
      }
    }
    for (const [key, list] of rawByDay) {
      const requiredRanges = (understaffedByDay.get(key) ?? []).map((g) => ({
        startMin: g.startMin,
        endMin: g.endMin,
        required: g.range.required,
      }));
      segmentsByDay.set(key, layoutDaySegments(list, requiredRanges));
    }

    const windowStartMin = dayKeys.size > 0 ? Math.floor(minMinuteOfDay / 60) * 60 : 0;
    const windowEndMin = dayKeys.size > 0 ? Math.min(24 * 60, Math.ceil(maxMinuteOfDay / 60) * 60) : 24 * 60;

    return { days, segmentsByDay, understaffedByDay, windowStartMin, windowEndMin };
  }, [result.assignments, result.understaffed]);

  const workload = useMemo(() => {
    const byMember = new Map<string, { minutes: number; shiftCount: number }>();
    for (const a of result.assignments) {
      const minutes = (new Date(a.end).getTime() - new Date(a.start).getTime()) / 60_000;
      const entry = byMember.get(a.memberName) ?? { minutes: 0, shiftCount: 0 };
      entry.minutes += minutes;
      entry.shiftCount += 1;
      byMember.set(a.memberName, entry);
    }
    return [...byMember.entries()]
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.minutes - a.minutes);
  }, [result.assignments]);

  const targetMinutes = workload.length
    ? workload.reduce((sum, w) => sum + w.minutes, 0) / workload.length
    : 0;
  const maxWorkload = workload[0];
  const minWorkload = workload[workload.length - 1];

  const members = [...memberColor.entries()];
  const windowLength = Math.max(60, windowEndMin - windowStartMin);
  const containerHeight = (windowLength / 60) * HOUR_HEIGHT_PX;
  const hourMarks = useMemo(() => {
    const marks: number[] = [];
    for (let m = windowStartMin; m <= windowEndMin; m += 60) marks.push(m);
    return marks;
  }, [windowStartMin, windowEndMin]);

  const totalWeeks = Math.max(1, Math.ceil(days.length / 7));
  const visibleDays = days.slice(weekOffset * 7, weekOffset * 7 + 7);

  const pctTop = (min: number) => ((min - windowStartMin) / windowLength) * 100;
  const pctHeight = (a: number, b: number) => ((b - a) / windowLength) * 100;

  // Which packed column a range sits in, so overlays match the underlying
  // bar's footprint instead of spanning the day column's full width.
  const findColumn = (dayKey: string, memberName: string, startMin: number, endMin: number) => {
    const owner = (segmentsByDay.get(dayKey) ?? []).find(
      (s) => s.memberName === memberName && s.startMin <= startMin && s.endMin >= endMin
    );
    return { col: owner?.col ?? 0, colCount: owner?.colCount ?? 1 };
  };

  // Overlay boxes for the in-progress swap proposal, drawn on top of the real
  // shift bars. Day-split like assignments so overnight selections span both
  // day columns they touch.
  const overlaysByDay = useMemo(() => {
    const map = new Map<
      string,
      Array<{ slot: SelectionSlot; startMin: number; endMin: number; isFirst: boolean; isLast: boolean; col: number; colCount: number }>
    >();
    (['from', 'to'] as const).forEach((slot) => {
      const sel = selections[slot];
      if (!sel) return;
      const segs = [...splitByDay(sel.start, sel.end)];
      segs.forEach(([dayKey, range], idx) => {
        const { col, colCount } = findColumn(dayKey, sel.memberName, range.startMin, range.endMin);
        const list = map.get(dayKey) ?? [];
        list.push({ slot, ...range, isFirst: idx === 0, isLast: idx === segs.length - 1, col, colCount });
        map.set(dayKey, list);
      });
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selections, segmentsByDay]);

  // Ghost outline for an incoming request hovered in the requests list.
  const previewByDay = useMemo(() => {
    const map = new Map<
      string,
      Array<{ startMin: number; endMin: number; label: string; color: string; col: number; colCount: number }>
    >();
    if (!previewRequest) return map;
    const addRange = (memberName: string, start: string, end: string, label: string, color: string) => {
      for (const [dayKey, range] of splitByDay(start, end)) {
        const { col, colCount } = findColumn(dayKey, memberName, range.startMin, range.endMin);
        const list = map.get(dayKey) ?? [];
        list.push({ ...range, label, color, col, colCount });
        map.set(dayKey, list);
      }
    };
    const toColor = memberColor.get(previewRequest.toMember) ?? getMemberColor(0);
    addRange(previewRequest.fromMember, previewRequest.fromStart, previewRequest.fromEnd, `→ ${previewRequest.toMember}`, toColor);
    if (previewRequest.toStart && previewRequest.toEnd) {
      const fromColor = memberColor.get(previewRequest.fromMember) ?? getMemberColor(0);
      addRange(previewRequest.toMember, previewRequest.toStart, previewRequest.toEnd, `→ ${previewRequest.fromMember}`, fromColor);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRequest, memberColor, segmentsByDay]);

  // Drag-select runs over real per-slot cell elements rather than inferring a
  // time from pixel coordinates, so nothing can drift out of sync.
  const beginCellDrag = (
    slot: SelectionSlot,
    memberName: string,
    assignmentStart: string,
    assignmentEnd: string,
    anchor: string
  ) => {
    dragRef.current = { slot, memberName, assignmentStart, assignmentEnd, anchor, touchedOtherCell: false };
    setSelections((prev) => ({
      ...prev,
      [slot]: { slot, memberName, start: anchor, end: addMinutesIso(anchor, snapMinutes) },
    }));
  };

  const extendCellDrag = (cellStart: string) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (cellStart !== drag.anchor) drag.touchedOtherCell = true;
    const lo = cellStart < drag.anchor ? cellStart : drag.anchor;
    const hiStart = cellStart < drag.anchor ? drag.anchor : cellStart;
    setSelections((prev) => ({
      ...prev,
      [drag.slot]: { slot: drag.slot, memberName: drag.memberName, start: lo, end: addMinutesIso(hiStart, snapMinutes) },
    }));
  };

  // A plain click (no drag to a different cell) proposes the whole shift;
  // dragging is only needed to narrow it.
  const finishDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;

    if (!drag.touchedOtherCell) {
      setSelections((prev) => ({
        ...prev,
        [drag.slot]: { slot: drag.slot, memberName: drag.memberName, start: drag.assignmentStart, end: drag.assignmentEnd },
      }));
    }
  };

  const beginEdgeDrag = (slot: SelectionSlot, edge: 'start' | 'end') => {
    const sel = selections[slot];
    if (!sel) return;
    const seg = findAssignmentFor(sel.memberName, sel.start);
    dragRef.current = {
      slot,
      memberName: sel.memberName,
      assignmentStart: seg?.assignmentStart ?? sel.start,
      assignmentEnd: seg?.assignmentEnd ?? sel.end,
      anchor: edge === 'start' ? addMinutesIso(sel.end, -snapMinutes) : sel.start,
      touchedOtherCell: true, // resizing an existing selection should never "snap to full shift" on release
    };
  };

  // Full (un-clipped) bounds of the assignment a selection belongs to, for the
  // click-expands-to-whole-shift behavior on release.
  const findAssignmentFor = (memberName: string, atIso: string): { assignmentStart: string; assignmentEnd: string } | null => {
    const match = result.assignments.find(
      (a) => a.memberName === memberName && new Date(a.start) <= new Date(atIso) && new Date(a.end) >= new Date(atIso)
    );
    return match ? { assignmentStart: match.start, assignmentEnd: match.end } : null;
  };

  const resetProposal = () => {
    setSelections({});
    setProposal(EMPTY_PROPOSAL);
  };

  const canSubmit = Boolean(selections.from && proposal.toMember && (!proposal.includeReciprocal || selections.to));

  const handleConfirm = async () => {
    if (!interactive || !selections.from || !proposal.toMember) return;
    if (proposal.includeReciprocal && !selections.to) return;

    setProposal((p) => ({ ...p, submitting: true, error: null }));
    try {
      await interactive.onSubmit({
        toMember: proposal.toMember,
        fromStart: selections.from.start,
        fromEnd: selections.from.end,
        toStart: proposal.includeReciprocal && selections.to ? selections.to.start : null,
        toEnd: proposal.includeReciprocal && selections.to ? selections.to.end : null,
        message: proposal.message.trim() || null,
      });
      resetProposal();
    } catch (err) {
      setProposal((p) => ({
        ...p,
        submitting: false,
        error: err instanceof Error ? err.message : 'Failed to submit request',
      }));
    }
  };

  return (
    <div className="mt-6 space-y-6" onMouseUp={finishDrag} onMouseLeave={finishDrag}>
      <h3 className="text-sm font-semibold text-gray-900">Generated {formatDateTime(result.generatedAt)}</h3>

      {workload.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Workload</h3>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-md border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Target per person</p>
              <p className="text-lg font-semibold text-gray-900">{formatHours(targetMinutes)}</p>
            </div>
            <div className="rounded-md border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Most scheduled</p>
              <p className="text-lg font-semibold text-gray-900">{formatHours(maxWorkload.minutes)}</p>
            </div>
            <div className="rounded-md border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Least scheduled</p>
              <p className="text-lg font-semibold text-gray-900">{formatHours(minWorkload.minutes)}</p>
            </div>
          </div>
        </div>
      )}

      {days.length === 0 ? (
        <p className="text-sm text-gray-500">No shifts could be assigned yet.</p>
      ) : (
        <div className="rounded-md border border-gray-200 overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 bg-gray-50 border-b border-gray-200">
            {members.map(([name, color]) => (
              <div key={name} className="flex items-center gap-2">
                <span
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                  style={{ backgroundColor: color }}
                >
                  {initials(name)}
                </span>
                <span className="text-xs font-medium text-gray-800">{name}</span>
              </div>
            ))}
            {result.understaffed.length > 0 && (
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-3 w-3 shrink-0 rounded-sm border"
                  style={{
                    borderColor: UNDERSTAFFED_COLOR,
                    backgroundImage: `repeating-linear-gradient(45deg, ${UNDERSTAFFED_COLOR}55 0, ${UNDERSTAFFED_COLOR}55 2px, transparent 2px, transparent 5px)`,
                  }}
                />
                <span className="text-xs font-medium text-gray-600">Understaffed</span>
              </div>
            )}
            {interactive && (
              <span className="text-xs text-gray-500 italic">Click or drag one of your shifts to propose a swap</span>
            )}
          </div>

          {interactive && selections.from && (
            <div className="space-y-2 border-b border-blue-200 bg-blue-50 px-4 py-3">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <p className="text-xs text-gray-500">Give away</p>
                  <p className="text-sm font-medium text-gray-900">
                    {formatShiftDateTime(selections.from.start)} &ndash; {formatShiftDateTime(selections.from.end)}
                  </p>
                </div>

                <div>
                  <label className="ui-label">Send to</label>
                  <select
                    className="ui-input h-9"
                    value={proposal.toMember}
                    onChange={(e) => {
                      const val = e.target.value;
                      setProposal((p) => ({ ...p, toMember: val }));
                      setSelections((s) => ({ from: s.from }));
                    }}
                  >
                    <option value="" disabled>
                      Select a member
                    </option>
                    {interactive.otherMembers.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="flex items-center gap-2 text-xs text-gray-900 pb-2">
                  <input
                    type="checkbox"
                    checked={proposal.includeReciprocal}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setProposal((p) => ({ ...p, includeReciprocal: checked }));
                      if (!checked) setSelections((s) => ({ from: s.from }));
                    }}
                  />
                  Ask for a shift back
                </label>

                <input
                  type="text"
                  className="ui-input h-9 max-w-[200px]"
                  placeholder="Message (optional)"
                  value={proposal.message}
                  onChange={(e) => setProposal((p) => ({ ...p, message: e.target.value }))}
                />

                <button
                  disabled={!canSubmit || proposal.submitting}
                  onClick={handleConfirm}
                  className="ui-btn-primary h-9 px-4 text-sm"
                >
                  {proposal.submitting ? 'Sending...' : 'Send Request'}
                </button>
                <button onClick={resetProposal} className="ui-btn-secondary h-9 px-3 text-sm">
                  Cancel
                </button>
              </div>

              {proposal.includeReciprocal && (
                <p className="text-xs text-gray-600">
                  {selections.to
                    ? `In return for ${formatShiftDateTime(selections.to.start)} – ${formatShiftDateTime(selections.to.end)}`
                    : proposal.toMember
                      ? `Click one of ${proposal.toMember}'s shifts on the calendar`
                      : 'Pick a member first'}
                </p>
              )}
              {proposal.error && <p className="text-xs text-red-600">{proposal.error}</p>}
            </div>
          )}

          {totalWeeks > 1 && (
            <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200">
              <button
                onClick={() => setWeekOffset((w) => Math.max(0, w - 1))}
                disabled={weekOffset === 0}
                className="px-2 py-1 text-xs rounded border border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                &larr; Prev
              </button>
              <span className="text-xs font-medium text-gray-600">
                Week {weekOffset + 1} of {totalWeeks}
              </span>
              <button
                onClick={() => setWeekOffset((w) => Math.min(totalWeeks - 1, w + 1))}
                disabled={weekOffset >= totalWeeks - 1}
                className="px-2 py-1 text-xs rounded border border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                Next &rarr;
              </button>
            </div>
          )}

          <div className="overflow-x-auto bg-white">
            <div className="flex min-w-full" style={{ minWidth: `${64 + visibleDays.length * 140}px` }}>
              <div className="w-16 shrink-0 border-r border-gray-200">
                <div className="h-12 border-b border-gray-200" />
                <div className="relative" style={{ height: `${containerHeight}px` }}>
                  {hourMarks.map((m) => (
                    <div
                      key={m}
                      className="absolute left-0 right-0 -translate-y-1/2 pr-2 text-right text-[10px] text-gray-500"
                      style={{ top: `${pctTop(m)}%` }}
                    >
                      {formatTimeOfDay(m)}
                    </div>
                  ))}
                </div>
              </div>

              {visibleDays.map((day) => {
                const segs = segmentsByDay.get(day.key) ?? [];
                const gaps = understaffedByDay.get(day.key) ?? [];
                const overlays = overlaysByDay.get(day.key) ?? [];
                const previews = previewByDay.get(day.key) ?? [];
                return (
                  <div key={day.key} className="flex-1 min-w-[140px] border-r border-gray-200 last:border-r-0">
                    <div className="h-12 border-b border-gray-200 flex flex-col items-center justify-center">
                      <span className="text-xs font-semibold text-gray-700">
                        {day.date.toLocaleDateString([], { timeZone: 'UTC', weekday: 'short' })}
                      </span>
                      <span className="text-[10px] text-gray-500">
                        {day.date.toLocaleDateString([], { timeZone: 'UTC', month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                    <div className="relative" style={{ height: `${containerHeight}px` }}>
                      {hourMarks.map((m) => (
                        <div
                          key={m}
                          className="absolute left-0 right-0 border-t border-gray-100"
                          style={{ top: `${pctTop(m)}%` }}
                        />
                      ))}
                      {hourMarks.slice(0, -1).map((m) => (
                        <div
                          key={`half-${m}`}
                          className="absolute left-0 right-0 border-t border-dashed border-gray-100"
                          style={{ top: `${pctTop(m + 30)}%` }}
                        />
                      ))}

                      {gaps.map((gap, idx) => (
                        <div
                          key={idx}
                          title={`Understaffed: ${gap.range.filled}/${gap.range.required} filled`}
                          className="absolute left-0 right-0 rounded-sm"
                          style={{
                            top: `${pctTop(gap.startMin)}%`,
                            height: `${pctHeight(gap.startMin, gap.endMin)}%`,
                            border: `1px solid ${UNDERSTAFFED_COLOR}88`,
                            backgroundImage: `repeating-linear-gradient(45deg, ${UNDERSTAFFED_COLOR}33 0, ${UNDERSTAFFED_COLOR}33 2px, transparent 2px, transparent 6px)`,
                          }}
                        />
                      ))}

                      {segs.map((seg) => {
                        const color = memberColor.get(seg.memberName) ?? getMemberColor(0);
                        const widthPct = 100 / seg.colCount;
                        const fromDraggable = Boolean(interactive && seg.memberName === interactive.viewerName);
                        const toDraggable = Boolean(
                          interactive && proposal.includeReciprocal && proposal.toMember && seg.memberName === proposal.toMember
                        );
                        const draggable = fromDraggable || toDraggable;
                        const slot: SelectionSlot = fromDraggable ? 'from' : 'to';
                        const left = `calc(${seg.col * widthPct}% + 2px)`;
                        const width = `calc(${widthPct}% - 4px)`;

                        const cellMinutes: number[] = [];
                        if (draggable) {
                          for (let m = seg.startMin; m < seg.endMin; m += snapMinutes) cellMinutes.push(m);
                        }

                        const timeRange = formatTimeRange(seg.startMin, seg.endMin);
                        // Exact-length blocks (no minimum height) so a short shift never
                        // spills over the next one; short ones put the times on one line.
                        const blockHeightPx = ((seg.endMin - seg.startMin) / 60) * HOUR_HEIGHT_PX;
                        const twoLine = blockHeightPx >= 36;

                        return (
                          <div key={seg.key}>
                            <div
                              title={`${seg.memberName}: ${timeRange}`}
                              className={`absolute rounded-md px-1.5 overflow-hidden shadow-sm${twoLine ? ' py-1' : ' flex items-center'}${draggable ? ' cursor-crosshair' : ''}`}
                              style={{
                                top: `calc(${pctTop(seg.startMin)}% + 1px)`,
                                height: `calc(${pctHeight(seg.startMin, seg.endMin)}% - 2px)`,
                                left,
                                width,
                                backgroundColor: color,
                              }}
                            >
                              <div className="flex min-w-0 items-center gap-1 text-[11px] font-medium text-white leading-tight">
                                <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-white/25 text-[8px]">
                                  {initials(seg.memberName)}
                                </span>
                                <span className="truncate">{seg.memberName}</span>
                                {!twoLine && <span className="truncate font-normal text-white/90">{timeRange}</span>}
                              </div>
                              {twoLine && (
                                <div className="truncate text-[10px] text-white/90 leading-tight mt-0.5">{timeRange}</div>
                              )}
                            </div>

                            {cellMinutes.map((m) => {
                              const start = cellTime(day.date, m);
                              return (
                                <div
                                  key={`cell-${seg.key}-${m}`}
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    beginCellDrag(slot, seg.memberName, seg.assignmentStart, seg.assignmentEnd, start);
                                  }}
                                  onMouseEnter={() => extendCellDrag(start)}
                                  className="absolute cursor-crosshair"
                                  style={{
                                    top: `${pctTop(m)}%`,
                                    height: `${pctHeight(m, m + snapMinutes)}%`,
                                    left,
                                    width,
                                  }}
                                />
                              );
                            })}
                          </div>
                        );
                      })}

                      {previews.map((p, idx) => {
                        const widthPct = 100 / p.colCount;
                        return (
                          <div
                            key={`preview-${idx}`}
                            className="absolute flex items-start justify-start rounded-md border-2 border-dashed px-1 py-0.5 pointer-events-none"
                            style={{
                              top: `${pctTop(p.startMin)}%`,
                              height: `${pctHeight(p.startMin, p.endMin)}%`,
                              left: `calc(${p.col * widthPct}% + 2px)`,
                              width: `calc(${widthPct}% - 4px)`,
                              borderColor: p.color,
                              backgroundColor: `${p.color}22`,
                            }}
                          >
                            <span className="rounded bg-white/85 px-1 text-[9px] font-semibold" style={{ color: p.color }}>
                              {p.label}
                            </span>
                          </div>
                        );
                      })}

                      {overlays.map((ov, idx) => {
                        const isFrom = ov.slot === 'from';
                        const borderColor = isFrom ? '#2563eb' : '#d97706';
                        const fillColor = isFrom ? 'rgba(37,99,235,0.3)' : 'rgba(217,119,6,0.3)';
                        const widthPct = 100 / ov.colCount;
                        return (
                          <div
                            key={`overlay-${ov.slot}-${idx}`}
                            className="absolute rounded-md pointer-events-none"
                            style={{
                              top: `${pctTop(ov.startMin)}%`,
                              height: `${pctHeight(ov.startMin, ov.endMin)}%`,
                              left: `calc(${ov.col * widthPct}% + 2px)`,
                              width: `calc(${widthPct}% - 4px)`,
                              border: `2px dashed ${borderColor}`,
                              backgroundColor: fillColor,
                            }}
                          >
                            {ov.isFirst && (
                              <div
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  beginEdgeDrag(ov.slot, 'start');
                                }}
                                className="pointer-events-auto absolute -top-1 left-0 right-0 h-2 cursor-ns-resize"
                              />
                            )}
                            {ov.isLast && (
                              <div
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  beginEdgeDrag(ov.slot, 'end');
                                }}
                                className="pointer-events-auto absolute -bottom-1 left-0 right-0 h-2 cursor-ns-resize"
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {result.understaffed.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-red-700 mb-2">Understaffed periods</h3>
          <div className="rounded-md border border-red-200 bg-red-50 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-red-700">
                  <th className="px-4 py-2 font-medium">From</th>
                  <th className="px-4 py-2 font-medium">To</th>
                  <th className="px-4 py-2 font-medium">Needed</th>
                  <th className="px-4 py-2 font-medium">Filled</th>
                </tr>
              </thead>
              <tbody>
                {result.understaffed.map((range, idx) => (
                  <tr key={idx} className="border-t border-red-200">
                    <td className="px-4 py-2 text-red-800">{formatShiftDateTime(range.start)}</td>
                    <td className="px-4 py-2 text-red-800">{formatShiftDateTime(range.end)}</td>
                    <td className="px-4 py-2 text-red-800">{range.required}</td>
                    <td className="px-4 py-2 text-red-800">{range.filled}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
