import { getStatus, slotKey } from './scheduler.ts';
import type { MemberAvailability, ShiftAssignment } from './types.ts';

// Worst-first: a picker shows the most serious problem for each person.
//  - on_shift:      already assigned somewhere in the range (would be double-booked)
//  - unavailable:   marked unavailable for at least one slot in the range
//  - not_preferred: marked not-preferred for at least one slot (but never unavailable)
//  - ok:            free and available for the whole range
export type ConflictStatus = 'on_shift' | 'unavailable' | 'not_preferred' | 'ok';

const SEVERITY: Record<ConflictStatus, number> = { ok: 0, not_preferred: 1, unavailable: 2, on_shift: 3 };

export function worse(a: ConflictStatus, b: ConflictStatus): ConflictStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

// Only the per-person verdict leaves the server — never the availability map
// itself — so members can see "Bob can't do that" without seeing Bob's week.
export function conflictsForRange(
  members: MemberAvailability[],
  assignments: ShiftAssignment[],
  start: string,
  end: string,
  granularityMinutes: number
): Record<string, ConflictStatus> {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const result: Record<string, ConflictStatus> = {};

  for (const member of members) {
    let status: ConflictStatus = 'ok';

    const overlapsShift = assignments.some(
      (a) => a.memberName === member.memberName && Date.parse(a.start) < endMs && Date.parse(a.end) > startMs
    );
    if (overlapsShift) status = 'on_shift';

    for (let t = startMs; t < endMs && status !== 'on_shift' && status !== 'unavailable'; t += granularityMinutes * 60_000) {
      const slot = getStatus(member.availability, slotKey(new Date(t)));
      if (slot === 'unavailable') status = worse(status, 'unavailable');
      else if (slot === 'not_preferred') status = worse(status, 'not_preferred');
    }

    result[member.memberName] = status;
  }

  return result;
}
