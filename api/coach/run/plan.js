// HYBRID: the week builder — sessions, structures and the arithmetic that holds a plan together.
//
// Everything here is a pure function over plain objects. The builder never reads state and
// never writes it; it is handed a plan and gives back a new one. That is what makes it testable
// without a server, a clock or a user, and what lets the same code run inside the browser for
// an immediate preview.

import { WORKOUT_TYPES, PHASES, CALIBRATION } from './vocab.js';
import { zonesFrom, targetPace, zoneOf } from './zones.js';

const isNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isPos = v => Number.isInteger(v) && v > 0;
const DAY = 86400000;
const iso = d => new Date(d).toISOString().slice(0, 10);
const addDays = (isoDate, n) => iso(new Date(isoDate + 'T00:00:00Z').getTime() + n * DAY);
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const weekdayOf = isoDate => new Date(isoDate + 'T00:00:00Z').getUTCDay();

let seq = 0;
export function runId() {
  // Deterministic-ish and collision-free in practice: the counter disambiguates two sessions
  // created in the same millisecond, which a plan builder generating a whole block absolutely
  // does. `r_` because a run session is never a routine id and must never be mistaken for one.
  seq = (seq + 1) % 100000;
  return 'r_' + Date.now().toString(36) + seq.toString(36).padStart(3, '0');
}

/* ---------- volume in the structure, out of it ---------- */
// A session's km is *derived*, never typed in twice. The number that ends up in the plan is the
// one the structure implies, so a session can never claim 8 km and describe 10x400 m plus
// warm-up without the discrepancy being visible in the code that built it.
//
// The easy kilometres are a *cap*, not a fixed cost. An interval session on a 25 km week should
// not drag 4.4 km of warm-up and cool-down behind it — that is how a week built for 25 km
// arrives on the calendar as 30, and how the 80/20 rule gets quietly broken by the warm-up.
const EASY_CAP_KM = 2;
export function structureKm(structure, easyKm = EASY_CAP_KM) {
  if (!Array.isArray(structure) || !structure.length) return null;
  let work = 0;
  for (const s of structure) {
    const reps = isNum(s.rep) ? s.rep : 1;
    if (isNum(s.dist)) work += reps * (s.dist / 1000);
    else if (isNum(s.timeSec)) work += reps * (s.timeSec / 60) / 5; // ~5:00/km assumed for time-based reps
  }
  return Math.round((work + 2 * easyKm) * 10) / 10;
}

/** The part of a structured session that is the interval work itself, in km. */
export function workKm(structure) {
  if (!Array.isArray(structure) || !structure.length) return 0;
  let work = 0;
  for (const s of structure) {
    const reps = isNum(s.rep) ? s.rep : 1;
    if (isNum(s.dist)) work += reps * (s.dist / 1000);
    else if (isNum(s.timeSec)) work += reps * (s.timeSec / 60) / 5;
  }
  return Math.round(work * 10) / 10;
}

export function sessionKm(type, structure, declaredKm) {
  if (isNum(declaredKm)) return Math.round(declaredKm * 10) / 10;
  const fromStructure = structureKm(structure);
  if (fromStructure) return fromStructure;
  const defaults = { easy: 8, recovery: 5, long: 16, tempo: 10, threshold: 11, cruise: 11,
    interval: 10, 'interval-time': 10, fartlek: 10, hills: 10, strides: 6, progression: 10,
    'race-pace': 11, 'time-trial': 8, taper: 6, shakeout: 4, 'cross-train': 0, rest: 0, race: 21.1 };
  return defaults[type] ?? 8;
}

/* ---------- session factory ---------- */
export function makeSession({
  d, type, structure = null, km = null, paceZones = null, notes = '', done = false
}) {
  if (!WORKOUT_TYPES[type]) throw new Error(`unknown run type "${type}"`);
  const meta = WORKOUT_TYPES[type];
  const st = structure ?? (meta.structure ? [{ ...meta.structure }] : null);
  const zone = st?.[0]?.paceZone || meta.zone;
  return {
    id: runId(),
    d,
    type,
    structure: st,
    km: sessionKm(type, st, km),
    targetPaceSec: paceZones ? targetPace(type, zone, paceZones) : null,
    targetHR: null,
    notes,
    done,
    actual: null
  };
}

