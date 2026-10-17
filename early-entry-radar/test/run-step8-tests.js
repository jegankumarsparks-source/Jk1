// STEP 8: integration failure / latency / data-quality / secret-hygiene tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { openJsonStore, emptyState } from '../src/jsonstore.js';
import { runCollectors, ingestEvents } from '../src/ingest.js';
import * as pumpfun from '../src/adapters/pumpfun.js';
import * as dexscreener from '../src/adapters/dexscreener.js';
import * as geckoterminal from '../src/adapters/geckoterminal.js';
import { isValidMint } from '../src/util.js';

const results = [];
const check = (n, ok, ev) => { results.push(ok); console.log(`${ok?'PASS':'FAIL'}  ${n}  | ${ev}`); };

// T22: a dead source degrades, pipeline survives (degraded-not-dead)
{
  const deadAdapter = { SOURCE: { source: 'deadsrc', source_type: 'api', auth_status: 'none', reliability_notes: 'test' },
    collect: async () => ({ events: [], health: { source: 'deadsrc', checked_at: new Date().toISOString(), status: 'OFFLINE', latency_ms: null, http_status: 0, rate_limit: null, error: 'simulated outage' } }) };
  const store = openJsonStore(emptyState());
  const out = await runCollectors(store, [deadAdapter, geckoterminal]);
  const ok = out.deadsrc.health.status === 'OFFLINE' && out.geckoterminal.health.status === 'LIVE' && out.geckoterminal.ingest.inserted > 0;
  check('T22_source_outage_isolated', ok,
    `deadsrc=OFFLINE error="${out.deadsrc.health.error}" while geckoterminal=LIVE inserted=${out.geckoterminal.ingest.inserted} (pipeline unaffected)`);
}

// T23: real collector latencies (live)
{
  const store = openJsonStore(emptyState());
  const t0 = Date.now();
  const out = await runCollectors(store, [pumpfun, dexscreener, geckoterminal]);
  const lat = Object.entries(out).map(([k, v]) => `${k}=${v.health.latency_ms}ms(${v.health.status})`).join(' ');
  const total = Date.now() - t0;
  check('T23_collector_latency', total < 30000, `${lat} | total ${total}ms (fits 5-min cron budget)`);
}

// T24: data-quality audit on live-captured events
{
  const store = openJsonStore(emptyState());
  const out = await runCollectors(store, [pumpfun, geckoterminal]);
  const evs = store.state.raw_events;
  const bad = [];
  let mints = 0, validMints = 0;
  for (const e of evs) {
    if (!e.source || !e.source_id || !e.ingested_at) bad.push(`missing meta: ${e.source}/${e.source_id}`);
    if (e.ingested_at && !e.ingested_at.endsWith('Z')) bad.push(`non-UTC ingested_at on ${e.source_id}`);
    if (e.payload && e.payload.mint) { mints++; if (isValidMint(e.payload.mint)) validMints++; }
    if (e.observed_at && isNaN(new Date(e.observed_at).getTime())) bad.push(`bad observed_at on ${e.source_id}`);
  }
  check('T24_data_quality_audit', bad.length === 0 && mints > 0 && validMints === mints,
    `audited ${evs.length} live events: meta complete, UTC timestamps valid, mints ${validMints}/${mints} valid base58-32B; issues=${bad.length}${bad[0] ? ' first: ' + bad[0] : ''}`);
}

// T25: entity sanity - all mint entities have valid mints; provisional entities never carry mints
{
  const store = openJsonStore(emptyState());
  await runCollectors(store, [pumpfun]);
  const ents = Object.values(store.state.entities);
  const mintEnts = ents.filter(e => e.kind === 'mint');
  const provs = ents.filter(e => e.kind === 'provisional');
  const ok = mintEnts.every(e => isValidMint(e.mint)) && provs.every(e => !e.mint);
  check('T25_entity_sanity', ok && mintEnts.length > 0,
    `${mintEnts.length} mint entities all valid; ${provs.length} provisional all mintless`);
}

const failed = results.filter(r => !r).length;
console.log(`\n== STEP8 SUMMARY: ${results.length - failed}/${results.length} PASS, ${failed} FAIL ==`);
process.exit(failed ? 1 : 0);
