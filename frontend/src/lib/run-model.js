/* The running plan, on the client side.
 *
 * This is the mirror of `api/coach/run/model.js` — the parts of it the browser needs: the shape
 * of `S.run`, the two helpers the views and the interference warnings read, and the cleaning
 * that keeps a hand-edited or hand-imported plan inside the same bounds the server enforces.
 *
 * The mirror is deliberate and it is tested (`run-model.test.js` pins the schema key set against
 * the server module's). Two implementations of one schema is a smell, but the alternative is
 * worse: the browser cannot import from `api/`, and shipping a plan the server would reject —
 * or trusting a server field the app never checks — is exactly the bug this feature is most
 * exposed to. `run-parity.test.js` compares behaviour, not text.
 *
 * HYBRID: new file. Nothing here is reachable unless `S.run` is present, so a strength-only
 * profile is byte-identical to upstream.
 */

// Bounds. They are the server's numbers, restated here because the client has to refuse the
// same plans. `MAX_RUN_WEEKS` is 52 and not 12: the *coach* is limited to twelve weeks per
// proposal (a year-long plan is not something anyone reviews), but a plan a person built by
// hand or imported can legitimately run a full season.
export const MAX_RUN_WEEKS = 52
export const MAX_RUN_SESSIONS_PER_WEEK = 7
export const MAX_RUN_KM_WEEK = 300
export const MAX_RUN_STRUCTURE = 4
export const MAX_RUN_NOTES = 600

/** A profile with no running plan. Frozen so a caller cannot accidentally mutate the default. */
export const EMPTY_RUN = Object.freeze({ calibration: null, zones: null, weeks: [], updatedAt: null })

export const isNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0

/** The run namespace, created on demand. Never writes anything unless it is asked to. */
export function ensureRun(S) {
  if (!S) return { ...EMPTY_RUN }
  if (!S.run || typeof S.run !== 'object') S.run = { ...EMPTY_RUN }
  const r = S.run
  if (!Array.isArray(r.weeks)) r.weeks = []
  if (r.calibration === undefined) r.calibration = null
  if (r.zones === undefined) r.zones = null
  return r
}

/** Whether this profile has a running plan at all. Every running UI hangs off this. */
export const hasRun = S => !!(S?.run && Array.isArray(S.run.weeks) && S.run.weeks.length)

/** Every session in the plan, flattened, with its week number attached. */
export function allSessions(run) {
  const out = []
  for (const w of run?.weeks || []) {
    for (const s of w.sessions || []) out.push({ ...s, wk: w.wk })
  }
  return out
}

/**
 * One session by id — the lookup every `run-*` change target goes through.
 *
 * Returns a **copy**, deliberately: it is the read path, used by views and by staleness checks,
 * and handing a view a reference into the store's state is how a stray mutation silently edits
 * the plan. The write path uses `liveSession`, which returns the object itself.
 */
export const findSession = (run, id) => {
  for (const w of run?.weeks || []) {
    for (const s of w.sessions || []) if (s.id === id) return { ...s, wk: w.wk }
  }
  return null
}

/**
 * The session object itself, for the apply path — mutating the result mutates the plan.
 *
 * Separate from `findSession` on purpose. An apply that mutates a copy is silent in the worst
 * way: it reports success, changes nothing, and the next read shows the old plan. Two functions
 * with different names make that mistake impossible to write by accident.
 */
export function liveSession(run, id) {
  for (const w of run?.weeks || []) {
    for (const s of w.sessions || []) if (s.id === id) return s
  }
  return null
}

/** The week carrying the given session id. */
export function weekOfSession(run, id) {
  for (const w of run?.weeks || []) {
    if ((w.sessions || []).some(s => s.id === id)) return w
  }
  return null
}

/* ============================ dates ============================ */
// `YYYY-MM-DD` as a pure civil date. Everything here is UTC-midnight arithmetic so a plan does
// not shift by a day when the browser is west of Greenwich — the same reason the server does it.

export const iso = ts => new Date(ts).toISOString().slice(0, 10)

export function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** `getUTCDay()` of a civil date: 0 = Sunday, matching the server's slot weekday. */
export const weekdayOf = isoDate => new Date(isoDate + 'T00:00:00Z').getUTCDay()

export function daysBetween(a, b) {
  if (!a || !b) return null
  const ms = new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')
  return Math.round(ms / 86400000)
}

/**
 * Which routine ids are scheduled on a date, folded to the list form the `week` map now uses.
 * A legacy bare string and a one-element list answer the same, like everywhere else.
 */
export const routinesOn = (S, isoDate) => [].concat(S?.week?.[weekdayOf(isoDate)] ?? []).filter(Boolean)

/** Whether a strength session is planned that day — the fact the interference rules read. */
export const strengthOn = (S, isoDate) => routinesOn(S, isoDate).length > 0

/* ============================ cleaning ============================ */

