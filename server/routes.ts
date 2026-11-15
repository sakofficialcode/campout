import { Router } from 'express';
import { verifyPassword } from './auth.ts';
import {
  acceptSwapRequest,
  authenticateMember,
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
  updateScheduleLocked,
  verifyMemberPassword,
} from './db.ts';
import { generateSchedule, recomputeUnderstaffed } from './scheduler.ts';
import { applySwap, assignRange, mergeContiguous, reassignRange } from './swaps.ts';
import { conflictsForRange } from './conflicts.ts';
import type { CreateGroupPayload } from './types.ts';

export const router = Router();

const MAX_GROUP_SIZE = 64;

function isValidGroupSize(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_GROUP_SIZE;
}

const isHour = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 23;

// Coverage is either off (both null/absent = around the clock) or two distinct
// whole hours; end <= start means the window runs past midnight.
function parseCoverage(
  start: unknown,
  end: unknown
): { ok: true; start: number | null; end: number | null } | { ok: false; error: string } {
  if (start == null && end == null) return { ok: true, start: null, end: null };
  if (!isHour(start) || !isHour(end)) {
    return { ok: false, error: 'Daily hours must be whole hours from 0 to 23' };
  }
  if (start === end) {
    return { ok: false, error: 'Daily hours need a different start and end — use around the clock for 24h coverage' };
  }
  return { ok: true, start, end };
}

router.post('/groups', async (req, res) => {
  const body = req.body as Partial<CreateGroupPayload>;

  if (
    !body.groupName ||
    !body.numMembers ||
    !body.shiftStart ||
    !body.shiftEnd ||
    !body.stdOnShift ||
    !body.timeGranularity
  ) {
    res.status(400).json({ error: 'Missing required group fields' });
    return;
  }

  if (!isValidGroupSize(body.numMembers)) {
    res.status(400).json({ error: `Group size must be a whole number from 1 to ${MAX_GROUP_SIZE}` });
    return;
  }

  const coverage = parseCoverage(body.coverageStart, body.coverageEnd);
  if (!coverage.ok) {
    res.status(400).json({ error: coverage.error });
    return;
  }

  const uuid = await createGroup({
    ...(body as CreateGroupPayload),
    coverageStart: coverage.start,
    coverageEnd: coverage.end,
  });
  res.status(201).json({ uuid });
});

router.get('/groups/:uuid', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  const adminHash = await getAdminPasswordHash(req.params.uuid);
  res.json({
    ...group,
    hasAdminPassword: Boolean(adminHash),
    members: await getMemberSummaries(req.params.uuid),
  });
});

router.post('/groups/:uuid/members/:memberName/login', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  const password = req.body?.password;
  if (typeof password !== 'string' || !password) {
    res.status(400).json({ error: 'password is required' });
    return;
  }

  const result = await authenticateMember(req.params.uuid, req.params.memberName, password);
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'No account with that name yet' });
    return;
  }
  if (result.status === 'invalid_password') {
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }

  res.json({ memberName: req.params.memberName, availability: result.availability, updatedAt: result.updatedAt });
});

router.put('/groups/:uuid/members/:memberName', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  const availability = req.body?.availability;
  if (typeof availability !== 'object' || availability === null) {
    res.status(400).json({ error: 'availability must be an object' });
    return;
  }

  const password = req.body?.password;
  if (typeof password !== 'string' || !password) {
    res.status(400).json({ error: 'password is required' });
    return;
  }

  const result = await saveMemberAvailability(req.params.uuid, req.params.memberName, password, availability);
  if (result.status === 'invalid_password') {
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }
  if (result.status === 'group_full') {
    res.status(409).json({ error: `This group is full (${result.numMembers} of ${result.numMembers} members)` });
    return;
  }

  res.json({ memberName: req.params.memberName, updatedAt: result.updatedAt, created: result.created });
});

async function checkAdminPassword(uuid: string, password: string | null | undefined): Promise<boolean> {
  const hash = await getAdminPasswordHash(uuid);
  if (!hash) return true; // no password set — endpoint is open
  return typeof password === 'string' && verifyPassword(password, hash);
}

