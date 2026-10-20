import type {
  AvailabilityMap,
  AvailabilityStatus,
  GroupConfig,
  MemberAvailability,
  ScheduleResult,
  ShiftAssignment,
  UnderstaffedRange,
} from './types.ts';

const MAX_SHIFT_MINUTES = 3 * 60;
const MIN_GAP_MINUTES = 30;
// Someone only relieves a member who's past the cap if they can stay at least
// this long — otherwise it's a 15-minute in-and-out that just fragments both.
const MIN_RELIEF_MINUTES = 60;
// A member this far behind on total hours takes over from whoever's on shift,
// even short of the cap. Wide enough that two people don't trade back and forth.
const FAIRNESS_RELIEF_GAP_MINUTES = 120;
// How long someone past the cap keeps going so a less-loaded member about to
// free up can relieve them, instead of a stand-in who'd then lock that member out.
const MAX_OVERTIME_WAIT_MINUTES = 30;

function toDateStr(d: Date): string {
  return (
    d.getUTCFullYear() +
    '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getUTCDate()).padStart(2, '0')
  );
}

function slotKey(d: Date): string {
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return `${toDateStr(d)}-${minutes}`;
}

function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

// shiftStart/shiftEnd are naive "YYYY-MM-DDTHH:mm" strings (from an
// <input type="datetime-local">) with no zone attached. Parsing them as UTC —
// rather than `new Date(s)`, which resolves against the server's own timezone —
// makes the wall-clock digits round-trip unchanged into the generated ISO
// timestamps, so every viewer sees the same hours. All rendering follows suit.
function parseWallClock(s: string): Date {
  return new Date(`${s}:00.000Z`);
}

// Legacy saved data may still hold a raw boolean (`true` = unavailable);
// normalize it alongside the current 3-state representation.
function getStatus(availability: AvailabilityMap, key: string): AvailabilityStatus {
  const raw = availability[key] as unknown;
  if (raw === true) return 'unavailable';
  if (raw === false || raw === undefined) return 'available';
  return raw as AvailabilityStatus;
}

export function isNightSlot(
  slotStart: Date,
  nightShiftStart: number,
  nightShiftEnd: number
): boolean {
  const hour = slotStart.getUTCHours() + slotStart.getUTCMinutes() / 60;
  return nightShiftStart <= nightShiftEnd
    ? hour >= nightShiftStart && hour < nightShiftEnd
    : hour >= nightShiftStart || hour < nightShiftEnd;
}

interface MemberState {
  memberName: string;
  openStart: Date | null;
  slotsElapsed: number;
  lastSlotEnd: Date | null;
  cooldownUntil: Date | null; // null = never worked yet, i.e. always eligible
  totalMinutesWorked: number; // for fairness: least-loaded-first when starting new shifts
  // Consecutive slots on duty without a break, spanning back-to-back shifts —
  // the 3h cap splits assignments, but someone re-picked at the cap keeps going.
  streakSlots: number;
}

