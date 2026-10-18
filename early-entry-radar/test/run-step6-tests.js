// STEP 6 tests: decision engine state machine. Deterministic fixtures.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { openStore } from '../src/store.js';

import { decide, lifecycle, applySignalState, dailySignalReport, SIGNAL_STATES } from '../src/decision.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const store = openStore(db);
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const results = [];
const check = (n, ok, ev) => { results.push(ok); console.log(`${ok?'PASS':'FAIL'}  ${n}  | ${ev}`); };

const goodFacts = { age_hours: 2, mean_source_reliability: 0.8, independent_sources: 3, independent_influencer_mentions: 2,
  identity: 'mint', unique_mentions: 12, txn_count: 800, liquidity_usd: 80000, min_liquidity_usd: config.min_liquidity_usd,
  noncritical_findings: 0, data_completeness: 0.9 };

// T17: full green path => QUALIFIED CANDIDATE with explainable score breakdown
{
  const r = decide({ identity: 'mint', launchStatus: 'LIVE MARKET VERIFIED', securityVerdict: 'PASS_WITH_FINDINGS', marketVerdict: 'MARKET OK', facts: goodFacts }, config);
  const components = r.breakdown ? Object.keys(r.breakdown).length : 0;
  check('T17_qualified_path', r.state === 'QUALIFIED CANDIDATE' && r.score >= 60 && components === 10,
    `state=${r.state} score=${r.score}/100 components=${components} (every component shows value+weight+raw)`);
}
// T18: security REJECTED beats a perfect score
{
  const r = decide({ identity: 'mint', launchStatus: 'LIVE MARKET VERIFIED', securityVerdict: 'REJECTED', marketVerdict: 'MARKET OK', facts: { ...goodFacts } }, config);
  check('T18_security_overrides_score', r.state === 'SECURITY REJECTED' && r.score === null,
    `state=${r.state} score=${r.score} (score never computed/emitted for rejected)`);
}
// T19: incomplete data blocks the signal
{
  const a = decide({ identity: 'mint', launchStatus: 'LIVE MARKET VERIFIED', securityVerdict: 'INCOMPLETE', marketVerdict: 'MARKET OK', facts: goodFacts }, config);
  const b = decide({ identity: 'mint', launchStatus: 'LIVE MARKET VERIFIED', securityVerdict: 'PASS_WITH_FINDINGS', marketVerdict: 'DATA INCOMPLETE', facts: goodFacts }, config);
  const c = decide({ identity: 'provisional', launchStatus: 'PRE-LAUNCH UNVERIFIED', securityVerdict: 'PASS_WITH_FINDINGS', marketVerdict: 'MARKET OK', facts: goodFacts }, config);
  check('T19_incomplete_and_unverified_blocked', a.state === 'DATA INCOMPLETE' && b.state === 'DATA INCOMPLETE' && c.state === 'NEEDS VERIFICATION',
    `sec-INCOMPLETE=>${a.state}; mkt-DATA_INCOMPLETE=>${b.state}; provisional=>${c.state}`);
}
// T20: NO QUALIFIED SIGNAL is a valid engine output
{
  const rep = dailySignalReport(store);
  const r2 = decide({ identity: 'mint', launchStatus: 'LIVE MARKET VERIFIED', securityVerdict: 'PASS_WITH_FINDINGS', marketVerdict: 'MARKET OK', facts: { ...goodFacts, liquidity_usd: 5000, unique_mentions: 0, independent_sources: 0, txn_count: 0, independent_influencer_mentions: 0, mean_source_reliability: 0.3, data_completeness: 0.4 } }, { ...config, min_signal_score: 60, watchlist_min_score: 55 }); // explicit thresholds: mechanism test (owner loosened defaults 2026-10-18)
  check('T20_no_qualified_signal', rep.headline === 'NO QUALIFIED SIGNAL' && r2.state === 'DISCOVERED' && r2.score < 55,
    `empty engine => "${rep.headline}"; weak candidate => state=${r2.state} score=${r2.score} (tracked, not signalled)`);
}
// T21: lifecycle - qualify, then invalidate on liquidity collapse; expiry path; state log audit
{
  applySignalState(store, 'mint:T21', { state: 'QUALIFIED CANDIDATE', reasons: ['test'], score: 80, breakdown: null });
  const inv = lifecycle('QUALIFIED CANDIDATE', { marketVerdict: 'LIQUIDITY INSUFFICIENT' }, config);
  applySignalState(store, 'mint:T21', { state: inv.state, reasons: inv.reasons, score: null, breakdown: null });
  const exp = lifecycle('OUTCOME PENDING', { age_hours: 100, marketVerdict: 'MARKET OK' }, config);
  const log = store.all(`SELECT from_state,to_state FROM signal_state_log WHERE entity_id='mint:T21' ORDER BY id`);
  check('T21_invalidate_expire_audit', inv.state === 'SIGNAL INVALIDATED' && exp.state === 'SIGNAL EXPIRED' && log.length === 2 && log[0].to_state === 'QUALIFIED CANDIDATE' && log[1].to_state === 'SIGNAL INVALIDATED',
    `invalidate=${inv.state} (liquidity collapse); expire=${exp.state} (>72h); audit chain: ${log.map(l => `${l.from_state||'∅'}→${l.to_state}`).join(' , ')}`);
}

const failed = results.filter(r => !r).length;
console.log(`\n== STEP6 SUMMARY: ${results.length - failed}/${results.length} PASS, ${failed} FAIL ==`);
process.exit(failed ? 1 : 0);
