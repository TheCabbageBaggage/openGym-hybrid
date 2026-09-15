/* The running domain, on its own — no server, no provider, no state file.
 *
 * These are the fixtures the rest of the hybrid feature is pinned to. Every one of them is a
 * behaviour that was wrong at least once while this was being built: a long run that ignored
 * the week it sat in, a "deload" that never came down, a plan whose eighth week was lighter than
 * its first, a week that breached 80/20 in every single week and reported it as a warning.
 *
 * A change to any of these numbers is a change to every plan the Coach will ever write, so they
 * are asserted as values rather than as ranges.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const plan = await import('../coach/run/plan.js');
const zones = await import('../coach/run/zones.js');
const vocab = await import('../coach/run/vocab.js');

const SLOTS_32 = [
  { weekday: 2, type: 'interval' },
  { weekday: 4, type: 'easy' },
  { weekday: 0, type: 'long' }
];
const build = (over = {}) => plan.buildWeeks({ startDate: '2026-09-21', weeks: 12, thresholdPace: 300, volumeStart: 35, slots: SLOTS_32, ...over });

/* ---------------- zones ---------------- */

test('the zone table is derived from threshold pace and pinned', () => {
  const z = zones.zonesFrom(300);
  assert.deepEqual(z.easy, [345, 390]);
  assert.deepEqual(z.threshold, [297, 309]);
  assert.deepEqual(z.interval, [270, 294]);
  assert.deepEqual(z.recovery, [375, 420]);
  assert.deepEqual(z.marathon, [309, 330]);
  assert.deepEqual(z.repetition, [255, 276]);
});

test('a slower pace is a larger number, and the zone lookup respects that', () => {
  const z = zones.zonesFrom(300);
  // 5:00/km is exactly threshold.
  assert.equal(zones.zoneOf(300, z), 'threshold');
  // 6:00/km is an easy/recovery pace, not an interval.
  assert.ok(['easy', 'recovery'].includes(zones.zoneOf(360, z)));
  // 4:30/km is interval work.
  assert.equal(zones.zoneOf(270, z), 'interval');
  // And the direction: every band is [fast, slow], so [0] < [1] everywhere.
  for (const [name, band] of Object.entries(z)) {
    assert.ok(band[0] < band[1], `${name} band is written slowest-first: ${band}`);
  }
});

test('threshold pace comes from the last twenty minutes of a thirty-minute test', () => {
  // No splits: the whole effort is the only evidence, so the estimate sits just below the
  // average (the settling-in period is not represented) and is flagged as a proxy.
  const even = zones.thresholdFromTest({ minutes: 30, distKm: 6 });
  assert.equal(even.avgPace, 300);
  assert.ok(even.thresholdPace <= even.avgPace && even.thresholdPace > even.avgPace * 0.8, 'the estimate is close to the average');
  assert.equal(even.estimated, true, 'no splits means the answer is a proxy and says so');

  // Split run: started slowly, finished fast. The last 20 minutes are quicker, so the threshold
  // pace must be quicker than the average — this is the whole reason the window exists.
  const splits = [
    { sec: 600, distKm: 1.8 },   // 10 min at 5:33
    { sec: 600, distKm: 2.0 },   // 10 min at 5:00
    { sec: 600, distKm: 2.2 }    // 10 min at 4:33
  ];
  const r = zones.thresholdFromTest({ minutes: 30, distKm: 6.0, splits });
  assert.equal(r.estimated, false);
  assert.ok(r.thresholdPace < r.avgPace, 'the steady window is faster than the whole effort');
  // The last 20 minutes of a 30-minute test are the last two splits: 1200 s over 4.2 km.
  assert.equal(r.thresholdPace, Math.round(1200 / 4.2));
});

test('a nonsense calibration produces no zones rather than a plan on a guessed pace', () => {
  assert.equal(zones.thresholdFromTest(null), null);
  assert.equal(zones.thresholdFromTest({ minutes: 0, distKm: 0 }), null);
  assert.equal(zones.zonesFrom(NaN), null);
});