export function generateSchedule(
  config: GroupConfig,
  members: MemberAvailability[]
): ScheduleResult {
  const granularity = config.timeGranularity;
  const maxSlotsPerShift = Math.floor(MAX_SHIFT_MINUTES / granularity);
  const minGapSlots = Math.ceil(MIN_GAP_MINUTES / granularity);
  const minGapMinutes = minGapSlots * granularity;
  const minReliefSlots = Math.ceil(MIN_RELIEF_MINUTES / granularity);
  const maxOvertimeWaitSlots = Math.floor(MAX_OVERTIME_WAIT_MINUTES / granularity);

  const start = parseWallClock(config.shiftStart);
  const end = parseWallClock(config.shiftEnd);

  const states = new Map<string, MemberState>(
    members.map((m) => [
      m.memberName,
      {
        memberName: m.memberName,
        openStart: null,
        slotsElapsed: 0,
        lastSlotEnd: null,
        cooldownUntil: null,
        totalMinutesWorked: 0,
        streakSlots: 0,
      },
    ])
  );
  const availabilityByName = new Map(members.map((m) => [m.memberName, m.availability]));

  // Consecutive workable slots from `fromSlot` (capped at one shift's worth).
  // Breaks load ties so a shift doesn't start with whoever runs out of
  // availability soonest, forcing a handoff someone else could have avoided.
  const workableAheadCount = (memberName: string, fromSlot: Date): number => {
    const availability = availabilityByName.get(memberName)!;
    let count = 0;
    for (
      let s = new Date(fromSlot);
      s < end && count < maxSlotsPerShift;
      s = addMinutes(s, granularity)
    ) {
      if (getStatus(availability, slotKey(s)) === 'unavailable') break;
      count++;
    }
    return count;
  };

  const assignments: ShiftAssignment[] = [];
  const understaffedSlots: UnderstaffedRange[] = [];

  const closeShift = (state: MemberState) => {
    if (state.openStart && state.lastSlotEnd) {
      assignments.push({
        memberName: state.memberName,
        start: state.openStart.toISOString(),
        end: state.lastSlotEnd.toISOString(),
      });
      state.cooldownUntil = addMinutes(state.lastSlotEnd, minGapMinutes);
    }
    state.totalMinutesWorked += state.slotsElapsed * granularity;
    state.openStart = null;
    state.slotsElapsed = 0;
    state.lastSlotEnd = null;
  };

  for (let slotStart = new Date(start); slotStart < end; slotStart = addMinutes(slotStart, granularity)) {
    const slotEnd = addMinutes(slotStart, granularity);
    const key = slotKey(slotStart);

    const isNight =
      config.nightShifts &&
      config.nightShiftStart != null &&
      config.nightShiftEnd != null &&
      isNightSlot(slotStart, config.nightShiftStart, config.nightShiftEnd);

    const required = isNight ? config.nightOnShift ?? config.stdOnShift : config.stdOnShift;
    // Night hours are all-or-nothing: the max-shift cap doesn't apply, so
    // whoever is on covers the whole window instead of handing off mid-night.
    const effectiveMaxSlots = isNight ? Infinity : maxSlotsPerShift;

    const statusByName = new Map(
      members.map((m) => [m.memberName, getStatus(availabilityByName.get(m.memberName)!, key)])
    );
    // Workable = available or not_preferred; unavailable is a hard block.
    const workableNames = new Set(
      [...statusByName.entries()].filter(([, status]) => status !== 'unavailable').map(([name]) => name)
    );

    const continuers = [...states.values()].filter(
      (s) => s.openStart !== null && workableNames.has(s.memberName) && s.slotsElapsed < effectiveMaxSlots
    );

    for (const state of states.values()) {
      if (state.openStart !== null && !continuers.includes(state)) {
        closeShift(state);
      }
    }

    let kept = continuers;
    if (continuers.length > required) {
      // Requirement dropped (e.g. night->day boundary) — keep the longest-running shifts.
      kept = [...continuers].sort((a, b) => b.slotsElapsed - a.slotsElapsed).slice(0, required);
      for (const state of continuers) {
        if (!kept.includes(state)) closeShift(state);
      }
    }

    // Least-worked-so-far first, so hours even out however shift lengths vary.
    const byLoad = (a: MemberState, b: MemberState) => {
      if (a.totalMinutesWorked !== b.totalMinutesWorked) return a.totalMinutesWorked - b.totalMinutesWorked;
      // Equally loaded — prefer whoever can carry the shift furthest.
      const aAhead = workableAheadCount(a.memberName, slotStart);
      const bAhead = workableAheadCount(b.memberName, slotStart);
      if (aAhead !== bAhead) return bAhead - aAhead;
      const at = a.cooldownUntil ? a.cooldownUntil.getTime() : -Infinity;
      const bt = b.cooldownUntil ? b.cooldownUntil.getTime() : -Infinity;
      if (at !== bt) return at - bt;
      return a.memberName.localeCompare(b.memberName);
    };

    const isPreferred = (s: MemberState) => statusByName.get(s.memberName) === 'available';

    const byPreference = (pool: MemberState[]) => {
      const preferred = pool.filter(isPreferred).sort(byLoad);
      const notPreferred = pool.filter((s) => !isPreferred(s)).sort(byLoad);
      return [...preferred, ...notPreferred];
    };

    const isRested = (s: MemberState) => s.cooldownUntil === null || s.cooldownUntil <= slotStart;
    // Already worked a full shift's worth without a break and would keep going.
    const onLongStreak = (s: MemberState) => !isNight && s.streakSlots >= maxSlotsPerShift;
    const canCoverRelief = (s: MemberState) => workableAheadCount(s.memberName, slotStart) >= minReliefSlots;

    const eligible = [...states.values()].filter(
      (s) => s.openStart === null && workableNames.has(s.memberName) && !kept.includes(s)
    );

    const needed = required - kept.length;
    const newlyStarted: MemberState[] = [];
    if (needed > 0) {
      // Rest is the dominant axis, preference only a tiebreak within it: a
      // rested not-preferred member is tried before a preferred one still owed
      // rest. Otherwise someone marked not-preferred for a window could be
      // frozen out entirely by an "available" member cycling through cooldown.
      let ordered = [...byPreference(eligible.filter(isRested)), ...byPreference(eligible.filter((s) => !isRested(s)))];

      // Someone who just hit the cap with no break yet would carry on; only
      // swap them out for someone who can stay a while, not hop in and out.
      if (eligible.some(onLongStreak)) {
        const tooShort = (s: MemberState) => !onLongStreak(s) && !canCoverRelief(s);
        ordered = [...ordered.filter((s) => !tooShort(s)), ...ordered.filter(tooShort)];
      }

      newlyStarted.push(...ordered.slice(0, needed));
    }

    // Relief, checked every slot, by a rested member who can stay a while:
    //  - anyone working past the 3h cap without a break (re-picked at the cap
    //    because nobody else could cover) is handed off right away;
    //  - anyone far ahead on total hours is handed off to someone far behind,
    //    once they've done a decent stint, so a late-available member isn't
    //    shut out just because the people on shift never hit the cap.
    const loadNow = (s: MemberState) => s.totalMinutesWorked + s.slotsElapsed * granularity;
    const relievers = byPreference(
      eligible.filter((s) => !newlyStarted.includes(s) && isRested(s) && canCoverRelief(s))
    );
    // Hold off on a swap if someone with even fewer hours frees up shortly —
    // otherwise the stand-in's own minimum stint would lock that person out
    // (e.g. a 3.5h member subbing in 15 min before a 0h member becomes free).
    // A fairness swap isn't urgent and can wait up to the relief stint; a break
    // for someone past the cap waits only briefly.
    const lessLoadedArrivesSoon = (reliever: MemberState, withinSlots: number) =>
      [...states.values()].some((q) => {
        if (q === reliever || q.openStart !== null || newlyStarted.includes(q)) return false;
        if (loadNow(q) >= loadNow(reliever)) return false;
        const availability = availabilityByName.get(q.memberName)!;
        for (let k = 1; k <= withinSlots; k++) {
          const later = addMinutes(slotStart, k * granularity);
          if (later >= end) return false;
          if (
            getStatus(availability, slotKey(later)) === 'available' &&
            (q.cooldownUntil === null || q.cooldownUntil <= later) &&
            workableAheadCount(q.memberName, later) >= minReliefSlots
          ) {
            return true;
          }
        }
        return false;
      });

    for (const reliever of relievers) {
      const relievable = kept
        .filter(
          (s) =>
            onLongStreak(s) ||
            (!isNight &&
              isPreferred(reliever) &&
              s.slotsElapsed >= minReliefSlots &&
              loadNow(s) - loadNow(reliever) >= FAIRNESS_RELIEF_GAP_MINUTES)
        )
        .sort(
          (a, b) =>
            Number(onLongStreak(b)) - Number(onLongStreak(a)) || b.streakSlots - a.streakSlots || loadNow(b) - loadNow(a)
        );
      if (relievable.length === 0) continue;
      const relieved = relievable[0];
      if (lessLoadedArrivesSoon(reliever, onLongStreak(relieved) ? maxOvertimeWaitSlots : minReliefSlots - 1)) continue;
      closeShift(relieved);
      kept = kept.filter((s) => s !== relieved);
      newlyStarted.push(reliever);
    }

    for (const state of kept) {
      state.slotsElapsed += 1;
      state.lastSlotEnd = slotEnd;
    }
    for (const state of newlyStarted) {
      state.openStart = slotStart;
      state.slotsElapsed = 1;
      state.lastSlotEnd = slotEnd;
    }
    for (const state of states.values()) {
      state.streakSlots = kept.includes(state) || newlyStarted.includes(state) ? state.streakSlots + 1 : 0;
    }

    const filled = kept.length + newlyStarted.length;
    if (filled < required) {
      understaffedSlots.push({
        start: slotStart.toISOString(),
        end: slotEnd.toISOString(),
        required,
        filled,
      });
    }
  }

  for (const state of states.values()) {
    closeShift(state);
  }

  assignments.sort((a, b) => a.start.localeCompare(b.start) || a.memberName.localeCompare(b.memberName));

  const understaffed: UnderstaffedRange[] = [];
  for (const slot of understaffedSlots) {
    const prev = understaffed[understaffed.length - 1];
    if (prev && prev.end === slot.start && prev.required === slot.required && prev.filled === slot.filled) {
      prev.end = slot.end;
    } else {
      understaffed.push({ ...slot });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    assignments,
    understaffed,
  };
}