router.patch('/groups/:uuid/size', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  if (!(await checkAdminPassword(req.params.uuid, req.body?.adminPassword))) {
    res.status(403).json({ error: 'Incorrect admin password' });
    return;
  }

  const numMembers = req.body?.numMembers;
  if (!isValidGroupSize(numMembers)) {
    res.status(400).json({ error: `Group size must be a whole number from 1 to ${MAX_GROUP_SIZE}` });
    return;
  }

  const minForShifts = Math.max(group.stdOnShift, group.nightShifts ? group.nightOnShift ?? 0 : 0);
  if (numMembers < minForShifts) {
    res.status(400).json({ error: `Group size can't be smaller than the ${minForShifts} people needed per shift` });
    return;
  }

  const result = await updateGroupSize(req.params.uuid, numMembers);
  switch (result.status) {
    case 'not_found':
      res.status(404).json({ error: 'Group not found' });
      return;
    case 'below_member_count':
      res.status(409).json({
        error: `${result.memberCount} people have already joined — remove members before shrinking the group below ${result.memberCount}`,
      });
      return;
    case 'ok':
      res.json({ numMembers: result.numMembers });
      return;
  }
});

router.patch('/groups/:uuid/coverage', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  if (!(await checkAdminPassword(req.params.uuid, req.body?.adminPassword))) {
    res.status(403).json({ error: 'Incorrect admin password' });
    return;
  }

  const coverage = parseCoverage(req.body?.coverageStart, req.body?.coverageEnd);
  if (!coverage.ok) {
    res.status(400).json({ error: coverage.error });
    return;
  }

  // The saved schedule is left alone; the admin regenerates to apply new hours.
  await updateGroupCoverage(req.params.uuid, coverage.start, coverage.end);
  res.json({ coverageStart: coverage.start, coverageEnd: coverage.end });
});

router.delete('/groups/:uuid/members/:memberName', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  if (!(await checkAdminPassword(req.params.uuid, req.body?.adminPassword))) {
    res.status(403).json({ error: 'Incorrect admin password' });
    return;
  }

  if (!(await removeMember(req.params.uuid, req.params.memberName))) {
    res.status(404).json({ error: 'No member with that name' });
    return;
  }

  res.status(204).end();
});

router.post('/groups/:uuid/schedule/generate', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  if (!(await checkAdminPassword(req.params.uuid, req.body?.adminPassword))) {
    res.status(403).json({ error: 'Incorrect admin password' });
    return;
  }

  const members = await getMembersForGroup(req.params.uuid);
  const result = generateSchedule(group, members);
  await saveSchedule(req.params.uuid, result);
  res.json(result);
});

router.post('/groups/:uuid/schedule/view', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  if (!(await checkAdminPassword(req.params.uuid, req.body?.adminPassword))) {
    res.status(403).json({ error: 'Incorrect admin password' });
    return;
  }

  const result = await getSchedule(req.params.uuid);
  if (!result) {
    res.status(404).json({ error: 'No schedule generated yet' });
    return;
  }

  res.json(result);
});

const MAX_CONFLICT_RANGE_MS = 7 * 24 * 60 * 60_000;

function isIsoRange(start: unknown, end: unknown): start is string {
  return (
    typeof start === 'string' &&
    typeof end === 'string' &&
    !Number.isNaN(Date.parse(start)) &&
    !Number.isNaN(Date.parse(end)) &&
    Date.parse(start) < Date.parse(end) &&
    Date.parse(end) - Date.parse(start) <= MAX_CONFLICT_RANGE_MS
  );
}

// Who can cover [start, end)? Returns only a per-person verdict (ok /
// not_preferred / unavailable / on_shift), never anyone's availability map.
// Callable by a logged-in member (for the swap picker) or the admin.
router.post('/groups/:uuid/schedule/conflicts', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  const { start, end, memberName, password, adminPassword } = req.body ?? {};
  if (!isIsoRange(start, end)) {
    res.status(400).json({ error: 'A valid start/end range (up to 7 days) is required' });
    return;
  }

  const asMember =
    typeof memberName === 'string' &&
    typeof password === 'string' &&
    (await verifyMemberPassword(req.params.uuid, memberName, password));
  const asAdmin = !asMember && (await checkAdminPassword(req.params.uuid, adminPassword));
  if (!asMember && !asAdmin) {
    res.status(401).json({ error: 'Log in to see availability conflicts' });
    return;
  }

  const [members, schedule] = await Promise.all([getMembersForGroup(req.params.uuid), getSchedule(req.params.uuid)]);
  res.json({
    conflicts: conflictsForRange(members, schedule?.assignments ?? [], start, end as string, group.timeGranularity),
  });
});