test('pace and distance convert for display without touching what is stored', () => {
  assert.equal(zones.displayPace(300, 'km'), '5:00');
  assert.equal(zones.displayPace(300, 'mi'), '8:03');
  assert.equal(zones.toDisplayDist(10, 'km'), 10);
  assert.ok(Math.abs(zones.toDisplayDist(10, 'mi') - 6.2137) < 0.001);
});

/* ---------------- the vocabulary ---------------- */

test('there are nineteen workout types and the strides are one of them', () => {
  assert.equal(vocab.RUN_TYPES.length, 19);
  assert.ok(vocab.RUN_TYPES.includes('strides'), 'Steigerungsläufe are a first-class type');
  assert.ok(vocab.RUN_TYPES.includes('long'));
  assert.ok(vocab.RUN_TYPES.includes('interval'));
});

test('a recovery run is not a hard session and a threshold run is', () => {
  assert.equal(vocab.WORKOUT_TYPES.recovery.quality, false);
  assert.equal(vocab.WORKOUT_TYPES.easy.quality, false);
  assert.equal(vocab.WORKOUT_TYPES.long.quality, false, 'the long run is volume, not intensity');
  assert.equal(vocab.WORKOUT_TYPES.threshold.quality, true);
  assert.equal(vocab.WORKOUT_TYPES.interval.quality, true);
  assert.equal(vocab.WORKOUT_TYPES.strides.quality, false, 'strides are short enough not to count');
});

/* ---------------- volume progression ---------------- */

test('a plan grows, and never by more than ten percent a week', () => {
  const r = build();
  const growing = r.weeks.filter(w => !['deload', 'taper'].includes(w.phase));
  for (const w of growing) {
    const prev = r.weeks[w.wk - 2];
    if (!prev || ['deload', 'taper'].includes(prev.phase)) continue;
    const ratio = w.km / prev.km;
    assert.ok(ratio <= 1.101, `week ${w.wk} grew by ${((ratio - 1) * 100).toFixed(1)}%`);
    assert.ok(ratio >= 1.0, `week ${w.wk} shrank without being a deload`);
  }
});

test('the plan is heavier at the end of its build than at the start', () => {
  const r = build({ weeks: 16 });
  const first = r.weeks[0].km;
  const lastBuild = r.weeks.filter(w => w.phase === 'build').slice(-1)[0];
  assert.ok(lastBuild.km > first * 1.5, `a block that does not build is not a block: ${first} → ${lastBuild.km}`);
});

test('a deload comes down and the next week grows from the peak, not from the deload', () => {
  const r = build();
  const deload = r.weeks.find(w => w.phase === 'deload');
  const before = r.weeks[deload.wk - 2];
  assert.ok(deload.km < before.km * 0.8, 'a deload has to be a step down');

  const after = r.weeks[deload.wk];
  assert.ok(after.km > deload.km * 1.15, 'the week after a deload resumes');
  // The bug this pins: tracking only one running total means every deload permanently lowers
  // the base, so the block ratchets downwards and the last build week is lighter than the first.
  assert.ok(after.km >= before.km, `week ${after.wk} (${after.km}) is lighter than week ${before.wk} (${before.km})`);
});

test('the taper sharpens — every taper week is lighter than the one before', () => {
  const r = build({ weeks: 16 });
  const taper = r.weeks.filter(w => w.phase === 'taper');
  assert.ok(taper.length >= 2, 'a sixteen-week block earns a real taper');
  for (let i = 1; i < taper.length; i++) {
    assert.ok(taper[i].km < taper[i - 1].km, `taper week ${taper[i].wk} did not come down`);
  }
});

test('a short block is not all taper', () => {
  // Four weeks is a legitimate ask, and the naive `wk > weeks - 2` rule makes half of it a
  // taper — a four-week plan that backs off for two of them is not a training block.
  const r = build({ weeks: 4 });
  assert.equal(r.weeks.filter(w => w.phase === 'taper').length, 0);
  assert.ok(r.weeks[3].km > r.weeks[0].km, 'it still builds');
});

/* ---------------- the 80/20 rule ---------------- */

