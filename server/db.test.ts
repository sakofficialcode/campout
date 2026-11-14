// Exercises the Postgres-backed db.ts against the real DATABASE_URL (a Neon
// dev branch). Run with:
//   npm run test:db
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptSwapRequest,
  authenticateMember,
  closeDb,
  createGroup,
  createSwapRequest,
  getAdminPasswordHash,
  getGroup,
  getMemberSummaries,
  getMembersForGroup,
  getSchedule,
  getSwapRequest,
  getSwapRequestsForMember,
  memberExists,
  removeMember,
  saveMemberAvailability,
  saveSchedule,
  setSwapRequestStatus,
  updateGroupCoverage,
  updateGroupSize,
  verifyMemberPassword,
} from './db.ts';
import type { CreateGroupPayload, ScheduleResult } from './types.ts';

after(async () => {
  await closeDb();
});

function testGroupPayload(overrides: Partial<CreateGroupPayload> = {}): CreateGroupPayload {
  return {
    groupName: 'db.test.ts fixture group',
    numMembers: 2,
    shiftStart: '2026-01-01T00:00',
    shiftEnd: '2026-01-02T00:00',
    stdOnShift: 1,
    timeGranularity: 60,
    nightShifts: false,
    adminPassword: null,
    ...overrides,
  };
}

function testSchedule(overrides: Partial<ScheduleResult> = {}): ScheduleResult {
  return {
    generatedAt: new Date().toISOString(),
    assignments: [],
    understaffed: [],
    ...overrides,
  };
}

test('createGroup + getGroup round trip preserves all fields', async () => {
  const uuid = await createGroup(
    testGroupPayload({ nightShifts: true, nightShiftStart: 22, nightShiftEnd: 6, nightOnShift: 1 })
  );
  const group = await getGroup(uuid);

  assert.ok(group);
  assert.equal(group.uuid, uuid);
  assert.equal(group.groupName, 'db.test.ts fixture group');
  assert.equal(group.nightShifts, true);
  assert.equal(group.nightShiftStart, 22);
});

test('admin password hash is stored and reported via getAdminPasswordHash', async () => {
  const uuid = await createGroup(testGroupPayload({ adminPassword: 'admin-secret' }));
  const hash = await getAdminPasswordHash(uuid);
  assert.ok(hash && hash.includes(':'));

  const noPasswordUuid = await createGroup(testGroupPayload());
  assert.equal(await getAdminPasswordHash(noPasswordUuid), null);
});

test('saveMemberAvailability creates a new member, then updates with the correct password', async () => {
  const uuid = await createGroup(testGroupPayload());

  const created = await saveMemberAvailability(uuid, 'Alice', 'alice-pw', { '2026-01-01T00:00': 'available' });
  assert.equal(created.status, 'ok');
  assert.equal(created.status === 'ok' && created.created, true);

  const updated = await saveMemberAvailability(uuid, 'Alice', 'alice-pw', { '2026-01-01T00:00': 'unavailable' });
  assert.equal(updated.status, 'ok');
  assert.equal(updated.status === 'ok' && updated.created, false);

  const wrongPassword = await saveMemberAvailability(uuid, 'Alice', 'wrong-pw', {});
  assert.equal(wrongPassword.status, 'invalid_password');

  const [members, summaries, auth] = await Promise.all([
    getMembersForGroup(uuid),
    getMemberSummaries(uuid),
    authenticateMember(uuid, 'Alice', 'alice-pw'),
  ]);
  assert.deepEqual(members, [{ memberName: 'Alice', availability: { '2026-01-01T00:00': 'unavailable' } }]);
  assert.equal(summaries.length, 1);
  assert.equal(auth.status, 'ok');
  assert.ok(await verifyMemberPassword(uuid, 'Alice', 'alice-pw'));
  assert.ok(await memberExists(uuid, 'Alice'));
  assert.equal(await memberExists(uuid, 'Nobody'), false);
});

