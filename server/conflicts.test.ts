import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictsForRange } from './conflicts.ts';
import { applySwap, assignRange, mergeContiguous, reassignRange } from './swaps.ts';
import type { MemberAvailability, ShiftAssignment } from './types.ts';

const iso = (wall: string) => new Date(`${wall}:00.000Z`).toISOString();
// Availability keys are "YYYY-MM-DD-<minuteOfDay>", wall clock.
const key = (date: string, hour: number, minute = 0) => `${date}-${hour * 60 + minute}`;

const members: MemberAvailability[] = [
  { memberName: 'Free', availability: {} },
  { memberName: 'Meh', availability: { [key('2026-01-01', 10)]: 'not_preferred' } },
  { memberName: 'Busy', availability: { [key('2026-01-01', 10)]: 'not_preferred', [key('2026-01-01', 11)]: 'unavailable' } },
  { memberName: 'Legacy', availability: { [key('2026-01-01', 9)]: true as unknown as 'unavailable' } },
  { memberName: 'Working', availability: {} },
];
const assignments: ShiftAssignment[] = [
  { memberName: 'Working', start: iso('2026-01-01T11:30'), end: iso('2026-01-01T13:00') },
];

test('conflictsForRange reports the worst problem per person across the range', () => {
  const c = conflictsForRange(members, assignments, iso('2026-01-01T09:00'), iso('2026-01-01T12:00'), 60);
  assert.deepEqual(c, { Free: 'ok', Meh: 'not_preferred', Busy: 'unavailable', Legacy: 'unavailable', Working: 'on_shift' });
});

test('conflictsForRange only looks inside [start, end)', () => {
  const c = conflictsForRange(members, assignments, iso('2026-01-01T12:00'), iso('2026-01-01T13:00'), 60);
  // Busy's unavailable hour is 11:00, Meh's not-preferred is 10:00: both outside.
  assert.equal(c.Busy, 'ok');
  assert.equal(c.Meh, 'ok');
  assert.equal(c.Working, 'on_shift');
  // A shift that ends exactly at the range start is not an overlap.
  const after = conflictsForRange(members, assignments, iso('2026-01-01T13:00'), iso('2026-01-01T14:00'), 60);
  assert.equal(after.Working, 'ok');
});

test('conflictsForRange checks every granularity slot, not just the first', () => {
  const m: MemberAvailability[] = [{ memberName: 'X', availability: { [key('2026-01-01', 9, 45)]: 'unavailable' } }];
  assert.equal(conflictsForRange(m, [], iso('2026-01-01T09:00'), iso('2026-01-01T10:00'), 15).X, 'unavailable');
});

