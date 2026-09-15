/* Applying the six running change types.
 *
 * Mirror of `applyRunChanges` in `api/coach/run/validate-run.js`. The server validates a
 * proposal and the client applies it — and the client's apply is the one that actually mutates
 * state, so it has to be the same closed list on this side of the wire. A type the server let
 * through and the app cannot apply is a proposal screen with a button that throws.
 *
 * Every function takes `(run, change)` and mutates `run` in place. The store hands the apply path
 * a throwaway clone and keeps it only if nothing throws, which is what makes a change-set
 * atomic — a half-applied running plan is not a state anyone can recover from by hand.
 *
 * HYBRID: new file.
 */
import { cleanSession, liveSession, weekOfSession, addDays, daysBetween, weekdayOf } from './run-model.js'
import { zonesFrom } from './run-zones.js'
import { cleanStructure } from './run-model.js'
import { WORKOUT_TYPES, RUN_TYPES } from './run-vocab.js'

const need = (x, what) => { if (!x) throw new Error(`missing ${what}`); return x }

/**
 * One implementation per allowed type. This object is the closed list on the client side: a type
 * with no entry cannot be applied, whatever the server permitted.
 */
export const RUN_CHANGE_APPLY = {
  /**
   * A new session in a week. The id is taken from the answer when it looks like one and invented
   * from the date and type otherwise — a session with no id cannot be named by a later change,
   * which makes the whole plan un-editable by the coach that just wrote it.
   */
  'run-add-session': (run, c) => {
    const wk = Number(c.target?.wk)
    const week = need((run.weeks || []).find(w => w.wk === wk), `week ${wk}`)
    const a = c.after || {}
    if (!a.d || typeof a.d !== 'string') throw new Error('session without a date')
    if (!RUN_TYPES.includes(a.type) || a.type === 'rest') throw new Error(`unknown type ${a.type}`)
    // Two sessions on one day is a plan nobody can run, and a merge is the usual way it happens.
    if ((week.sessions || []).some(s => s.d === a.d)) throw new Error(`a session already sits on ${a.d}`)
    const s = cleanSession({
      id: typeof a.id === 'string' && a.id ? a.id : `run-${a.d}-${a.type}`,
      d: a.d, type: a.type,
      structure: a.structure, km: a.km, notes: a.notes
    })
    if (!s) throw new Error('unusable session')
    if (!s.km) s.km = 5
    week.sessions.push(s)
    week.sessions.sort((x, y) => (x.d < y.d ? -1 : 1))
    resizeWeek(week)
  },

  'run-remove-session': (run, c) => {
    const id = c.target?.sessionId
    const week = need(weekOfSession(run, id), `session ${id}`)
    week.sessions = week.sessions.filter(s => s.id !== id)
    resizeWeek(week)
  },

  /**
   * Move a session to another day. Refused when the target day already holds one or when it
   * would leave the week — a shift outside its own week silently reorders the plan and, worse,
   * lands a long run next to the previous week's leg day.
   *
   * The week's span is taken from its **calendar week**, not from its first and last session:
   * measuring against the sessions themselves makes moving onto the boundary day look like
   * leaving the week, which refuses the one shift nobody would object to.
   */
  'run-shift-day': (run, c) => {
    const id = c.target?.sessionId
    const week = need(weekOfSession(run, id), `session ${id}`)
    const s = need(liveSession(run, id), `session ${id}`)
    const to = c.after
    if (typeof to !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('bad date')
    // The target must fall inside the same seven-day window the week starts in.
    const weekStart = week.sessions.reduce((min, x) => (x.d < min ? x.d : min), week.sessions[0].d)
    // The window opens on the Monday of that date, so a plan starting mid-week is measured from
    // a real week boundary rather than from wherever the first session happened to land.
    const offset = (weekdayOf(weekStart) + 6) % 7      // days since Monday
    const monday = addDays(weekStart, -offset)
    const gap = daysBetween(monday, to)
    if (gap == null || gap < 0 || gap > 6) throw new Error('outside the week')
    if (week.sessions.some(x => x.d === to && x.id !== id)) throw new Error(`a session already sits on ${to}`)
    s.d = to
    week.sessions.sort((x, y) => (x.d < y.d ? -1 : 1))
    resizeWeek(week)
  },

  /**
   * Replace the repetitions. All distances or all times, never mixed — the unit is decided by
   * the first entry and every later one must agree.
   */
  'run-change-structure': (run, c) => {
    const id = c.target?.sessionId
    const s = need(liveSession(run, id), `session ${id}`)
    const structure = cleanStructure(c.after)
    if (!structure.length) throw new Error('empty structure')
    // The type follows the unit: switching a session from 800s to 3-minute reps makes it an
    // `interval-time`, and leaving it as `interval` would label the card with the wrong unit.
    const byDist = structure[0].dist != null
    if (s.type === 'interval' && !byDist) s.type = 'interval-time'
    else if (s.type === 'interval-time' && byDist) s.type = 'interval'
    else if (!WORKOUT_TYPES[s.type]?.structure && s.type !== 'interval' && s.type !== 'interval-time') {
      s.type = byDist ? 'interval' : 'interval-time'
    }
    s.structure = structure
    const week = weekOfSession(run, id)
    if (week) resizeWeek(week)
  },

  /**
   * Set a week's total. The individual sessions are re-sized from it — the coach is explicitly
   * told not to propose per-session distances alongside this, because two numbers that must
   * agree and are computed in two places eventually disagree.
   */
  'run-change-volume': (run, c) => {
    const wk = Number(c.target?.wk)
    const week = need((run.weeks || []).find(w => w.wk === wk), `week ${wk}`)
    const km = Number(c.after)
    if (!Number.isFinite(km) || km <= 0) throw new Error('bad volume')
    const prev = week.km || 0
    // At most +50 % in one change. A bigger jump is not a plan change, it is a different plan,
    // and no validator can tell a bold progression from a typo.
    if (prev && km > prev * 1.5) throw new Error('volume step too large')
    week.km = Math.round(km * 10) / 10
    resizeWeek(week, true)
  },

  /**
   * A new threshold pace. Only the number travels: the zone table is computed from it here, and
   * a table supplied by the model would be a table that disagrees with its own number.
   */
  'run-change-pace-zone': (run, c) => {
    const pace = Number(c.after?.thresholdPace)
    if (!Number.isFinite(pace) || pace <= 0) throw new Error('bad threshold pace')
    const paceZones = zonesFrom(pace)
    run.zones = { ...(run.zones || {}), thresholdPace: Math.round(pace), paceZones }
    // Every session's target pace follows the new table. Leaving them would show a plan whose
    // header and whose cards disagree about how fast to run.
    for (const w of run.weeks || []) {
      for (const s of w.sessions || []) {
        const zone = WORKOUT_TYPES[s.type]?.zone
        const band = zone ? paceZones[zone] : null
        s.targetPaceSec = band ? Math.round((band[0] + band[1]) / 2) : null
      }
    }
  }
}

export const RUN_CHANGE_TYPES = Object.keys(RUN_CHANGE_APPLY)

/** Apply an accepted subset in order. Throwing part-way through discards the whole set. */
export function applyRunChanges(run, changes) {
  for (const c of changes || []) {
    const fn = RUN_CHANGE_APPLY[c.type]
    if (!fn) throw new Error(`cannot apply ${c.type}`)
    fn(run, c)
  }
  return { applied: (changes || []).length }
}

/**
 * Re-size a week's sessions after its total moved. The long run keeps its share; the structured
 * sessions keep the distance their repetitions require; the easy runs take the rest. Same order
 * as the builder, for the same reason.
 */
function resizeWeek(week, explicit = false) {
  const sessions = week.sessions || []
  if (!sessions.length) { week.km = 0; return }
  const km = explicit ? week.km : Math.round(sessions.reduce((n, s) => n + (s.km || 0), 0) * 10) / 10
  week.km = km
  const long = sessions.find(s => s.type === 'long')
  const easy = sessions.filter(s => !s.structure && s.type !== 'long')
  const fixed = sessions.filter(s => s.structure)
  let used = 0
  if (long) { long.km = round1(Math.min(km * 0.5, Math.max(6, km * 0.35))); used += long.km }
  for (const s of fixed) { used += s.km || 0 }
  if (!easy.length) return
  const each = Math.max(3, (km - used) / easy.length)
  for (const s of easy) s.km = round1(each)
}

const round1 = n => Math.round(n * 10) / 10

/** The current value a run change is about — what `before` is checked against for staleness. */
export function currentRunValue(run, change) {
  switch (change.type) {
    case 'run-add-session': {
      const wk = Number(change.target?.wk)
      const week = (run?.weeks || []).find(w => w.wk === wk)
      return week ? week.km : null
    }
    case 'run-change-volume': {
      const week = (run?.weeks || []).find(w => w.wk === Number(change.target?.wk))
      return week ? week.km : null
    }
    case 'run-change-pace-zone':
      return run?.zones?.thresholdPace ?? null
    default: {
      const s = change.target?.sessionId ? liveSession(run, change.target.sessionId) : null
      return s || null
    }
  }
}

/**
 * Mark the run changes that can no longer be applied: the session they name is gone, or the week
 * has moved since the proposal was computed. A stale change is disabled and explained, never
 * silently skipped — same rule as the strength half.
 */
export function markRunStale(proposal, run) {
  if (!proposal?.runChanges?.changes) return proposal
  const changes = proposal.runChanges.changes.map(c => {
    let stale = false
    const id = c.target?.sessionId
    if (id && !liveSession(run, id)) stale = true
    if (c.type === 'run-add-session') {
      const wk = Number(c.target?.wk)
      if (!(run?.weeks || []).some(w => w.wk === wk)) stale = true
      else if (c.after?.d && (run.weeks.find(w => w.wk === wk).sessions || []).some(s => s.d === c.after.d)) {
        stale = true   // something already occupies that day
      }
    }
    if (c.type === 'run-change-volume' && !(run?.weeks || []).some(w => w.wk === Number(c.target?.wk))) stale = true
    return { ...c, status: stale ? 'stale' : (c.status === 'stale' ? 'proposed' : c.status || 'proposed') }
  })
  return { ...proposal, runChanges: { ...proposal.runChanges, changes } }
}
