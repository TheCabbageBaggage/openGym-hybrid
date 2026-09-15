// HYBRID: the running domain's own schema — S.run, the second namespace in a profile's state.
//
// A run session is not a workout. It has no exercise id, no sets and no load, and the cardio
// mode that exists in S.routines is a duration-and-speed stub that answers a different question
// ("how long on the bike"). Everything here therefore lives under S.run, a namespace upstream
// knows nothing about, and is written by exactly the three code paths that have any business
// writing it: the plan builder (plan.js), the calibration result, and a change-set the user
// approved.
//
// Why a namespace rather than an extension of the cardio mode: validate.js calls its own
// CHANGE_TYPES "the actual security boundary", `cardio` requires a target.exId that a run does
// not have, and MODES is consulted from twenty call sites. Extending any of them is a rewrite
// with a rebase conflict attached. A new root key on the state document, by contrast, survives
// an upstream release untouched — the sync layer carries the document, not the schema.
//
// Pure functions over plain objects: no clock, no I/O, no state file. `frontend/src/lib/run/
// run-model.js` mirrors the parts a browser needs and run-model.test.js pins the two together.

import { WORKOUT_TYPES, UNITS, PHASES } from './vocab.js';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- limits ---------- */
// Every one of these exists because a model or a bug can produce the number without meaning to,
// and a state document is synced to every device the profile owns. A plan that is merely
// ambitious is fine; a plan with 4,000 sessions is a document that stops syncing.
export const MAX_RUN_WEEKS = 52;
export const MAX_RUN_SESSIONS_PER_WEEK = 7;
export const MAX_RUN_KM_WEEK = 300;
export const MAX_RUN_STRUCTURE = 4;
export const MAX_RUN_NOTES = 600;
export const MAX_CALIBRATION_NOTES = 600;

/** An empty running namespace — what a profile has before its first run plan. */
export const EMPTY_RUN = Object.freeze({ calibration: null, zones: null, weeks: [], updatedAt: null });

/**
 * Create the `run` key on a state document if it is not there.
 *
 * Idempotent and additive: an existing `run` is returned untouched, so this can run on every
 * load without ever rewriting a plan. Absent `run` is not a broken document — every profile
 * that existed before this feature has none, and one that never runs will never have one.
 */
export function ensureRun(S) {
  if (!S || typeof S !== 'object') return S;
  if (S.run == null || typeof S.run !== 'object') {
    S.run = { calibration: null, zones: null, weeks: [] };
  }
  return S.run;
}

/**
 * The running part of a state document, reduced to what is safe to send anywhere — the Coach
 * payload, an export, a share.
 *
 * A copy, not the original: `S.run` is live state and a caller that mutates what it was given
 * has mutated the profile's document. Fields are copied in by name, so nothing that is added
 * to the schema next year rides out by accident.
 */
export function cleanRun(S, { maxWeeks = 12, today = null } = {}) {
  const run = S?.run;
  if (!run || typeof run !== 'object') return null;
  const out = {
    unit: run.zones?.unit === 'mi' ? 'mi' : 'km',
    thresholdPace: isPos(run.zones?.thresholdPace) ? Math.round(run.zones.thresholdPace) : null,
    hrMax: isPos(run.zones?.hrMax) ? Math.round(run.zones.hrMax) : null,
    calibration: run.calibration
      ? {
        type: String(run.calibration.type || 'threshold30').slice(0, 20),
        d: ISO.test(String(run.calibration.d)) ? run.calibration.d : null,
        done: !!run.calibration.done,
        result: run.calibration.result ? {
          distKm: round1(run.calibration.result.distKm),
          avgPaceSec: isPos(run.calibration.result.avgPaceSec) ? Math.round(run.calibration.result.avgPaceSec) : null,
          avgHR: isPos(run.calibration.result.avgHR) ? Math.round(run.calibration.result.avgHR) : null
        } : null
      }
      : null,
    weeks: []
  };
  const weeks = Array.isArray(run.weeks) ? run.weeks.slice(0, maxWeeks) : [];
  for (const w of weeks) {
    if (!w || typeof w !== 'object') continue;
    const sessions = (Array.isArray(w.sessions) ? w.sessions : []).slice(0, MAX_RUN_SESSIONS_PER_WEEK);
    out.weeks.push({
      wk: isInt(w.wk, 1, MAX_RUN_WEEKS) ? w.wk : out.weeks.length + 1,
      phase: PHASES.includes(w.phase) ? w.phase : 'base',
      km: round1(w.km),
      sessions: sessions.map(cleanSession).filter(Boolean)
    });
  }
  // A window, not a career: the Coach reads a training block. Sessions after `today` are the
  // plan; sessions before it are what happened, and only the recent ones are worth the tokens.
  if (today) out.weeks = out.weeks.filter(w => !w.sessions.length || w.sessions.slice(-1)[0].d >= today || w.sessions[0].d >= today);
  return out;
}

