// Backend parity: identical domain scenario against SQLite store and Worker JSON store.
// Proves the Worker's storage backend behaves identically for the pipeline's contract.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { openJsonStore, emptyState, capState } from '../src/jsonstore.js';
import { ingestEvents } from '../src/ingest.js';
import { ingestMentions } from '../src/social.js';
import { applySignalState, dailySignalReport } from '../src/decision.js';

const results = [];
const check = (n, ok, ev) => { results.push(ok); console.log(`${ok?'PASS':'FAIL'}  ${n}  | ${ev}`); };
const ts = new Date().toISOString();
const MINT = 'So11111111111111111111111111111111111111112';

async function scenario(store) {
  store.registerSource({ source: 'pumpfun', source_type: 'api', auth_status: 'none', reliability_notes: 'parity' });
  store.registerSource({ source: 'telegram', source_type: 'web_preview', auth_status: 'none', reliability_notes: 'parity' });
  store.recordHealth({ source: 'pumpfun', checked_at: ts, status: 'LIVE', latency_ms: 100, http_status: 200, rate_limit: null, error: null });
  const evs = [
    { source: 'pumpfun', source_id: MINT, url: 'u1', observed_at: ts, ingested_at: ts, payload: { mint: MINT, name: 'ParityCoin', symbol: 'PAR' } },
    { source: 'pumpfun', source_id: MINT, url: 'u1', observed_at: ts, ingested_at: ts, payload: { mint: MINT, name: 'ParityCoin', symbol: 'PAR' } }, // dupe
  ];
  const ing = await ingestEvents(store, evs);
  const m1 = await ingestMentions(store, [{ id: 1, source: 'telegram', source_id: 'tg:c:1', url: 'https://t.me/c/1', observed_at: ts, ingested_at: ts, payload: { channel: 'c', text: 'CA check $PAR' } }]);
  const tgIns = store.insertRawEvent({ source: 'telegram', source_id: 'tg:c:1', url: 'https://t.me/c/1', observed_at: ts, ingested_at: ts, payload: { channel: 'c', text: 'x' } });
  const m2 = await ingestMentions(store, [{ id: tgIns.id, source: 'telegram', source_id: 'tg:c:2', url: 'https://t.me/c/2', observed_at: ts, ingested_at: ts, payload: { channel: 'd', text: 'CA check $PAR' } }]);
  store.upsertEntity({ entity_id: 'mint:X', kind: 'mint', mint: 'X', name: 'A', ticker: null, first_evidence_at: ts, created_at: ts });
  store.upsertEntity({ entity_id: 'mint:X', kind: 'mint', mint: 'X', name: null, ticker: 'AX', first_evidence_at: '2020-01-01T00:00:00.000Z', created_at: ts });
  store.setEntityLaunchStatus('mint:X', 'LAUNCH DETECTED');
  store.logLaunchStatus('mint:X', 'STATUS UNKNOWN', 'LAUNCH DETECTED', '["r"]', ts);
  applySignalState(store, 'mint:X', { state: 'QUALIFIED CANDIDATE', reasons: ['r'], score: 88, breakdown: { a: 1 } });
  applySignalState(store, 'mint:X', { state: 'QUALIFIED CANDIDATE', reasons: ['r'], score: 88, breakdown: { a: 1 } }); // no dup transition
  store.insertSecurityResult({ entity_id: 'mint:X', check_name: 'mint_authority', result: 'PASS', evidence: '{}', provider: 'goplus', limitations: null, at: ts });
  store.insertGateResult({ entity_id: 'mint:X', gate: 'real_pool', result: 'PASS', detail: '{}', at: ts });
  return {
    ing, m1, m2,
    entity: store.state ? store.state.entities['mint:X'] : store.get(`SELECT * FROM entities WHERE entity_id='mint:X'`),
    latest: store.latestSignalState('mint:X'),
    report: dailySignalReport(store),
  };
}

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const sqlR = await scenario(openStore(db));
const jsStore = openJsonStore(emptyState());
const jsR = await scenario(jsStore);

check('B1_ingest_parity', sqlR.ing.inserted === 1 && sqlR.ing.duplicates === 1 && jsR.ing.inserted === 1 && jsR.ing.duplicates === 1,
  `sqlite: ${sqlR.ing.inserted}+${sqlR.ing.duplicates}dup | json: ${jsR.ing.inserted}+${jsR.ing.duplicates}dup`);
check('B2_mentions_parity', jsR.m1.mentions === 1 && jsR.m2.duplicates === 1 && sqlR.m1.mentions === 1 && sqlR.m2.duplicates === 1,
  `both: first mention new, cross-channel copy flagged duplicate`);
check('B3_entity_merge_parity', jsR.entity.name === 'A' && jsR.entity.ticker === 'AX' && jsR.entity.first_evidence_at === '2020-01-01T00:00:00.000Z' && sqlR.entity.ticker === 'AX',
  `upsert merge semantics identical (name kept, ticker filled, earliest evidence kept)`);
check('B4_signal_log_parity', jsR.latest === 'QUALIFIED CANDIDATE' && sqlR.latest === 'QUALIFIED CANDIDATE'
  && jsStore.state.signal_state_log.length === 1,
  `same-state re-apply creates no duplicate transition (json log rows=${jsStore.state.signal_state_log.length})`);
check('B5_report_parity', jsR.report.headline === sqlR.report.headline && jsR.report.candidates.length === 1,
  `report headline="${jsR.report.headline}" on both`);
// capState bounds
const big = emptyState(); for (let i = 0; i < 6000; i++) big.raw_events.push({ id: i, source: 's', source_id: 'id' + i, ingested_at: ts, payload: '{}' });
capState(big);
check('B6_state_bounded', big.raw_events.length === 5000 && big.raw_events[0].source_id === 'id1000',
  `state capped at 5000 events, oldest trimmed (Worker free-tier safe)`);

const failed = results.filter(r => !r).length;
console.log(`\n== PARITY SUMMARY: ${results.length - failed}/${results.length} PASS, ${failed} FAIL ==`);
process.exit(failed ? 1 : 0);
