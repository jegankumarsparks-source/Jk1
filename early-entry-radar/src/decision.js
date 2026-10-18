// Decision engine / signal state machine.
// States: DISCOVERED, PRE-LAUNCH WATCH, NEEDS VERIFICATION, LAUNCH DETECTED, SECURITY REJECTED,
//         DATA INCOMPLETE, LIQUIDITY INSUFFICIENT, QUALIFIED CANDIDATE, SIGNAL EXPIRED,
//         SIGNAL INVALIDATED, OUTCOME PENDING, OUTCOME RECORDED
// Rules: security gates override everything; score ranks, never rescues; every transition
// logs reasons + score breakdown; NO QUALIFIED SIGNAL is a valid engine output.
import { nowUTC } from './util.js';
import { scoreCandidate } from './scoring.js';

export const SIGNAL_STATES = ['DISCOVERED', 'PRE-LAUNCH WATCH', 'NEEDS VERIFICATION', 'LAUNCH DETECTED',
  'SECURITY REJECTED', 'DATA INCOMPLETE', 'LIQUIDITY INSUFFICIENT', 'QUALIFIED CANDIDATE', 'WATCHLIST',
  'SIGNAL EXPIRED', 'SIGNAL INVALIDATED', 'OUTCOME PENDING', 'OUTCOME RECORDED'];

// inputs: identity kind, launch status, security verdict, market verdict, score facts, config, timestamps
export function decide(input, config = {}) {
  const reasons = [];
  const minScore = config.min_signal_score ?? 60; // configurable, not proven
  const expiryH = config.candidate_expiry_hours ?? 72;

  // Terminal security first - score can never override
  if (input.securityVerdict === 'REJECTED') {
    reasons.push('critical security check failed');
    return { state: 'SECURITY REJECTED', reasons, score: null, breakdown: null };
  }
  if (input.launchStatus === 'CANCELLED OR DELAYED') {
    return { state: 'SIGNAL INVALIDATED', reasons: ['launch cancelled or delayed (explicit statement)'], score: null, breakdown: null };
  }
  if (input.identity !== 'mint') {
    reasons.push(`identity is ${input.identity || 'unknown'} - mint not verified`);
    return { state: 'NEEDS VERIFICATION', reasons, score: null, breakdown: null };
  }
  if (input.securityVerdict === 'INCOMPLETE' || input.marketVerdict === 'DATA INCOMPLETE') {
    reasons.push(`mandatory data missing (security=${input.securityVerdict}, market=${input.marketVerdict})`);
    return { state: 'DATA INCOMPLETE', reasons, score: null, breakdown: null };
  }
  if (input.marketVerdict === 'LIQUIDITY INSUFFICIENT') {
    // owner directive 2026-10-18: surface, don't hide. Enough signal => WATCHLIST with the
    // failing gates kept visible in reasons; otherwise the honest LIQUIDITY INSUFFICIENT label stays.
    if (input.launchStatus === 'LIVE MARKET VERIFIED' && input.securityVerdict === 'PASS_WITH_FINDINGS') {
      const { score, breakdown } = scoreCandidate(input.facts || {}, (config.score && config.score.weights) || undefined);
      const wlMin = config.watchlist_min_score ?? 20;
      if (score >= wlMin) return { state: 'WATCHLIST', reasons: ['liquidity gate(s) failing - surfaced per owner config, NOT trade-ready', `score ${score}/100 (watchlist min ${wlMin})`], score, breakdown };
    }
    return { state: 'LIQUIDITY INSUFFICIENT', reasons: ['one or more market gates failed'], score: null, breakdown: null };
  }
  // Pre-launch states
  if (input.launchStatus === 'PRE-LAUNCH CONFIRMED BY EVIDENCE' || input.launchStatus === 'PRE-LAUNCH UNVERIFIED'
      || input.launchStatus === 'LAUNCH WINDOW APPROACHING') {
    reasons.push(`launch status: ${input.launchStatus}`);
    return { state: 'PRE-LAUNCH WATCH', reasons, score: null, breakdown: null };
  }
  if (input.launchStatus === 'LAUNCH DETECTED') {
    reasons.push('mint detected, market not yet verified');
    return { state: 'LAUNCH DETECTED', reasons, score: null, breakdown: null };
  }
  // Live market verified + security pass -> score
  if (input.launchStatus === 'LIVE MARKET VERIFIED' && input.securityVerdict === 'PASS_WITH_FINDINGS' && input.marketVerdict === 'MARKET OK') {
    const { score, breakdown } = scoreCandidate(input.facts || {}, (config.score && config.score.weights) || undefined);
    reasons.push(`score ${score}/100 (min ${minScore}, configurable)`);
    if ((input.facts && input.facts.disclosed_paid_mentions) > 0) reasons.push(`note: ${input.facts.disclosed_paid_mentions} disclosed-paid mention(s) present - counted as risk context, not endorsement`);
    if (score >= minScore) return { state: 'QUALIFIED CANDIDATE', reasons, score, breakdown };
    const wlMin = config.watchlist_min_score ?? 20;
    if (score >= wlMin) return { state: 'WATCHLIST', reasons: [...reasons, 'below qualify score - watchlist tier (owner config 2026-10-18)'], score, breakdown };
    return { state: 'DISCOVERED', reasons: [...reasons, 'below watchlist score - tracked, not signalled'], score, breakdown };
  }
  if (input.launchStatus === 'STATUS UNKNOWN') {
    return { state: 'DISCOVERED', reasons: ['launch status unknown - tracked only'], score: null, breakdown: null };
  }
  return { state: 'DISCOVERED', reasons: [`unhandled combination (launch=${input.launchStatus}, sec=${input.securityVerdict}, mkt=${input.marketVerdict})`], score: null, breakdown: null };
}

