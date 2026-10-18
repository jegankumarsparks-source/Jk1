// STEP 9 tests: paper outcome tracking + evaluation honesty. Run: node test/run-step9-tests.js
import { priceFromPairs, updateOutcome, summarizeEvaluation, trackedEntityIds, TRACK_WINDOW_HOURS } from '../src/evaluation.js';
import { mergeStates } from '../worker/worker.mjs';

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`); };

const mkState = () => ({ seq: 0, sources: {}, raw_events: [], entities: {}, entity_evidence: [], mentions: [],
  security_results: [], gate_results: [], launch_status_log: [], signal_state_log: [], source_health: [], outcomes: {} });

// T30: priceFromPairs picks highest-liquidity solana pair
{
  const pi = priceFromPairs([
    { chainId: 'solana', priceUsd: '0.001', liquidity: { usd: 100 }, pairAddress: 'a' },
    { chainId: 'ethereum', priceUsd: '9', liquidity: { usd: 1e6 } },
    { chainId: 'solana', priceUsd: '0.002', liquidity: { usd: 9000 }, pairAddress: 'b' }]);
  t('T30 price pick = highest-liq solana pair', pi && pi.price_usd === 0.002 && pi.pair === 'b');
  t('T30b null on no pairs', priceFromPairs([]) === null && priceFromPairs(null) === null);
}

// T31: entry ref + max upside/adverse math
{
  const s = mkState();
  s.entities['e1'] = { entity_id: 'e1', kind: 'mint', mint: 'A'.repeat(44), name: 'Tok', ticker: 'TOK' };
  s.signal_state_log.push({ entity_id: 'e1', to_state: 'QUALIFIED CANDIDATE', at: '2026-10-17T10:00:00Z' });
  updateOutcome(s, 'e1', { price_usd: 1.0, liquidity_usd: 10000 }, '2026-10-17T10:00:00Z');
  updateOutcome(s, 'e1', { price_usd: 1.5, liquidity_usd: 12000 }, '2026-10-17T10:30:00Z');
  updateOutcome(s, 'e1', { price_usd: 0.9, liquidity_usd: 8000 }, '2026-10-17T11:00:00Z');
  const oc = s.outcomes['e1'];
  t('T31 entry ref = first price', oc.entry_price === 1.0 && oc.entry_state === 'QUALIFIED CANDIDATE');
  t('T31 max upside +50%', Math.abs(oc.max_upside_pct - 50) < 1e-9, `got ${oc.max_upside_pct}`);
  t('T31 max adverse -10%', Math.abs(oc.max_adverse_pct - (-10)) < 1e-9, `got ${oc.max_adverse_pct}`);
  t('T31 current ret -10%', Math.abs(oc.current_ret_pct - (-10)) < 1e-9);
}

// T32: rug detection (price collapse and liquidity collapse)
{
  const s = mkState();
  s.entities['r1'] = { entity_id: 'r1', kind: 'mint', mint: 'B'.repeat(44) };
  s.signal_state_log.push({ entity_id: 'r1', to_state: 'WATCHING', at: 'x' });
  updateOutcome(s, 'r1', { price_usd: 1.0, liquidity_usd: 20000 });
  const oc = updateOutcome(s, 'r1', { price_usd: 0.1, liquidity_usd: 15000 });
  t('T32a price rug >=80% drop', oc.rug_event === true && oc.status === 'RUG_EVENT' && oc.rug_kind === 'price_collapse');
  const s2 = mkState();
  s2.entities['r2'] = { entity_id: 'r2', kind: 'mint', mint: 'C'.repeat(44) };
  s2.signal_state_log.push({ entity_id: 'r2', to_state: 'WATCHING', at: 'x' });
  updateOutcome(s2, 'r2', { price_usd: 1.0, liquidity_usd: 20000 });
  const oc2 = updateOutcome(s2, 'r2', { price_usd: 0.95, liquidity_usd: 500 });
  t('T32b liquidity rug (<$1k after >=$5k)', oc2.rug_event === true && oc2.rug_kind === 'liquidity_collapse');
}

// T33: rejected candidates are tracked too (no survivorship bias)
{
  const s = mkState();
  s.entities['q'] = { entity_id: 'q', kind: 'mint', mint: 'D'.repeat(44) };
  s.entities['x'] = { entity_id: 'x', kind: 'mint', mint: 'E'.repeat(44) };
  s.signal_state_log.push({ entity_id: 'q', to_state: 'QUALIFIED CANDIDATE', at: 'x' });
  s.signal_state_log.push({ entity_id: 'x', to_state: 'SECURITY REJECTED', at: 'x' });
  const ids = trackedEntityIds(s);
  t('T33 rejected entity included in tracking', ids.includes('q') && ids.includes('x'), ids.join(','));
}

// T34: tracking window ends after 24h
{
  const s = mkState();
  s.entities['old'] = { entity_id: 'old', kind: 'mint', mint: 'F'.repeat(44) };
  s.signal_state_log.push({ entity_id: 'old', to_state: 'WATCHING', at: 'x' });
  const old = new Date(Date.now() - (TRACK_WINDOW_HOURS + 1) * 3600000).toISOString();
  updateOutcome(s, 'old', { price_usd: 1, liquidity_usd: 1000 }, old);
  const ids = trackedEntityIds(s);
  t('T34 window end => ENDED + untracked', !ids.includes('old') && s.outcomes['old'].status === 'ENDED');
}

// T35: summary groups + INSUFFICIENT_SAMPLE honesty
{
  const s = mkState();
  for (let i = 0; i < 3; i++) {
    const id = 'q' + i;
    s.entities[id] = { entity_id: id, kind: 'mint', mint: 'G'.repeat(43) + i, name: 'Q' + i };
    s.signal_state_log.push({ entity_id: id, to_state: 'QUALIFIED CANDIDATE', at: 'x' });
    updateOutcome(s, id, { price_usd: 1, liquidity_usd: 5000 });
    updateOutcome(s, id, { price_usd: 2, liquidity_usd: 6000 });
  }
  s.entities['rj'] = { entity_id: 'rj', kind: 'mint', mint: 'H'.repeat(44) };
  s.signal_state_log.push({ entity_id: 'rj', to_state: 'LIQUIDITY INSUFFICIENT', at: 'x' });
  updateOutcome(s, 'rj', { price_usd: 1, liquidity_usd: 900 });
  const sum = summarizeEvaluation(s);
  t('T35 counts', sum.tracked_total === 4 && sum.qualified_tracked === 3 && sum.rejected_tracked === 1);
  t('T35 qualified group INSUFFICIENT_SAMPLE (n=3<5)', sum.by_group['QUALIFIED CANDIDATE'].sample_status === 'INSUFFICIENT_SAMPLE');
  t('T35 median upside +100%', Math.abs(sum.by_group['QUALIFIED CANDIDATE'].median_max_upside_pct - 100) < 1e-9);
}

// T36: mergeStates unions outcomes without losing entry ref
{
  const a = mkState(), b = mkState();
  a.entities['e'] = { entity_id: 'e', kind: 'mint' }; b.entities['e'] = { entity_id: 'e', kind: 'mint' };
  a.signal_state_log.push({ entity_id: 'e', to_state: 'WATCHING', at: 'x' });
  b.signal_state_log.push({ entity_id: 'e', to_state: 'WATCHING', at: 'x' });
  updateOutcome(a, 'e', { price_usd: 1.0, liquidity_usd: 5000 }, '2026-10-17T10:00:00Z');
  updateOutcome(b, 'e', { price_usd: 1.0, liquidity_usd: 5000 }, '2026-10-17T10:00:00Z');
  updateOutcome(b, 'e', { price_usd: 2.0, liquidity_usd: 5000 }, '2026-10-17T11:00:00Z');
  const m = mergeStates(a, b);
  t('T36 merge keeps entry 1.0 + max 2.0', m.outcomes['e'].entry_price === 1.0 && m.outcomes['e'].max_price === 2.0 && m.outcomes['e'].current_price === 2.0);
}

console.log(`\n${pass} passed, ${fail} failed`);


// T37: geckoterminal fallback path (live dexscreener blocked from CF egress)
import { priceFromGecko } from '../src/evaluation.js';
{
  const pi = priceFromGecko([
    { attributes: { base_token_price_usd: '0.001', reserve_in_usd: '100' } },
    { attributes: { base_token_price_usd: '0.002', reserve_in_usd: '9000', address: 'pool1' } }]);
  t('T37 gecko price pick = highest-reserve pool', pi && pi.price_usd === 0.002 && pi.pair === 'pool1' && pi.source === 'geckoterminal');
  t('T37b gecko null on empty', priceFromGecko([]) === null && priceFromGecko(null) === null);
}
console.log(`(with T37) total: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
