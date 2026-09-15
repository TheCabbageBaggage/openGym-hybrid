// HYBRID: interference — the rules that keep a strength plan and a running plan from fighting.
//
// This is the part that makes the feature worth having. Two apps can each write a perfect plan
// and still produce a bad athlete: a long run twelve hours after a heavy squat day is not a
// training stimulus, it is a hole in the week that costs recovery and buys nothing. The rules
// here are deterministic arithmetic over two documents that already exist, and they run in three
// places from the same code:
//
//   * the plan builder refuses to *emit* a week that breaks them (buildWeeks -> checkWeek)
//   * the validator refuses to *apply* a change-set that breaks them (validate-run.js)
//   * the review prompt is *told* about them, so the model proposes a complying week first
//
// Blocking, not warning — Linus confirmed this on 2026-09-15. A warning in a review screen is
// read once and dismissed; a rule that refuses the change is read every time, which is the only
// version that survives contact with a tired Wednesday.
//
// Everything is pure. `strengthOn(S, d)` is the only door into the strength side, so this file
// never learns what a routine is.

import { WORKOUT_TYPES } from './vocab.js';
import { strengthOn, daysBetween } from './model.js';

/* ---------- what counts as a leg day ---------- */

// Linus, 2026-09-15: "nimm die 50% Schwelle". A routine is leg-heavy when at least half of the
// work it prescribes lands on a leg muscle group.
//
// A share rather than a name match ("anything with Squat in it") because the strength plan is
// edited constantly — a routine gets renamed, an accessory gets swapped, a second leg movement
// gets added to an upper day. The share recomputes itself from whatever the routine is *today*,
// which is the only definition that stays true across an edit.
//
// The group list is deliberately the hip-and-knee chain. Calves count (they are load-bearing on
// every run) and glutes count (they are the engine of the stride). `lower back` does not: it is
// a deadlift day's *fatigue* but it is not what a long run is competing with.
export const LEG_GROUPS = ['quads', 'hamstrings', 'glutes', 'calves', 'legs'];
export const LEG_SHARE_THRESHOLD = 0.5;

/**
 * Is one routine a leg day? Counts *sets*, not exercises, because three sets of squats and one
 * set of calf raises are not equally heavy days and an exercise count says they are.
 *
 * @param {object} routine  a cleaned routine: { id, name, ex: [{ id, sets, bp? }] }
 * @param {object} bodyPartOf  id -> body part, injected so this file needs no library import
 */
export function isLegDay(routine, bodyPartOf = () => null) {
  const ex = Array.isArray(routine?.ex) ? routine.ex : [];
  let leg = 0, total = 0;
  for (const e of ex) {
    const sets = Number.isFinite(e?.sets) ? e.sets : 1;
    total += sets;
    const bp = e?.bp || bodyPartOf(e?.id);
    if (bp && LEG_GROUPS.includes(bp)) leg += sets;
  }
  return total > 0 && leg / total >= LEG_SHARE_THRESHOLD;
}

/**
 * The leg days in a strength plan, as a set of ISO dates over a horizon.
 *
 * `S.week` maps weekday -> routine id(s); `S.routines` holds the routines. A day with two
 * routines is a leg day if *either* of them is, because the athlete still squats that day.
 */
export function legDays(S, { from, to } = {}) {
  const byId = new Map((S?.routines || []).map(r => [r.id, r]));
  const out = new Set();
  if (!from || !to) return out;
  for (let d = from; daysBetween(d, to) >= 0; d = addDays(d, 1)) {
    const slots = strengthOn(S, d);
    if (slots.some(id => isLegDay(byId.get(id)))) out.add(d);
  }
  return out;
}

/* ---------- the rules ---------- */

// Two sessions interfere when the *hard* part of one lands close enough to the hard part of the
// other that the second is paid for out of the first's recovery. The windows below are in whole
// days between the two dates.
//
// 48 hours is the headline number (Linus set it): a heavy leg day and a long run need two nights
// between them. A quality run (interval, tempo, threshold) and a leg day need the same, and the
// hard direction is asymmetric — a leg day *after* an interval session is normal training, an
// interval session *after* a leg day is a session run on dead legs.
export const MIN_HOURS_LEG_TO_LONG = 48;
export const MIN_HOURS_LEG_TO_QUALITY = 48;
export const MIN_HOURS_LONG_TO_QUALITY = 24;