test('no week in any plan breaches 80/20', () => {
  for (const weeks of [4, 8, 12, 16, 24]) {
    for (const volumeStart of [20, 30, 50, 80]) {
      const r = build({ weeks, volumeStart });
      for (const w of r.weeks) {
        const h = plan.hardShare(w);
        assert.ok(h.ok, `${weeks}w/${volumeStart}km week ${w.wk}: ${(h.share * 100).toFixed(1)}% hard`);
      }
    }
  }
});

test('80/20 is met by shortening the intervals, never by lengthening the easy runs', () => {
  // A week holding far more quality than its volume can carry: the repetitions have to give.
  const sessions = [
    plan.makeSession({ d: '2026-09-22', type: 'interval', structure: [{ rep: 10, dist: 1200, paceZone: 'interval', restSec: 90 }] }),
    plan.makeSession({ d: '2026-09-27', type: 'long', km: 12 })
  ];
  const before = sessions[0].structure[0].rep;
  plan.clampHardShare(sessions);
  assert.ok(sessions[0].structure[0].rep < before, 'the intervals got shorter');
  assert.ok(plan.hardShare({ sessions }).ok, 'and the week is legal');
});

/* ---------------- the volume target is honoured ---------------- */

test('a plan starts at the volume it was asked for, unless its own sessions need more', () => {
  for (const volumeStart of [30, 35, 50, 70]) {
    const r = build({ volumeStart, weeks: 6 });
    const floor = plan.weekFloor(r.weeks[0].sessions);
    assert.equal(r.weeks[0].km, Math.max(volumeStart, floor), `asked for ${volumeStart}, got ${r.weeks[0].km} (floor ${floor})`);
  }
});

test('a week too small for its own interval session is raised, not silently shrunk', () => {
  // Three sessions with one interval workout cannot be done on 20 km: the hard running alone is
  // ~6.8 km and 80/20 caps that at a fifth of the week. The honest answer is a bigger week.
  const r = build({ volumeStart: 20, weeks: 6 });
  assert.ok(r.weeks[0].km > 20, 'the week was raised');
  assert.ok(r.weeks[0].km >= plan.weekFloor(r.weeks[0].sessions), 'and it is above its own floor');
});

/* ---------------- the shape of a week ---------------- */

test('the long run is a share of its week, not a fixed distance', () => {
  const r = build();
  for (const w of r.weeks) {
    const long = w.sessions.find(s => s.type === 'long');
    if (!long) continue;
    const share = long.km / w.km;
    assert.ok(share >= 0.25 && share <= 0.41, `week ${w.wk}: long run is ${(share * 100).toFixed(0)}% of the week`);
  }
});

test('the long run comes down in a deload like everything else', () => {
  const r = build({ volumeStart: 45 });
  const deload = r.weeks.find(w => w.phase === 'deload');
  const before = r.weeks[deload.wk - 2];
  const longBefore = before.sessions.find(s => s.type === 'long').km;
  const longDeload = deload.sessions.find(s => s.type === 'long').km;
  assert.ok(longDeload < longBefore, `the long run ignored the deload: ${longBefore} → ${longDeload}`);
});

test('the interval session grows through the build and holds its repetitions', () => {
  const r = build({ weeks: 16 });
  const reps = r.weeks.map(w => w.sessions.find(s => s.type === 'interval')?.structure?.[0]?.rep ?? 0);
  const buildReps = r.weeks.filter(w => ['base', 'build', 'peak'].includes(w.phase))
    .map(w => w.sessions.find(s => s.type === 'interval').structure[0].rep);
  for (let i = 1; i < buildReps.length; i++) {
    assert.ok(buildReps[i] >= buildReps[i - 1], `reps went backwards: ${buildReps.join(',')}`);
  }
  assert.ok(Math.max(...reps) > Math.min(...reps), 'the intervals do progress');
  assert.ok(Math.max(...reps) <= 10, 'and stop at ten');
});

test('a day with no running is left empty rather than filled with a recovery jog', () => {
  const r = build({ slots: [{ weekday: 2, type: 'interval' }, { weekday: 0, type: 'long' }] });
  for (const w of r.weeks) assert.equal(w.sessions.length, 2);
});

