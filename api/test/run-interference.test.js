/* Interference — the rules that keep two plans from becoming one bad week.
 *
 * This file exists because the rules are blocking. A warning that is wrong costs a sentence; a
 * block that is wrong costs the runner the session. So every rule is tested in both directions:
 * it fires on the arrangement it exists to stop, and it stays quiet on the arrangement that is
 * merely tight but legal (a long run two days after squats, easy running on a lifting day).
 *
 * The 50 % leg-day threshold is Linus's call (2026-09-15) and it is pinned here as a value,
 * because "which routines count as leg days" decides every verdict below it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { isLegDay, legDays, checkWeek, checkPlan, legVolumeMultiplier, proximity, addDays, LEG_SHARE_THRESHOLD, LEG_GROUPS } = await import('../coach/run/interference.js');

/* ---------- what counts as a leg day ---------- */

test('a routine is a leg day at half its working sets, not at half its exercises', () => {
  // 4 sets of legs against 1 set of chest: 80 % of the work is legs, and an exercise count
  // would have called this "half leg" and then argued about it. No `bp` field, so the body
  // part comes from the injected library lookup.
  assert.equal(isLegDay({ id: 'a', ex: [{ id: 'q', sets: 4 }, { id: 'c', sets: 1 }] }, id => (id === 'q' ? 'upper legs' : 'chest')), true);
  // Three exercises, four leg sets and four chest sets: exactly at the threshold, and the rule
  // is "at least half" — a dead-even routine is a leg day.
  assert.equal(isLegDay({
    id: 'b',
    ex: [{ id: 'q', sets: 4, bp: 'upper legs' }, { id: 'c', sets: 4, bp: 'chest' }]
  }), true);
  // Just under: 3 leg sets to 4 upper. Not a leg day, and this is the boundary the threshold
  // exists for — a routine with a couple of leg accessories does not cost a long run.
  assert.equal(isLegDay({
    id: 'c',
    ex: [{ id: 'q', sets: 3, bp: 'lower legs' }, { id: 'c', sets: 4, bp: 'back' }]
  }), false);
  assert.equal(LEG_SHARE_THRESHOLD, 0.5);
});

/* The regression guard for the bug that made this whole engine a no-op.
 *
 * `LEG_GROUPS` was written as ['quads','hamstrings','glutes','calves','legs'] — plausible names
 * that appear nowhere in the exercise library, which ships "upper legs" and "lower legs". Every
 * routine therefore scored zero leg work, `isLegDay` returned false for an obvious squat day,
 * and the blocking rules Linus asked for blocked nothing. Nothing failed, because the tests used
 * the same invented strings as the code.
 *
 * This test reads the real library, so the two can never drift apart again. */
test('LEG_GROUPS matches the shipped library exactly', async () => {
  const { LIBRARY } = await import('../coach/core/library.js');
  const real = new Set(LIBRARY.map(e => e.bp));
  for (const g of LEG_GROUPS) {
    assert.ok(real.has(g), `LEG_GROUPS contains ${JSON.stringify(g)}, which is not a body part in the exercise library`);
  }
  // And the negative: the library's own leg categories must all be covered, or a leg day built
  // from calf work alone would slip through the rule.
  for (const bp of real) {
    if (/leg/i.test(bp)) assert.ok(LEG_GROUPS.includes(bp), `library body part ${JSON.stringify(bp)} looks like legs but is not in LEG_GROUPS`);
  }
});

test('a real squat routine from the shipped library is detected as a leg day', async () => {
  const { LIB_BY_ID, LIBRARY } = await import('../coach/core/library.js');
  const squat = LIBRARY.find(e => e.bp === 'upper legs' && /barbell bench squat/.test(e.n));
  assert.ok(squat, 'the library still has a barbell squat');
  const routine = { id: 'legs', name: 'Leg day', ex: [{ id: squat.id, sets: 4 }] };
  assert.equal(isLegDay(routine, id => LIB_BY_ID.get(id)?.bp), true, 'a squat-only routine is a leg day');
});

test('every group in the hip-and-knee chain counts, and the lower back does not', () => {
  for (const bp of ['upper legs', 'lower legs']) {
    assert.equal(isLegDay({ ex: [{ id: 'x', sets: 3, bp }] }), true, `${bp} is leg work`);
  }
  // A deadlift day fatigues the lower back, which is why it is hard — but a long run is not
  // competing with a spinal erector the way it competes with a quadriceps.
  assert.equal(isLegDay({ ex: [{ id: 'x', sets: 4, bp: 'back' }, { id: 'y', sets: 1, bp: 'lower legs' }] }), false);
  // An empty routine is not a leg day. Zero sets is not a heavy day, and returning true here
  // would make every unedited routine block the calendar.
  assert.equal(isLegDay({ ex: [] }), false);
  assert.equal(isLegDay(null), false);
});

