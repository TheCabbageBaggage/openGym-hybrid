// HYBRID: the shared vocabulary of the running domain.
//
// One module, imported by every other run/* file and mirrored by the frontend. Keeping the
// words in one place is what makes the whole feature cheap to rebase: if upstream ever grows
// an opinion about running, there is exactly one file whose opinion has to be reconciled.
//
// Nothing here touches S.routines, S.week or the cardio mode. A run session is not a workout
// with a different mode — it has no exercise id, no sets and no load, and forcing it into that
// shape is what would break on every upstream release.

/* ---------- units ---------- */
// Distance is stored in km, always. Miles are a *display* concern: a mile plan is a km plan
// with a conversion at the edge (run-zones.js `unitScale`). Storing miles would mean a unit
// switch rewrites every pace and distance in the document, which is exactly the class of bug
// units.js exists to prevent on the weight side.
export const UNITS = ['km', 'mi'];
export const KM_PER_MI = 1.609344;

/* ---------- the 19 workout types ---------- */
// `quality` marks the sessions that carry real intensity. It drives three things downstream:
// the 80/20 volume rule (volume.js), the interference rules against heavy leg days
// (interference.js, Phase 3), and whether the session may be scheduled the day before a long
// run. `recovery` and `easy` are deliberately not quality, even when they carry strides.
//
// The long run is the exception that proves the point: it is not *intensity* (it is run at an
// easy pace and the 80/20 rule must not count it), but it is the single highest-cost session in
// the week and the one interference.js exists to protect. It carries its own flag rather than
// being folded into `quality`, because the two questions are different and answering them with
// one field is how the long run ended up unprotected while this was being built.
export const WORKOUT_TYPES = {
  easy:         { label: 'Easy Run',        zone: 'easy',       quality: false, structure: null },
  recovery:     { label: 'Recovery Run',    zone: 'recovery',   quality: false, structure: null },
  long:         { label: 'Long Run',        zone: 'easy',       quality: false, structure: null, finish: 'marathon', long: true },
  tempo:        { label: 'Tempo Run',       zone: 'threshold',  quality: true,  structure: { rep: 1, dist: 6000, paceZone: 'threshold', restSec: 0 } },
  threshold:    { label: 'Threshold',       zone: 'threshold',  quality: true,  structure: { rep: 4, dist: 2000, paceZone: 'threshold', restSec: 60 } },
  cruise:       { label: 'Cruise Intervals', zone: 'threshold', quality: true,  structure: { rep: 5, timeSec: 360, paceZone: 'threshold', restSec: 75 } },
  interval:     { label: 'Intervals',       zone: 'interval',   quality: true,  structure: { rep: 6, dist: 800,   paceZone: 'interval',  restSec: 90 } },
  'interval-time': { label: 'Time Intervals', zone: 'interval', quality: true,  structure: { rep: 6, timeSec: 180, paceZone: 'interval', restSec: 90 } },
  fartlek:      { label: 'Fartlek',         zone: 'mixed',      quality: true,  structure: { rep: 8, timeSec: 120, paceZone: 'interval', restSec: 60 } },
  hills:        { label: 'Hill Repeats',    zone: 'interval',   quality: true,  structure: { rep: 8, timeSec: 60,  paceZone: 'interval', restSec: 120 } },
  strides:      { label: 'Strides',         zone: 'repetition', quality: false, structure: { rep: 6, timeSec: 25,  paceZone: 'repetition', restSec: 45 } },
  progression:  { label: 'Progression Run', zone: 'threshold',  quality: true,  structure: null, finish: 'threshold' },
  'race-pace':  { label: 'Race Pace',       zone: 'race',       quality: true,  structure: { rep: 3, dist: 2000, paceZone: 'race', restSec: 90 } },
  'time-trial': { label: 'Time Trial',      zone: 'max',        quality: true,  structure: { rep: 1, dist: 5000, paceZone: 'max', restSec: 0 } },
  taper:        { label: 'Taper Run',       zone: 'easy',       quality: false, structure: null },
  shakeout:     { label: 'Shakeout',        zone: 'recovery',   quality: false, structure: null },
  'cross-train':{ label: 'Cross Training',  zone: null,         quality: false, structure: null },
  rest:         { label: 'Rest',            zone: null,         quality: false, structure: null },
  race:         { label: 'Race',            zone: 'race',       quality: true,  structure: null }
};
export const RUN_TYPES = Object.keys(WORKOUT_TYPES);

/* ---------- training phases ---------- */
export const PHASES = ['base', 'build', 'peak', 'deload', 'taper', 'race'];

/* ---------- pace zones ---------- */
// Percent of threshold pace, written **[fast, slow]** — the same order every band is written in
// everywhere else in this feature. `easy: [115, 130]` means "from 115% to 130% of threshold", and
// 130% is the *slower* number because a slower pace is more seconds per kilometre.
//
// Linus confirmed these bands (2026-09-15); they are Pfitzner-near and are the values the
// fixtures pin. Changing them changes every plan, so the pin in run-plan.test.js is the point.
export const ZONE_PCT = {
  recovery:   [125, 140],
  easy:       [115, 130],
  marathon:   [103, 110],
  threshold:  [ 99, 103],
  interval:   [ 90,  98],
  repetition: [ 85,  92],
  race:       [ 95, 101],
  max:        [ 95, 100]
};
export const ZONES = Object.keys(ZONE_PCT);

/* ---------- the 30-minute threshold test ---------- */
// The first session of every run plan. Threshold pace is the average pace of the last 20
// minutes — the final third is where the steady state actually is, and averaging the whole
// effort reads fast because the first ten minutes are spent settling in.
export const CALIBRATION = { type: 'threshold30', minutes: 30, steadyMinutes: 20 };

/* ---------- change types this feature adds ---------- */
// The server's CHANGE_TYPES is the security boundary (validate.js says so itself). These are
// appended to it rather than mixed in, so the hybrid additions are one contiguous block that a
// rebase can find.
export const RUN_CHANGE_TYPES = [
  'run-add-session', 'run-remove-session', 'run-change-pace-zone',
  'run-change-volume', 'run-shift-day', 'run-change-structure'
];
