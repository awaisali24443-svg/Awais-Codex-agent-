/**
 * The scheduling math and input validation, without a database.
 *
 * All wall-clock cases use Asia/Karachi (+05:00, no DST) so the expectations
 * are exact instants, not vibes.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeNextRun,
  nextDaily,
  nextInterval,
  nextWeekly,
  normalizeTaskInput,
} from './scheduler.js';

const KHI = 'Asia/Karachi';

describe('nextDaily', () => {
  test('a later time today fires today', () => {
    const from = new Date('2026-09-23T08:00:00+05:00'); // Wed
    assert.equal(nextDaily(from, '09:00', KHI).toISOString(), '2026-09-23T04:00:00.000Z');
  });

  test('a past time today fires tomorrow', () => {
    const from = new Date('2026-09-23T10:00:00+05:00');
    assert.equal(nextDaily(from, '09:00', KHI).toISOString(), '2026-09-24T04:00:00.000Z');
  });

  test('exactly at the time fires tomorrow — strictly after', () => {
    const from = new Date('2026-09-23T09:00:00+05:00');
    assert.equal(nextDaily(from, '09:00', KHI).toISOString(), '2026-09-24T04:00:00.000Z');
  });
});

describe('nextWeekly', () => {
  test('a later weekday fires that day this week', () => {
    const from = new Date('2026-09-23T10:00:00+05:00'); // Wed
    assert.equal(
      nextWeekly(from, 5, '09:00', KHI).toISOString(),
      '2026-09-25T04:00:00.000Z', // Friday
    );
  });

  test('the same weekday at a past time fires next week', () => {
    const from = new Date('2026-09-23T10:00:00+05:00'); // Wed
    assert.equal(
      nextWeekly(from, 3, '09:00', KHI).toISOString(),
      '2026-09-30T04:00:00.000Z', // next Wednesday
    );
  });

  test('Sunday wraps from Saturday', () => {
    const from = new Date('2026-09-26T10:00:00+05:00'); // Sat
    assert.equal(
      nextWeekly(from, 0, '09:00', KHI).toISOString(),
      '2026-09-27T04:00:00.000Z', // Sunday
    );
  });
});

describe('nextInterval', () => {
  test('adds whole minutes', () => {
    const from = new Date('2026-09-23T10:00:00Z');
    assert.equal(nextInterval(from, 90).toISOString(), '2026-09-23T11:30:00.000Z');
  });
});

describe('computeNextRun', () => {
  test('dispatches on cadence', () => {
    const from = new Date('2026-09-23T10:00:00+05:00');
    const base = { timezone: KHI, intervalMinutes: null, timeOfDay: null, weekday: null };
    assert.equal(
      computeNextRun({ ...base, cadence: 'interval', intervalMinutes: 30 }, from).toISOString(),
      '2026-09-23T05:30:00.000Z',
    );
    assert.equal(
      computeNextRun({ ...base, cadence: 'daily', timeOfDay: '09:00' }, from).toISOString(),
      '2026-09-24T04:00:00.000Z',
    );
    assert.equal(
      computeNextRun({ ...base, cadence: 'weekly', timeOfDay: '09:00', weekday: 5 }, from).toISOString(),
      '2026-09-25T04:00:00.000Z',
    );
  });
});

describe('normalizeTaskInput', () => {
  test('accepts a valid interval task with defaults', () => {
    const v = normalizeTaskInput({ name: 'Ping', prompt: 'say hi', cadence: 'interval', intervalMinutes: 60 });
    assert.equal(v.timezone, 'Asia/Karachi');
    assert.equal(v.deliver, 'web');
    assert.equal(v.intervalMinutes, 60);
  });

  test('rejects an empty name and an overlong prompt', () => {
    assert.throws(() => normalizeTaskInput({ name: '  ', prompt: 'x', cadence: 'daily', timeOfDay: '09:00' }), /name is empty/);
    assert.throws(
      () => normalizeTaskInput({ name: 'x', prompt: 'y'.repeat(2001), cadence: 'daily', timeOfDay: '09:00' }),
      /limit is 2000/,
    );
  });

  test('rejects bad cadence fields', () => {
    assert.throws(
      () => normalizeTaskInput({ name: 'x', prompt: 'y', cadence: 'interval', intervalMinutes: 3 }),
      /5 to 10080/,
    );
    assert.throws(
      () => normalizeTaskInput({ name: 'x', prompt: 'y', cadence: 'daily', timeOfDay: '9am' }),
      /HH:MM/,
    );
    assert.throws(
      () => normalizeTaskInput({ name: 'x', prompt: 'y', cadence: 'weekly', timeOfDay: '09:00', weekday: 7 }),
      /weekday/,
    );
    assert.throws(
      () => normalizeTaskInput({ name: 'x', prompt: 'y', cadence: 'daily', timeOfDay: '09:00', timezone: 'Mars/Olympus' }),
      /unknown timezone/,
    );
  });
});
