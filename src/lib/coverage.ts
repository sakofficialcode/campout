// Mirrors server/scheduler.ts's inHourWindow/isCoveredSlot. Hours are whole
// wall-clock hours 0-23; end <= start wraps past midnight.

export interface Coverage {
  start: number;
  end: number;
}

export function inHourWindow(hour: number, start: number, end: number): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

// null = around the clock.
export function isCoveredHour(hour: number, coverage: Coverage | null): boolean {
  return coverage === null || inHourWindow(hour, coverage.start, coverage.end);
}

export function coverageFromGroup(group: { coverageStart: number | null; coverageEnd: number | null }): Coverage | null {
  return group.coverageStart == null || group.coverageEnd == null
    ? null
    : { start: group.coverageStart, end: group.coverageEnd };
}

export function formatClockHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const period = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12} ${period}`;
}

export function hoursPerDay(coverage: Coverage | null): number {
  if (!coverage) return 24;
  return coverage.end > coverage.start ? coverage.end - coverage.start : 24 - coverage.start + coverage.end;
}

export function coverageLabel(coverage: Coverage | null): string {
  if (!coverage) return 'Around the clock';
  return `${formatClockHour(coverage.start)} – ${formatClockHour(coverage.end)} daily`;
}

// Covered hours between two naive "YYYY-MM-DDTHH:mm" strings, read as UTC wall
// clock like the scheduler does. Returns null if either is missing/invalid.
export function totalCoveredHours(shiftStart: string, shiftEnd: string, coverage: Coverage | null): number | null {
  const start = Date.parse(`${shiftStart}:00.000Z`);
  const end = Date.parse(`${shiftEnd}:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  const minute = 60_000;
  let total = 0;
  // Step by 15 min so partial first/last hours are counted fairly.
  for (let t = start; t < end; t += 15 * minute) {
    if (isCoveredHour(new Date(t).getUTCHours(), coverage)) total += 0.25;
  }
  return total;
}

// Hours the new window covers that the old one didn't.
export function addsHours(previous: Coverage | null, next: Coverage | null): boolean {
  for (let h = 0; h < 24; h++) {
    if (isCoveredHour(h, next) && !isCoveredHour(h, previous)) return true;
  }
  return false;
}
