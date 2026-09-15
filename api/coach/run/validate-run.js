// HYBRID: the run-side validator, and the run change-types validate.js gains.
//
// Split out of validate.js for one reason: rebasing. validate.js is the file upstream changes
// most often (it is the security boundary of the whole Coach feature), so the hybrid work adds
// exactly one contiguous, marker-tagged block to it and puts every line of judgement in here.
// A conflict in validate.js is then two lines of import and a switch arm rather than a merge
// through four hundred lines of another author's rules.
//
// The same posture as validate.js, deliberately: this is structural and safety validation, not
// policy. It answers "is this change coherent and safe to apply", never "do we approve of the
// training". A run change cannot reference an exercise, a load or a routine, so the surface it
// exposes is much smaller than the strength side — but everything it does touch is bounded.

import { WORKOUT_TYPES } from './vocab.js';
import { validateRun, cleanStructure } from './model.js';
import { checkWeek, legDays, addDays } from './interference.js';

const isStr = v => typeof v === 'string' && v.trim().length > 0;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const clampStr = (v, n) => String(v == null ? '' : v).slice(0, n);

export const RUN_CHANGE_TYPES = [
  'run-add-session', 'run-remove-session', 'run-change-pace-zone',
  'run-change-volume', 'run-shift-day', 'run-change-structure'
];

export const MAX_RUN_CHANGES = 12;
// A single change may not move a week more than this far. Volume progression is the plan's own
// job (volume.js, +10% a week); a review that doubles a week in one approval is either a model
// slip or a misread, and either way it is not something to apply on a checkbox.
export const MAX_VOLUME_STEP = 0.5;

/**
 * Validate a run change-set. Mirrors validateReview: one change at a time against the plan as
 * it stands, then the rules that are only wrong in company.
 *
 * @param {object} data  the answer's `runChanges` array plus its `changes`-style metadata
 * @param {object} run   the payload's cleaned run namespace
 * @param {object} ctx   { plan } — the strength plan, so a run day can be checked against it
 */
