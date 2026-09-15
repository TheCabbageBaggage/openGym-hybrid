// HYBRID: pace zones, derived from one number.
//
// A runner's whole prescription follows from threshold pace (T, seconds per km). Everything
// else in this file is a percentage of it. That is deliberate: it means a plan can be
// regenerated from a single calibration run, and it means there is exactly one number that can
// be wrong.
//
// Pure functions, no I/O, no clock. Every exported function is pinned by run-zones.test.js.

import { ZONE_PCT, ZONES, KM_PER_MI } from './vocab.js';

const isNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Threshold pace from a 30-minute test.
 *
 * Takes the average of the last `steadyMinutes` split or, when no splits were recorded (a
 * watch that only gave a total), the average of the whole effort scaled to the steady window.
 * The scale factor is the honest compromise: a well-run 30-minute test is paced almost evenly,
 * so the total is a good proxy, but it is a proxy and the caller is told so via `estimated`.
 *
 * @param {{ minutes:number, distKm:number, splits?:Array<{sec:number,distKm:number}>, steadyMinutes?:number }} r
 * @returns {{ thresholdPace:number, avgPace:number, estimated:boolean } | null}
 */
export function thresholdFromTest(r, steadyMinutes = 20) {
  if (!r || !isNum(r.minutes) || !isNum(r.distKm)) return null;
  const avgPace = (r.minutes * 60) / r.distKm;
  const splits = Array.isArray(r.splits) ? r.splits.filter(s => isNum(s?.sec) && isNum(s?.distKm)) : [];
  if (!splits.length) {
    // No splits: the whole effort is the only evidence there is, so its average is the estimate.
    // Scale it by how much of the run the steady window covers — a 30-minute test with a
    // 20-minute window is 2/3 steady, so the estimate is 2/3 of the way from the average towards
    // the (unknowable) steady pace. In practice the two are close, because a well-run test is
    // paced almost evenly; the flag says it is a proxy and the caller may ask for a re-test.
    const steadyFrac = Math.min(1, Math.max(0.5, steadyMinutes / r.minutes));
    // A steady window is normally *faster* than the whole effort, so the estimate is bounded
    // above by the average and below by the average scaled down a tenth: enough to acknowledge
    // the settling-in period without inventing a pace nobody ran.
    const estimate = Math.round(avgPace * (1 - (1 - steadyFrac) * 0.25));
    return { thresholdPace: estimate, avgPace: Math.round(avgPace), estimated: true };
  }
  const totalSec = splits.reduce((a, s) => a + s.sec, 0);
  const totalKm = splits.reduce((a, s) => a + s.distKm, 0);
  const target = steadyMinutes * 60;
  let accSec = 0, accKm = 0;
  for (let i = splits.length - 1; i >= 0 && accSec < target; i--) {
    accSec += splits[i].sec; accKm += splits[i].distKm;
  }
  if (!isNum(accKm)) return { thresholdPace: Math.round(avgPace), avgPace: Math.round(avgPace), estimated: true };
  return { thresholdPace: Math.round(accSec / accKm), avgPace: Math.round((totalSec || 1) / (totalKm || 1)), estimated: false };
}

/**
 * The zone table. Every bound is seconds per km in the storage unit (km), slowest first.
 *
 * `to` is the slow end, `from` the fast end — named for reading order, not for arithmetic.
 * A caller that only wants "am I in the band" should use `zoneOf`, which is the one function
 * that gets the direction right.
 */
/**
 * The zone table. Every bound is seconds per km in the storage unit (km), written **fastest
 * number first** — `[from, to]`, matching the spec: `easy: [345, 390]` means "between 5:45 and
 * 6:30 per kilometre".
 *
 * A slower pace is a larger number of seconds, which is the single most easily-misread thing in
 * this feature, so the direction is fixed here once and every reader goes through `zoneOf`
 * rather than doing arithmetic on the bounds.
 */
export function zonesFrom(thresholdPace) {
  if (!isNum(thresholdPace)) return null;
  const out = {};
  for (const z of ZONES) {
    const [fastPct, slowPct] = ZONE_PCT[z];   // [fast, slow], as the table is written
    out[z] = [
      Math.round(thresholdPace * fastPct / 100),  // from = faster = smaller number
      Math.round(thresholdPace * slowPct / 100)   // to   = slower = larger number
    ];
  }
  return out;
}

/**
 * Which zone a pace falls in, fastest-match wins.
 *
 * The bands overlap on purpose (recovery 125-140 and easy 115-130 share 125-130). Resolving
 * by taking the first zone whose range contains the pace, in the fixed ZONES order, makes the
 * answer deterministic — an overlapping table with an unspecified tie-break is a table that
 * classifies the same run differently on two devices.
 */
export function zoneOf(paceSec, paceZones) {
  if (!isNum(paceSec) || !paceZones) return null;
  for (const z of ZONES) {
    const band = paceZones[z];
    // `from` is the faster bound and therefore the smaller number.
    if (band && paceSec >= band[0] && paceSec <= band[1]) return z;
  }
  return paceSec < (paceZones.interval?.[0] ?? Infinity) ? 'repetition' : 'recovery';
}

/** The pace a session type should be run at, from its zone. Falls back to easy. */
export function targetPace(type, zone, paceZones) {
  const band = paceZones?.[zone] || paceZones?.easy;
  if (!band) return null;
  return Math.round((band[0] + band[1]) / 2);
}

/** Seconds per km <-> display pace, honouring the profile's unit. */
export const unitScale = unit => (unit === 'mi' ? KM_PER_MI : 1);
export const toDisplayPace = (secPerKm, unit) => (unit === 'mi' ? secPerKm * KM_PER_MI : secPerKm);
export const toDisplayDist = (km, unit) => (unit === 'mi' ? km / KM_PER_MI : km);
export const displayPace = (secPerKm, unit) => {
  const s = Math.round(toDisplayPace(secPerKm, unit));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};
