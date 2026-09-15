import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { findSession } from '../lib/run-model.js'
import { WORKOUT_TYPES } from '../lib/run-vocab.js'
import { displayPace, distLabel, zonesFrom } from '../lib/run-zones.js'

// One running session, opened from the running plan. The interval guide reads each repetition
// out, with a rest countdown between them — the same RestTimer the strength screens use, because
// a running interval's rest is the same countdown. HYBRID: new file.

export default function RunWorkout() {
  const { id } = useParams()
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const startRest = useUI(s => s.startRest)

  const session = S.run ? findSession(S.run, id) : null
  if (!session) {
    return <div className="empty"><Icon name="figureRun" /><p>{t('That session is not in your plan.')}</p><Button onClick={() => nav('/run')}>{t('Back')}</Button></div>
  }
  const unit = S.run?.zones?.unit || 'km'
  const paceZones = S.run?.zones?.paceZones || zonesFrom(S.run?.zones?.thresholdPace)
  const zone = WORKOUT_TYPES[session.type]?.zone
  const pace = session.targetPaceSec ? displayPace(session.targetPaceSec, unit) : null
  const reps = session.structure || []

  return <>
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/run')} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
      <div>
        <h1 style={{ textTransform: 'capitalize' }}>{session.type}</h1>
        <div className="sub">{fmtDate(session.d, true)} · {distLabel(session.km, unit)} {unit}{pace ? ` · ${pace} /${unit}` : ''}</div>
      </div>
    </div>

    <div className="cols">
      <div className="tile">
        <div className="l">{t('Zone')}</div>
        <div className="v">{zone || '—'}</div>
      </div>
      <div className="tile">
        <div className="l">{t('Target pace')}</div>
        <div className="v">{pace ? pace + ' /' + unit : '—'}</div>
      </div>
    </div>

    {session.notes && <div className="sync-banner"><Icon name="info" /><span>{session.notes}</span></div>}

    {reps.length ? (
      <div>
        <h4 className="sec">{t('Intervals')}</h4>
        <div className="list" style={{ display: 'flex', flexDirection: 'column' }}>
          {reps.map((r, i) => {
            const work = r.dist ? `${r.rep} × ${Math.round(r.dist)} m` : `${r.rep} × ${r.timeSec} s`
            const at = r.paceZone && paceZones?.[r.paceZone]
              ? displayPace(Math.round((paceZones[r.paceZone][0] + paceZones[r.paceZone][1]) / 2), unit) + ' /' + unit
              : null
            return (
              <div key={i} className="item">
                <div className="grow">
                  <div className="tt">{i + 1}. {work}</div>
                  {at && <div className="ss">{at}</div>}
                </div>
                {r.restSec > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => startRest(r.restSec, i)}>
                    {t('Rest {0}s', r.restSec)}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    ) : (
      <div className="sync-banner">
        <Icon name="figureRun" />
        <span>{t('A continuous run: {0} at an easy, conversational effort.', distLabel(session.km, unit))}</span>
      </div>
    )}

    <div className="cols" style={{ marginTop: 16 }}>
      <Button onClick={() => nav('/run')}>{t('Back to plan')}</Button>
    </div>
  </>
}
