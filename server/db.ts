import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.ts';
import type {
  AvailabilityMap,
  CreateGroupPayload,
  GroupConfig,
  MemberAvailability,
  ScheduleResult,
  SwapRequest,
  SwapStatus,
} from './types.ts';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 10_000,
});

export async function closeDb(): Promise<void> {
  await pool.end();
}

interface GroupRow {
  id: string;
  group_name: string;
  num_members: number;
  shift_start: string;
  shift_end: string;
  std_on_shift: number;
  time_granularity: number;
  night_shifts: boolean;
  night_shift_start: number | null;
  night_shift_end: number | null;
  night_on_shift: number | null;
  coverage_start: number | null;
  coverage_end: number | null;
  coverage_updated_at: string | null;
  admin_password_hash: string | null;
}

function rowToConfig(row: GroupRow): GroupConfig {
  return {
    uuid: row.id,
    groupName: row.group_name,
    numMembers: row.num_members,
    shiftStart: row.shift_start,
    shiftEnd: row.shift_end,
    stdOnShift: row.std_on_shift,
    timeGranularity: row.time_granularity as 15 | 30 | 60,
    nightShifts: row.night_shifts,
    nightShiftStart: row.night_shift_start,
    nightShiftEnd: row.night_shift_end,
    nightOnShift: row.night_on_shift,
    coverageStart: row.coverage_start,
    coverageEnd: row.coverage_end,
    coverageUpdatedAt: row.coverage_updated_at,
  };
}