/**
 * A structure repetition, reduced to the one legal shape: `{ rep, dist }` **or**
 * `{ rep, timeSec }`, never both, plus `paceZone` and `restSec`. A session whose repetitions
 * are half distances and half times is dropped rather than half-shown.
 */
/**
  * A structure repetition, reduced to the one legal shape: `{ rep, dist }` **or**
  * `{ rep, timeSec }`, never both, plus `paceZone` and `restSec`.
  *
  * **All distances or all times, never mixed** — the unit is decided by the first repetition and
  * every later one has to agree. A session whose repetitions are half distances and half times is
  * dropped *entirely* rather than partly rendered: a card showing "6 x 800 m" and "4 x 3:00" in
  * the same list is worse than no card, because it looks like a plan.
  *
  * The unit test is strict (`!= null` on both fields, so `dist: 800, timeSec: null` is still a
  * distance), because a payload may legitimately carry the other key as an explicit null.
  */
export function cleanStructure(structure) {
  if (!Array.isArray(structure) || !structure.length) return []
  const first = structure[0]
  if (!first || typeof first !== 'object') return []
  const byDist = first.dist != null && first.timeSec == null
  const byTime = first.timeSec != null && first.dist == null
  if (!byDist && !byTime) return []
  const out = []
  for (const r of structure.slice(0, MAX_RUN_STRUCTURE)) {
    if (!r || typeof r !== 'object') return []
    // Any disagreement about the unit voids the whole structure — see the note above.
    if (byDist && (r.dist == null || r.timeSec != null)) return []
    if (byTime && (r.timeSec == null || r.dist != null)) return []
    const rep = Math.min(20, Math.max(1, Math.round(Number(r.rep) || 1)))
    const entry = { rep, paceZone: typeof r.paceZone === 'string' ? r.paceZone : 'easy' }
    if (byDist) {
      if (!isNum(Number(r.dist))) return []
      entry.dist = Math.min(10000, Math.max(50, Math.round(Number(r.dist))))
    } else {
      if (!isNum(Number(r.timeSec))) return []
      entry.timeSec = Math.min(3600, Math.max(20, Math.round(Number(r.timeSec))))
    }
    if (isNum(Number(r.restSec))) entry.restSec = Math.min(600, Math.round(Number(r.restSec)))
    out.push(entry)
  }
  return out
}

/** Notes: a single string, trimmed to the bound. `null` when empty, so a blank field is absent. */
export const cleanNotes = v => {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, MAX_RUN_NOTES)
  return s || null
}

/** One session, in its legal shape. Returns null for anything unusable (it is dropped, not fixed). */
export function cleanSession(s) {
  if (!s || typeof s !== 'object') return null
  if (typeof s.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.d)) return null
  if (typeof s.type !== 'string' || s.type === 'rest') return null   // a rest day is an absence
  const structure = cleanStructure(s.structure)
  return {
    id: typeof s.id === 'string' && s.id ? s.id : null,
    d: s.d,
    type: s.type,
    ...(structure.length ? { structure } : {}),
    km: isNum(Number(s.km)) ? Math.round(Number(s.km) * 10) / 10 : null,
    targetPaceSec: isNum(Number(s.targetPaceSec)) ? Math.round(Number(s.targetPaceSec)) : null,
    targetHR: isNum(Number(s.targetHR)) ? Math.round(Number(s.targetHR)) : null,
    done: !!s.done,
    ...(s.actual ? { actual: cleanActual(s.actual) } : {}),
    ...(cleanNotes(s.notes) ? { notes: cleanNotes(s.notes) } : {})
  }
}

/**
 * What actually happened, once a run is logged (or synced from Garmin). Every field optional —
 * a run entered by hand has a distance and a time and nothing else, and that has to be a legal
 * record rather than a half-filled one.
 */
export function cleanActual(a) {
  if (!a || typeof a !== 'object') return null
  const out = {}
  if (isNum(Number(a.km))) out.km = Math.round(Number(a.km) * 100) / 100
  if (isNum(Number(a.sec))) out.sec = Math.round(Number(a.sec))
  if (isNum(Number(a.avgHR))) out.avgHR = Math.round(Number(a.avgHR))
  if (isNum(Number(a.avgPaceSec))) out.avgPaceSec = Math.round(Number(a.avgPaceSec))
  if (typeof a.source === 'string') out.source = a.source         // 'manual' | 'garmin'
  if (Array.isArray(a.splits)) out.splits = a.splits.slice(0, 100)
  return Object.keys(out).length ? out : null
}

/**
 * The whole plan, cleaned and bounded. Weeks are renumbered in date order and sessions sorted
 * within their week, so a plan that arrived shuffled renders and validates the same as one that
 * was built in order.
 */