test('an explicit rest day is the absence of a session', () => {
  const r = build({ slots: [{ weekday: 2, type: 'interval' }, { weekday: 3, type: 'rest' }, { weekday: 0, type: 'long' }] });
  for (const w of r.weeks) {
    assert.equal(w.sessions.length, 2);
    assert.ok(!w.sessions.some(s => s.type === 'rest'));
  }
});

test('sessions land on the weekdays they were asked for', () => {
  const r = build({ weeks: 4 });
  const interval = r.weeks.flatMap(w => w.sessions).filter(s => s.type === 'interval');
  for (const s of interval) assert.equal(plan.weekdayOf(s.d), 2, `${s.d} is not a Tuesday`);
});

/* ---------------- validation ---------------- */

test('a well-formed plan validates', () => {
  const r = build();
  const res = plan.validateRunPlan({ zones: { thresholdPace: 300, unit: 'km', paceZones: r.paceZones }, weeks: r.weeks });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test('a zone table that disagrees with its own threshold pace is refused', () => {
  // The table is derived. A stale one silently prescribes the wrong pace for months, and it is
  // cheap to detect because the two fields can be compared.
  const r = build();
  const res = plan.validateRunPlan({
    zones: { thresholdPace: 300, unit: 'km', paceZones: zones.zonesFrom(260) },
    weeks: r.weeks
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => e.includes('paceZones')));
});

test('an invented workout type is refused', () => {
  const r = build({ weeks: 2 });
  r.weeks[0].sessions[0].type = 'ultramarathon';
  const res = plan.validateRunPlan({ weeks: r.weeks });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => e.includes('ultramarathon')));
});

test('a session id used twice is refused', () => {
  const r = build({ weeks: 2 });
  const id = r.weeks[0].sessions[0].id;
  r.weeks[1].sessions[0].id = id;
  const res = plan.validateRunPlan({ weeks: r.weeks });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => e.includes('used twice')));
});

test('a session prescribing a pace zone the plan has no band for is refused', () => {
  const r = build({ weeks: 2 });
  r.weeks[0].sessions[0].structure[0].paceZone = 'sprint';
  const res = plan.validateRunPlan({ zones: { thresholdPace: 300, unit: 'km', paceZones: r.paceZones }, weeks: r.weeks });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => e.includes('sprint')));
});

test('a mileage of zero is legal and a missing mileage is not', () => {
  const r = build({ weeks: 2 });
  assert.equal(plan.validateRunPlan({ weeks: r.weeks }).ok, true);
  delete r.weeks[0].sessions[0].km;
  assert.equal(plan.validateRunPlan({ weeks: r.weeks }).ok, false);
});

/* ---------------- summaries ---------------- */

test('the summary counts what the plan actually contains', () => {
  const r = build({ weeks: 12 });
  const s = plan.planSummary({ weeks: r.weeks });
  assert.equal(s.weeks, 12);
  assert.equal(s.longRuns, 12);
  assert.equal(s.qualitySessions, 12, 'one interval session a week');
  assert.ok(s.totalKm > 0 && s.avgKm > 0);
});

test('compliance counts only what is already due', () => {
  const r = build({ weeks: 8 });
  const all = r.weeks.flatMap(w => w.sessions);
  const mid = all[Math.floor(all.length / 2)].d;
  const due = all.filter(s => s.d <= mid);
  due.slice(0, 3).forEach(s => { s.done = true; });
  const c = plan.compliance({ weeks: r.weeks }, mid);
  assert.equal(c.due, due.length);
  assert.equal(c.done, Math.min(3, due.length));
  assert.equal(c.pct, Math.round(Math.min(3, due.length) / due.length * 100));
});

test('an empty plan summarises without inventing anything', () => {
  const s = plan.planSummary({});
  assert.equal(s.weeks, 0);
  assert.equal(s.totalKm, 0);
  assert.equal(plan.compliance({}).pct, null);
});

/* ---------------- the calibration session ---------------- */

test('the calibration run is a thirty-minute time trial with no distance target', () => {
  const c = plan.calibrationSession('2026-09-21');
  assert.equal(c.type, 'time-trial');
  assert.equal(c.structure[0].timeSec, 1800);
  assert.equal(c.structure[0].paceZone, 'max');
  assert.match(c.notes, /30 min/);
  assert.match(c.notes, /last 20/);
});
