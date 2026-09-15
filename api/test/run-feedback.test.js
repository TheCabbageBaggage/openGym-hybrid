import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData, sampleState } from './helpers.mjs';

tempData();
const payload = await import('../coach/core/payload.js');
const { handleFor } = await import('../coach/handle.js');

/* The cross-discipline signal.
 *
 * This file exists because of a real bug: `legDayProximity` never fired. The leg-day detector
 * returned weekday numbers and the comparison fed them to a date differencing helper, which
 * returned NaN - so `NaN < 2` was false for every session and the array was always empty. The
 * signal that Phase 4 is built on was dead and nothing noticed, because no test asserted the
 * *positive* case. These tests do.
 *
 * The shape of the fixture matters: `S.week` is a weekly pattern with weekday keys, while run
 * sessions carry ISO dates. Getting from one to the other is the whole job. */

/* A leg-heavy routine (every exercise is a leg body part) and an upper-body one, so we can
 * place leg days deliberately and prove the detector reads the exercise library, not names. */
const LEG_HEAVY = {
  id: 'legs', name: 'Leg day', emoji: '🦵', prog: 'linear',
  ex: [
    { id: '0026', sets: 3, reps: 8, mode: 'reps', weight: 60, prog: 'linear' },
    { id: '0024', sets: 3, reps: 8, mode: 'reps', weight: 50, prog: 'linear' },
    { id: '0029', sets: 3, reps: 10, mode: 'reps', weight: 40, prog: 'linear' }
  ]
};
const UPPER = {
  id: 'push', name: 'Push day', emoji: '💪', prog: 'linear',
  ex: [{ id: '0025', sets: 3, reps: 10, mode: 'reps', weight: 20, prog: 'linear' }]
};

/** One week of running: a long run and an interval day, on the given ISO dates. */
const runWeek = (longDate, intervalDate) => ({
  calibration: { source: 'test', thresholdPace: 303, thresholdHR: 162, done: true },
  zones: { thresholdPace: 303, thresholdHR: 162, unit: 'km', hrMax: null, paceZones: {} },
  weeks: [{
    wk: 1, phase: 'base', km: 30,
    sessions: [
      { id: 'r_long', d: longDate, type: 'long', km: 16, done: false },
      { id: 'r_int', d: intervalDate, type: 'interval', km: 8, structure: [{ rep: 6, dist: 800, paceZone: 'interval', restSec: 90 }], done: false }
    ]
  }]
});

const runAgg = S => payload.build(S, { handle: handleFor('u1'), kind: 'review' }).aggregates.run;

/* Which body part is which in the real library decides whether this detector works at all, so
 * the test pins the assumption rather than trusting a comment. This is the regression guard for
 * the vocabulary bug: the detector was written against invented group names (`'legs'`, `'quads'`)
 * while the library ships `"upper legs"` / `"lower legs"`, so it matched nothing and reported
 * every routine as a non-leg day. */
test('the leg-heavy fixture really is leg-heavy in the shipped library', async () => {
  const { LIB_BY_ID } = await import('../coach/core/library.js');
  for (const id of ['0026', '0024', '0029']) {
    const bp = LIB_BY_ID.get(id)?.bp;
    assert.ok(['upper legs', 'lower legs'].includes(bp), `${id} is ${JSON.stringify(bp)}, expected a leg body part`);
  }
  assert.ok(!['upper legs', 'lower legs'].includes(LIB_BY_ID.get('0025')?.bp), '0025 must not be a leg part');
});

test('run aggregates are absent without a running plan, so strength-only users pay nothing', () => {
  const p = payload.build(sampleState(), { handle: handleFor('u1'), kind: 'review' });
  // The run block is spread into the parent, so "no running plan" means the key is absent
  // entirely rather than an empty object — nothing is sent, so nothing is billed.
  assert.equal(p.aggregates.run, undefined, 'no run namespace means no run aggregates');
  assert.ok(!JSON.stringify(p).includes('legDayProximity'), 'the run block must not leak into a strength payload');
});

test('leg day weekdays are reported so a reader can see which days they are', () => {
  const S = sampleState({
    routines: [LEG_HEAVY, UPPER],
    week: { 1: 'legs', 3: 'push' },
    run: runWeek('2026-09-19', '2026-09-23')
  });
  assert.deepEqual(runAgg(S).legDayWeekdays, [1], 'only the leg-heavy routine counts');
});

test('a long run the day after a heavy leg day is reported as proximity 1', () => {
  // 2026-09-21 is a Monday (weekday 1), so a Tuesday 22nd long run is exactly one day after.
  const S = sampleState({
    routines: [LEG_HEAVY, UPPER],
    week: { 1: 'legs' },
    run: runWeek('2026-09-22', '2026-09-25')
  });
  const agg = runAgg(S);
  assert.deepEqual(agg.legDayProximity, [{ d: '2026-09-22', type: 'long', daysFromLegDay: 1 }]);
});

