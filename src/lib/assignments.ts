import type { ShiftAssignment } from './types';

// Back-to-back pieces of the same person's time are drawn and selected as one
// shift. Must match mergeContiguous in server/swaps.ts, which accepts swaps and
// reassignments on the same merged view — otherwise "Whole shift" here could
// pick a range the server rejects.
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