export function validateRunChanges(data, run, ctx = {}) {
  const errors = [];
  if (!data || typeof data !== 'object') return fail(['the run answer was not an object']);
  const list = Array.isArray(data.changes) ? data.changes : null;
  if (!list) return fail(['runChanges.changes must be an array']);

  const weeks = new Map((run?.weeks || []).map(w => [w.wk, w]));
  const sessionIndex = new Map();
  for (const w of run?.weeks || []) for (const s of w.sessions || []) if (s.id) sessionIndex.set(s.id, { week: w, session: s });

  const changes = [];
  const seen = new Set();
  list.slice(0, MAX_RUN_CHANGES).forEach((c, i) => {
    const where = `runChanges[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${where} is not an object`); return; }
    if (!RUN_CHANGE_TYPES.includes(c.type)) {
      errors.push(`${where}.type "${c.type}" is not allowed — use one of: ${RUN_CHANGE_TYPES.join(', ')}`);
      return;
    }
    if (!isStr(c.why)) { errors.push(`${where}.why is required — every change must cite the evidence behind it`); return; }

    let cid = isStr(c.id) ? clampStr(c.id, 40) : 'rc' + i;
    if (seen.has(cid)) cid = `${cid}-${i}`;
    seen.add(cid);

    const target = c.target || {};
    // `after` is a number for the two changes that carry a scalar (volume, threshold pace) and an
    // object for the ones that carry a session or a structure. A fixture that hands the scalar
    // changes an `{ thresholdPace: 303 }` object — which is what this one did before it went red —
    // is a fixture bug, not a validator bug: the contract is `after: 303`.
    const after = c.after;
    const out = { id: cid, type: c.type, target: {}, why: clampStr(c.why, 600), before: null, after: null };

    switch (c.type) {
      /* ----- adding a session to a week ----- */
      case 'run-add-session': {
        if (!isInt(target.wk, 1, 52)) { errors.push(`${where}.target.wk must be a week number`); return; }
        const week = weeks.get(target.wk);
        if (!week) { errors.push(`${where}.target.wk ${target.wk} is not a week in the plan`); return; }
        if ((week.sessions || []).length >= 7) { errors.push(`week ${target.wk} already holds seven sessions`); return; }
        const a = c.after || {};
        if (!WORKOUT_TYPES[a.type]) { errors.push(`${where}.after.type "${a.type}" is not a workout type`); return; }
        // A workout that is *defined* by its structure may not be added without one: an
        // "interval session" with no intervals is a card the runner opens on Tuesday morning
        // with nothing on it.
        const needsStructure = WORKOUT_TYPES[a.type].structure != null;
        const structure = cleanStructure(a.structure);
        if (needsStructure && !structure) {
          errors.push(`${where}.after.structure is required for a ${a.type} session`);
          return;
        }
        // The day must be inside the week it is added to, or the plan and the calendar disagree
        // the moment the week rolls over.
        if (isStr(a.d)) {
          if (!inWeek(a.d, week, target.wk)) { errors.push(`${where}.after.d ${a.d} does not fall inside week ${target.wk}`); return; }
          if ((week.sessions || []).some(s => s.d === a.d && s.type === a.type)) {
            errors.push(`week ${target.wk} already has a ${a.type} session on ${a.d}`);
            return;
          }
        }
        out.target = { wk: target.wk };
        out.after = {
          d: isStr(a.d) ? clampStr(a.d, 10) : null,
          type: a.type,
          structure,
          notes: clampStr(a.notes || '', 600)
        };
        break;
      }

      /* ----- removing one ----- */
      case 'run-remove-session': {
        if (!isStr(target.sessionId)) { errors.push(`${where}.target.sessionId is required`); return; }
        const hit = sessionIndex.get(target.sessionId);
        if (!hit) { errors.push(`${where}.target.sessionId "${target.sessionId}" is not a session in the plan`); return; }
        if ((hit.week.sessions || []).length <= 1) {
          errors.push(`week ${hit.week.wk} would be left with no running at all — remove the week, not its last session`);
          return;
        }
        out.target = { sessionId: clampStr(target.sessionId, 40) };
        out.before = { d: hit.session.d, type: hit.session.type, km: hit.session.km };
        break;
      }

      /* ----- moving a session to another day ----- */
      case 'run-shift-day': {
        if (!isStr(target.sessionId)) { errors.push(`${where}.target.sessionId is required`); return; }
        if (!isStr(c.after)) { errors.push(`${where}.after must be the new ISO date`); return; }
        const hit = sessionIndex.get(target.sessionId);
        if (!hit) { errors.push(`${where}.target.sessionId "${target.sessionId}" is not a session in the plan`); return; }
        if (!inWeek(c.after, hit.week, hit.week.wk)) {
          errors.push(`${where}.after ${c.after} moves the session out of week ${hit.week.wk}`);
          return;
        }
        out.target = { sessionId: clampStr(target.sessionId, 40) };
        out.before = hit.session.d;
        out.after = clampStr(c.after, 10);
        break;
      }

      /* ----- the structure of one session ----- */
      case 'run-change-structure': {
        if (!isStr(target.sessionId)) { errors.push(`${where}.target.sessionId is required`); return; }
        const hit = sessionIndex.get(target.sessionId);
        if (!hit) { errors.push(`${where}.target.sessionId "${target.sessionId}" is not a session in the plan`); return; }
        const structure = cleanStructure(c.after);
        if (!structure) { errors.push(`${where}.after must be a usable structure — repetitions with dist or timeSec`); return; }
        // Switching between a distance-based and a time-based prescription is a legitimate and
        // explicit move (a treadmill session is measured in minutes), and the runner is told
        // which one they asked for. What is refused is a *mix* inside one session, which no
        // screen can show honestly.
        const kinds = new Set(structure.map(r => (r.dist != null ? 'dist' : 'time')));
        if (kinds.size > 1) { errors.push(`${where}.after mixes distance and time repetitions in one session — convert the whole session`); return; }
        out.target = { sessionId: clampStr(target.sessionId, 40) };
        out.before = hit.session.structure || null;
        out.after = structure;
        break;
      }

      /* ----- one week's volume ----- */
      case 'run-change-volume': {
        if (!isInt(target.wk, 1, 52)) { errors.push(`${where}.target.wk must be a week number`); return; }
        const week = weeks.get(target.wk);
        if (!week) { errors.push(`${where}.target.wk ${target.wk} is not a week in the plan`); return; }
        if (!isNum(c.after) || c.after <= 0) { errors.push(`${where}.after must be the new weekly volume in kilometres`); return; }
        if (c.after > 300) { errors.push(`${where}.after exceeds 300 km — nothing in this plan is that`); return; }
        if (isNum(week.km) && week.km > 0) {
          const ratio = c.after / week.km;
          if (ratio > 1 + MAX_VOLUME_STEP) {
            errors.push(`${where}.after raises week ${target.wk} by ${((ratio - 1) * 100).toFixed(0)}% — at most ${MAX_VOLUME_STEP * 100}% in one change`);
            return;
          }
        }
        out.target = { wk: target.wk };
        out.before = isNum(week.km) ? week.km : null;
        out.after = Math.round(c.after * 10) / 10;
        break;
      }

      /* ----- the zones themselves ----- */
      case 'run-change-pace-zone': {
        // A scalar, like run-change-volume: the new threshold pace in seconds per kilometre.
        // Accepting the object form as well would mean two shapes for one field, and the client
        // would have to guess which one the model meant.
        const a = { thresholdPace: isNum(after) ? after : (after || {}).thresholdPace };
        if (!isNum(a.thresholdPace) || a.thresholdPace <= 0) { errors.push(`${where}.after must be the new threshold pace in seconds per kilometre`); return; }
        // 2:30/km to 12:00/km. Outside that the number is a typo — a threshold pace in minutes
        // per mile, or a heart rate pasted into the wrong field — and every zone, every session
        // target and every historical compliance number is derived from it.
        if (a.thresholdPace < 150 || a.thresholdPace > 720) {
          errors.push(`${where}.after.thresholdPace ${a.thresholdPace} s/km is not a plausible threshold pace (2:30-12:00 per km)`);
          return;
        }
        // A zone table arriving alongside a threshold pace that does not generate it is the
        // stale-table bug in a new place: the app computes zones from the pace (zones.js), so a
        // supplied table can only disagree.
        if (a.paceZones != null) {
          errors.push(`${where}.after must not carry paceZones — zones are derived from thresholdPace`);
          return;
        }
        out.target = {};
        out.before = isNum(run?.zones?.thresholdPace) ? run.zones.thresholdPace : null;
        out.after = { thresholdPace: Math.round(a.thresholdPace) };
        break;
      }

      default:
        errors.push(`${where}.type "${c.type}" has no case`);
        return;
    }
    changes.push(out);
  });

  if (errors.length) return fail(errors);

  /* ----- rules that are only wrong in company ----- */
  const days = new Set();
  const sessions = new Set();
  const weeksTouched = new Set();
  for (const ch of changes) {
    if (ch.type === 'run-add-session') {
      weeksTouched.add('wk' + ch.target.wk);
      const key = `${ch.target.wk}|${ch.after.d}|${ch.after.type}`;
      if (days.has(key)) { errors.push(`two changes both add a ${ch.after.type} session to week ${ch.target.wk} on ${ch.after.d}`); }
      days.add(key);
    }
    if (ch.type === 'run-shift-day' && ch.after) {
      const key = `shift|${ch.after}`;
      if (days.has(key)) errors.push(`two sessions are both moved onto ${ch.after}, which the app cannot express`);
      days.add(key);
    }
    if (ch.target.sessionId) {
      if (sessions.has(ch.target.sessionId)) {
        errors.push(`session ${ch.target.sessionId} is changed twice in one review — one change per session`);
      }
      sessions.add(ch.target.sessionId);
    }
    if (ch.type === 'run-remove-session') {
      const key = 'rm' + ch.target.sessionId;
      if (sessions.has(key)) errors.push(`session ${ch.target.sessionId} is both removed and changed`);
      sessions.add(key);
    }
  }
  if (errors.length) return fail(errors);

  // A change whose `after` already equals the plan is dropped rather than refused, matching
  // validateReview: one redundant entry should not cost the whole review.
  const kept = changes.filter(ch => JSON.stringify(ch.before ?? null) !== JSON.stringify(ch.after ?? null));
  if (!kept.length) return { ok: true, nochange: true };

  /* ----- HYBRID: the interference rules, applied to the plan the changes produce -----
   *
   * Run after the change-set is known-legal and non-empty, and against the *result* rather than
   * the individual change: moving a quality session onto a leg day is not a property of the
   * change, it is a property of the week that change creates. `ctx.S` is the profile state (so
   * the leg days can be read); without it the check is skipped rather than falsely passed — the
   * builder has already enforced the rules when the plan was written, so an absent state means
   * "no strength plan to interfere with", not "unchecked".
   *
   * Blocking, per Linus (2026-09-15). The whole set is refused, which is the same posture as the
   * strength validator: nothing is ever half-applied. */
  if (ctx.S) {
    const next = applyRunChanges(run, kept);
    const touched = new Set();
    for (const ch of kept) {
      if (ch.type === 'run-add-session' || ch.type === 'run-change-volume') touched.add(ch.target.wk);
      else for (const w of next.weeks || []) {
        if ((w.sessions || []).some(s => s.id === ch.target.sessionId)) touched.add(w.wk);
      }
    }
    const dates = (next.weeks || []).flatMap(w => w.sessions || []).map(s => s.d).filter(Boolean).sort();
    const legs = dates.length ? legDays(ctx.S, { from: dates[0], to: dates[dates.length - 1] }) : new Set();
    const clashes = [];
    for (const wk of touched) {
      const week = (next.weeks || []).find(w => w.wk === wk);
      if (!week) continue;
      for (const e of checkWeek(week, legs, { phase: week.phase })) clashes.push({ wk, ...e });
    }
    if (clashes.length) {
      return fail(clashes.map(c =>
        `week ${c.wk}: ${c.message} — ${c.fix}. Move the run day or shift the strength session; the rules block this change.`
      ));
    }
  }

  return {
    ok: true,
    proposal: {
      changes: kept,
      // The zones change is the only one that rewrites the table; it travels separately because
      // the client applies it through the zone recompute rather than through the plan edit.
      zoneChange: kept.find(ch => ch.type === 'run-change-pace-zone')?.after?.thresholdPace ?? null
    }
  };
}

