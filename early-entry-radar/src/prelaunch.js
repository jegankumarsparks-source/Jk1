// Pre-launch engine: launch status state machine.
// Statuses: PRE-LAUNCH CONFIRMED BY EVIDENCE | PRE-LAUNCH UNVERIFIED | LAUNCH WINDOW APPROACHING |
//           LAUNCH DETECTED | LIVE MARKET VERIFIED | CANCELLED OR DELAYED | STATUS UNKNOWN
// Hard rules: "soon/tomorrow" is never a launch date; original statements are stored verbatim;
// CANCELLED OR DELAYED only on an explicit statement, never inferred; every transition stores reasons.
import { nowUTC } from './util.js';

export const LAUNCH_STATUSES = [
  'PRE-LAUNCH CONFIRMED BY EVIDENCE', 'PRE-LAUNCH UNVERIFIED', 'LAUNCH WINDOW APPROACHING',
  'LAUNCH DETECTED', 'LIVE MARKET VERIFIED', 'CANCELLED OR DELAYED', 'STATUS UNKNOWN',
];

// Vague time words - explicitly NOT evidence of a launch time.
const VAGUE = /\b(soon|tomorrow|coming|shortly|stay tuned|almost|loading|imminent|this week|next week)\b/i;
// Explicit cancel/delay statements.
const CANCEL = /\b(cancelled|canceled|delayed|postponed|rescheduled|called off|not launching)\b/i;
// A concrete claimed launch time: a date/datetime phrase, optionally with timezone.
const CLAIMED_TIME = /\b(launch(?:es|ing)?|presale|mint|listing|tge|ido|live)\b[^\n.]{0,60}?\b(on|at)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(st|nd|rd|th)?[,:\s]/i;
const CLAIMED_TIME_2 = /\b\d{1,2}[:.]\d{2}\s?(am|pm)?\s?(utc|gmt|ist|est|pst|cET|cet)\b/i;

// Classify one announcement text. Returns {kind, claimed_time_text, vague, cancel, original}.
export function classifyAnnouncement(text) {
  const t = (text || '').trim();
  return {
    original: t.slice(0, 1000),
    cancel: CANCEL.test(t),
    vague: VAGUE.test(t),
    claimed_time_text: (t.match(CLAIMED_TIME)?.[0] || t.match(CLAIMED_TIME_2)?.[0] || null),
  };
}

// Compute launch status for an entity from its evidence rows + mentions.
// evidence: [{source, observed_at, payload}], mentions: [{text, published_at, category}]
// Returns {status, reasons[], claimed_launch_text, launch_detected_at, market_verified_at}
export function computeLaunchStatus({ evidence = [], mentions = [], now = null }) {
  const nowIso = now || nowUTC();
  const reasons = [];
  let claimed = null, cancelled = false, detectedAt = null, marketAt = null;

  for (const m of mentions) {
    const c = classifyAnnouncement(m.text);
    if (c.cancel) { cancelled = true; reasons.push(`explicit cancel/delay statement: "${c.original.slice(0, 80)}"`); }
    if (c.claimed_time_text && !claimed) { claimed = c.claimed_time_text; reasons.push(`claimed launch time stored verbatim: "${c.claimed_time_text}"`); }
    if (c.vague && !c.claimed_time_text) reasons.push(`vague timing only ("${c.original.slice(0, 60)}") - not a launch date`);
  }
  for (const e of evidence) {
    if (e.source === 'pumpfun' && e.observed_at && !detectedAt) { detectedAt = e.observed_at; reasons.push(`mint creation observed via pumpfun at ${e.observed_at}`); }
    if (e.source === 'geckoterminal' && e.observed_at && !marketAt) { marketAt = e.observed_at; reasons.push(`trading pool observed via geckoterminal at ${e.observed_at}`); }
  }

  if (cancelled) return { status: 'CANCELLED OR DELAYED', reasons, claimed_launch_text: claimed, launch_detected_at: detectedAt, market_verified_at: marketAt };
  if (marketAt) return { status: 'LIVE MARKET VERIFIED', reasons, claimed_launch_text: claimed, launch_detected_at: detectedAt, market_verified_at: marketAt };
  if (detectedAt) return { status: 'LAUNCH DETECTED', reasons, claimed_launch_text: claimed, launch_detected_at: detectedAt, market_verified_at: null };
  if (claimed) {
    // We never parse the claim into a date ourselves at this step; if the claim mentions a future
    // window we cannot verify, the status stays evidence-based, not speculative.
    return { status: 'PRE-LAUNCH CONFIRMED BY EVIDENCE', reasons, claimed_launch_text: claimed, launch_detected_at: null, market_verified_at: null };
  }
  if (mentions.length > 0) return { status: 'PRE-LAUNCH UNVERIFIED', reasons, claimed_launch_text: null, launch_detected_at: null, market_verified_at: null };
  return { status: 'STATUS UNKNOWN', reasons: reasons.length ? reasons : ['no evidence rows'], claimed_launch_text: null, launch_detected_at: null, market_verified_at: null };
}

// Persist a transition into entities.launch_status (append-only log via launch_status_log).
export function applyLaunchStatus(store, entityId, result) {
  const now = nowUTC();
  const prev = store.get(`SELECT launch_status FROM entities WHERE entity_id=?`, entityId);
  store.run(`UPDATE entities SET launch_status=? WHERE entity_id=?`, result.status, entityId);
  store.run(`INSERT INTO launch_status_log(entity_id,from_status,to_status,reasons,at) VALUES(?,?,?,?,?)`,
    entityId, prev ? prev.launch_status : null, result.status, JSON.stringify(result.reasons), now);
  return { from: prev ? prev.launch_status : null, to: result.status };
}