// Admin edit: hand part or all of one member's shift to someone else, applied
// immediately (no request/accept). Conflicts are a warning in the UI, not a
// block here — the admin may knowingly double-book or override availability.
router.post('/groups/:uuid/schedule/reassign', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  if (!(await checkAdminPassword(req.params.uuid, req.body?.adminPassword))) {
    res.status(403).json({ error: 'Incorrect admin password' });
    return;
  }

  const { fromMember, toMember, start, end } = req.body ?? {};
  if (typeof fromMember !== 'string' || typeof toMember !== 'string' || !fromMember || !toMember || !isIsoRange(start, end)) {
    res.status(400).json({ error: 'fromMember, toMember, start, and end are required' });
    return;
  }

  if (!(await memberExists(req.params.uuid, toMember))) {
    res.status(404).json({ error: 'No member with that name' });
    return;
  }

  const outcome = await updateScheduleLocked(req.params.uuid, (schedule) => {
    const result = reassignRange(schedule.assignments, fromMember, start, end as string, toMember);
    return result.ok
      ? {
          ok: true,
          schedule: { ...schedule, assignments: result.assignments, understaffed: recomputeUnderstaffed(group, result.assignments) },
        }
      : result;
  });

  switch (outcome.status) {
    case 'no_schedule':
      res.status(404).json({ error: 'No schedule generated yet' });
      return;
    case 'conflict':
      res.status(409).json({ error: outcome.message });
      return;
    case 'ok':
      res.json(outcome.schedule);
      return;
  }
});

// Admin fill: put someone on [start, end) — typically an understaffed gap.
router.post('/groups/:uuid/schedule/assign', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  if (!(await checkAdminPassword(req.params.uuid, req.body?.adminPassword))) {
    res.status(403).json({ error: 'Incorrect admin password' });
    return;
  }

  const { toMember, start, end } = req.body ?? {};
  if (typeof toMember !== 'string' || !toMember || !isIsoRange(start, end)) {
    res.status(400).json({ error: 'toMember, start, and end are required' });
    return;
  }

  // Must sit inside the event (shiftStart/End are UTC-anchored wall clock).
  const eventStart = Date.parse(`${group.shiftStart}:00.000Z`);
  const eventEnd = Date.parse(`${group.shiftEnd}:00.000Z`);
  if (Date.parse(start) < eventStart || Date.parse(end as string) > eventEnd) {
    res.status(400).json({ error: 'That time is outside the event' });
    return;
  }

  if (!(await memberExists(req.params.uuid, toMember))) {
    res.status(404).json({ error: 'No member with that name' });
    return;
  }

  const outcome = await updateScheduleLocked(req.params.uuid, (schedule) => {
    const result = assignRange(schedule.assignments, toMember, start, end as string);
    return result.ok
      ? {
          ok: true,
          schedule: { ...schedule, assignments: result.assignments, understaffed: recomputeUnderstaffed(group, result.assignments) },
        }
      : result;
  });

  switch (outcome.status) {
    case 'no_schedule':
      res.status(404).json({ error: 'No schedule generated yet' });
      return;
    case 'conflict':
      res.status(409).json({ error: outcome.message });
      return;
    case 'ok':
      res.json(outcome.schedule);
      return;
  }
});

// Members view the schedule with their own name+password, not the admin
// password — the group link alone isn't enough.
router.post('/groups/:uuid/schedule/view-as-member', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  const { memberName, password } = req.body ?? {};
  if (typeof memberName !== 'string' || typeof password !== 'string' || !memberName || !password) {
    res.status(400).json({ error: 'memberName and password are required' });
    return;
  }

  if (!(await verifyMemberPassword(req.params.uuid, memberName, password))) {
    res.status(401).json({ error: 'Incorrect name or password' });
    return;
  }

  const result = await getSchedule(req.params.uuid);
  if (!result) {
    res.status(404).json({ error: 'No schedule generated yet' });
    return;
  }

  res.json(result);
});

function findAssignmentRange(
  assignments: { memberName: string; start: string; end: string }[],
  memberName: string,
  rangeStart: string,
  rangeEnd: string
): boolean {
  const startMs = new Date(rangeStart).getTime();
  const endMs = new Date(rangeEnd).getTime();
  if (!(startMs < endMs)) return false;
  return mergeContiguous(assignments).some(
    (a) =>
      a.memberName === memberName &&
      new Date(a.start).getTime() <= startMs &&
      new Date(a.end).getTime() >= endMs
  );
}

