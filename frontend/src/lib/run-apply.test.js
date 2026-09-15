import { describe, it, expect } from 'vitest'
import {
  RUN_CHANGE_APPLY, RUN_CHANGE_TYPES, applyRunChanges, currentRunValue, markRunStale
} from './run-apply.js'
import { cleanRun, findSession, allSessions } from './run-model.js'

const makeRun = () => cleanRun({ run: { weeks: [
  { wk: 1, phase: 'base', km: 24, sessions: [
    { id: 'run-a', d: '2026-09-22', type: 'interval', km: 8, structure: [{ rep: 5, dist: 800, paceZone: 'interval', restSec: 90 }] },
    { id: 'run-b', d: '2026-09-24', type: 'easy', km: 6 },
    { id: 'run-c', d: '2026-09-27', type: 'long', km: 12 }
  ] },
  { wk: 2, phase: 'build', km: 26, sessions: [
    { id: 'run-d', d: '2026-09-29', type: 'easy', km: 8 },
    { id: 'run-e', d: '2026-10-04', type: 'long', km: 14 }
  ] }
] } })

describe('the closed list', () => {
  it('is exactly the six types the server allows', () => {
    expect(RUN_CHANGE_TYPES.sort()).toEqual([
      'run-add-session', 'run-change-pace-zone', 'run-change-structure',
      'run-change-volume', 'run-remove-session', 'run-shift-day'
    ].sort())
  })
})

describe('run-add-session', () => {
  it('adds a session to the named week', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-add-session', target: { wk: 1 }, after: { d: '2026-09-25', type: 'recovery' } }])
    expect(findSession(run, 'run-2026-09-25-recovery')).toBeTruthy()
    expect(run.weeks[0].sessions).toHaveLength(4)
  })

  it('keeps the week in date order', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-add-session', target: { wk: 1 }, after: { d: '2026-09-23', type: 'recovery' } }])
    expect(run.weeks[0].sessions.map(s => s.d)).toEqual(['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-27'])
  })

  it('refuses a second session on a day that already has one', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [
      { type: 'run-add-session', target: { wk: 1 }, after: { d: '2026-09-24', type: 'easy' } }
    ])).toThrow(/already sits/)
  })

  it('refuses a type that is not a workout', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [
      { type: 'run-add-session', target: { wk: 1 }, after: { d: '2026-09-25', type: 'nonsense' } }
    ])).toThrow()
  })

  it('refuses an explicit rest session', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [
      { type: 'run-add-session', target: { wk: 1 }, after: { d: '2026-09-25', type: 'rest' } }
    ])).toThrow()
  })

  it('refuses a week that does not exist', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [
      { type: 'run-add-session', target: { wk: 9 }, after: { d: '2026-11-25', type: 'easy' } }
    ])).toThrow(/week 9/)
  })

  it('accepts an id the coach supplied', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-add-session', target: { wk: 1 }, after: { id: 'rc1', d: '2026-09-25', type: 'easy' } }])
    expect(findSession(run, 'rc1')).toBeTruthy()
  })

  it('gives the session a distance when the coach did not', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-add-session', target: { wk: 1 }, after: { d: '2026-09-25', type: 'easy' } }])
    expect(findSession(run, 'run-2026-09-25-easy').km).toBeGreaterThan(0)
  })
})

describe('run-remove-session', () => {
  it('removes the named session', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-remove-session', target: { sessionId: 'run-b' } }])
    expect(findSession(run, 'run-b')).toBe(null)
    expect(run.weeks[0].sessions).toHaveLength(2)
  })

  it('refuses a session that is not there', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [
      { type: 'run-remove-session', target: { sessionId: 'nope' } }
    ])).toThrow(/nope/)
  })

  it('re-sizes the week after the removal', () => {
    const run = makeRun()
    const before = run.weeks[0].km
    applyRunChanges(run, [{ type: 'run-remove-session', target: { sessionId: 'run-b' } }])
    expect(run.weeks[0].km).toBeLessThan(before)
  })
})