function cleanSession(s) {
  if (!s || typeof s !== 'object') return null;
  if (!WORKOUT_TYPES[s.type]) return null;
  return {
    id: typeof s.id === 'string' ? s.id.slice(0, 40) : null,
    d: ISO.test(String(s.d)) ? s.d : null,
    type: s.type,
    structure: cleanStructure(s.structure),
    km: round1(s.km),
    targetPaceSec: isPos(s.targetPaceSec) ? Math.round(s.targetPaceSec) : null,
    targetHR: isPos(s.targetHR) ? Math.round(s.targetHR) : null,
    notes: String(s.notes || '').slice(0, MAX_RUN_NOTES),
    done: !!s.done
  };
}

/** A structure, reduced to the two ways a repetition can be measured. */
export function cleanStructure(structure) {
  if (!Array.isArray(structure)) return null;
  const out = [];
  for (const raw of structure.slice(0, MAX_RUN_STRUCTURE)) {
    if (!raw || typeof raw !== 'object') continue;
    const rep = isInt(raw.rep, 1, 60) ? raw.rep : null;
    // dist is metres and timeSec is seconds — one of the two, never both. A repetition measured
    // in both is ambiguous at display time ("6 x 800 m / 3:00" says nothing about which one the
    // runner is meant to hit), and the validator below refuses it rather than picking one.
    const dist = isPos(raw.dist) ? Math.round(raw.dist) : null;
    const timeSec = isPos(raw.timeSec) ? Math.round(raw.timeSec) : null;
    if (!rep || (dist == null) === (timeSec == null)) continue;
    out.push({
      rep,
      ...(dist != null ? { dist } : { timeSec }),
      paceZone: typeof raw.paceZone === 'string' ? raw.paceZone.slice(0, 20) : null,
      restSec: isInt(raw.restSec, 0, 3600) ? raw.restSec : 0
    });
  }
  return out.length ? out : null;
}

const round1 = v => (isNum(v) ? Math.round(v * 10) / 10 : null);

/**
 * Is this a running namespace we are willing to store, sync and act on?
 *
 * Structural only, exactly like validateRunPlan: it answers "is this coherent", never "is this
 * content allowed". The closed list of change types stays in validate.js where the security
 * boundary is documented, and this function is not part of it — a bad `run` is a bug or a bad
 * model answer, not an attack surface, because nothing here is executed.
 */