// A day has ~24 hours in it, so "48 hours apart" between ISO dates means at least two days of
// separation. `daysBetween(a,b) === 2` is the first legal arrangement.
const CLEAR_LEG_LONG = MIN_HOURS_LEG_TO_LONG / 24;          // 2
const CLEAR_LEG_QUALITY = MIN_HOURS_LEG_TO_QUALITY / 24;    // 2
const CLEAR_LONG_QUALITY = MIN_HOURS_LONG_TO_QUALITY / 24;  // 1

/**
 * The weekly rules that hold regardless of the calendar: how much running intensity a week may
 * carry while the athlete is also squatting, and how much leg volume a week may carry while the
 * athlete is also running quality.
 *
 * Both directions of the same interference, capped on both sides. The caps are multipliers on
 * the plan's own numbers rather than absolute values, so they hold for a beginner and a
 * competitive lifter without either being told a number that does not apply to them.
 */
export const HARD_SHARE_CAP_WITH_LEGS = 0.25;   // max share of weekly km at quality pace
export const LEG_VOLUME_MULTIPLIER = 0.75;      // leg sets when >=2 quality runs a week

/**
 * Check one week of a running plan against a strength plan. Returns a list of violations, empty
 * when the week is legal. This is the function the builder, the validator and the prompt all
 * call, so there is exactly one answer to "is this week allowed".
 *
 * @param {object} week      a built week: { wk, phase, km, sessions: [{d, type, ...}] }
 * @param {Set<string>} legs  ISO dates of the leg days, from legDays()
 * @param {object} [opts]     { phase } — a deload or taper week is allowed to be sloppier
 */
export function checkWeek(week, legs, opts = {}) {
  const errors = [];
  const sessions = Array.isArray(week?.sessions) ? week.sessions : [];
  const phase = opts.phase || week?.phase || 'build';
  // A deload or a taper is *meant* to be light. Refusing a tight arrangement in a week that is
  // already at 60% of normal volume is protecting a rule instead of protecting the athlete. The
  // slack is *added* to what the week is allowed to get away with (one day less of separation),
  // not subtracted from the requirement — getting that backwards made a deload demand 72 hours.
  const slack = phase === 'deload' || phase === 'taper' ? 1 : 0;

  for (const s of sessions) {
    const meta = WORKOUT_TYPES[s.type];
    // The long run is checked even though it is not `quality` — it is the session this rule is
    // really about, and reading `quality` alone left it unprotected (found by the tests).
    if (!meta || (!meta.quality && !meta.long)) continue;
    const want = meta.long ? CLEAR_LEG_LONG : CLEAR_LEG_QUALITY;
    const near = nearest(s.d, legs);
    // Signed: a leg day *behind* the session is what the rule is about. A leg day *ahead* of it
    // is the run's own taper (Monday's intervals cost Tuesday's squats, not the other way
    // round), so only a non-negative distance is a violation.
    if (near != null && near >= 0 && near + slack < want) {
      errors.push({
        rule: s.type === 'long' ? 'leg-long' : 'leg-quality',
        d: s.d, type: s.type, legDay: near,
        message: `${label(s.type)} on ${s.d} sits ${near * 24}h after a heavy leg day (${want * 24}h required)`,
        fix: `move it to ${addDays(s.d, want - near)} or later, or move the leg day`
      });
    }
  }

  // The long run and the quality sessions are the same 48 hours of a runner's week; putting a
  // third hard session in the middle of them is how a week stops being trainable.
  const long = sessions.find(s => s.type === 'long');
  if (long) {
    for (const s of sessions) {
      const meta = WORKOUT_TYPES[s.type];
      if (!meta?.quality || meta.long || !s.d || !long.d) continue;
      const gap = Math.abs(daysBetween(long.d, s.d));
      if (gap + slack < CLEAR_LONG_QUALITY) {
        errors.push({
          rule: 'long-quality',
          d: s.d, type: s.type, legDay: null,
          message: `${label(s.type)} on ${s.d} is ${gap} day(s) from the long run on ${long.d} (24h required)`,
          fix: 'separate the quality session and the long run by at least a day'
        });
      }
    }
  }

  return errors;
}

