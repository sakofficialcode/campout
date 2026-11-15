import type { ShiftAssignment } from './types.ts';

// Back-to-back pieces of the same person's time are one shift as far as
// anyone can tell (the scheduler splits at its 3h cap; edits leave seams), so
// merge them. Must match src/lib/assignments.ts, which the UI draws with —
// otherwise a range the UI shows as one shift would be rejected here.
export function mergeContiguous(assignments: ShiftAssignment[]): ShiftAssignment[] {
  const sorted = [...assignments].sort(
    (a, b) => a.memberName.localeCompare(b.memberName) || a.start.localeCompare(b.start)
  );
  const merged: ShiftAssignment[] = [];
  for (const a of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.memberName === a.memberName && Date.parse(prev.end) >= Date.parse(a.start)) {
      if (Date.parse(a.end) > Date.parse(prev.end)) prev.end = a.end;
    } else {
      merged.push({ ...a });
    }
  }
  return merged.sort((a, b) => a.start.localeCompare(b.start) || a.memberName.localeCompare(b.memberName));
}

// Reassigns [rangeStart, rangeEnd) from whichever of `memberName`'s
// assignments fully contains it to `newOwner`, splitting that assignment
// into up to three pieces so the parts outside the range stay put.
function carveRange(
  assignments: ShiftAssignment[],
  memberName: string,
  rangeStart: string,
  rangeEnd: string,
  newOwner: string
): ShiftAssignment[] | null {
  const rangeStartMs = new Date(rangeStart).getTime();
  const rangeEndMs = new Date(rangeEnd).getTime();
  // A range may span seams between back-to-back pieces of one shift.
  assignments = mergeContiguous(assignments);

  const index = assignments.findIndex(
    (a) =>
      a.memberName === memberName &&
      new Date(a.start).getTime() <= rangeStartMs &&
      new Date(a.end).getTime() >= rangeEndMs
  );
  if (index === -1) return null;

  const original = assignments[index];
  const pieces: ShiftAssignment[] = [];
  if (new Date(original.start).getTime() < rangeStartMs) {
    pieces.push({ memberName, start: original.start, end: rangeStart });
  }
  pieces.push({ memberName: newOwner, start: rangeStart, end: rangeEnd });
  if (rangeEndMs < new Date(original.end).getTime()) {
    pieces.push({ memberName, start: rangeEnd, end: original.end });
  }

  const next = [...assignments];
  next.splice(index, 1, ...pieces);
  // The new owner's block may butt up against a shift they already had.
  return mergeContiguous(next);
}

function overlapsOwnShift(assignments: ShiftAssignment[], member: string, start: string, end: string): boolean {
  const s = Date.parse(start);
  const e = Date.parse(end);
  return assignments.some((a) => a.memberName === member && Date.parse(a.start) < e && Date.parse(a.end) > s);
}

// Admin fill: put toMember on [start, end), e.g. to cover an understaffed gap.
// Refuses to double-book them — that adds no coverage, it just hides a gap.
export function assignRange(
  assignments: ShiftAssignment[],
  toMember: string,
  start: string,
  end: string
): ApplySwapResult {
  if (!(Date.parse(start) < Date.parse(end))) return { ok: false, error: 'Pick a time range to assign' };
  if (overlapsOwnShift(assignments, toMember, start, end)) {
    return { ok: false, error: `${toMember} is already on shift during part of that time` };
  }
  return { ok: true, assignments: mergeContiguous([...assignments, { memberName: toMember, start, end }]) };
}

// Admin reassignment: hand [start, end) of fromMember's shift to toMember
// directly. Same carving as a swap, so the rest of the shift stays put.
export function reassignRange(
  assignments: ShiftAssignment[],
  fromMember: string,
  start: string,
  end: string,
  toMember: string
): ApplySwapResult {
  if (fromMember === toMember) return { ok: false, error: 'That shift already belongs to them' };
  if (!(Date.parse(start) < Date.parse(end))) return { ok: false, error: 'Pick a time range to reassign' };
  if (overlapsOwnShift(assignments, toMember, start, end)) {
    return { ok: false, error: `${toMember} is already on shift during part of that time` };
  }
  const next = carveRange(assignments, fromMember, start, end, toMember);
  if (!next) return { ok: false, error: `${fromMember}'s shift no longer covers that time range` };
  return {
    ok: true,
    assignments: next.sort((a, b) => a.start.localeCompare(b.start) || a.memberName.localeCompare(b.memberName)),
  };
}

export interface SwapInput {
  fromMember: string;
  fromStart: string;
  fromEnd: string;
  toMember: string;
  toStart: string | null;
  toEnd: string | null;
}

export type ApplySwapResult =
  | { ok: true; assignments: ShiftAssignment[] }
  | { ok: false; error: string };

// Hands fromMember's [fromStart, fromEnd) slice to toMember, and — if a
// reciprocal range is given — toMember's slice back. Both carves must succeed
// or neither applies, so a stale request can't leave the schedule half-swapped.
export function applySwap(assignments: ShiftAssignment[], swap: SwapInput): ApplySwapResult {
  const afterFrom = carveRange(assignments, swap.fromMember, swap.fromStart, swap.fromEnd, swap.toMember);
  if (!afterFrom) {
    return { ok: false, error: `${swap.fromMember}'s shift no longer covers that time range` };
  }

  if (!swap.toStart || !swap.toEnd) {
    return { ok: true, assignments: afterFrom };
  }

  const afterTo = carveRange(afterFrom, swap.toMember, swap.toStart, swap.toEnd, swap.fromMember);
  if (!afterTo) {
    return { ok: false, error: `${swap.toMember}'s shift no longer covers that time range` };
  }

  return { ok: true, assignments: afterTo };
}