export function validateRun(run) {
  const errors = [];
  if (run == null) return { ok: true, errors };
  if (typeof run !== 'object') return { ok: false, errors: ['run must be an object'] };

  if (run.calibration != null) {
    const c = run.calibration;
    if (typeof c !== 'object') errors.push('calibration must be an object');
    else {
      if (c.d != null && !ISO.test(String(c.d))) errors.push('calibration.d must be an ISO date');
      if (c.done != null && typeof c.done !== 'boolean') errors.push('calibration.done must be a boolean');
      // A calibration marked done with no result is a plan whose zones have no origin: the next
      // load cannot tell "not calibrated yet" from "calibrated and the numbers were lost", and
      // would happily rebuild the zone table from nothing.
      if (c.done === true && !c.result) errors.push('calibration.done is true but no result was recorded');
      if (c.result) {
        if (!isPos(c.result.distKm)) errors.push('calibration.result.distKm must be a positive number of kilometres');
        if (!isPos(c.result.avgPaceSec)) errors.push('calibration.result.avgPaceSec must be a positive number of seconds per kilometre');
      }
    }
  }

  if (run.zones != null) {
    const z = run.zones;
    if (typeof z !== 'object') errors.push('zones must be an object');
    else {
      if (z.unit != null && !UNITS.includes(z.unit)) errors.push(`zones.unit must be one of ${UNITS.join(', ')}`);
      // Distances and paces are stored in kilometres whatever the unit is: a mile profile is a
      // kilometre plan with a conversion at the edge. Storing miles would mean the unit switch
      // rewrites every pace and distance in the document, which is the class of bug that makes
      // a runner's history read 40% short after a settings change.
      if (z.thresholdPace != null && !isPos(z.thresholdPace)) errors.push('zones.thresholdPace must be seconds per kilometre');
      if (z.paceZones != null) {
        if (typeof z.paceZones !== 'object') errors.push('zones.paceZones must be an object');
        else for (const [name, band] of Object.entries(z.paceZones)) {
          if (!Array.isArray(band) || band.length !== 2 || !band.every(isPos)) {
            errors.push(`zones.paceZones.${name} must be a [fast, slow] pair of second values`);
          } else if (band[0] >= band[1]) {
            // Written [fast, slow] and compared as such everywhere; a band stored the other way
            // round is a band that classifies every run as the slowest zone it touches.
            errors.push(`zones.paceZones.${name} is written slowest-first — bands are [fast, slow]`);
          }
        }
      }
    }
  }

  const weeks = Array.isArray(run.weeks) ? run.weeks : null;
  if (weeks == null) {
    if (run.weeks != null) errors.push('weeks must be an array');
  } else {
    if (weeks.length > MAX_RUN_WEEKS) errors.push(`a run plan is at most ${MAX_RUN_WEEKS} weeks`);
    const ids = new Set();
    weeks.forEach((w, wi) => {
      const where = `weeks[${wi}]`;
      if (!w || typeof w !== 'object') { errors.push(`${where} is not an object`); return; }
      if (!isInt(w.wk, 1, MAX_RUN_WEEKS)) errors.push(`${where}.wk must be a whole number of weeks`);
      if (w.phase != null && !PHASES.includes(w.phase)) errors.push(`${where}.phase "${w.phase}" is not one of ${PHASES.join(', ')}`);
      if (isNum(w.km) && w.km > MAX_RUN_KM_WEEK) errors.push(`${where}.km ${w.km} exceeds ${MAX_RUN_KM_WEEK}`);
      const sessions = Array.isArray(w.sessions) ? w.sessions : [];
      if (!Array.isArray(w.sessions)) errors.push(`${where}.sessions must be an array`);
      if (sessions.length > MAX_RUN_SESSIONS_PER_WEEK) errors.push(`${where} holds ${sessions.length} sessions — at most ${MAX_RUN_SESSIONS_PER_WEEK}`);
      sessions.forEach((s, si) => {
        const sw = `${where}.sessions[${si}]`;
        if (!s || typeof s !== 'object') { errors.push(`${sw} is not an object`); return; }
        if (!WORKOUT_TYPES[s.type]) { errors.push(`${sw}.type "${s.type}" is not a workout type`); return; }
        if (!ISO.test(String(s.d))) errors.push(`${sw}.d must be an ISO date`);
        if (s.id) {
          if (typeof s.id !== 'string') errors.push(`${sw}.id must be a string`);
          else if (ids.has(s.id)) errors.push(`${sw}.id "${s.id}" is used twice — a run session id is how a change-set names it`);
          else ids.add(s.id);
        }
        (Array.isArray(s.structure) ? s.structure : []).forEach((r, ri) => validateRep(r, `${sw}.structure[${ri}]`, run, errors));
      });
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, run };
}

function validateRep(r, where, run, errors) {
  if (!r || typeof r !== 'object') { errors.push(`${where} is not an object`); return; }
  if (!isInt(r.rep, 1, 60)) errors.push(`${where}.rep must be 1-60 repetitions`);
  const hasDist = isPos(r.dist);
  const hasTime = isPos(r.timeSec);
  if (!hasDist && !hasTime) errors.push(`${where} must carry dist (metres) or timeSec`);
  // Both is not "more precise", it is two prescriptions in one field. The app shows one target
  // on the workout screen and a runner cannot hit both, so the answer is refused here rather
  // than resolved arbitrarily at display time.
  if (hasDist && hasTime) errors.push(`${where} carries both dist and timeSec — a repetition is measured one way`);
  if (hasDist && r.dist > 20000) errors.push(`${where}.dist ${r.dist} m is further than a repetition`);
  if (hasTime && r.timeSec > 3600) errors.push(`${where}.timeSec ${r.timeSec} s is longer than a repetition`);
  if (r.restSec != null && !isInt(r.restSec, 0, 3600)) errors.push(`${where}.restSec must be 0-3600 seconds`);
  // The band has to exist, or the session prescribes a pace nobody can look up and the
  // prescription quietly becomes "run how you feel".
  if (r.paceZone != null) {
    const zones = run?.zones?.paceZones;
    if (zones && !zones[r.paceZone]) {
      errors.push(`${where}.paceZone "${r.paceZone}" is not one of ${Object.keys(zones).join(', ')}`);
    }
  }
}

/**
 * Where a run session sits relative to the strength plan — the one function the interference
 * rules read.
 *
 * `S.week` maps a weekday to a list of routine ids; `plan.week` in a Coach payload is the same
 * thing cleaned. Days are compared as ISO dates, and `weekdayOf` uses UTC because that is how
 * every date in this app is compared (a plan built in Vienna and read in Auckland must not
 * disagree about which day Saturday is).
 */
export function strengthOn(S, isoDate) {
  const weekday = new Date(isoDate + 'T00:00:00Z').getUTCDay();
  const slots = S?.week?.[weekday];
  if (!slots) return [];
  return [].concat(slots);
}

/** Whole days between two ISO dates. Negative when `b` is earlier. */
export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