router.post('/groups/:uuid/swap-requests', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  const { fromMember, fromPassword, toMember, fromStart, fromEnd, toStart, toEnd, message } = req.body ?? {};
  if (
    typeof fromMember !== 'string' ||
    typeof fromPassword !== 'string' ||
    typeof toMember !== 'string' ||
    typeof fromStart !== 'string' ||
    typeof fromEnd !== 'string' ||
    !fromMember ||
    !toMember ||
    !fromStart ||
    !fromEnd
  ) {
    res.status(400).json({ error: 'fromMember, fromPassword, toMember, fromStart, and fromEnd are required' });
    return;
  }

  if (fromMember === toMember) {
    res.status(400).json({ error: 'Cannot request a swap with yourself' });
    return;
  }

  if (!(await verifyMemberPassword(req.params.uuid, fromMember, fromPassword))) {
    res.status(401).json({ error: 'Incorrect name or password' });
    return;
  }

  if (!(await memberExists(req.params.uuid, toMember))) {
    res.status(404).json({ error: 'No member with that name' });
    return;
  }

  const schedule = await getSchedule(req.params.uuid);
  if (!schedule) {
    res.status(404).json({ error: 'No schedule generated yet' });
    return;
  }

  if (!findAssignmentRange(schedule.assignments, fromMember, fromStart, fromEnd)) {
    res.status(400).json({ error: 'That time range is not part of one of your shifts' });
    return;
  }

  const hasToRange = typeof toStart === 'string' && typeof toEnd === 'string' && toStart && toEnd;
  if (hasToRange && !findAssignmentRange(schedule.assignments, toMember, toStart, toEnd)) {
    res.status(400).json({ error: 'That time range is not part of one of their shifts' });
    return;
  }

  const swapRequest = await createSwapRequest(req.params.uuid, {
    fromMember,
    toMember,
    fromStart,
    fromEnd,
    toStart: hasToRange ? toStart : null,
    toEnd: hasToRange ? toEnd : null,
    message: typeof message === 'string' && message.trim() ? message.trim() : null,
  });

  res.status(201).json(swapRequest);
});

router.post('/groups/:uuid/swap-requests/list', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  const { memberName, password } = req.body ?? {};
  if (typeof memberName !== 'string' || typeof password !== 'string' || !memberName || !password) {
    res.status(400).json({ error: 'memberName and password are required' });
    return;
  }

  if (!(await verifyMemberPassword(req.params.uuid, memberName, password))) {
    res.status(401).json({ error: 'Incorrect name or password' });
    return;
  }

  res.json(await getSwapRequestsForMember(req.params.uuid, memberName));
});

router.post('/groups/:uuid/swap-requests/:id/respond', async (req, res) => {
  const group = await getGroup(req.params.uuid);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  const { memberName, password, accept } = req.body ?? {};
  if (typeof memberName !== 'string' || typeof password !== 'string' || typeof accept !== 'boolean' || !memberName || !password) {
    res.status(400).json({ error: 'memberName, password, and accept are required' });
    return;
  }

  if (!(await verifyMemberPassword(req.params.uuid, memberName, password))) {
    res.status(401).json({ error: 'Incorrect name or password' });
    return;
  }

  const id = Number(req.params.id);
  const swapRequest = await getSwapRequest(req.params.uuid, id);
  if (!swapRequest) {
    res.status(404).json({ error: 'Swap request not found' });
    return;
  }

  if (swapRequest.toMember !== memberName) {
    res.status(403).json({ error: 'Only the requested member can respond to this request' });
    return;
  }

  if (swapRequest.status !== 'pending') {
    res.status(409).json({ error: 'This request has already been responded to' });
    return;
  }

  if (!accept) {
    await setSwapRequestStatus(req.params.uuid, id, 'declined');
    res.json({ swapRequest: await getSwapRequest(req.params.uuid, id) });
    return;
  }

  // acceptSwapRequest locks both rows for the transaction, so this
  // read-modify-write can't race a concurrent response.
  const outcome = await acceptSwapRequest(req.params.uuid, id, memberName, (schedule, swap) => {
    const result = applySwap(schedule.assignments, {
      fromMember: swap.fromMember,
      fromStart: swap.fromStart,
      fromEnd: swap.fromEnd,
      toMember: swap.toMember,
      toStart: swap.toStart,
      toEnd: swap.toEnd,
    });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    const assignments = [...result.assignments].sort(
      (a, b) => a.start.localeCompare(b.start) || a.memberName.localeCompare(b.memberName)
    );
    return { ok: true, schedule: { ...schedule, assignments, understaffed: recomputeUnderstaffed(group, assignments) } };
  });

  switch (outcome.status) {
    case 'not_found':
      res.status(404).json({ error: 'Swap request not found' });
      return;
    case 'forbidden':
      res.status(403).json({ error: 'Only the requested member can respond to this request' });
      return;
    case 'no_schedule':
      res.status(404).json({ error: 'No schedule generated yet' });
      return;
    case 'conflict':
      res.status(409).json({ error: outcome.message });
      return;
    case 'ok':
      res.json({ swapRequest: outcome.swapRequest, schedule: outcome.schedule });
      return;
  }
});
