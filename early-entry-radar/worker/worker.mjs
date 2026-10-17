// jk-early-entry-radar - Cloudflare Worker entry (cron + manual run + health).
// Collects -> ingests -> resolves -> launch status -> security/market gates -> decision -> dashboard JSON -> Telegram.
// State lives in the Jk1 repo (early-entry-radar/data/state.json); commits via GitHub contents API (GH_TOKEN secret).
import { openJsonStore, emptyState, capState } from './src/jsonstore.js';
import { runCollectors } from './src/ingest.js';
import { ingestMentions } from './src/social.js';
import { computeLaunchStatus, applyLaunchStatus } from './src/prelaunch.js';
import { runSecurityChecks, persistSecurity } from './src/security.js';
import { runMarketGates, persistGates } from './src/marketgates.js';
import { decide, lifecycle, applySignalState } from './src/decision.js';
import * as pumpfun from './src/adapters/pumpfun.js';
import * as dexscreener from './src/adapters/dexscreener.js';
import * as geckoterminal from './src/adapters/geckoterminal.js';
import * as telegram from './src/adapters/telegram.js';

const REPO = 'jegankumarsparks-source/Jk1';
const BASE = 'early-entry-radar';
const TG_CHANNELS = ['pumpfundotfun']; // config: public-preview channels only (GAP: most CT channels have no preview)
const SECURITY_BUDGET_PER_CYCLE = 8;   // free-tier safe: each entity costs ~6 API calls
const SECURITY_RECHECK_MIN = 30;

const ghHeaders = (env) => ({ authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'jk-early-entry-radar' });
const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s) => decodeURIComponent(escape(atob(s)));

async function ghGet(env, path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, { headers: ghHeaders(env) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`gh get ${path}: HTTP ${r.status}`);
  const j = await r.json();
  return { sha: j.sha, text: unb64(j.content.replace(/\n/g, '')) };
}
async function ghPut(env, path, text, message) {
  const cur = await ghGet(env, path).catch(() => null);
  const body = { message, content: b64(text), committer: { name: 'EARLY-ENTRY RADAR (worker)', email: 'jegankumarsparks@gmail.com' } };
  if (cur) body.sha = cur.sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, { method: 'PUT', headers: { ...ghHeaders(env), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`gh put ${path}: HTTP ${r.status} ${await r.text().then(t => t.slice(0, 200))}`);
  return true;
}

async function tgSend(env, text, state) {
  if (!env.TG_TOKEN || !env.TG_CHAT_ID) return 'not_configured';
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: text.slice(0, 3900), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000) });
    return r.ok ? 'sent' : `http_${r.status}`;
  } catch (e) { return `error:${String(e).slice(0, 80)}`; }
}