test('reassignRange hands one block to someone and leaves the rest of the shift', () => {
  const shifts: ShiftAssignment[] = [{ memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T12:00') }];
  const r = reassignRange(shifts, 'A', iso('2026-01-01T10:00'), iso('2026-01-01T10:30'), 'B');
  assert.ok(r.ok);
  assert.deepEqual(r.assignments, [
    { memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T10:00') },
    { memberName: 'B', start: iso('2026-01-01T10:00'), end: iso('2026-01-01T10:30') },
    { memberName: 'A', start: iso('2026-01-01T10:30'), end: iso('2026-01-01T12:00') },
  ]);
});

test('reassignRange moves a whole shift', () => {
  const shifts: ShiftAssignment[] = [{ memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T12:00') }];
  const r = reassignRange(shifts, 'A', iso('2026-01-01T09:00'), iso('2026-01-01T12:00'), 'B');
  assert.ok(r.ok);
  assert.deepEqual(r.assignments, [{ memberName: 'B', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T12:00') }]);
});

test('reassignRange rejects stale ranges, self-assignment and empty ranges', () => {
  const shifts: ShiftAssignment[] = [{ memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T12:00') }];
  assert.equal(reassignRange(shifts, 'A', iso('2026-01-01T11:00'), iso('2026-01-01T13:00'), 'B').ok, false);
  assert.equal(reassignRange(shifts, 'A', iso('2026-01-01T09:00'), iso('2026-01-01T10:00'), 'A').ok, false);
  assert.equal(reassignRange(shifts, 'A', iso('2026-01-01T10:00'), iso('2026-01-01T10:00'), 'B').ok, false);
  assert.equal(reassignRange(shifts, 'C', iso('2026-01-01T09:00'), iso('2026-01-01T10:00'), 'B').ok, false);
});

test('mergeContiguous joins back-to-back pieces of the same person only', () => {
  const merged = mergeContiguous([
    { memberName: 'A', start: iso('2026-01-01T12:00'), end: iso('2026-01-01T15:00') },
    { memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T12:00') },
    { memberName: 'B', start: iso('2026-01-01T15:00'), end: iso('2026-01-01T16:00') }, // different person
    { memberName: 'A', start: iso('2026-01-01T16:00'), end: iso('2026-01-01T17:00') }, // gap after 15:00
  ]);
  assert.deepEqual(merged, [
    { memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T15:00') },
    { memberName: 'B', start: iso('2026-01-01T15:00'), end: iso('2026-01-01T16:00') },
    { memberName: 'A', start: iso('2026-01-01T16:00'), end: iso('2026-01-01T17:00') },
  ]);
});

test('reassignRange works across the seam of a 3h-cap split', () => {
  const shifts: ShiftAssignment[] = [
    { memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T12:00') },
    { memberName: 'A', start: iso('2026-01-01T12:00'), end: iso('2026-01-01T15:00') },
  ];
  const r = reassignRange(shifts, 'A', iso('2026-01-01T11:00'), iso('2026-01-01T13:00'), 'B');
  assert.ok(r.ok);
  assert.deepEqual(r.assignments, [
    { memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T11:00') },
    { memberName: 'B', start: iso('2026-01-01T11:00'), end: iso('2026-01-01T13:00') },
    { memberName: 'A', start: iso('2026-01-01T13:00'), end: iso('2026-01-01T15:00') },
  ]);
});

test('a block handed to someone merges into the shift they already had next to it', () => {
  const shifts: ShiftAssignment[] = [
    { memberName: 'B', start: iso('2026-01-01T08:00'), end: iso('2026-01-01T09:00') },
    { memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T12:00') },
  ];
  const r = reassignRange(shifts, 'A', iso('2026-01-01T09:00'), iso('2026-01-01T10:00'), 'B');
  assert.ok(r.ok);
  assert.deepEqual(r.assignments, [
    { memberName: 'B', start: iso('2026-01-01T08:00'), end: iso('2026-01-01T10:00') },
    { memberName: 'A', start: iso('2026-01-01T10:00'), end: iso('2026-01-01T12:00') },
  ]);
});

test('member swaps also accept a range spanning a seam', () => {
  const shifts: ShiftAssignment[] = [
    { memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T12:00') },
    { memberName: 'A', start: iso('2026-01-01T12:00'), end: iso('2026-01-01T15:00') },
  ];
  const r = applySwap(shifts, {
    fromMember: 'A', fromStart: iso('2026-01-01T09:00'), fromEnd: iso('2026-01-01T15:00'),
    toMember: 'B', toStart: null, toEnd: null,
  });
  assert.ok(r.ok);
  assert.deepEqual(r.assignments, [{ memberName: 'B', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T15:00') }]);
});

test('assignRange fills a gap, merging into an adjacent shift of the same person', () => {
  const shifts: ShiftAssignment[] = [{ memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T10:00') }];
  const r = assignRange(shifts, 'A', iso('2026-01-01T10:00'), iso('2026-01-01T11:00'));
  assert.ok(r.ok);
  assert.deepEqual(r.assignments, [{ memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T11:00') }]);

  const r2 = assignRange(shifts, 'B', iso('2026-01-01T09:30'), iso('2026-01-01T10:30'));
  assert.ok(r2.ok);
  assert.equal(r2.assignments.length, 2);
});

test('assign and reassign refuse to double-book someone already on shift', () => {
  const shifts: ShiftAssignment[] = [
    { memberName: 'A', start: iso('2026-01-01T09:00'), end: iso('2026-01-01T12:00') },
    { memberName: 'B', start: iso('2026-01-01T11:00'), end: iso('2026-01-01T13:00') },
  ];
  assert.equal(assignRange(shifts, 'A', iso('2026-01-01T11:30'), iso('2026-01-01T12:30')).ok, false);
  assert.equal(reassignRange(shifts, 'A', iso('2026-01-01T10:00'), iso('2026-01-01T12:00'), 'B').ok, false);
  // Touching end-to-start is fine.
  assert.equal(reassignRange(shifts, 'A', iso('2026-01-01T09:00'), iso('2026-01-01T11:00'), 'B').ok, true);
});