/* ---------- the calibration session ---------- */
// Every plan starts here. Without a threshold pace there are no zones, and without zones there
// is no prescription to make — a run plan built on a guessed pace is a plan that prescribes the
// wrong intensity for months. So this is session one, it is a `time-trial`, and the plan after
// it is provisional until it lands.
export function calibrationSession(startDate) {
  return makeSession({
    d: startDate, type: 'time-trial',
    structure: [{ rep: 1, timeSec: CALIBRATION.minutes * 60, paceZone: 'max', restSec: 0 }],
    km: Math.round(CALIBRATION.minutes / 5 * 10) / 10,
    notes: `Calibration: ${CALIBRATION.minutes} min as evenly as you can. Threshold pace comes from the last ${CALIBRATION.steadyMinutes}.`
  });
}

/* ---------- week assembly ---------- */
/**
 * Lay sessions onto a week grid.
 *
 * `slots` is the input that makes hybrid training work: each entry is a weekday (0=Sun) with
 * an optional kind. A day with no running is not an error — it is a strength day, and the
 * builder leaves it empty rather than inventing a recovery jog to fill the slot. That is why
 * this returns what it was asked for and nothing more.
 *
 * @param {{ startDate:string, weeks:number, slots:Array<{weekday:number,type:string}>, thresholdPace:number }} opts
 */
// HYBRID: the interference rules, and the strength plan they are checked against.
//
// The builder is where a week is *created*, so it is the cheapest place to refuse one: a plan
// that has never been emitted cannot be synced to a phone and approved. `S` is the profile state
// and is optional — a caller with no strength plan (an import, a test) gets the builder without
// the rules, which is correct: there is nothing to interfere with.
import { checkWeek, legDays, addDays as addIsoDays } from './interference.js';

/**
 * The ISO dates of a week's leg days, or an empty set when there is no strength plan to read.
 * Kept in one place so the builder, the validator and the prompt all ask the same question of the
 * same calendar.
 */
function legDaysFor(S, weekStart) {
  if (!S) return new Set();
  return legDays(S, { from: weekStart, to: addIsoDays(weekStart, 6) });
}