test('the day before a leg day counts too — the rule is distance, not direction', () => {
  // Leg day Monday the 21st; a Sunday the 20th long run is one day away.
  const S = sampleState({
    routines: [LEG_HEAVY, UPPER],
    week: { 1: 'legs' },
    run: runWeek('2026-09-20', '2026-09-24')
  });
  const agg = runAgg(S);
  assert.deepEqual(agg.legDayProximity, [{ d: '2026-09-20', type: 'long', daysFromLegDay: 1 }]);
});

test('a well-spaced plan reports no proximity conflict', () => {
  // Leg day Monday the 21st; long run Thursday the 24th is three days away.
  const S = sampleState({
    routines: [LEG_HEAVY, UPPER],
    week: { 1: 'legs' },
    run: runWeek('2026-09-24', '2026-09-26')
  });
  assert.deepEqual(runAgg(S).legDayProximity, [], '48h+ of separation is not a conflict');
});

test('the proximity signal is empty when no leg day exists, and does not throw', () => {
  const S = sampleState({
    routines: [UPPER],
    week: { 1: 'push', 3: 'push' },
    run: runWeek('2026-09-22', '2026-09-25')
  });
  const agg = runAgg(S);
  assert.deepEqual(agg.legDayProximity, []);
  assert.deepEqual(agg.legDayWeekdays, []);
});

test('a quality run close to a leg day is reported, not just the long run', () => {
  // Leg day Monday; interval session Tuesday. Both are protected by the rule.
  const S = sampleState({
    routines: [LEG_HEAVY, UPPER],
    week: { 1: 'legs' },
    run: runWeek('2026-09-25', '2026-09-22')
  });
  const agg = runAgg(S);
  assert.deepEqual(agg.legDayProximity, [{ d: '2026-09-22', type: 'interval', daysFromLegDay: 1 }]);
});

test('an easy run next to a leg day is not a conflict — it is the recommended pairing', () => {
  const S = sampleState({
    routines: [LEG_HEAVY, UPPER],
    week: { 1: 'legs' },
    run: {
      calibration: { source: 'test', thresholdPace: 303, done: true },
      zones: { thresholdPace: 303, unit: 'km', paceZones: {} },
      weeks: [{ wk: 1, phase: 'base', km: 20, sessions: [{ id: 'e1', d: '2026-09-22', type: 'easy', km: 6, done: false }] }]
    }
  });
  assert.deepEqual(runAgg(S).legDayProximity, [], 'easy runs are allowed on and around leg days');
});

test('a week with two or more quality runs reports the leg-volume cap', () => {
  const S = sampleState({
    routines: [LEG_HEAVY, UPPER],
    week: { 1: 'legs' },
    run: {
      calibration: { source: 'test', thresholdPace: 303, done: true },
      zones: { thresholdPace: 303, unit: 'km', paceZones: {} },
      weeks: [{
        wk: 1, phase: 'build', km: 40,
        sessions: [
          { id: 'a', d: '2026-09-22', type: 'interval', km: 8, done: false },
          { id: 'b', d: '2026-09-24', type: 'threshold', km: 10, done: false },
          { id: 'c', d: '2026-09-26', type: 'easy', km: 6, done: false }
        ]
      }]
    }
  });
  assert.deepEqual(runAgg(S).legVolumeConflicts, [{ wk: 1, qualityRuns: 2, legVolumeScale: 0.75 }]);
});

test('a week with one quality run does not trigger the cap', () => {
  const S = sampleState({
    routines: [LEG_HEAVY, UPPER],
    week: { 1: 'legs' },
    run: {
      calibration: { source: 'test', thresholdPace: 303, done: true },
      zones: { thresholdPace: 303, unit: 'km', paceZones: {} },
      weeks: [{
        wk: 1, phase: 'build', km: 30,
        sessions: [
          { id: 'a', d: '2026-09-22', type: 'interval', km: 8, done: false },
          { id: 'b', d: '2026-09-25', type: 'easy', km: 8, done: false }
        ]
      }]
    }
  });
  assert.deepEqual(runAgg(S).legVolumeConflicts, []);
});

test('compliance counts a hand-ticked session and a synced one alike, but reports both', () => {
  const S = sampleState({
    run: {
      calibration: { source: 'test', thresholdPace: 303, done: true },
      zones: { thresholdPace: 303, unit: 'km', paceZones: {} },
      weeks: [{
        wk: 1, phase: 'base', km: 20,
        sessions: [
          { id: 'a', d: '2020-01-01', type: 'easy', km: 6, done: true },
          { id: 'b', d: '2020-01-02', type: 'easy', km: 6, actual: { distKm: 6, avgPaceSec: 320 } },
          { id: 'c', d: '2020-01-03', type: 'easy', km: 6, done: false }
        ]
      }]
    }
  });
  const agg = runAgg(S);
  assert.equal(agg.sessionsDue, 3);
  assert.equal(agg.sessionsDone, 2, 'ticked and synced both count');
  assert.equal(agg.compliancePct, 67);
  assert.equal(agg.paceTrend.length, 1, 'only a synced activity feeds the pace trend');
});