test('leg days come out of the strength plan as dates', () => {
  const S = {
    routines: [{ id: 'legs', ex: [{ id: 'q', sets: 4, bp: 'upper legs' }] }],
    // 2026-09-22 is a Tuesday, 2026-09-25 a Friday.
    week: { 2: 'legs', 5: 'legs', 4: 'legs' }
  };
  const days = legDays(S, { from: '2026-09-21', to: '2026-09-28' });
  assert.deepEqual([...days].sort(), ['2026-09-22', '2026-09-24', '2026-09-25']);
});

test('a day with two routines is a leg day if either of them is', () => {
  const S = {
    routines: [
      { id: 'legs', ex: [{ id: 'q', sets: 5, bp: 'upper legs' }] },
      { id: 'upper', ex: [{ id: 'c', sets: 5, bp: 'chest' }] }
    ],
    week: { 2: ['upper', 'legs'] }
  };
  assert.ok(legDays(S, { from: '2026-09-21', to: '2026-09-23' }).has('2026-09-22'));
});

/* ---------- the 48-hour rules ---------- */

const week = (sessions, phase = 'build') => ({
  wk: 1, phase, km: sessions.reduce((a, s) => a + (s.km || 0), 0), sessions
});
// Tue legs, Fri legs. The dates below are the real week: 21 Mon, 22 Tue, 23 Wed, 24 Thu, 25 Fri,
// 26 Sat, 27 Sun. 2026-09-21 is a Monday, so "the day after Friday" is Saturday the 26th.
const LEG_TUE_FRI = new Set(['2026-09-22', '2026-09-25']);

test('a long run the day after a leg day is blocked', () => {
  const w = week([{ d: '2026-09-26', type: 'long', km: 16 }]);
  const errors = checkWeek(w, LEG_TUE_FRI);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'leg-long');
  // The message has to name the fix, because the person reading it is a runner looking at a
  // screen at 21:00 deciding whether to move tomorrow's run.
  assert.match(errors[0].fix, /move it to 2026-09-27/);
});

test('a long run two days after a leg day is legal', () => {
  // Sunday, two days after Friday's legs: the first arrangement the rule allows.
  const w = week([{ d: '2026-09-27', type: 'long', km: 16 }]);
  assert.deepEqual(checkWeek(w, LEG_TUE_FRI), []);
});

test('an interval session the day after a leg day is blocked', () => {
  const w = week([{ d: '2026-09-23', type: 'interval', km: 8 }]);
  const errors = checkWeek(w, LEG_TUE_FRI);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'leg-quality');
  assert.equal(errors[0].legDay, 1, 'the nearest leg day is one day behind');
});

// The rule the long-run case above does not cover: Tuesday's legs against Wednesday's intervals.
// Both must fire, and neither may fire on the reverse arrangement.
test('the rule is about the day after, not about the same week', () => {
  const tueLegs = new Set(['2026-09-22']);
  assert.equal(checkWeek(week([{ d: '2026-09-23', type: 'tempo', km: 8 }]), tueLegs).length, 1, 'Wednesday is one day after Tuesday');
  assert.equal(checkWeek(week([{ d: '2026-09-24', type: 'tempo', km: 8 }]), tueLegs).length, 0, 'Thursday is two days after Tuesday');
});

test('easy and recovery running are never blocked by a leg day', () => {
  // The rule is about intensity, not about touching a leg. Twenty easy minutes after the bar is
  // active recovery and blocking it would be the rule fighting the training.
  const w = week([
    { d: '2026-09-23', type: 'easy', km: 6 },
    { d: '2026-09-26', type: 'recovery', km: 5 }
  ]);
  assert.deepEqual(checkWeek(w, LEG_TUE_FRI), []);
});

test('a quality session and a long run are separated by at least a day', () => {
  const w = week([
    { d: '2026-09-26', type: 'long', km: 16 },
    { d: '2026-09-26', type: 'tempo', km: 8, structure: [{ rep: 1, dist: 6000 }] }
  ]);
  const errors = checkWeek(w, new Set());
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'long-quality');
  assert.match(errors[0].message, /0 day\(s\) from the long run/);
});