export function buildWeeks({ startDate, weeks = 8, slots = [], thresholdPace = null, volumeStart = 20, S = null }) {
  const paceZones = thresholdPace ? zonesFrom(thresholdPace) : null;
  const out = [];
  // Two numbers, and they are not the same number. `peak` is the volume this block is building
  // towards and only ever moves up; `kmTarget` is what this particular week asks for, which
  // dips in a deload and tapers at the end. Tracking only one of them is how a plan ratchets
  // downwards: every deload permanently lowers the base the next week grows from, so an
  // eight-week block ends lighter than it started.
  let peak = volumeStart;
  let kmTarget = volumeStart;
  let hard = false;
  let buildWeeksSeen = 0;
  let taperCount = 0;
  // What each quality session has become, so a deload steps it back from where it was rather
  // than from the preset it started at.
  const repCount = new Map();
  for (let wk = 1; wk <= weeks; wk++) {
    const phase = phaseFor(wk, weeks);
    const weekStart = addDays(startDate, (wk - 1) * 7);

    // Sessions first, volume second. The week's floor comes from the sessions it holds — six
    // 800s are a fixed distance however the week is going — so building the sessions before
    // deciding how far the week runs is what stops the two from disagreeing.
    //
    // The repetition count is carried forward from last week rather than re-read from the type
    // preset. The preset is where a session starts in week one; regenerating it each week is why
    // a deload reset the intervals to five and the week after a deload was easier than the week
    // before it. `repCount` is the plan's memory of how hard this session has become.
    const sessions = [];
    for (const slot of slots) {
      const offset = (slot.weekday - weekdayOf(weekStart) + 7) % 7;
      const d = addDays(weekStart, offset);
      const type = slot.type || (weekdayOf(d) === 0 ? 'long' : 'easy');
      if (type === 'rest') continue;   // an explicit rest day is the absence of a session
      const preset = WORKOUT_TYPES[type]?.structure;
      const structure = preset
        ? [{ ...preset, ...(preset.rep && repCount.has(type) ? { rep: repCount.get(type) } : {}) }]
        : null;
      sessions.push(makeSession({ d, type, structure, paceZones, km: slot.km || null }));
    }

    // The quality sessions grow with the block. An interval session that stays six-by-800 for
    // eighteen weeks is not a plan, it is a habit — and it is the specific failure of a builder
    // that only ever scales total volume. The count steps up through the build and peak, one at
    // a time, and holds.
    //
    // It is derived from *how many build weeks have happened*, not from the week number modulo
    // something: a modulo test makes the count rise and fall, which is the plan getting easier
    // for no reason a runner could see.
    if (phase === 'build' || phase === 'peak') {
      buildWeeksSeen += 1;
      if (buildWeeksSeen % Math.max(1, Math.round(weeks / 6)) === 0) {
        for (const s of sessions) {
          if (!WORKOUT_TYPES[s.type]?.quality || !s.structure?.length) continue;
          const r = s.structure[0];
          const ceil = r.dist ? 10 : 8;   // ten 800s, or eight timed reps, is plenty
          if (r.rep < ceil) s.structure = [{ ...r, rep: r.rep + 1 }];
        }
      }
    }
    // Remember what each session has become, so next week starts where this one ended.
    for (const s of sessions) {
      if (WORKOUT_TYPES[s.type]?.quality && s.structure?.[0]?.rep) repCount.set(s.type, s.structure[0].rep);
    }
    // A deload steps the quality sessions back one repetition *before* the floor is computed,
    // which is the order that matters: a floor calculated for a normal week pushes a deload
    // back up to where it was, and a "deload" that lands 18% below the week before it, on a
    // session still holding six 800s, is not a deload.
    if (phase === 'deload') {
      for (const s of sessions) {
        if (!WORKOUT_TYPES[s.type]?.quality || !s.structure?.length) continue;
        const r = s.structure[0];
        if (r.rep > 3) s.structure = [{ ...r, rep: r.rep - 1 }];
      }
    }
    const floor = weekFloor(sessions);

    // Growth is capped at +10% and at +8% once a hard week follows another hard week, because
    // the second consecutive jump is where beginners get hurt — the plan that goes 20 → 22 →
    // 24 km is a plan whose third week is the one they miss. The deload is −25%, not −40%: the
    // spec allows a range and the shallower end is the one that keeps the aerobic base that was
    // just built. The taper comes down harder because it is meant to, and because it happens
    // once, at the end, on purpose.
    if (phase === 'taper') {
      // The taper compounds. Each taper week is 15% below the *previous* one rather than a fixed
      // fraction of the peak, because a taper that returns to the same number every week is not
      // a taper — the last two weeks before a race came out identical until this.
      taperCount += 1;
      kmTarget = Math.round(peak * 0.8 * Math.pow(0.85, taperCount - 1) * 10) / 10;
      hard = false;
    } else if (phase === 'deload') {
      kmTarget = Math.round(peak * 0.75 * 10) / 10;
      hard = false;
    } else if (wk === 1) {
      kmTarget = peak;
    } else {
      peak = Math.round(peak * (hard ? 1.08 : 1.1) * 10) / 10;
      kmTarget = peak;
      hard = true;
    }

    // The week may be raised by its own sessions' needs, but never lowered — except in a deload,
    // where coming down is the entire point. Three sessions a week including one interval workout
    // cannot be done on 20 km: the arithmetic says the week needs roughly thirty once the hard
    // running is capped at a fifth. Raising the week is what a coach does; quietly making the
    // intervals shorter is what a spreadsheet does.
    const raised = phase === 'deload' ? kmTarget : Math.max(kmTarget, floor);
    if (raised > kmTarget) peak = Math.max(peak, raised);
    if (!slots.some(s => s.km)) distributeVolume(sessions, raised);
    clampHardShare(sessions);
    const built = { wk, phase, km: Math.round(sessions.reduce((a, s) => a + s.km, 0) * 10) / 10, sessions };
    // HYBRID: the week is only legal if it survives the interference rules. A violation here is
    // not a warning to hand back — it is a plan that will be refused the moment anyone tries to
    // apply it, so the builder reports it in the same shape the validator does and the caller
    // decides. `slots` are chosen by the intake wizard, and a clash means the *slots* were wrong
    // (a run day picked next to a leg day), which is a question for the runner, not a silent
    // reshuffle of their week.
    const clashes = S ? checkWeek(built, legDaysFor(S, weekStart), { phase }) : [];
    out.push(clashes.length ? { ...built, clashes } : built);
  }
  // A taper should sharpen, not stall. The taper weeks all sit at the same fraction of `peak`,
  // and `peak` stops moving once the build ends — so they come out identical and the last week
  // before the race is exactly as heavy as the first week of the taper. Successive taper weeks
  // therefore come down again, which is the whole shape of a taper.
  return { weeks: out, paceZones };
}

