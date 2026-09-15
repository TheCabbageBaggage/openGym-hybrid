import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { todayISO, fmtDate } from '../lib/format.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { tappable } from '../lib/use-sheet-keyboard.js'
import { hasRun, planRange, planTotals, compliance } from '../lib/run-model.js'
import { checkPlan } from '../lib/run-interference.js'
import { WORKOUT_TYPES } from '../lib/run-vocab.js'
import { displayPace, distLabel, bandLabel, structureLine, zonesFrom } from '../lib/run-zones.js'

// The running half of a hybrid plan — its weeks, sessions, what is done and what is not, and
// (the reason it exists) where the running week collides with the lifting week. Renders nothing
// for a strength-only profile; the route is gated on `hasRun` at every entry point.
//
// HYBRID: new file. Only run-* modules and shared components are imported; the strength view
// stack is untouched.

export default function Run() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)

  if (!hasRun(S)) return null
  const run = S.run
  const unit = run.zones?.unit || 'km'
  const paceZones = run.zones?.paceZones || zonesFrom(run.zones?.thresholdPace)
  const range = planRange(run)
  const totals = planTotals(run)
  const comp = compliance(run)
  const { conflicts } = checkPlan(run, S)

  const toggleDone = sessionId => update(s => {
    const week = (s.run?.weeks || []).find(w => (w.sessions || []).some(x => x.id === sessionId))
    const sess = week && (week.sessions || []).find(x => x.id === sessionId)
    if (sess) sess.done = !sess.done
  })

  return <>
    <div className="hdr">
      <div>
        <h1>{t('Running')}</h1>
        <div className="sub">
          {range ? `${fmtDate(range.from)} – ${fmtDate(range.to)}` : ''} · {distLabel(totals.km, unit)} {unit} · {distLabel(totals.avgKm, unit)} {unit}/{t('wk')}
        </div>
      </div>
    </div>

    {/* Calibration: until the 30-minute threshold test is done, every pace is a guess. */}
    {run.calibration && !run.calibration.done && (
      <div className="sync-banner">
        <Icon name="info" />
        <span>{t('Paces are provisional until your 30-minute threshold test is run.')}</span>
      </div>
    )}

    {/* Interference: where the running week hits the lifting week, surfaced directly. */}
    {conflicts.length > 0 && (
      <div className="sync-banner" style={{ background: 'color-mix(in srgb,var(--red) 14%,var(--surface))' }}>
        <Icon name="warning" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {conflicts.map((c, i) => <div key={i}>{c.message}</div>)}
        </div>
      </div>
    )}

    <div className="cols">
      <div className="tile">
        <div className="l">{t('Done')}</div>
        <div className="v">{comp.done} / {comp.due}</div>
      </div>
      <div className="tile">
        <div className="l">{t('This week')}</div>
        <div className="v">{distLabel(run.weeks[0]?.km || 0, unit)} {unit}</div>
      </div>
    </div>

    {run.weeks.map(w => (
      <div key={w.wk}>
        <h4 className="sec">
          {t('Week {0}', w.wk)}{w.phase && w.phase !== 'base' ? ` · ${w.phase}` : ''}
          <span style={{ float: 'right', fontWeight: 500 }}>{distLabel(w.km, unit)} {unit}</span>
        </h4>
        <div className="list" style={{ display: 'flex', flexDirection: 'column' }}>
          {(w.sessions || []).map(s => {
            const band = s.structure?.length && paceZones?.[s.structure[0].paceZone]
              ? bandLabel(paceZones[s.structure[0].paceZone], unit) : null
            const pace = s.targetPaceSec ? displayPace(s.targetPaceSec, unit) : null
            const late = s.d < todayISO() && !s.done
            return (
              <div
                key={s.id}
                className={'item run-session' + (s.done ? ' done' : '') + (late ? ' late' : '')}
                {...tappable(() => nav('/run/' + s.id))}
              >
                <div className="grow">
                  <div className="tt" style={{ textTransform: 'capitalize' }}>{s.type}</div>
                  <div className="ss">
                    {fmtDate(s.d, true)}
                    {s.km != null ? ` · ${distLabel(s.km, unit)} ${unit}` : ''}
                    {pace ? ` · ${pace} /${unit}` : ''}
                  </div>
                  {band && <div className="ss" style={{ color: 'var(--acc)' }}>{band}</div>}
                  {s.structure && s.structure.length > 0 && (
                    <div className="ss">{s.structure.map((r, i) => structureLine(r, unit, paceZones)).join(' · ')}</div>
                  )}
                  {s.notes && <div className="ss">{s.notes}</div>}
                </div>
                <button
                  className={'iconbtn run-done' + (s.done ? ' on' : '')}
                  onClick={e => { e.stopPropagation(); toggleDone(s.id) }}
                  aria-label={t('Mark done')}
                >
                  <Icon name={s.done ? 'checkCircle' : 'check'} />
                </button>
              </div>
            )
          })}
        </div>
      </div>
    ))}

    {!run.weeks.length && (
      <div className="empty">
        <Icon name="figureRun" />
        <p>{t('No running plan yet. Ask the Coach to build one.')}</p>
        <Button onClick={() => nav('/coach')}>{t('Go to Coach')}</Button>
      </div>
    )}
  </>
}
