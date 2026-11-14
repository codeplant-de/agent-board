import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractError } from '../src/contract.mts';
import { formatDuration, parseDuration, parseWhen } from '../src/time.mts';

const MIN = 60_000;

test('parseDuration reads units and their combinations', () => {
  assert.equal(parseDuration('30m'), 30 * MIN);
  assert.equal(parseDuration('2h'), 120 * MIN);
  assert.equal(parseDuration('1h30m'), 90 * MIN);
  assert.equal(parseDuration(' 2d '), 2 * 1440 * MIN);
  assert.equal(parseDuration('1w2d'), 9 * 1440 * MIN);
});

test('parseDuration names the accepted forms when it rejects', () => {
  for (const bad of ['', '  ', '0m', '0h0m', '-5m', '5', '5x', '30m1h', '1.5h', 'soon']) {
    assert.throws(
      () => parseDuration(bad),
      (error) => error instanceof ContractError && /m, h, d, w/.test(error.message),
    );
  }
});

test('formatDuration is compact and inverts parseDuration', () => {
  assert.equal(formatDuration(2 * 60 * MIN), '2h');
  assert.equal(formatDuration(90 * MIN), '1h 30m');
  assert.equal(formatDuration(9 * 1440 * MIN), '1w 2d');
  assert.equal(formatDuration(0), '0m');
  for (const text of ['45m', '3h', '1d', '1w3d4h5m'])
    assert.equal(parseDuration(formatDuration(parseDuration(text))), parseDuration(text));
});

const now = new Date(2026, 10, 14, 10, 0, 0);

test('parseWhen reads ISO with an offset as that instant', () => {
  assert.equal(parseWhen('2027-01-01T12:00:00Z', now).toISOString(), '2027-01-01T12:00:00.000Z');
  assert.equal(parseWhen('2027-01-01T12:00+02:00', now).toISOString(), '2027-01-01T10:00:00.000Z');
});

test('parseWhen reads ISO without an offset, and a date, as local time', () => {
  assert.equal(parseWhen('2027-01-01T12:00', now).getTime(), new Date(2027, 0, 1, 12, 0).getTime());
  assert.equal(parseWhen('2027-01-01T12:00:30', now).getTime(), new Date(2027, 0, 1, 12, 0, 30).getTime());
  assert.equal(parseWhen('2027-01-01', now).getTime(), new Date(2027, 0, 1).getTime());
});

test('parseWhen reads HH:MM as the next occurrence', () => {
  assert.equal(parseWhen('14:30', now).getTime(), new Date(2026, 10, 14, 14, 30).getTime());
  assert.equal(parseWhen('9:15', now).getTime(), new Date(2026, 10, 15, 9, 15).getTime());
  assert.equal(parseWhen('10:00', now).getTime(), new Date(2026, 10, 15, 10, 0).getTime());
  const monthEnd = new Date(2026, 10, 30, 23, 0);
  assert.equal(parseWhen('08:00', monthEnd).getTime(), new Date(2026, 11, 1, 8, 0).getTime());
});

test('parseWhen rejects what is not a time or is not ahead', () => {
  for (const bad of [
    '',
    'tomorrow',
    '25:00',
    '12:60',
    '2027-02-30',
    '2027-13-01',
    '2027-01-01T25:00',
    '2027-01-01 12:00',
  ])
    assert.throws(() => parseWhen(bad, now), /is not a time; use .*09:30/, bad);
  assert.throws(() => parseWhen('2026-11-14T09:00', now), /is in the past/);
  assert.throws(() => parseWhen('2026-11-14T10:00', now), /is in the past/);
  assert.throws(() => parseWhen('2020-01-01T00:00:00Z', now), /is in the past/);
});