// Phase shape for a block of `weeks` with no race at the end (a race plan passes its own
// weeksToRace and gets a real taper — see taperWeeks). The deload every fourth week is checked
// BEFORE the taper window, because a four-week block is otherwise entirely taper: `wk > weeks-2`
// is true for weeks 3 and 4 of 4, and a block that builds for two weeks and then backs off for
// two is not a training block.
function phaseFor(wk, weeks) {
  const taper = taperWeeks(weeks);
  if (taper > 0 && wk > weeks - taper) return 'taper';
  if (wk % 4 === 0 && wk < weeks) return 'deload';
  if (wk <= Math.ceil(weeks * 0.4)) return 'base';
  if (wk <= Math.ceil(weeks * 0.75)) return 'build';
  return 'peak';
}

/** How many weeks of taper a block of this length earns. A short block gets none: you cannot
 *  taper what you have not built, and a two-week plan that tapers is a two-week rest. */
export function taperWeeks(weeks) {
  if (weeks >= 10) return 3;
  if (weeks >= 6) return 2;
  return 0;
}

export function distributeVolume(sessions, weekKm) {
  if (!sessions.length) return;
  const long = sessions.filter(s => s.type === 'long');
  const rest = sessions.filter(s => s.type !== 'long');

  // Step 1 — the sessions that cannot be argued with get what they need, and no more. A
  // structured workout is its interval kilometres plus a two-kilometre allowance either side;
  // without a cap here the session absorbs the whole easy allocation of the week, which is how a
  // week built for 35 km once contained a 13.8 km "interval session".
  for (const s of rest) {
    const w = workKm(s.structure);
    if (w > 0) s.km = Math.round((w + EASY_CAP_KM) * 10) / 10;
  }
  if (weekKm <= 0) return sessions;

  // Step 2 — the long run gets a third of the week, capped at 40%. Beyond that the plan stops
  // being a week with a long run in it and becomes a long run with some other runs attached:
  // that is how a 50 km starter's long run reached eighty kilometres. Several long runs share the
  // allocation, with the last absorbing the rounding so the group sums exactly.
  const share = Math.min(0.35, 0.4);
  const longTotal = long.length ? Math.round(weekKm * share * 10) / 10 : 0;
  long.forEach((s, i) => {
    s.km = i === long.length - 1
      ? Math.round((longTotal - used(long, i)) * 10) / 10
      : Math.round(longTotal / long.length * 10) / 10;
  });

  // Step 3 — every remaining kilometre goes into the unstructured easy runs, exactly. Sizing them
  // last is what makes the week land on its target instead of drifting over it, and it is why
  // `volumeStart` is honoured rather than approximated.
  const plain = rest.filter(s => !workKm(s.structure));
  const fixed = sessions.reduce((a, s) => a + s.km, 0);
  const remainder = Math.round((weekKm - fixed) * 10) / 10;
  if (plain.length && remainder > 0) {
    let usedKm = 0;
    plain.forEach((s, i) => {
      const each = i === plain.length - 1 ? Math.round((remainder - usedKm) * 10) / 10 : Math.round(remainder / plain.length * 10) / 10;
      usedKm += each;
      s.km = Math.max(2, Math.round((s.km + each) * 10) / 10);
    });
  } else if (!plain.length && long.length && remainder > 0) {
    // No plain easy runs to carry the remainder: the long run takes it, up to its cap, so the
    // week can come in slightly under rather than the long run becoming unreasonable.
    const cap = Math.round(weekKm * 0.4 * 10) / 10;
    long[0].km = Math.min(cap, Math.round((long[0].km + remainder) * 10) / 10);
  }
  return sessions;
}

