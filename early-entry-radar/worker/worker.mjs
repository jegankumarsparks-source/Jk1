// jk-early-entry-radar - Cloudflare Worker entry (cron + manual run + health).
// Collects -> ingests -> resolves -> launch status -> security/market gates -> decision -> dashboard JSON -> Telegram.
// State lives in the Jk1 repo (early-entry-radar/data/state.json); commits via GitHub contents API (GH_TOKEN secret).
import { openJsonStore, emptyState, capState } from './src/jsonstore.js';
import { runOutcomeRefresh, summarizeEvaluation } from './src/evaluation.js';
import { runCollectors } from './src/ingest.js';
import { ingestMentions } from './src/social.js';
import { computeLaunchStatus, applyLaunchStatus } from './src/prelaunch.js';
import { runSecurityChecks, persistSecurity, verdictFromRows } from './src/security.js';
import { runMarketGates, persistGates } from './src/marketgates.js';
import { decide, lifecycle, applySignalState } from './src/decision.js';
import * as pumpfun from './src/adapters/pumpfun.js';
import * as dexscreener from './src/adapters/dexscreener.js';
import * as geckoterminal from './src/adapters/geckoterminal.js';
import * as telegram from './src/adapters/telegram.js';
import * as reddit from './src/adapters/reddit.js';

const REPO = 'jegankumarsparks-source/Jk1';
const BASE = 'early-entry-radar';
const TG_CHANNELS = ['pumpfundotfun', 'DRBTSolanaPF']; // public-preview channels; DRBTSolanaPF verified active 2026-10-18
// Free Workers cap at 50 subrequests/invocation (hit in testing 2026-10-17). Hard budget below.
const SECURITY_BUDGET_PER_CYCLE = 3;   // each entity costs ~8 subrequests (sec 5 + gates 3)
const SUBREQUEST_BUDGET = 44;
const SECURITY_RECHECK_MIN = 30;

const ghHeaders = (env) => ({ authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'jk-early-entry-radar' });
const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s) => decodeURIComponent(escape(atob(s)));

async function ghGet(env, path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, { headers: ghHeaders(env) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`gh get ${path}: HTTP ${r.status}`);
  const j = await r.json();
  if (!j.content && j.download_url) { // contents API omits content for files >1MB
    const raw = await fetch(j.download_url, { headers: ghHeaders(env) });
    if (!raw.ok) throw new Error(`gh raw ${path}: HTTP ${raw.status}`);
    return { sha: j.sha, text: await raw.text() };
  }
  return { sha: j.sha, text: unb64(j.content.replace(/\n/g, '')) };
}
async function ghPut(env, path, text, message, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const cur = await ghGet(env, path).catch(() => null);
    const body = { message, content: b64(text), committer: { name: 'EARLY-ENTRY RADAR (worker)', email: 'jegankumarsparks@gmail.com' } };
    if (cur) body.sha = cur.sha;
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, { method: 'PUT', headers: { ...ghHeaders(env), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) return true;
    if (r.status === 409 && i < retries) continue; // concurrent writer (cron overlap): refetch sha, retry
    throw new Error(`gh put ${path}: HTTP ${r.status} ${await r.text().then(t => t.slice(0, 200))}`);
  }
  return false;
}

// Union-merge two store states (append-only lists + entity upserts). Idempotent; safe for cron overlap.
export function mergeStates(a, b) {
  const out = a;
  out.seq = Math.max(a.seq || 0, b.seq || 0);
  const seen = new Set(a.raw_events.map(e => e.source + '|' + e.source_id));
  for (const e of b.raw_events) if (!seen.has(e.source + '|' + e.source_id)) { out.raw_events.push(e); seen.add(e.source + '|' + e.source_id); }
  for (const k of ['entity_evidence', 'mentions', 'security_results', 'gate_results', 'launch_status_log', 'signal_state_log', 'source_health', 'notifications', 'pending_notifications']) {
    const key = (x) => JSON.stringify(x);
    const have = new Set((out[k] || []).map(key));
    for (const x of (b[k] || [])) if (!have.has(key(x))) { out[k] = out[k] || []; out[k].push(x); have.add(key(x)); }
  }
  for (const [id, e] of Object.entries(b.entities || {})) {
    if (!out.entities[id]) out.entities[id] = e;
    else { const o = out.entities[id]; if (!o.name && e.name) o.name = e.name; if (!o.ticker && e.ticker) o.ticker = e.ticker;
      if (e.first_evidence_at < o.first_evidence_at) o.first_evidence_at = e.first_evidence_at; o.launch_status = e.launch_status; }
  }
  Object.assign(out.sources, b.sources);
  out.outcomes = out.outcomes || {};
  for (const [id, oc] of Object.entries(b.outcomes || {})) {
    const ex = out.outcomes[id];
    if (!ex) out.outcomes[id] = oc;
    else { // keep richer/earlier-entry record
      ex.samples = Math.max(ex.samples || 0, oc.samples || 0);
      ex.max_price = Math.max(ex.max_price, oc.max_price); ex.min_price = Math.min(ex.min_price, oc.min_price);
      if ((oc.last_price_at || '') > (ex.last_price_at || '')) { ex.current_price = oc.current_price; ex.current_liquidity_usd = oc.current_liquidity_usd; ex.last_price_at = oc.last_price_at; ex.current_ret_pct = oc.current_ret_pct; }
      if (oc.rug_event && !ex.rug_event) { ex.rug_event = true; ex.rug_at = oc.rug_at; ex.rug_kind = oc.rug_kind; ex.status = oc.status; }
      ex.max_liquidity_seen_usd = Math.max(ex.max_liquidity_seen_usd || 0, oc.max_liquidity_seen_usd || 0);
    }
  }
  return out;
}