// Lifecycle transitions for already-qualified candidates.
export function lifecycle(currentState, input, config = {}) {
  const expiryH = config.candidate_expiry_hours ?? 72;
  if (currentState === 'QUALIFIED CANDIDATE' || currentState === 'OUTCOME PENDING') {
    if (input.securityVerdict === 'REJECTED') return { state: 'SIGNAL INVALIDATED', reasons: ['post-qualification security failure'] };
    if (input.marketVerdict === 'LIQUIDITY INSUFFICIENT') return { state: 'SIGNAL INVALIDATED', reasons: ['liquidity collapsed after qualification'] };
    if ((input.age_hours ?? 0) > expiryH) return { state: 'SIGNAL EXPIRED', reasons: [`older than ${expiryH}h (configurable)`] };
    if (currentState === 'QUALIFIED CANDIDATE') return { state: 'OUTCOME PENDING', reasons: ['outcome tracking started'] };
  }
  return null; // no transition
}

export function applySignalState(store, entityId, result) {
  const now = nowUTC();
  const from = store.latestSignalState(entityId);
  if (from === result.state) return { from, to: result.state, changed: false };
  store.logSignalState({ entity_id: entityId, from_state: from, to_state: result.state,
    reasons: JSON.stringify(result.reasons), score: result.score,
    score_breakdown: result.breakdown ? JSON.stringify(result.breakdown) : null, at: now });
  return { from, to: result.state, changed: true };
}

// The engine's honest output when nothing qualifies.
export function dailySignalReport(store) {
  const q = store.latestSignalStates();
  const qualified = q.filter(r => r.to_state === 'QUALIFIED CANDIDATE' || r.to_state === 'OUTCOME PENDING');
  if (!qualified.length) return { headline: 'NO QUALIFIED SIGNAL', candidates: [], note: 'No candidate passed all gates. This is a valid result, not an outage.' };
  return { headline: `${qualified.length} QUALIFIED CANDIDATE(S)`, candidates: qualified };
}