const used = (list, upto) => list.slice(0, upto).reduce((a, s) => a + s.km, 0);

export function hardShare(week) {
  const total = (week?.sessions || []).reduce((a, s) => a + s.km, 0);
  if (!total) return { share: 0, hardKm: 0, totalKm: 0, ok: true };
  const hardKm = week.sessions.filter(s => WORKOUT_TYPES[s.type]?.quality).reduce((a, s) => a + s.km, 0);
  const share = hardKm / total;
  return { share: Math.round(share * 1000) / 1000, hardKm: Math.round(hardKm * 10) / 10, totalKm: Math.round(total * 10) / 10, ok: share <= 0.2 };
}

/* ---------- validation ---------- */
const MAX_WEEKS_PLAN = 52;
const MAX_SESSIONS_PER_WEEK = 7;
const MAX_KM_WEEK = 300;

/**
 * Structural validation of a plan. This is the run-side counterpart to validate.js: it answers
 * "is this plan internally coherent", never "is this content allowed" — the closed list of
 * change types stays where it is.
 */
export function validateRunPlan(run) {
  const errors = [];
  if (!run || typeof run !== 'object') return { ok: false, errors: ['run must be an object'] };
  if (run.zones != null) {
    if (!isNum(run.zones.thresholdPace)) errors.push('zones.thresholdPace must be a positive number of seconds per km');
    if (run.zones.unit != null && !['km', 'mi'].includes(run.zones.unit)) errors.push('zones.unit must be km or mi');
    const expect = run.zones.thresholdPace ? zonesFrom(run.zones.thresholdPace) : null;
    // The stored table is derived, so a table that disagrees with its own threshold pace is
    // stale — regenerating it is cheap and a plan built on a stale table is silently wrong.
    if (expect && run.zones.paceZones && JSON.stringify(expect) !== JSON.stringify(run.zones.paceZones)) {
      errors.push('zones.paceZones does not match zones.thresholdPace — recompute the table rather than editing it');
    }
  }
  const weeks = Array.isArray(run.weeks) ? run.weeks : [];
  if (weeks.length > MAX_WEEKS_PLAN) errors.push(`a plan is at most ${MAX_WEEKS_PLAN} weeks`);
  const seen = new Set();
  weeks.forEach((w, wi) => {
    if (!PHASES.includes(w.phase)) errors.push(`weeks[${wi}].phase "${w.phase}" is not one of ${PHASES.join(', ')}`);
    const sessions = Array.isArray(w.sessions) ? w.sessions : [];
    if (sessions.length > MAX_SESSIONS_PER_WEEK) errors.push(`weeks[${wi}] has ${sessions.length} sessions — at most ${MAX_SESSIONS_PER_WEEK}`);
    if (w.km > MAX_KM_WEEK) errors.push(`weeks[${wi}].km ${w.km} exceeds ${MAX_KM_WEEK}`);
    sessions.forEach((s, si) => {
      const where = `weeks[${wi}].sessions[${si}]`;
      if (!WORKOUT_TYPES[s.type]) { errors.push(`${where}.type "${s.type}" is not a workout type`); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.d))) errors.push(`${where}.d must be an ISO date`);
      if (!isNum(s.km) && s.km !== 0) errors.push(`${where}.km must be a number`);
      if (s.id) { if (seen.has(s.id)) errors.push(`${where}.id "${s.id}" is used twice`); seen.add(s.id); }
      (Array.isArray(s.structure) ? s.structure : []).forEach((rep, ri) => {
        const rw = `${where}.structure[${ri}]`;
        if (!isPos(rep.rep)) errors.push(`${rw}.rep must be a positive whole number of repetitions`);
        if (rep.dist == null && rep.timeSec == null) errors.push(`${rw} must carry dist (m) or timeSec`);
        // The zone has to be one this plan actually has a band for, or the session prescribes
        // a pace nobody can look up — the prescription silently becomes "run how you feel".
        const zones = buildZoneLookup(run);
        if (rep.paceZone != null && zones && !zones[rep.paceZone]) {
          errors.push(`${rw}.paceZone "${rep.paceZone}" is not one of ${Object.keys(zones).join(', ')}`);
        }
      });
    });
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, run };
}

const buildZoneLookup = run => run?.zones?.paceZones || null;