test('saveSchedule + getSchedule round-trips a jsonb schedule', async () => {
  const uuid = await createGroup(testGroupPayload());
  const schedule = testSchedule({
    assignments: [{ memberName: 'Alice', start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T03:00:00.000Z' }],
  });

  await saveSchedule(uuid, schedule);
  assert.deepEqual(await getSchedule(uuid), schedule);

  const updated = testSchedule({ understaffed: [{ start: 'x', end: 'y', required: 2, filled: 1 }] });
  await saveSchedule(uuid, updated);
  assert.deepEqual(await getSchedule(uuid), updated);
});

test('swap request lifecycle: create, list, decline', async () => {
  const uuid = await createGroup(testGroupPayload());
  await saveMemberAvailability(uuid, 'Alice', 'pw', {});
  await saveMemberAvailability(uuid, 'Bob', 'pw', {});

  const swap = await createSwapRequest(uuid, {
    fromMember: 'Alice',
    toMember: 'Bob',
    fromStart: '2026-01-01T00:00:00.000Z',
    fromEnd: '2026-01-01T03:00:00.000Z',
    toStart: null,
    toEnd: null,
    message: null,
  });
  assert.equal(swap.status, 'pending');
  assert.deepEqual(await getSwapRequest(uuid, swap.id), swap);

  const { incoming, outgoing } = await getSwapRequestsForMember(uuid, 'Bob');
  assert.equal(incoming.length, 1);
  assert.equal(outgoing.length, 0);

  await setSwapRequestStatus(uuid, swap.id, 'declined');
  const declined = await getSwapRequest(uuid, swap.id);
  assert.equal(declined?.status, 'declined');
  assert.ok(declined?.respondedAt);
});

test('race #1: two concurrent first-time saves for the same member never throw, exactly one creates', async () => {
  const uuid = await createGroup(testGroupPayload());

  const [a, b] = await Promise.all([
    saveMemberAvailability(uuid, 'RaceMember', 'pw-a', { slot: 'available' }),
    saveMemberAvailability(uuid, 'RaceMember', 'pw-b', { slot: 'unavailable' }),
  ]);

  const results = [a, b];
  const createdCount = results.filter((r) => r.status === 'ok' && r.created).length;
  // The loser finds the winner's row; the passwords differ, so it reports
  // invalid_password rather than throwing a UNIQUE-constraint violation.
  const invalidCount = results.filter((r) => r.status === 'invalid_password').length;

  assert.equal(createdCount, 1);
  assert.equal(invalidCount, 1);
});

test('race #2: two concurrent accepts on the same swap request resolve to exactly one winner', async () => {
  const uuid = await createGroup(testGroupPayload());
  await saveMemberAvailability(uuid, 'Alice', 'pw', {});
  await saveMemberAvailability(uuid, 'Bob', 'pw', {});
  await saveSchedule(
    uuid,
    testSchedule({
      assignments: [{ memberName: 'Alice', start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T03:00:00.000Z' }],
    })
  );

  const swap = await createSwapRequest(uuid, {
    fromMember: 'Alice',
    toMember: 'Bob',
    fromStart: '2026-01-01T00:00:00.000Z',
    fromEnd: '2026-01-01T03:00:00.000Z',
    toStart: null,
    toEnd: null,
    message: null,
  });

  const compute = (schedule: ScheduleResult) => ({ ok: true as const, schedule });

  const [first, second] = await Promise.all([
    acceptSwapRequest(uuid, swap.id, 'Bob', compute),
    acceptSwapRequest(uuid, swap.id, 'Bob', compute),
  ]);

  const outcomes = [first, second];
  assert.equal(outcomes.filter((o) => o.status === 'ok').length, 1);
  assert.equal(outcomes.filter((o) => o.status === 'conflict').length, 1);

  const final = await getSwapRequest(uuid, swap.id);
  assert.equal(final?.status, 'accepted');
});

test('a full group rejects new members but still lets existing ones update', async () => {
  const uuid = await createGroup(testGroupPayload({ numMembers: 2 }));
  await saveMemberAvailability(uuid, 'Alice', 'pw', {});
  await saveMemberAvailability(uuid, 'Bob', 'pw', {});

  const third = await saveMemberAvailability(uuid, 'Carol', 'pw', {});
  assert.deepEqual(third, { status: 'group_full', numMembers: 2 });
  assert.equal(await memberExists(uuid, 'Carol'), false);

  const update = await saveMemberAvailability(uuid, 'Alice', 'pw', { slot: 'available' });
  assert.equal(update.status, 'ok');
});

test('concurrent joins for the last spot admit exactly one', async () => {
  const uuid = await createGroup(testGroupPayload({ numMembers: 1 }));
  const results = await Promise.all(
    ['A', 'B', 'C', 'D'].map((name) => saveMemberAvailability(uuid, name, 'pw', {}))
  );
  assert.equal(results.filter((r) => r.status === 'ok').length, 1);
  assert.equal(results.filter((r) => r.status === 'group_full').length, 3);
  assert.equal((await getMemberSummaries(uuid)).length, 1);
});

test('updateGroupSize grows freely but cannot shrink below the member count', async () => {
  const uuid = await createGroup(testGroupPayload({ numMembers: 2 }));
  await saveMemberAvailability(uuid, 'Alice', 'pw', {});
  await saveMemberAvailability(uuid, 'Bob', 'pw', {});

  assert.deepEqual(await updateGroupSize(uuid, 1), { status: 'below_member_count', memberCount: 2 });
  assert.deepEqual(await updateGroupSize(uuid, 3), { status: 'ok', numMembers: 3 });
  assert.equal((await saveMemberAvailability(uuid, 'Carol', 'pw', {})).status, 'ok');
  assert.deepEqual(await updateGroupSize(uuid, 2), { status: 'below_member_count', memberCount: 3 });
  assert.deepEqual(await updateGroupSize('no-such-group', 5), { status: 'not_found' });
});

test('removeMember frees a spot and clears their pending swap requests', async () => {
  const uuid = await createGroup(testGroupPayload({ numMembers: 2 }));
  await saveMemberAvailability(uuid, 'Alice', 'pw', {});
  await saveMemberAvailability(uuid, 'Bob', 'pw', {});
  const swap = await createSwapRequest(uuid, {
    fromMember: 'Alice',
    toMember: 'Bob',
    fromStart: '2026-01-01T00:00:00.000Z',
    fromEnd: '2026-01-01T01:00:00.000Z',
    toStart: null,
    toEnd: null,
    message: null,
  });

  assert.equal(await removeMember(uuid, 'Bob'), true);
  assert.equal(await removeMember(uuid, 'Bob'), false);
  assert.equal(await getSwapRequest(uuid, swap.id), undefined);

  assert.deepEqual(await updateGroupSize(uuid, 1), { status: 'ok', numMembers: 1 });
  assert.equal((await saveMemberAvailability(uuid, 'Carol', 'pw', {})).status, 'group_full');
});

test('coverage hours round-trip through create and updateGroupCoverage', async () => {
  const uuid = await createGroup(testGroupPayload({ coverageStart: 18, coverageEnd: 8 }));
  let group = await getGroup(uuid);
  assert.equal(group?.coverageStart, 18);
  assert.equal(group?.coverageEnd, 8);
  assert.equal(group?.coverageUpdatedAt, null);

  assert.equal(await updateGroupCoverage(uuid, null, null), true);
  group = await getGroup(uuid);
  assert.equal(group?.coverageStart, null);
  assert.equal(group?.coverageEnd, null);
  assert.ok(group?.coverageUpdatedAt);

  const aroundTheClock = await getGroup(await createGroup(testGroupPayload()));
  assert.equal(aroundTheClock?.coverageStart, null);
  assert.equal(await updateGroupCoverage('no-such-group', 9, 17), false);
});