test('a deload week is allowed the tight arrangement', () => {
  // In a deload the whole point is that the week is light; refusing the same spacing here
  // protects the rule instead of the runner.
  const w = week([{ d: '2026-09-26', type: 'long', km: 7 }], 'deload');
  assert.deepEqual(checkWeek(w, LEG_TUE_FRI), []);
});

test('a leg day after a quality run is legal — the rule is directional', () => {
  // Interval Monday, legs Tuesday. The hard session came first, so Tuesday's squats are paid for
  // out of Monday's recovery, which is normal training. Blocking this would make a hybrid week
  // impossible.
  const w = week([{ d: '2026-09-21', type: 'interval', km: 8 }]);
  assert.deepEqual(checkWeek(w, new Set(['2026-09-22'])), []);
});

/* ---------- the whole plan ---------- */

const RUN = {
  zones: { thresholdPace: 300, unit: 'km' },
  weeks: [
    { wk: 1, phase: 'build', km: 35, sessions: [
      { id: 's1', d: '2026-09-23', type: 'interval', km: 8 },
      { id: 's2', d: '2026-09-27', type: 'long', km: 14 },
      { id: 's3', d: '2026-09-21', type: 'easy', km: 6 }
    ] },
    // Week 2 is clean: the interval is on Thursday the 1st, two days after Tuesday legs, and the
    // long run is Sunday the 4th. Week 1 is the one that clashes, and the plan report has to
    // name exactly that week.
    { wk: 2, phase: 'build', km: 38, sessions: [
      { id: 's4', d: '2026-10-01', type: 'interval', km: 8 },
      { id: 's5', d: '2026-10-04', type: 'long', km: 16 }
    ] }
  ]
};
const S_PLAN = {
  routines: [{ id: 'legs', ex: [{ id: 'q', sets: 4, bp: 'upper legs' }] }],
  week: { 2: 'legs' }
};

test('a plan with a clash reports the week and says it blocks', () => {
  // Week 1's interval sits on Wednesday, the day after Tuesday legs — a real clash. Week 2 is
  // clean (legs are Tuesday, intervals the following Wednesday, long run Sunday).
  const r = checkPlan(RUN, S_PLAN);
  assert.equal(r.ok, false);
  assert.equal(r.blocking, true);
  assert.equal(r.weeks.length, 1);
  assert.equal(r.weeks[0].wk, 1);
  assert.ok(r.counts.violations >= 1);
});

test('a plan whose run days avoid the leg days reports nothing', () => {
  const clean = JSON.parse(JSON.stringify(RUN));
  clean.weeks[0].sessions[0].d = '2026-09-24';   // Thursday, two days after Tuesday legs
  const r = checkPlan(clean, S_PLAN);
  assert.equal(r.ok, true);
  assert.equal(r.blocking, false);
  assert.deepEqual(r.weeks, []);
});

test('without a strength plan there is nothing to interfere with', () => {
  const r = checkPlan(RUN, { routines: [], week: {} });
  assert.equal(r.ok, true);
  assert.equal(r.legDays.length, 0);
});

/* ---------- what the prompt is told ---------- */

test('proximity reports the hours from the nearest leg day, and whether it is legal', () => {
  const p = proximity(RUN, S_PLAN);
  const interval = p.find(x => x.d === '2026-09-23');
  assert.equal(interval.hoursFromLegDay, 24, 'Wednesday is 24 hours after Tuesday legs');
  assert.equal(interval.legal, false);
  const long = p.find(x => x.d === '2026-09-27');
  assert.equal(long.hoursFromLegDay, -48, 'Sunday is two days *before* the next Tuesday legs');
  assert.equal(long.legal, true, 'a leg day still ahead of the long run is not interference');
  // The long run is listed even though it is not `quality` — it is the session the report exists
  // for. Easy sessions are not, because the rules cannot be broken by one.
  assert.ok(p.some(x => x.type === 'long'));
  assert.equal(p.some(x => x.type === 'easy'), false);
});

test('the leg-volume multiplier halves the cap once two quality runs share the week', () => {
  const withTwo = { weeks: [{ wk: 1, sessions: [{ type: 'interval' }, { type: 'tempo' }] }] };
  const withOne = { weeks: [{ wk: 1, sessions: [{ type: 'interval' }, { type: 'easy' }] }] };
  assert.equal(legVolumeMultiplier(withTwo, 1), 0.75);
  assert.equal(legVolumeMultiplier(withOne, 1), 1);
  assert.equal(legVolumeMultiplier(withTwo, 9), 1, 'a week that is not in the plan has no cap');
});

test('addDays is calendar-correct across a month boundary', () => {
  assert.equal(addDays('2026-09-30', 2), '2026-10-02');
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
});