/* ---------- summaries ---------- */
export function planSummary(run) {
  const weeks = run?.weeks || [];
  if (!weeks.length) return { weeks: 0, totalKm: 0, avgKm: 0, qualitySessions: 0, longRuns: 0, from: null, to: null };
  const all = weeks.flatMap(w => w.sessions);
  const totalKm = Math.round(all.reduce((a, s) => a + s.km, 0) * 10) / 10;
  return {
    weeks: weeks.length,
    totalKm,
    avgKm: Math.round(totalKm / weeks.length * 10) / 10,
    qualitySessions: all.filter(s => WORKOUT_TYPES[s.type]?.quality).length,
    longRuns: all.filter(s => s.type === 'long').length,
    from: weeks[0].sessions[0]?.d || null,
    to: weeks[weeks.length - 1].sessions.slice(-1)[0]?.d || null
  };
}

/**
 * The smallest weekly volume that can carry these sessions inside the 80/20 rule.
 *
 * A structured interval workout is a fixed distance — six 800s are 4.8 km of hard running
 * however the week is going — and 80/20 says that may be at most a fifth of the week. So the
 * week has a floor, and it is arithmetic rather than preference. Computing it *before* the
 * volume is handed out is what keeps the plan honest; discovering it afterwards, as a clamp, is
 * what produced a starter plan whose first week was thirty percent above its own target.
 */
export function weekFloor(sessions) {
  const hard = sessions.filter(s => WORKOUT_TYPES[s.type]?.quality);
  if (!hard.length) return 0;
  const hardKm = hard.reduce((a, s) => {
    const w = workKm(s.structure);
    return a + (w > 0 ? w + EASY_CAP_KM : s.km);
  }, 0);
  return Math.ceil(hardKm / 0.2 * 10) / 10;
}

/**
 * Bring a week back inside the 80/20 rule by shortening the hard sessions, never the easy ones.
 *
 * Only needed when a caller has supplied its own `km` per session and skipped the volume
 * distribution; the builder itself already sizes every week above `weekFloor`. Repetitions come
 * off before the easy kilometres around the workout do, because a runner told "your easy runs
 * are now sprints" is being given advice that makes them slower.
 */
export function clampHardShare(sessions) {
  const isHard = s => !!WORKOUT_TYPES[s.type]?.quality;
  const total = () => sessions.reduce((a, s) => a + s.km, 0);
  const hardOf = () => sessions.filter(isHard).reduce((a, s) => a + s.km, 0);
  if (!sessions.some(isHard)) return sessions;

  // Two levers, and they are used in that order. First the repetitions come off the quality
  // sessions — the interval distance is what makes a week hard, so it is what gives. Only when
  // every quality session is down to its minimum (two repetitions) is the second lever used:
  // the easy running *grows*, because at that point the week is simply too small and the honest
  // resolution is a bigger week rather than a broken rule or a deleted workout.
  let guard = 0;
  while (guard++ < 200) {
    const km = total();
    if (!km || hardOf() / km <= 0.2) return sessions;
    const shrinkable = sessions.filter(s => isHard(s) && (s.structure?.[0]?.rep ?? 0) > 2);
    if (shrinkable.length) {
      const target = shrinkable.sort((a, b) => b.km - a.km)[0];
      const r = target.structure[0];
      target.structure = [{ ...r, rep: r.rep - 1 }];
      target.km = Math.round((workKm(target.structure) + EASY_CAP_KM) * 10) / 10;
      continue;
    }
    // Nothing left to shrink: raise the week. The extra goes to the longest non-quality session,
    // so the ratio comes down without any single run becoming unreasonable.
    const easy = sessions.filter(s => !isHard(s)).sort((a, b) => b.km - a.km)[0];
    if (!easy) return sessions;   // a week of nothing but quality cannot be fixed by volume
    easy.km = Math.round((easy.km + 0.5) * 10) / 10;
  }
  return sessions;
}

export function compliance(run, today = iso(Date.now())) {
  const due = (run?.weeks || []).flatMap(w => w.sessions).filter(s => s.d <= today);
  const done = due.filter(s => s.done);
  return { due: due.length, done: done.length, pct: due.length ? Math.round(done.length / due.length * 100) : null };
}