// Keep repo state under the ~1MB contents-API cap: tighter caps in prod + drop stale
// provisional (mintless) entities that never got a signal decision. Decided entities are kept.
function pruneState(state) {
  const caps = { raw_events: 1500, entity_evidence: 3000, mentions: 1200, security_results: 1000,
    gate_results: 1000, launch_status_log: 300, signal_state_log: 600, source_health: 300,
    notifications: 200, pending_notifications: 100 };
  for (const [k, cap] of Object.entries(caps)) if (state[k] && state[k].length > cap) state[k] = state[k].slice(-cap);
  const decided = new Set(state.signal_state_log.map(r => r.entity_id));
  const cutoff = Date.now() - 6 * 3600000;
  for (const [id, e] of Object.entries(state.entities)) {
    if (e.kind !== 'mint' && !decided.has(id) && e.first_evidence_at && new Date(e.first_evidence_at).getTime() < cutoff)
      delete state.entities[id];
  }
  return state;
}

async function tgSend(env, text, state) {
  if (!env.TG_TOKEN || !env.TG_CHAT_ID) return 'not_configured';
  if (state && state.tg_muted_until && Date.now() < new Date(state.tg_muted_until).getTime()) return 'muted';
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: text.slice(0, 3900), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000) });
    if (r.status === 429) {
      let wait = 600;
      try { const j = await r.json(); wait = (j.parameters && j.parameters.retry_after) || wait; } catch {}
      if (state) state.tg_muted_until = new Date(Date.now() + (wait + 60) * 1000).toISOString();
      return 'rate_limited';
    }
    return r.ok ? 'sent' : `http_${r.status}`;
  } catch (e) { return `error:${String(e).slice(0, 80)}`; }
}

