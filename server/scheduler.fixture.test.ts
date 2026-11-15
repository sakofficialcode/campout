import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSchedule, recomputeUnderstaffed, isNightSlot } from './scheduler.ts';
import type { GroupConfig } from './types.ts';
import { auburnTentingConfig, auburnTentingMembers } from './fixtures/auburn-tenting-availability.ts';

// Regression test over real, messy availability data (12 members, 2.5 days).
// Hand-computing the exact expected schedule isn't practical at that size, so
// this asserts the invariants generateSchedule must uphold instead.

// Assignment timestamps are UTC-anchored, so re-deriving their availability-map
// key must read UTC fields — local getters would shift by the runner's offset.
function slotKey(d: Date): string {
  const dateStr =
    d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  return `${dateStr}-${d.getUTCHours() * 60 + d.getUTCMinutes()}`;
}

test('real-world fixture: tenting sign-up schedule respects recorded availability and shift rules', () => {
  const config: GroupConfig = {
    uuid: 'auburn-tenting',
    groupName: 'Auburn Tenting',
    numMembers: auburnTentingMembers.length,
    coverageStart: null,
    coverageEnd: null,
    coverageUpdatedAt: null,
    ...auburnTentingConfig,
  };

  const result = generateSchedule(config, auburnTentingMembers);
  assert.ok(result.assignments.length > 0);

  const availabilityByName = new Map(auburnTentingMembers.map((m) => [m.memberName, m.availability]));
  const granularityMs = config.timeGranularity * 60_000;
  const maxDayShiftMs = 3 * 60 * 60_000;

  for (const a of result.assignments) {
    const startD = new Date(a.start);
    const endD = new Date(a.end);
    const availability = availabilityByName.get(a.memberName)!;

    let touchesNight = false;
    for (let s = new Date(startD); s < endD; s = new Date(s.getTime() + granularityMs)) {
      assert.notEqual(
        availability[slotKey(s)],
        'unavailable',
        `${a.memberName} scheduled at ${s.toISOString()}, a slot they marked unavailable`
      );
      if (isNightSlot(s, config.nightShiftStart!, config.nightShiftEnd!)) touchesNight = true;
    }

    // Night hours are all-or-nothing (no 3h cap); day-only shifts must respect it.
    if (!touchesNight) {
      assert.ok(
        endD.getTime() - startD.getTime() <= maxDayShiftMs,
        `${a.memberName}'s day shift ${a.start} - ${a.end} exceeds the 3h cap`
      );
    }
  }

  // No member is double-booked.
  const shiftsByMember = new Map<string, { start: Date; end: Date }[]>();
  for (const a of result.assignments) {
    const list = shiftsByMember.get(a.memberName) ?? [];
    list.push({ start: new Date(a.start), end: new Date(a.end) });
    shiftsByMember.set(a.memberName, list);
  }
  for (const [memberName, shifts] of shiftsByMember) {
    shifts.sort((x, y) => x.start.getTime() - y.start.getTime());
    for (let i = 1; i < shifts.length; i++) {
      assert.ok(
        shifts[i].start.getTime() >= shifts[i - 1].end.getTime(),
        `${memberName} has overlapping shifts around ${shifts[i].start.toISOString()}`
      );
    }
  }

  // Understaffed ranges must reflect a genuine, correctly-sized deficit.
  for (const u of result.understaffed) {
    assert.ok(u.filled < u.required, `understaffed range ${u.start}-${u.end} has filled >= required`);
    assert.ok(u.filled >= 0);
  }
});

test('recomputeUnderstaffed reproduces the scheduler\'s own understaffed list', () => {
  const base: GroupConfig = {
    uuid: 'auburn-tenting',
    groupName: 'Auburn Tenting',
    numMembers: auburnTentingMembers.length,
    coverageStart: null,
    coverageEnd: null,
    coverageUpdatedAt: null,
    ...auburnTentingConfig,
  };
  // Same data under a few staffing rules, so night counts and coverage gaps
  // are exercised and the list isn't trivially empty.
  const variants: GroupConfig[] = [
    base,
    { ...base, stdOnShift: 8, nightOnShift: 6 },
    { ...base, stdOnShift: 7, nightOnShift: 5, coverageStart: 18, coverageEnd: 8 },
    { ...base, nightShifts: false, stdOnShift: 9 },
  ];
  let sawUnderstaffed = false;
  for (const config of variants) {
    const result = generateSchedule(config, auburnTentingMembers);
    sawUnderstaffed ||= result.understaffed.length > 0;
    assert.deepEqual(recomputeUnderstaffed(config, result.assignments), result.understaffed);
  }
  assert.ok(sawUnderstaffed, 'at least one variant should be understaffed');
});
