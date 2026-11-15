// Run with: npm run test:client  (forces a US timezone so DST cases are real)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countCalendarWeeks, dayOverlapsEvent, eventDays, sundayOf, toDateStr } from './calendarWeeks.ts';

// Naive "YYYY-MM-DDTHH:mm" parses as local time, exactly like the grid's inputs.
const at = (s: string) => new Date(s);

test('sundayOf snaps to local midnight of the previous-or-same Sunday', () => {
  assert.equal(toDateStr(sundayOf(at('2026-11-14T18:00'))), '2026-11-08'); // Sat
  assert.equal(toDateStr(sundayOf(at('2026-11-15T00:00'))), '2026-11-15'); // Sun
  assert.equal(sundayOf(at('2026-11-14T18:00')).getHours(), 0);
});

test('countCalendarWeeks counts calendar weeks touched, not days / 7', () => {
  // The bug: Sat -> Tue is 4 days but two calendar weeks.
  assert.equal(countCalendarWeeks(at('2026-11-14T18:00'), at('2026-11-17T09:00')), 2);
  assert.equal(countCalendarWeeks(at('2026-11-15T00:00'), at('2026-11-21T23:00')), 1);
  assert.equal(countCalendarWeeks(at('2026-11-10T09:00'), at('2026-11-10T17:00')), 1);
  // Ending exactly at Sunday midnight doesn't add an empty week.
  assert.equal(countCalendarWeeks(at('2026-11-14T00:00'), at('2026-11-15T00:00')), 1);
  // Across the Nov 1 DST change.
  assert.equal(countCalendarWeeks(at('2026-10-31T00:00'), at('2026-11-08T12:00')), 3);
  // Degenerate range still shows one week.
  assert.equal(countCalendarWeeks(at('2026-11-14T18:00'), at('2026-11-14T18:00')), 1);
});

test('dayOverlapsEvent: a mid-day start still includes its whole first day', () => {
  const start = at('2026-11-14T18:00');
  const end = at('2026-11-17T09:00');
  // The regression: Saturday must count even though midnight < 6 PM start.
  assert.equal(dayOverlapsEvent(at('2026-11-14T00:00'), start, end), true);
  assert.equal(dayOverlapsEvent(at('2026-11-17T00:00'), start, end), true);
  assert.equal(dayOverlapsEvent(at('2026-11-13T00:00'), start, end), false);
  assert.equal(dayOverlapsEvent(at('2026-11-18T00:00'), start, end), false);
  // Same answer whatever time of day the column date carries.
  assert.equal(dayOverlapsEvent(at('2026-11-14T02:00'), start, end), true);
  // Ends at midnight: the next day is not part of the event.
  assert.equal(dayOverlapsEvent(at('2026-11-18T00:00'), start, at('2026-11-18T00:00')), false);
});

test('eventDays lists every touched day, including a last day before the start time-of-day', () => {
  // The CSV bug: stepping from 6 PM Sat lands on 6 PM Tue > 9 AM end and drops Tuesday.
  assert.deepEqual(
    eventDays(at('2026-11-14T18:00'), at('2026-11-17T09:00')).map(toDateStr),
    ['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17']
  );
  assert.deepEqual(eventDays(at('2026-11-14T00:00'), at('2026-11-15T00:00')).map(toDateStr), ['2026-11-14']);
  // DST week keeps one entry per calendar day.
  assert.deepEqual(
    eventDays(at('2026-10-31T12:00'), at('2026-11-02T12:00')).map(toDateStr),
    ['2026-10-31', '2026-11-01', '2026-11-02']
  );
});