/**
 * Check a whole plan. Returns per-week violations plus the summary a prompt or a review screen
 * needs. `blocking` is true when at least one week is illegal outside a deload/taper — which is
 * the condition a caller must refuse on.
 */
export function checkPlan(run, S, { from = null, to = null } = {}) {
  const weeks = Array.isArray(run?.weeks) ? run.weeks : [];
  const all = weeks.flatMap(w => w.sessions || []).map(s => s.d).filter(Boolean).sort();
  const start = from || all[0] || null;
  const end = to || all[all.length - 1] || null;
  const legs = start && end ? legDays(S, { from: start, to: end }) : new Set();

  const per = [];
  for (const w of weeks) {
    const errors = checkWeek(w, legs, { phase: w.phase });
    if (errors.length) per.push({ wk: w.wk, phase: w.phase, errors });
  }
  const hard = per.filter(p => p.phase !== 'deload' && p.phase !== 'taper');
  return {
    ok: hard.length === 0,
    blocking: hard.length > 0,
    weeks: per,
    legDays: [...legs].sort(),
    counts: { violations: per.reduce((a, p) => a + p.errors.length, 0), weeks: per.length }
  };
}

/**
 * The leg-day context the review prompt needs: for every long run and quality session in the
 * plan, how far it sits from the nearest leg day. The model gets numbers, not a rule it has to
 * re-derive from a calendar it cannot see — because the calendar is in the client.
 */
export function proximity(run, S) {
  const legs = legDays(S, planWindow(run));
  const out = [];
  for (const w of run?.weeks || []) {
    for (const s of w.sessions || []) {
      const meta = WORKOUT_TYPES[s.type];
      // Same exception as checkWeek: a long run is not quality, but it is the session the report
      // exists for, so it is listed with the hours behind it.
      if ((!meta?.quality && !meta?.long) || !s.d) continue;
      const near = nearest(s.d, legs);
      out.push({
        d: s.d, wk: w.wk, type: s.type,
        hoursFromLegDay: near == null ? null : near * 24,
        legal: near == null || near < 0 || near >= (meta.long ? CLEAR_LEG_LONG : CLEAR_LEG_QUALITY)
      });
    }
  }
  return out;
}

/**
 * How much leg volume a week may carry given how many quality runs it holds. Returns the
 * multiplier the review prompt should apply to leg sets — 1 when the week is easy, 0.75 when it
 * holds two or more quality sessions.
 */
export function legVolumeMultiplier(run, wk) {
  const week = (run?.weeks || []).find(w => w.wk === wk);
  const quality = (week?.sessions || []).filter(s => WORKOUT_TYPES[s.type]?.quality).length;
  return quality >= 2 ? LEG_VOLUME_MULTIPLIER : 1;
}
/* ---------- helpers ---------- */

/** Days from the *nearest preceding* leg day to `d` — null when there is none before it. */
function nearestPreceding(d, legs) {
  if (!d || !legs?.size) return null;
  let best = null;
  for (const l of legs) {
    const diff = daysBetween(l, d);
    if (diff < 0) continue;
    if (best == null || diff < best) best = diff;
  }
  return best;
}

/** Days from `d` to the *nearest* leg day, signed — negative when the leg day is after. */
function nearest(d, legs) {
  if (!d || !legs?.size) return null;
  let best = null;
  for (const l of legs) {
    const diff = daysBetween(l, d);
    if (best == null || Math.abs(diff) < Math.abs(best)) best = diff;
  }
  return best;
}

const planWindow = run => {
  const all = (run?.weeks || []).flatMap(w => w.sessions || []).map(s => s.d).filter(Boolean).sort();
  return { from: all[0] || null, to: all[all.length - 1] || null };
};

const label = type => WORKOUT_TYPES[type]?.label || type;

export function addDays(iso, n) {
  const t = new Date(iso + 'T00:00:00Z').getTime() + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export { CLEAR_LEG_LONG, CLEAR_LEG_QUALITY, CLEAR_LONG_QUALITY };