export async function createGroup(payload: CreateGroupPayload): Promise<string> {
  const uuid = randomUUID();
  const adminPasswordHash = payload.adminPassword ? hashPassword(payload.adminPassword) : null;

  await pool.query(
    `INSERT INTO groups (
      id, group_name, num_members, shift_start, shift_end, std_on_shift,
      time_granularity, night_shifts, night_shift_start, night_shift_end,
      night_on_shift, admin_password_hash, created_at, coverage_start, coverage_end
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      uuid,
      payload.groupName,
      payload.numMembers,
      payload.shiftStart,
      payload.shiftEnd,
      payload.stdOnShift,
      payload.timeGranularity,
      payload.nightShifts,
      payload.nightShifts ? payload.nightShiftStart ?? null : null,
      payload.nightShifts ? payload.nightShiftEnd ?? null : null,
      payload.nightShifts ? payload.nightOnShift ?? null : null,
      adminPasswordHash,
      new Date().toISOString(),
      payload.coverageStart ?? null,
      payload.coverageEnd ?? null,
    ]
  );

  return uuid;
}

export async function getGroup(uuid: string): Promise<GroupConfig | undefined> {
  const { rows } = await pool.query<GroupRow>('SELECT * FROM groups WHERE id = $1', [uuid]);
  return rows[0] ? rowToConfig(rows[0]) : undefined;
}

export async function getAdminPasswordHash(uuid: string): Promise<string | null | undefined> {
  const { rows } = await pool.query<{ admin_password_hash: string | null }>(
    'SELECT admin_password_hash FROM groups WHERE id = $1',
    [uuid]
  );
  return rows[0]?.admin_password_hash;
}

interface MemberRow {
  member_name: string;
  availability: AvailabilityMap;
  password_hash: string;
  updated_at: string;
}

export async function getMembersForGroup(groupId: string): Promise<MemberAvailability[]> {
  const { rows } = await pool.query<MemberRow>(
    'SELECT member_name, availability FROM members WHERE group_id = $1',
    [groupId]
  );

  return rows.map((row) => ({
    memberName: row.member_name,
    availability: row.availability,
  }));
}

export async function getMemberSummaries(groupId: string): Promise<{ memberName: string; updatedAt: string }[]> {
  const { rows } = await pool.query<{ member_name: string; updated_at: string }>(
    'SELECT member_name, updated_at FROM members WHERE group_id = $1 ORDER BY member_name',
    [groupId]
  );

  return rows.map((row) => ({ memberName: row.member_name, updatedAt: row.updated_at }));
}

export async function getMember(groupId: string, memberName: string): Promise<MemberRow | undefined> {
  const { rows } = await pool.query<MemberRow>(
    'SELECT member_name, availability, password_hash, updated_at FROM members WHERE group_id = $1 AND member_name = $2',
    [groupId, memberName]
  );
  return rows[0];
}

export type MemberAuthResult =
  | { status: 'ok'; availability: AvailabilityMap; updatedAt: string }
  | { status: 'not_found' }
  | { status: 'invalid_password' };

// Every member name is bound to a password set on first submission, so a
// stranger typing someone else's name can't read or overwrite their data.
export async function authenticateMember(groupId: string, memberName: string, password: string): Promise<MemberAuthResult> {
  const existing = await getMember(groupId, memberName);
  if (!existing) return { status: 'not_found' };
  if (!verifyPassword(password, existing.password_hash)) return { status: 'invalid_password' };
  return { status: 'ok', availability: existing.availability, updatedAt: existing.updated_at };
}

export type SaveMemberResult =
  | { status: 'ok'; updatedAt: string; created: boolean }
  | { status: 'invalid_password' }
  | { status: 'group_full'; numMembers: number };

// Joining, resizing, and removing members all take this row lock first, so
// the member count and num_members can't change underneath each other (two
// people grabbing the last spot at once, or a shrink racing a join).
async function lockGroupSize(client: pg.PoolClient, groupId: string): Promise<{ numMembers: number; memberCount: number } | undefined> {
  const group = await client.query<{ num_members: number }>(
    'SELECT num_members FROM groups WHERE id = $1 FOR UPDATE',
    [groupId]
  );
  if (group.rowCount === 0) return undefined;
  const count = await client.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM members WHERE group_id = $1',
    [groupId]
  );
  return { numMembers: group.rows[0].num_members, memberCount: Number(count.rows[0].count) };
}

export async function saveMemberAvailability(
  groupId: string,
  memberName: string,
  password: string,
  availability: AvailabilityMap
): Promise<SaveMemberResult> {
  const now = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const selectExisting = () =>
      client.query<{ password_hash: string }>(
        'SELECT password_hash FROM members WHERE group_id = $1 AND member_name = $2 FOR UPDATE',
        [groupId, memberName]
      );

    let existing = await selectExisting();

    if (existing.rowCount === 0) {
      const size = await lockGroupSize(client, groupId);
      if (size && size.memberCount >= size.numMembers) {
        await client.query('ROLLBACK');
        return { status: 'group_full', numMembers: size.numMembers };
      }

      // A concurrent first-time submission under the same name can still win
      // the UNIQUE index between our SELECT and INSERT: the loser gets zero
      // rows back (not a thrown constraint violation) and falls through to the
      // existing-member path below.
      const inserted = await client.query(
        `INSERT INTO members (group_id, member_name, availability, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (group_id, member_name) DO NOTHING
         RETURNING updated_at`,
        [groupId, memberName, JSON.stringify(availability), hashPassword(password), now]
      );

      if (inserted.rowCount === 1) {
        await client.query('COMMIT');
        return { status: 'ok', updatedAt: now, created: true };
      }

      existing = await selectExisting();
    }

    const passwordHash = existing.rows[0]?.password_hash ?? '';

    if (!verifyPassword(password, passwordHash)) {
      await client.query('ROLLBACK');
      return { status: 'invalid_password' };
    }

    await client.query(
      `UPDATE members SET availability = $1, updated_at = $2 WHERE group_id = $3 AND member_name = $4`,
      [JSON.stringify(availability), now, groupId, memberName]
    );
    await client.query('COMMIT');
    return { status: 'ok', updatedAt: now, created: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Both null = around the clock. Stamping coverage_updated_at lets the group
// page tell members who submitted before a change to review their hours.
export async function updateGroupCoverage(
  groupId: string,
  coverageStart: number | null,
  coverageEnd: number | null
): Promise<boolean> {
  const result = await pool.query(
    'UPDATE groups SET coverage_start = $1, coverage_end = $2, coverage_updated_at = $3 WHERE id = $4',
    [coverageStart, coverageEnd, new Date().toISOString(), groupId]
  );
  return result.rowCount === 1;
}

export type UpdateGroupSizeResult =
  | { status: 'ok'; numMembers: number }
  | { status: 'not_found' }
  | { status: 'below_member_count'; memberCount: number };

export async function updateGroupSize(groupId: string, numMembers: number): Promise<UpdateGroupSizeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const size = await lockGroupSize(client, groupId);
    if (!size) {
      await client.query('ROLLBACK');
      return { status: 'not_found' };
    }
    if (numMembers < size.memberCount) {
      await client.query('ROLLBACK');
      return { status: 'below_member_count', memberCount: size.memberCount };
    }
    await client.query('UPDATE groups SET num_members = $1 WHERE id = $2', [numMembers, groupId]);
    await client.query('COMMIT');
    return { status: 'ok', numMembers };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Deletes the member and any still-pending swap requests involving them
// (accepted/declined ones stay as history). An already-generated schedule is
// left untouched — the admin regenerates to drop them from it.
export async function removeMember(groupId: string, memberName: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockGroupSize(client, groupId);
    const deleted = await client.query('DELETE FROM members WHERE group_id = $1 AND member_name = $2', [
      groupId,
      memberName,
    ]);
    if (deleted.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `DELETE FROM swap_requests
       WHERE group_id = $1 AND status = 'pending' AND (from_member = $2 OR to_member = $2)`,
      [groupId, memberName]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function saveSchedule(groupId: string, result: ScheduleResult): Promise<void> {
  await pool.query(
    `INSERT INTO schedules (group_id, result_json, generated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_id) DO UPDATE SET result_json = EXCLUDED.result_json, generated_at = EXCLUDED.generated_at`,
    [groupId, JSON.stringify(result), result.generatedAt]
  );
}

export async function getSchedule(groupId: string): Promise<ScheduleResult | undefined> {
  const { rows } = await pool.query<{ result_json: ScheduleResult }>(
    'SELECT result_json FROM schedules WHERE group_id = $1',
    [groupId]
  );
  return rows[0]?.result_json;
}

export async function verifyMemberPassword(groupId: string, memberName: string, password: string): Promise<boolean> {
  const member = await getMember(groupId, memberName);
  return Boolean(member && verifyPassword(password, member.password_hash));
}

export async function memberExists(groupId: string, memberName: string): Promise<boolean> {
  return Boolean(await getMember(groupId, memberName));
}

interface SwapRequestRow {
  id: number;
  from_member: string;
  to_member: string;
  from_start: string;
  from_end: string;
  to_start: string | null;
  to_end: string | null;
  message: string | null;
  status: SwapStatus;
  created_at: string;
  responded_at: string | null;
}

function rowToSwapRequest(row: SwapRequestRow): SwapRequest {
  return {
    id: row.id,
    fromMember: row.from_member,
    toMember: row.to_member,
    fromStart: row.from_start,
    fromEnd: row.from_end,
    toStart: row.to_start,
    toEnd: row.to_end,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  };
}

export async function createSwapRequest(
  groupId: string,
  input: {
    fromMember: string;
    toMember: string;
    fromStart: string;
    fromEnd: string;
    toStart: string | null;
    toEnd: string | null;
    message: string | null;
  }
): Promise<SwapRequest> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO swap_requests (group_id, from_member, to_member, from_start, from_end, to_start, to_end, message, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      groupId,
      input.fromMember,
      input.toMember,
      input.fromStart,
      input.fromEnd,
      input.toStart,
      input.toEnd,
      input.message,
      new Date().toISOString(),
    ]
  );

  return (await getSwapRequest(groupId, rows[0].id))!;
}

export async function getSwapRequest(groupId: string, id: number): Promise<SwapRequest | undefined> {
  const { rows } = await pool.query<SwapRequestRow>(
    'SELECT * FROM swap_requests WHERE id = $1 AND group_id = $2',
    [id, groupId]
  );
  return rows[0] ? rowToSwapRequest(rows[0]) : undefined;
}

export async function getSwapRequestsForMember(
  groupId: string,
  memberName: string
): Promise<{ incoming: SwapRequest[]; outgoing: SwapRequest[] }> {
  const { rows } = await pool.query<SwapRequestRow>(
    `SELECT * FROM swap_requests WHERE group_id = $1 AND (from_member = $2 OR to_member = $2)
     ORDER BY created_at DESC`,
    [groupId, memberName]
  );

  const all = rows.map(rowToSwapRequest);
  const incoming = all.filter((r) => r.toMember === memberName);
  const outgoing = all.filter((r) => r.fromMember === memberName);
  return { incoming, outgoing };
}

export async function setSwapRequestStatus(groupId: string, id: number, status: SwapStatus): Promise<void> {
  await pool.query(
    'UPDATE swap_requests SET status = $1, responded_at = $2 WHERE id = $3 AND group_id = $4',
    [status, new Date().toISOString(), id, groupId]
  );
}

export type UpdateScheduleResult =
  | { status: 'ok'; schedule: ScheduleResult }
  | { status: 'no_schedule' }
  | { status: 'conflict'; message: string };

// Locked read-modify-write of a group's saved schedule, so an admin edit can't
// race a member accepting a swap on the same row (both take FOR UPDATE).
export async function updateScheduleLocked(
  groupId: string,
  compute: (schedule: ScheduleResult) => { ok: true; schedule: ScheduleResult } | { ok: false; error: string }
): Promise<UpdateScheduleResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query<{ result_json: ScheduleResult }>(
      'SELECT result_json FROM schedules WHERE group_id = $1 FOR UPDATE',
      [groupId]
    );
    if (row.rowCount === 0) {
      await client.query('ROLLBACK');
      return { status: 'no_schedule' };
    }
    const result = compute(row.rows[0].result_json);
    if (!result.ok) {
      await client.query('ROLLBACK');
      return { status: 'conflict', message: result.error };
    }
    await client.query('UPDATE schedules SET result_json = $1 WHERE group_id = $2', [
      JSON.stringify(result.schedule),
      groupId,
    ]);
    await client.query('COMMIT');
    return { status: 'ok', schedule: result.schedule };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type AcceptSwapRequestResult =
  | { status: 'ok'; schedule: ScheduleResult; swapRequest: SwapRequest }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'no_schedule' }
  | { status: 'conflict'; message: string };

// Two members could respond to overlapping swaps at the same instant. Locking
// both the swap-request and schedule rows (FOR UPDATE) in one transaction makes
// the second attempt block, then re-read the updated state instead of racing a
// lost update.
export async function acceptSwapRequest(
  groupId: string,
  id: number,
  memberName: string,
  compute: (
    schedule: ScheduleResult,
    swapRequest: SwapRequest
  ) => { ok: true; schedule: ScheduleResult } | { ok: false; error: string }
): Promise<AcceptSwapRequestResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const swapRow = await client.query<SwapRequestRow>(
      'SELECT * FROM swap_requests WHERE id = $1 AND group_id = $2 FOR UPDATE',
      [id, groupId]
    );
    if (swapRow.rowCount === 0) {
      await client.query('ROLLBACK');
      return { status: 'not_found' };
    }
    const swapRequest = rowToSwapRequest(swapRow.rows[0]);

    if (swapRequest.toMember !== memberName) {
      await client.query('ROLLBACK');
      return { status: 'forbidden' };
    }
    if (swapRequest.status !== 'pending') {
      await client.query('ROLLBACK');
      return { status: 'conflict', message: 'This request has already been responded to' };
    }

    const scheduleRow = await client.query<{ result_json: ScheduleResult }>(
      'SELECT result_json FROM schedules WHERE group_id = $1 FOR UPDATE',
      [groupId]
    );
    if (scheduleRow.rowCount === 0) {
      await client.query('ROLLBACK');
      return { status: 'no_schedule' };
    }

    const result = compute(scheduleRow.rows[0].result_json, swapRequest);
    if (!result.ok) {
      await client.query('ROLLBACK');
      return { status: 'conflict', message: result.error };
    }

    const respondedAt = new Date().toISOString();
    await client.query('UPDATE schedules SET result_json = $1, generated_at = $2 WHERE group_id = $3', [
      JSON.stringify(result.schedule),
      result.schedule.generatedAt,
      groupId,
    ]);
    await client.query(`UPDATE swap_requests SET status = 'accepted', responded_at = $1 WHERE id = $2 AND group_id = $3`, [
      respondedAt,
      id,
      groupId,
    ]);

    await client.query('COMMIT');
    return {
      status: 'ok',
      schedule: result.schedule,
      swapRequest: { ...swapRequest, status: 'accepted', respondedAt },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
