import type {
  AvailabilityMap,
  CreateGroupPayload,
  GroupConfig,
  ScheduleResult,
  SwapRequest,
} from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function parseOrThrow<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(data.error || `Request failed with status ${response.status}`, response.status);
  }
  return data as T;
}

export async function createGroup(payload: CreateGroupPayload): Promise<{ uuid: string }> {
  const response = await fetch(apiUrl('/api/groups'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseOrThrow(response);
}

export async function getGroup(uuid: string): Promise<GroupConfig> {
  const response = await fetch(apiUrl(`/api/groups/${uuid}`));
  return parseOrThrow(response);
}

export async function loginMember(
  uuid: string,
  memberName: string,
  password: string
): Promise<{ memberName: string; availability: AvailabilityMap; updatedAt: string } | null> {
  const response = await fetch(apiUrl(`/api/groups/${uuid}/members/${encodeURIComponent(memberName)}/login`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (response.status === 404) return null;
  return parseOrThrow(response);
}

export async function saveMemberAvailability(
  uuid: string,
  memberName: string,
  availability: AvailabilityMap,
  password: string
): Promise<{ memberName: string; updatedAt: string; created: boolean }> {
  const response = await fetch(apiUrl(`/api/groups/${uuid}/members/${encodeURIComponent(memberName)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ availability, password }),
  });
  return parseOrThrow(response);
}

export async function generateSchedule(
  uuid: string,
  adminPassword: string | null
): Promise<ScheduleResult> {
  const response = await fetch(apiUrl(`/api/groups/${uuid}/schedule/generate`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminPassword }),
  });
  return parseOrThrow(response);
}

export async function viewSchedule(
  uuid: string,
  adminPassword: string | null
): Promise<ScheduleResult> {
  const response = await fetch(apiUrl(`/api/groups/${uuid}/schedule/view`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminPassword }),
  });
  return parseOrThrow(response);
}

export async function viewScheduleAsMember(
  uuid: string,
  memberName: string,
  password: string
): Promise<ScheduleResult> {
  const response = await fetch(apiUrl(`/api/groups/${uuid}/schedule/view-as-member`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberName, password }),
  });
  return parseOrThrow(response);
}

export interface CreateSwapRequestPayload {
  fromMember: string;
  fromPassword: string;
  toMember: string;
  fromStart: string;
  fromEnd: string;
  toStart?: string | null;
  toEnd?: string | null;
  message?: string | null;
}

export async function createSwapRequest(uuid: string, payload: CreateSwapRequestPayload): Promise<SwapRequest> {
  const response = await fetch(apiUrl(`/api/groups/${uuid}/swap-requests`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseOrThrow(response);
}

export async function listSwapRequests(
  uuid: string,
  memberName: string,
  password: string
): Promise<{ incoming: SwapRequest[]; outgoing: SwapRequest[] }> {
  const response = await fetch(apiUrl(`/api/groups/${uuid}/swap-requests/list`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberName, password }),
  });
  return parseOrThrow(response);
}

export async function respondToSwapRequest(
  uuid: string,
  id: number,
  memberName: string,
  password: string,
  accept: boolean
): Promise<{ swapRequest: SwapRequest; schedule?: ScheduleResult }> {
  const response = await fetch(apiUrl(`/api/groups/${uuid}/swap-requests/${id}/respond`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberName, password, accept }),
  });
  return parseOrThrow(response);
}

export async function updateGroupSize(
  uuid: string,
  numMembers: number,
  adminPassword: string | null
): Promise<{ numMembers: number }> {
  const response = await fetch(apiUrl(`/api/groups/${uuid}/size`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ numMembers, adminPassword }),
  });
  return parseOrThrow(response);
}

export async function removeMember(uuid: string, memberName: string, adminPassword: string | null): Promise<void> {
  const response = await fetch(apiUrl(`/api/groups/${uuid}/members/${encodeURIComponent(memberName)}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminPassword }),
  });
  await parseOrThrow(response);
}

export async function updateGroupCoverage(
  uuid: string,
  coverageStart: number | null,
  coverageEnd: number | null,
  adminPassword: string | null
): Promise<{ coverageStart: number | null; coverageEnd: number | null }> {
  const response = await fetch(apiUrl(`/api/groups/${uuid}/coverage`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coverageStart, coverageEnd, adminPassword }),
  });
  return parseOrThrow(response);
}