async function runCycle(env) {
  const t0 = Date.now();
  globalThis.EER_FETCH_RETRIES = 0; // 50-subrequest cap: no silent retry multiplication inside Workers
  globalThis.EER_HELIUS_KEY = env.HELIUS_KEY || null; // owner-approved free-tier key (vault 2026-10-18)
  let subrequests = 0;
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (...a) => { subrequests++; return realFetch(...a); };
  const saved = await ghGet(env, `${BASE}/data/state.json`).catch(() => null);
  const state = saved ? JSON.parse(saved.text) : emptyState();
  if (!state.notifications) state.notifications = [];
  if (!state.pending_notifications) state.pending_notifications = [];
  const store = openJsonStore(state);

  // 1. collect
  const collected = await runCollectors(store, [pumpfun, dexscreener, geckoterminal, telegram, reddit], { telegram: { channels: TG_CHANNELS }, reddit: { subreddits: ['solana'] } });

  // 2. mentions from new telegram events
  const tgEvents = state.raw_events.filter(e => e.source === 'telegram' || e.source === 'reddit').slice(-80);
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
      if (stale && secChecked < SECURITY_BUDGET_PER_CYCLE && subrequests < SUBREQUEST_BUDGET - 10) {
        secChecked++;
        const sec = await runSecurityChecks(ent.mint, config);
        persistSecurity(store, entityId, sec);
        const gates = await runMarketGates(ent.mint, config);
        persistGates(store, entityId, gates);
        var secVerdict = sec.verdict, mktVerdict = gates.verdict;
      } else if (lastSec) {
        // correct cache path: stored _verdict row wins; else recompute from all check rows (never last-row inference)
        const rows = state.security_results.filter(r => r.entity_id === entityId).reverse();
        const vrow = rows.find(r => r.check_name === '_verdict');
        var secVerdict = vrow ? vrow.result : verdictFromRows(rows);
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

  // 4. notifications: queue first, then drain max 3/cycle (Telegram rate-limit + 50-subrequest budget).
  const NOTIFY_STATES = ['QUALIFIED CANDIDATE', 'WATCHLIST', 'SECURITY REJECTED', 'SIGNAL INVALIDATED', 'DATA INCOMPLETE'];
  for (const tr of transitions) {
    const key = `${tr.entityId}:${tr.to}`;
    const isRegression = ['QUALIFYING', 'QUALIFIED CANDIDATE', 'OUTCOME PENDING'].includes(tr.from);
    if (tr.to === 'DATA INCOMPLETE' && !isRegression) continue; // first-time incompletes are routine, log-only
    if (NOTIFY_STATES.includes(tr.to)
        && !state.notifications.some(n => n.key === key)
        && !state.pending_notifications.some(n => n.key === key)) {
      state.pending_notifications.push({ key, entityId: tr.entityId, to: tr.to, from: tr.from, queued_at: new Date().toISOString() });
    }
  }
  // coalesce: if rejections pile up (e.g. after a stall), keep at most 2 and fold the rest into one summary
  for (const st of ['SECURITY REJECTED', 'DATA INCOMPLETE', 'WATCHLIST']) {
    const rej = state.pending_notifications.filter(n => n.to === st);
    if (rej.length > 2) {
      state.pending_notifications = state.pending_notifications.filter(n => n.to !== st || rej.indexOf(n) < 2);
      state.pending_notifications.push({ key: `summary:${st}:${new Date().toISOString().slice(0, 13)}`, entityId: null,
        to: st, from: null, summary_count: rej.length - 2, queued_at: new Date().toISOString() });
      for (const n of rej.slice(2)) state.notifications.push({ key: n.key, at: new Date().toISOString(), result: 'coalesced' });
    }
  }
  // QUALIFIED CANDIDATE alerts drain first
  state.pending_notifications.sort((a, b) => ((b.to === 'QUALIFIED CANDIDATE') - (a.to === 'QUALIFIED CANDIDATE')) || ((b.to === 'WATCHLIST') - (a.to === 'WATCHLIST')));
  let notified = 0, tgStatus = 'disabled';
  while (state.pending_notifications.length && notified < 3 && subrequests < SUBREQUEST_BUDGET - 6) {
    const n = state.pending_notifications.shift();
    const ent = state.entities[n.entityId];
    tgStatus = await tgSend(env, n.summary_count
      ? `EARLY-ENTRY RADAR\n${n.summary_count} further ${n.to} transitions this period (routine, see dashboard)\nhttps://jegankumarsparks-source.github.io/Jk1/${BASE}/`
      : `EARLY-ENTRY RADAR\n${n.to}\n${ent && ent.name || '?'} (${ent && ent.ticker || '?'})\nmint: ${(ent && ent.mint) || 'unverified'}\nstate change: ${n.from || 'new'} -> ${n.to}\nhttps://jegankumarsparks-source.github.io/Jk1/${BASE}/`, state);
    if (tgStatus === 'sent') { state.notifications.push({ key: n.key, at: new Date().toISOString(), result: tgStatus }); notified++; }
    else if (tgStatus === 'not_configured' || tgStatus === 'rate_limited' || tgStatus === 'muted') { state.pending_notifications.unshift(n); break; } // keep queue, try later
    else { state.notifications.push({ key: n.key, at: new Date().toISOString(), result: tgStatus }); } // real error: log + move on (no retry storm)
  }

  // 4b. prune for the ~1MB GitHub contents cap (state grew past it 2026-10-17 and stalled cycles)
  pruneState(state);

  // 4c. STEP 9: paper outcome refresh (budget-limited)
  const outcomeStats = await runOutcomeRefresh(state, { budget: Math.max(2, 6 - secChecked), subrequests: () => subrequests, subLimit: SUBREQUEST_BUDGET - 6 });

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
    evaluation: summarizeEvaluation(state),
    gaps: [
      'X/Twitter: IMPOSSIBLE free - X removed the free tier Feb 2026 (pay-per-use only, needs card); nitter dead, syndication empty (probed 2026-10-18)',
      'Reddit: PARTIAL - public RSS live but intermittent from datacenter IPs (429/403); reliable path = your own free Reddit app (needs your Reddit login once)',
      'Discord: IMPOSSIBLE free - reading a server needs an account inside it; no public message feed exists',
      'Instagram: IMPOSSIBLE free - no public discovery API',
      'GMGN: no API, site Cloudflare-blocks datacenter access (probed 403); links open fine from your phone'] };

  // Concurrent-writer safe: if state.json changed under us even after sha retry, merge with remote once.
  try {
    await ghPut(env, `${BASE}/data/state.json`, JSON.stringify(state), 'early-entry-radar: cycle state');
  } catch (e) {
    if (String(e).includes('409')) {
      const remote = await ghGet(env, `${BASE}/data/state.json`);
      const merged = mergeStates(JSON.parse(remote.text), state);
      await ghPut(env, `${BASE}/data/state.json`, JSON.stringify(merged), 'early-entry-radar: cycle state (merged)');
    } else throw e;
  }
  await ghPut(env, `${BASE}/data/feed.json`, JSON.stringify(feed), `early-entry-radar: feed ${feed.headline}`);
  return { ok: true, cycle_ms: Date.now() - t0, entities: coins.length, secChecked, notified, tgStatus, headline: feed.headline, outcomes: outcomeStats };
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