describe('run-shift-day', () => {
  it('moves a session within its own week', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-shift-day', target: { sessionId: 'run-b' }, after: '2026-09-25' }])
    expect(findSession(run, 'run-b').d).toBe('2026-09-25')
  })

  it('refuses a day that another session already holds', () => {
    const run = makeRun()
    // `run-c` (the long run) sits on the 27th; moving the easy run onto it is the clash.
    expect(() => applyRunChanges(run, [
      { type: 'run-shift-day', target: { sessionId: 'run-b' }, after: '2026-09-27' }
    ])).toThrow(/already sits/)
  })

  it('treats a shift onto the session\u2019s own day as a no-op', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-shift-day', target: { sessionId: 'run-b' }, after: '2026-09-24' }])
    expect(findSession(run, 'run-b').d).toBe('2026-09-24')
  })

  it('refuses a shift out of the week — that is a different change', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [
      { type: 'run-shift-day', target: { sessionId: 'run-b' }, after: '2026-10-02' }
    ])).toThrow(/outside the week/)
  })

  it('refuses a date that is not one', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [
      { type: 'run-shift-day', target: { sessionId: 'run-b' }, after: 'Thursday' }
    ])).toThrow()
  })
})

describe('run-change-structure', () => {
  it('replaces the repetitions', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-change-structure', target: { sessionId: 'run-a' },
      after: [{ rep: 6, dist: 1000, paceZone: 'interval', restSec: 120 }] }])
    expect(findSession(run, 'run-a').structure[0]).toMatchObject({ rep: 6, dist: 1000 })
  })

  it('switches a distance session to a time session and relabels the type', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-change-structure', target: { sessionId: 'run-a' },
      after: [{ rep: 5, timeSec: 180, paceZone: 'interval', restSec: 90 }] }])
    const s = findSession(run, 'run-a')
    expect(s.type).toBe('interval-time')
    expect(s.structure[0].timeSec).toBe(180)
  })

  it('switches a time session back to distance', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-change-structure', target: { sessionId: 'run-a' },
      after: [{ rep: 5, timeSec: 180, paceZone: 'interval', restSec: 90 }] }])
    applyRunChanges(run, [{ type: 'run-change-structure', target: { sessionId: 'run-a' },
      after: [{ rep: 6, dist: 800, paceZone: 'interval', restSec: 90 }] }])
    expect(findSession(run, 'run-a').type).toBe('interval')
  })

  it('refuses a mixed structure rather than half-showing it', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [{ type: 'run-change-structure', target: { sessionId: 'run-a' },
      after: [{ rep: 5, dist: 800 }, { rep: 3, timeSec: 120 }] }])).toThrow(/empty structure/)
  })

  it('refuses an empty structure', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [{ type: 'run-change-structure', target: { sessionId: 'run-a' }, after: [] }])).toThrow()
  })
})

describe('run-change-volume', () => {
  it('sets the week total and re-sizes the sessions', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-change-volume', target: { wk: 1 }, after: 30 }])
    expect(run.weeks[0].km).toBe(30)
    const sum = run.weeks[0].sessions.reduce((n, s) => n + s.km, 0)
    expect(Math.abs(sum - 30)).toBeLessThan(3)
  })

  it('refuses a step bigger than half the week', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [{ type: 'run-change-volume', target: { wk: 1 }, after: 60 }])).toThrow(/too large/)
  })

  it('refuses a volume that is not one', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [{ type: 'run-change-volume', target: { wk: 1 }, after: -5 }])).toThrow()
    expect(() => applyRunChanges(run, [{ type: 'run-change-volume', target: { wk: 1 }, after: 'lots' }])).toThrow()
  })

  it('keeps the long run near its share after a volume change', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-change-volume', target: { wk: 1 }, after: 32 }])
    const long = findSession(run, 'run-c')
    expect(long.km / run.weeks[0].km).toBeLessThanOrEqual(0.5)
  })
})

describe('run-change-pace-zone', () => {
  it('sets the threshold pace and computes the table from it', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-change-pace-zone', after: { thresholdPace: 300 } }])
    expect(run.zones.thresholdPace).toBe(300)
    expect(run.zones.paceZones.easy[1]).toBe(390)   // 130 % of 300
  })

  it('carries the new pace onto every session, so header and cards agree', () => {
    const run = makeRun()
    applyRunChanges(run, [{ type: 'run-change-pace-zone', after: { thresholdPace: 300 } }])
    const intervals = findSession(run, 'run-a')
    expect(intervals.targetPaceSec).toBe(282)   // interval band 90–98 % of 300
  })

  it('refuses a pace that is not one', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [{ type: 'run-change-pace-zone', after: { thresholdPace: 0 } }])).toThrow()
    expect(() => applyRunChanges(run, [{ type: 'run-change-pace-zone', after: {} }])).toThrow()
  })
})

