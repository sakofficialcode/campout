export type AvailabilityStatus = 'available' | 'not_preferred' | 'unavailable';
export type AvailabilityMap = Record<string, AvailabilityStatus>;

export interface GroupConfig {
  uuid: string;
  groupName: string;
  numMembers: number;
  shiftStart: string;
  shiftEnd: string;
  stdOnShift: number;
  timeGranularity: 15 | 30 | 60;
  nightShifts: boolean;
  nightShiftStart: number | null;
  nightShiftEnd: number | null;
  nightOnShift: number | null;
  coverageStart: number | null;
  coverageEnd: number | null;
  coverageUpdatedAt: string | null;
  hasAdminPassword: boolean;
  members: MemberInfo[];
}

export interface MemberInfo {
  memberName: string;
  updatedAt: string;
}

export interface CreateGroupPayload {
  groupName: string;
  numMembers: number;
  shiftStart: string;
  shiftEnd: string;
  stdOnShift: number;
  timeGranularity: 15 | 30 | 60;
  nightShifts: boolean;
  nightShiftStart?: number;
  nightShiftEnd?: number;
  nightOnShift?: number;
  coverageStart?: number | null;
  coverageEnd?: number | null;
  adminPassword?: string | null;
}

export interface ShiftAssignment {
  memberName: string;
  start: string;
  end: string;
}

export interface UnderstaffedRange {
  start: string;
  end: string;
  required: number;
  filled: number;
}

export interface ScheduleResult {
  generatedAt: string;
  assignments: ShiftAssignment[];
  understaffed: UnderstaffedRange[];
}

export type SwapStatus = 'pending' | 'accepted' | 'declined';

export interface SwapRequest {
  id: number;
  fromMember: string;
  toMember: string;
  fromStart: string;
  fromEnd: string;
  toStart: string | null;
  toEnd: string | null;
  message: string | null;
  status: SwapStatus;
  createdAt: string;
  respondedAt: string | null;
}

// Worst problem a person has with a time range, from the server's conflict check.
export type ConflictStatus = 'on_shift' | 'unavailable' | 'not_preferred' | 'ok';
