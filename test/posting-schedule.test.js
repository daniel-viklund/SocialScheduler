import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POSTING_SCHEDULE, validatePostingSchedule, nextAvailableSlot } from '../src/posting-schedule.js';

const friday = DEFAULT_POSTING_SCHEDULE.youtube;

test('finds the first future slot, fills gaps, and ignores past bookings', () => {
  const now = '2026-10-05T10:00:00Z';
  assert.equal(nextAvailableSlot(friday, [], now), '2026-10-09T16:00:00.000Z');
  assert.equal(nextAvailableSlot(friday, ['2026-10-02T16:00:00Z', '2026-10-16T16:00:00Z'], now), '2026-10-09T16:00:00.000Z');
  assert.equal(nextAvailableSlot(friday, ['2026-10-09T16:00:25Z'], now), '2026-10-16T16:00:00.000Z');
  assert.equal(nextAvailableSlot(friday, [], '2026-10-09T16:00:00Z'), '2026-10-16T16:00:00.000Z');
});

test('Instagram uses both Monday and Friday', () => {
  const spec = DEFAULT_POSTING_SCHEDULE.instagram;
  assert.equal(nextAvailableSlot(spec, [], '2026-10-05T10:00:00Z'), '2026-10-05T16:00:00.000Z');
  assert.equal(nextAvailableSlot(spec, ['2026-10-05T16:00:00Z'], '2026-10-05T10:00:00Z'), '2026-10-09T16:00:00.000Z');
});

test('keeps local posting time over daylight saving changes', () => {
  assert.equal(nextAvailableSlot(friday, [], '2026-10-24T10:00:00Z'), '2026-10-30T17:00:00.000Z');
  assert.equal(nextAvailableSlot(friday, [], '2026-03-28T10:00:00Z'), '2026-04-03T16:00:00.000Z');
});

test('skips nonexistent times and treats repeated times as one slot', () => {
  const spec = { days: [0], time: '02:30', timezone: 'Europe/Stockholm' };
  assert.equal(nextAvailableSlot(spec, [], '2026-03-28T10:00:00Z'), '2026-04-05T00:30:00.000Z');
  assert.equal(nextAvailableSlot(spec, [], '2026-10-24T10:00:00Z'), '2026-10-25T00:30:00.000Z');
  assert.equal(nextAvailableSlot(spec, [], '2026-10-25T00:45:00Z'), '2026-11-01T01:30:00.000Z');
  assert.equal(nextAvailableSlot(spec, ['2026-10-25T01:30:00Z'], '2026-10-24T10:00:00Z'), '2026-11-01T01:30:00.000Z');
});

test('uses the configured timezone across date and year boundaries', () => {
  assert.equal(nextAvailableSlot({ days: [5], time: '00:15', timezone: 'Asia/Kathmandu' }, [], '2026-12-31T17:00:00Z'), '2026-12-31T18:30:00.000Z');
  assert.equal(nextAvailableSlot({ days: [4], time: '23:30', timezone: 'America/Los_Angeles' }, [], '2027-01-01T06:00:00Z'), '2027-01-01T07:30:00.000Z');
});

test('handles a long fully booked queue', () => {
  const spec = { days: [5], time: '18:00', timezone: 'UTC' };
  const first = Date.parse('2026-10-09T18:00:00Z');
  const occupied = Array.from({ length: 160 }, (_, i) => new Date(first + i * 7 * 86400000).toISOString());
  assert.equal(nextAvailableSlot(spec, occupied, '2026-10-05T10:00:00Z'), new Date(first + 160 * 7 * 86400000).toISOString());
});

test('validates the complete settings before saving', () => {
  assert.deepEqual(validatePostingSchedule(DEFAULT_POSTING_SCHEDULE), DEFAULT_POSTING_SCHEDULE);
  assert.throws(() => validatePostingSchedule(null));
  assert.throws(() => validatePostingSchedule({}));
  for (const invalid of [{ days: [] }, { days: [5, 5] }, { days: [8] }, { days: ['5'] }, { time: '24:00' }, { time: '18:99' }, { timezone: 'invalid' }]) {
    assert.throws(() => validatePostingSchedule({ ...DEFAULT_POSTING_SCHEDULE, youtube: { ...friday, ...invalid } }));
  }
});

test('a midnight booking blocks the evening slot on the same local date', () => {
  // Friday midnight in Stockholm is Thursday in UTC.
  assert.equal(nextAvailableSlot(friday, ['2026-10-08T22:00:00Z'], '2026-10-05T10:00:00Z'), '2026-10-16T16:00:00.000Z');
  // Even if the earlier post already ran today, don't suggest a second one.
  assert.equal(nextAvailableSlot(friday, ['2026-10-08T22:00:00Z'], '2026-10-09T10:00:00Z'), '2026-10-16T16:00:00.000Z');
  // Thursday in the platform timezone does not occupy Friday.
  assert.equal(nextAvailableSlot(friday, ['2026-10-08T21:59:00Z'], '2026-10-05T10:00:00Z'), '2026-10-09T16:00:00.000Z');
});

test('a later booking on the date blocks an earlier recurring time', () => {
  assert.equal(nextAvailableSlot(friday, ['2026-10-09T21:00:00Z'], '2026-10-05T10:00:00Z'), '2026-10-16T16:00:00.000Z');
});