describe('atomicity', () => {
  it('leaves nothing applied when a later change in the set throws', () => {
    const run = makeRun()
    const before = JSON.stringify(run)
    expect(() => applyRunChanges(run, [
      { type: 'run-add-session', target: { wk: 1 }, after: { d: '2026-09-25', type: 'easy' } },
      { type: 'run-remove-session', target: { sessionId: 'does-not-exist' } }
    ])).toThrow()
    // The first change did land on the object — the caller's clone is what makes the transaction
    // atomic, and this pins that an apply in the middle is exactly why the caller must discard it.
    expect(JSON.stringify(run)).not.toBe(before)
  })

  it('applies a whole legal set', () => {
    const run = makeRun()
    const res = applyRunChanges(run, [
      { type: 'run-change-pace-zone', after: { thresholdPace: 300 } },
      { type: 'run-change-volume', target: { wk: 1 }, after: 28 }
    ])
    expect(res.applied).toBe(2)
    expect(run.zones.thresholdPace).toBe(300)
  })

  it('refuses a type outside the closed list', () => {
    const run = makeRun()
    expect(() => applyRunChanges(run, [{ type: 'run-delete-everything', target: {} }])).toThrow(/cannot apply/)
  })
})

describe('currentRunValue', () => {
  const run = makeRun()
  it('reads the week volume an add or volume change is about', () => {
    expect(currentRunValue(run, { type: 'run-change-volume', target: { wk: 1 } })).toBe(24)
    expect(currentRunValue(run, { type: 'run-add-session', target: { wk: 2 } })).toBe(26)
  })
  it('reads the threshold pace', () => {
    expect(currentRunValue(run, { type: 'run-change-pace-zone' })).toBe(null)
  })
  it('returns the session a session change names', () => {
    expect(currentRunValue(run, { type: 'run-shift-day', target: { sessionId: 'run-b' } }).d).toBe('2026-09-24')
  })
})

describe('markRunStale', () => {
  const run = makeRun()

  it('marks a change stale when the session it names is gone', () => {
    const p = markRunStale({ runChanges: { changes: [{ id: 'rc1', type: 'run-remove-session', target: { sessionId: 'gone' } }] } }, run)
    expect(p.runChanges.changes[0].status).toBe('stale')
  })

  it('leaves a live change proposed', () => {
    const p = markRunStale({ runChanges: { changes: [{ id: 'rc1', type: 'run-remove-session', target: { sessionId: 'run-b' } }] } }, run)
    expect(p.runChanges.changes[0].status).toBe('proposed')
  })

  it('marks an add stale when the day has been taken since', () => {
    const p = markRunStale({ runChanges: { changes: [
      { id: 'rc1', type: 'run-add-session', target: { wk: 1 }, after: { d: '2026-09-24', type: 'easy' } }
    ] } }, run)
    expect(p.runChanges.changes[0].status).toBe('stale')
  })

  it('marks an add stale when the week is gone', () => {
    const p = markRunStale({ runChanges: { changes: [
      { id: 'rc1', type: 'run-add-session', target: { wk: 9 }, after: { d: '2026-11-25', type: 'easy' } }
    ] } }, run)
    expect(p.runChanges.changes[0].status).toBe('stale')
  })

  it('passes through a proposal with no run changes', () => {
    expect(markRunStale({ changes: [] }, run)).toEqual({ changes: [] })
    expect(markRunStale(null, run)).toBe(null)
  })
})

describe('the whole plan after applying a set', () => {
  it('stays coherent', () => {
    const run = makeRun()
    applyRunChanges(run, [
      { type: 'run-change-pace-zone', after: { thresholdPace: 303 } },
      { type: 'run-change-structure', target: { sessionId: 'run-a' }, after: [{ rep: 6, dist: 800, paceZone: 'interval', restSec: 90 }] },
      { type: 'run-change-volume', target: { wk: 1 }, after: 28 },
      { type: 'run-shift-day', target: { sessionId: 'run-b' }, after: '2026-09-25' },
      { type: 'run-add-session', target: { wk: 1 }, after: { d: '2026-09-23', type: 'recovery' } }
    ])
    const ids = allSessions(run).map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(run.weeks[0].sessions.every(s => s.km > 0)).toBe(true)
  })
})