async function runCycle(env) {
  const t0 = Date.now();
  const saved = await ghGet(env, `${BASE}/data/state.json`).catch(() => null);
  const state = saved ? JSON.parse(saved.text) : emptyState();
  if (!state.notifications) state.notifications = [];
  const store = openJsonStore(state);

  // 1. collect
  const collected = await runCollectors(store, [pumpfun, dexscreener, geckoterminal, telegram], { telegram: { channels: TG_CHANNELS } });

  // 2. mentions from new telegram events
  const tgEvents = state.raw_events.filter(e => e.source === 'telegram').slice(-50);
  await ingestMentions(store, tgEvents.map(e => ({ ...e, id: e.id })));

  // 3. per-entity pipeline for entities with fresh evidence this cycle
  const config = await ghGet(env, `${BASE}/config.json`).then(c => JSON.parse(c.text)).catch(() => ({}));
  const touched = new Set(state.entity_evidence.slice(-400).map(x => x.entity_id));
  let secChecked = 0;
  const transitions = [];
  for (const entityId of touched) {
    const ent = state.entities[entityId];
    if (!ent) continue;
    const evRows = state.entity_evidence.filter(x => x.entity_id === entityId)
      .map(x => state.raw_events.find(r => r.id === x.raw_event_id)).filter(Boolean);
    const mentions = state.mentions.filter(m => m.entity_id === entityId);
    // launch status
    const ls = computeLaunchStatus({ evidence: evRows.map(r => ({ source: r.source, observed_at: r.observed_at, payload: r.payload })), mentions });
    applyLaunchStatus(store, entityId, ls);
    // security + market gates only for mint entities with launch evidence, throttled
    if (ent.kind === 'mint' && (ls.status === 'LAUNCH DETECTED' || ls.status === 'LIVE MARKET VERIFIED')) {
      const lastSec = state.security_results.filter(r => r.entity_id === entityId).slice(-1)[0];
      const stale = !lastSec || (Date.now() - new Date(lastSec.at).getTime()) > SECURITY_RECHECK_MIN * 60000;
      if (stale && secChecked < SECURITY_BUDGET_PER_CYCLE) {
        secChecked++;
        const sec = await runSecurityChecks(ent.mint, config);
        persistSecurity(store, entityId, sec);
        const gates = await runMarketGates(ent.mint, config);
        persistGates(store, entityId, gates);
        var secVerdict = sec.verdict, mktVerdict = gates.verdict;
      } else if (lastSec) {
        var secVerdict = lastSec.result === 'FAIL' ? 'REJECTED' : 'PASS_WITH_FINDINGS';
      }
      // decision
      const facts = buildFacts(state, entityId, ent, config);
      const current = store.latestSignalState(entityId);
      if (current === 'QUALIFIED CANDIDATE' || current === 'OUTCOME PENDING') {
        const lc = lifecycle(current, { securityVerdict: secVerdict, marketVerdict: mktVerdict, age_hours: facts.age_hours }, config);
        if (lc) transitions.push({ entityId, ...applySignalState(store, entityId, { ...lc, score: null, breakdown: null }) });
      } else {
        const d = decide({ identity: ent.kind, launchStatus: ls.status, securityVerdict: secVerdict, marketVerdict: mktVerdict, facts }, config);
        const applied = applySignalState(store, entityId, d);
        if (applied.changed) transitions.push({ entityId, ...applied });
      }
    }
  }

  // 4. notify on transitions (dedupe: one message per entity+state)
  let notified = 0, tgStatus = 'disabled';
  for (const tr of transitions) {
    const key = `${tr.entityId}:${tr.to}`;
    if (['QUALIFIED CANDIDATE', 'SECURITY REJECTED', 'SIGNAL INVALIDATED', 'DATA INCOMPLETE'].includes(tr.to)
        && !state.notifications.some(n => n.key === key)) {
      const ent = state.entities[tr.entityId];
      tgStatus = await tgSend(env,
        `EARLY-ENTRY RADAR\n${tr.to}\n${ent.name || '?'} (${ent.ticker || '?'})\nmint: ${ent.mint || 'unverified'}\nstate change: ${tr.from || 'new'} -> ${tr.to}\nhttps://jegankumarsparks-source.github.io/Jk1/${BASE}/`, state);
      state.notifications.push({ key, at: new Date().toISOString(), result: tgStatus });
      notified++;
    }
  }

  // 5. dashboard data
  capState(state);
  const latestSec = {}, latestGate = {};
  for (const r of state.security_results) latestSec[r.entity_id + ':' + r.check_name] = r;
  for (const r of state.gate_results) latestGate[r.entity_id + ':' + r.gate] = r;
  const latestSig = {};
  for (const r of state.signal_state_log) latestSig[r.entity_id] = r;
  const coins = Object.values(state.entities).map(e => ({
    id: e.entity_id, kind: e.kind, name: e.name, ticker: e.ticker, mint: e.mint || null,
    launch_status: e.launch_status, first_evidence_at: e.first_evidence_at,
    signal: latestSig[e.entity_id] ? { state: latestSig[e.entity_id].to_state, score: latestSig[e.entity_id].score, at: latestSig[e.entity_id].at } : null,
    security: Object.values(latestSec).filter(r => r.entity_id === e.entity_id).map(r => ({ check: r.check_name, result: r.result })),
    gates: Object.values(latestGate).filter(r => r.entity_id === e.entity_id).map(r => ({ gate: r.gate, result: r.result })),
  })).sort((a, b) => (b.first_evidence_at || '').localeCompare(a.first_evidence_at || ''));
  const health = {};
  for (const h of state.source_health) health[h.source] = h;
  const feed = { generated_at: new Date().toISOString(), cycle_ms: Date.now() - t0,
    headline: coins.filter(c => c.signal && (c.signal.state === 'QUALIFIED CANDIDATE')).length
      ? `${coins.filter(c => c.signal && c.signal.state === 'QUALIFIED CANDIDATE').length} QUALIFIED CANDIDATE(S)` : 'NO QUALIFIED SIGNAL',
    coins, sources: health, transitions: state.signal_state_log.slice(-50), notifications: state.notifications.slice(-20),
    gaps: ['X/Twitter: no free API', 'Reddit: blocked (needs free OAuth app)', 'Discord: needs per-server bot', 'Instagram: no free access', 'GMGN: no API (links from validated mint only)'] };

  await ghPut(env, `${BASE}/data/state.json`, JSON.stringify(state), 'early-entry-radar: cycle state');
  await ghPut(env, `${BASE}/data/feed.json`, JSON.stringify(feed), `early-entry-radar: feed ${feed.headline}`);
  return { ok: true, cycle_ms: Date.now() - t0, entities: coins.length, secChecked, notified, tgStatus, headline: feed.headline };
}

function buildFacts(state, entityId, ent, config) {
  const firstAt = ent.first_evidence_at ? new Date(ent.first_evidence_at).getTime() : Date.now();
  const ment = state.mentions.filter(m => m.entity_id === entityId);
  const sources = new Set(state.entity_evidence.filter(x => x.entity_id === entityId)
    .map(x => (state.raw_events.find(r => r.id === x.raw_event_id) || {}).source).filter(Boolean));
  return {
    age_hours: (Date.now() - firstAt) / 3600000,
    mean_source_reliability: 0.7, // static until source reliability tiers are tuned in STEP 8/9
    independent_sources: sources.size,
    independent_influencer_mentions: ment.filter(m => !m.is_duplicate).length,
    disclosed_paid_mentions: ment.filter(m => m.category === 'disclosed_paid').length,
    identity: ent.kind,
    unique_mentions: ment.filter(m => !m.is_duplicate).length,
    txn_count: 0, // filled by market adapter enrichment in later step
    liquidity_usd: 0,
    min_liquidity_usd: config.min_liquidity_usd ?? 5000,
    noncritical_findings: 0,
    data_completeness: 0.6,
  };
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runCycle(env).catch(e => console.error('cycle failed', e))); },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'jk-early-entry-radar', at: new Date().toISOString() });
    if (url.pathname.startsWith('/run')) {
      if (!env.RUN_KEY || url.searchParams.get('key') !== env.RUN_KEY) return new Response('forbidden', { status: 403 });
      return Response.json(await runCycle(env).catch(e => ({ ok: false, error: String(e) })));
    }
    return new Response('jk-early-entry-radar', { status: 200 });
  },
};