export function cleanRun(S, { maxWeeks = MAX_RUN_WEEKS, today = null } = {}) {
  const r = ensureRun(S)
  const weeks = []
  for (const w of (r.weeks || []).slice(0, maxWeeks)) {
    if (!w || typeof w !== 'object') continue
    const sessions = []
    for (const s of (w.sessions || []).slice(0, MAX_RUN_SESSIONS_PER_WEEK)) {
      const c = cleanSession(s)
      if (c) sessions.push(c)
    }
    sessions.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
    if (!sessions.length) continue
    weeks.push({
      wk: Number.isInteger(w.wk) ? w.wk : weeks.length + 1,
      phase: typeof w.phase === 'string' ? w.phase : 'base',
      km: isNum(Number(w.km)) ? Math.min(MAX_RUN_KM_WEEK, Math.round(Number(w.km) * 10) / 10) : round1(sessions.reduce((n, s) => n + (s.km || 0), 0)),
      sessions
    })
  }
  weeks.sort((a, b) => (a.sessions[0].d < b.sessions[0].d ? -1 : 1))
  weeks.forEach((w, i) => { w.wk = i + 1 })
  return {
    calibration: r.calibration ? cleanCalibration(r.calibration) : null,
    zones: r.zones || null,
    weeks,
    updatedAt: today ? new Date(today + 'T00:00:00Z').getTime() : (r.updatedAt || null)
  }
}

const round1 = n => Math.round(n * 10) / 10

function cleanCalibration(c) {
  if (!c || typeof c !== 'object') return null
  const out = { type: typeof c.type === 'string' ? c.type : 'threshold30', done: !!c.done }
  for (const k of ['d', 'thresholdPace', 'avgHR', 'km', 'sec']) {
    if (c[k] != null) out[k] = isNum(Number(c[k])) ? Number(c[k]) : c[k]
  }
  if (cleanNotes(c.notes)) out.notes = cleanNotes(c.notes)
  return out
}

/* ============================ validation ============================ */

/**
 * Whether a plan is coherent enough to be shown and applied. Returns an array of problems —
 * empty means valid. The view turns these into a banner; the apply path refuses on any of them.
 *
 * This is not the whole of the server's `validateRun` (that one also checks the interference
 * rules against the lifting week, which lives in `run-interference.js`), but it is every check
 * that does not need the strength plan.
 */
export function validateRun(run) {
  const problems = []
  if (!run || typeof run !== 'object') return ['no plan']
  const weeks = run.weeks || []
  if (weeks.length > MAX_RUN_WEEKS) problems.push('too many weeks')
  const seen = new Set()
  let prevEnd = null
  for (const w of weeks) {
    if ((w.sessions || []).length > MAX_RUN_SESSIONS_PER_WEEK) problems.push(`week ${w.wk}: too many sessions`)
    if ((w.km || 0) > MAX_RUN_KM_WEEK) problems.push(`week ${w.wk}: volume above the cap`)
    const sorted = w.sessions || []
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i]
      if (seen.has(s.id)) problems.push(`duplicate session id ${s.id}`)
      seen.add(s.id)
      if (!isNum(Number(s.km))) problems.push(`session ${s.id}: no distance`)
      // Two sessions on one day is a plan nobody can run. The builder never produces it; a hand
      // edit or a merge can, and that is exactly when it needs to be caught.
      if (i > 0 && sorted[i - 1].d === s.d) problems.push(`two sessions on ${s.d}`)
      if (s.structure && s.structure.length && s.km && structureKm(s.structure) > s.km + 0.6) {
        problems.push(`session ${s.id}: structure longer than the session`)
      }
    }
    const start = sorted[0]?.d
    if (prevEnd && start && daysBetween(prevEnd, start) < 1) problems.push(`week ${w.wk} overlaps the previous one`)
    prevEnd = sorted[sorted.length - 1]?.d || prevEnd
  }
  return problems
}

/** The kilometres a structure works out to, plus a warm-up and cool-down allowance. */
export function structureKm(structure, allowanceKm = 3) {
  if (!Array.isArray(structure) || !structure.length) return 0
  let km = 0
  for (const r of structure) {
    const one = r.dist ? r.dist / 1000 : (r.timeSec / 300)   // a timed rep is estimated at 5:00/km
    km += one * (r.rep || 1)
  }
  return round1(km + allowanceKm)
}

/* ============================ display ============================ */

/** The plan's date range, for the header of the running view. */
export function planRange(run) {
  const s = allSessions(run)
  if (!s.length) return null
  return { from: s[0].d, to: s[s.length - 1].d }
}

/** Total kilometres in the plan, and the average week — the two numbers the header shows. */
export function planTotals(run) {
  const weeks = run?.weeks || []
  const km = weeks.reduce((n, w) => n + (w.km || 0), 0)
  return { km: round1(km), weeks: weeks.length, avgKm: weeks.length ? round1(km / weeks.length) : 0 }
}

/** How much of the plan has actually been run. `0` for a plan with nothing logged. */
export function compliance(run, today = iso(Date.now())) {
  const sessions = allSessions(run)
  const due = sessions.filter(s => s.d <= today)
  const done = due.filter(s => s.done)
  return {
    due: due.length,
    done: done.length,
    ratio: due.length ? done.length / due.length : 0,
    missed: due.filter(s => !s.done).map(s => s.id)
  }
}