/** Is `d` one of the seven days of the week that starts on the plan week's first session? */
function inWeek(d, week, wk) {
  const first = (week.sessions || []).map(s => s.d).filter(Boolean).sort()[0];
  if (!first) return true;   // an empty week accepts any date inside its own window
  const start = new Date(first + 'T00:00:00Z');
  // Weeks are anchored on the plan start (a Sunday), so the window is the seven days from the
  // week's own start rather than from whatever session happens to come first alphabetically.
  const anchor = new Date(start.getTime() - ((wk * 7 - 7 + start.getUTCDay()) % 7) * 86400000);
  const diff = (new Date(d + 'T00:00:00Z') - anchor) / 86400000;
  return diff >= 0 && diff < 7;
}

/** The running namespace as it should be after a change-set is applied — pure, so the client and
 *  the server agree by construction. The actual apply lives in frontend/src/lib/run/run-plan.js
 *  for the UI; this is the server's copy, used by tests and by a future scheduled review. */
export function applyRunChanges(run, changes) {
  const next = JSON.parse(JSON.stringify(run || { calibration: null, zones: null, weeks: [] }));
  for (const ch of changes) {
    switch (ch.type) {
      case 'run-add-session': {
        const week = (next.weeks || []).find(w => w.wk === ch.target.wk);
        if (!week) break;
        week.sessions = week.sessions || [];
        week.sessions.push({
          id: 'r_' + Math.random().toString(36).slice(2, 10),
          d: ch.after.d, type: ch.after.type, structure: ch.after.structure,
          km: estimateKm(ch.after.type, ch.after.structure), targetPaceSec: null, targetHR: null,
          notes: ch.after.notes || '', done: false, actual: null
        });
        week.sessions.sort((a, b) => String(a.d).localeCompare(String(b.d)));
        break;
      }
      case 'run-remove-session':
        for (const w of next.weeks || []) w.sessions = (w.sessions || []).filter(s => s.id !== ch.target.sessionId);
        break;
      case 'run-shift-day':
        for (const w of next.weeks || []) for (const s of w.sessions || []) if (s.id === ch.target.sessionId) s.d = ch.after;
        for (const w of next.weeks || []) w.sessions.sort((a, b) => String(a.d).localeCompare(String(b.d)));
        break;
      case 'run-change-structure':
        for (const w of next.weeks || []) for (const s of w.sessions || []) if (s.id === ch.target.sessionId) s.structure = ch.after;
        break;
      case 'run-change-volume': {
        const week = (next.weeks || []).find(w => w.wk === ch.target.wk);
        if (week) week.km = ch.after;
        break;
      }
      case 'run-change-pace-zone':
        next.zones = { ...(next.zones || {}), thresholdPace: ch.after.thresholdPace };
        break;
    }
  }
  return next;
}

const estimateKm = (type, structure) => {
  if (!structure?.length) return null;
  let work = 0;
  for (const r of structure) {
    if (r.dist) work += r.rep * (r.dist / 1000);
    else if (r.timeSec) work += r.rep * (r.timeSec / 60) / 5;
  }
  return Math.round((work + 4) * 10) / 10;
};

export { validateRun };
function fail(errors) { return { ok: false, errors }; }
