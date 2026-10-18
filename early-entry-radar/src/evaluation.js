// STEP 9 - paper outcome tracking + evaluation.
// Tracks EVERY entity that received any signal decision (including rejections) so the
// evaluation has no survivorship bias. Entry reference = first observed market price at
// or after the first signal decision. Paper only: nothing here executes or implies trades.
import { fetchDexscreenerPairs } from './marketgates.js';
import { fetchJson } from './util.js';

export const TRACK_WINDOW_HOURS = 24;
export const RUG_DROP_PCT = 80;        // price down >=80% from entry => rug/collapse event
export const RUG_LIQ_FLOOR_USD = 1000; // or liquidity collapses below this after being >=5k
const MIN_SAMPLE = 5;

export function priceFromPairs(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const sol = pairs.filter(p => p.chainId === 'solana' && p.priceUsd);
  if (!sol.length) return null;
  const best = sol.reduce((m, p) => (((p.liquidity || {}).usd || 0) > ((m.liquidity || {}).usd || 0) ? p : m), sol[0]);
  return { price_usd: parseFloat(best.priceUsd), liquidity_usd: (best.liquidity || {}).usd || 0,
           source: 'dexscreener', pair: best.pairAddress || null };
}

// Entities to track: mint entities with at least one signal-state decision, within window.
export function trackedEntityIds(state, nowMs = Date.now()) {
  if (!state.outcomes) state.outcomes = {};
  const decided = new Set(state.signal_state_log.map(r => r.entity_id));
  const ids = [];
  for (const id of decided) {
    const ent = state.entities[id];
    if (!ent || ent.kind !== 'mint') continue;
    const oc = state.outcomes[id];
    if (oc && (oc.status === 'ENDED' || oc.status === 'RUG_EVENT')) continue;
    if (oc && (nowMs - new Date(oc.entry_at).getTime()) > TRACK_WINDOW_HOURS * 3600000) { oc.status = 'ENDED'; continue; }
    ids.push(id);
  }
  return ids;
}

export function updateOutcome(state, entityId, priceInfo, nowIso = new Date().toISOString()) {
  if (!state.outcomes) state.outcomes = {};
  const sig = state.signal_state_log.filter(r => r.entity_id === entityId);
  const firstState = sig.length ? sig[0].to_state : 'DISCOVERED';
  let oc = state.outcomes[entityId];
  if (!oc) {
    oc = state.outcomes[entityId] = {
      entry_price: priceInfo.price_usd, entry_at: nowIso, entry_state: firstState,
      max_price: priceInfo.price_usd, min_price: priceInfo.price_usd,
      current_price: priceInfo.price_usd, current_liquidity_usd: priceInfo.liquidity_usd,
      max_liquidity_seen_usd: priceInfo.liquidity_usd,
      status: 'TRACKING', rug_event: false, samples: 0,
    };
  }
  const p = priceInfo.price_usd;
  oc.samples++;
  oc.current_price = p; oc.current_liquidity_usd = priceInfo.liquidity_usd;
  oc.max_liquidity_seen_usd = Math.max(oc.max_liquidity_seen_usd || 0, priceInfo.liquidity_usd || 0);
  oc.max_price = Math.max(oc.max_price, p);
  oc.min_price = Math.min(oc.min_price, p);
  oc.last_price_at = nowIso;
  const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);
  oc.current_ret_pct = pct(p, oc.entry_price);
  oc.max_upside_pct = pct(oc.max_price, oc.entry_price);
  oc.max_adverse_pct = pct(oc.min_price, oc.entry_price); // negative or 0
  if (!oc.rug_event) {
    const priceRug = oc.entry_price > 0 && p <= oc.entry_price * (1 - RUG_DROP_PCT / 100);
    const liqRug = (oc.max_liquidity_seen_usd >= 5000) && (priceInfo.liquidity_usd < RUG_LIQ_FLOOR_USD);
    if (priceRug || liqRug) { oc.rug_event = true; oc.rug_at = nowIso; oc.rug_kind = priceRug ? 'price_collapse' : 'liquidity_collapse'; oc.status = 'RUG_EVENT'; }
  }
  return oc;
}

// Median helper
const med = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function summarizeEvaluation(state, nowIso = new Date().toISOString()) {
  const outcomes = state.outcomes || {};
  const rows = Object.entries(outcomes).map(([id, oc]) => {
    const ent = state.entities[id] || {};
    return { entity_id: id, name: ent.name || null, ticker: ent.ticker || null, mint: ent.mint || null,
      entry_state: oc.entry_state, entry_at: oc.entry_at, entry_price: oc.entry_price,
      current_ret_pct: oc.current_ret_pct, max_upside_pct: oc.max_upside_pct, max_adverse_pct: oc.max_adverse_pct,
      status: oc.status, rug_event: !!oc.rug_event, samples: oc.samples };
  });
  const groups = {};
  for (const r of rows) {
    const g = r.entry_state || 'UNKNOWN';
    groups[g] = groups[g] || { n: 0, rugs: 0, rets: [], upsides: [], adverses: [] };
    groups[g].n++; if (r.rug_event) groups[g].rugs++;
    if (r.current_ret_pct != null) groups[g].rets.push(r.current_ret_pct);
    if (r.max_upside_pct != null) groups[g].upsides.push(r.max_upside_pct);
    if (r.max_adverse_pct != null) groups[g].adverses.push(r.max_adverse_pct);
  }
  const by_group = {};
  for (const [g, v] of Object.entries(groups)) {
    by_group[g] = {
      n: v.n, rug_events: v.rugs,
      sample_status: v.n >= MIN_SAMPLE ? 'SUFFICIENT_SAMPLE' : 'INSUFFICIENT_SAMPLE',
      median_current_ret_pct: med(v.rets), median_max_upside_pct: med(v.upsides), median_max_adverse_pct: med(v.adverses),
    };
  }
  const qualified = rows.filter(r => r.entry_state === 'QUALIFIED CANDIDATE' || r.entry_state === 'OUTCOME PENDING');
  const rejected = rows.filter(r => /REJECTED|INSUFFICIENT/.test(r.entry_state));
  return {
    generated_at: nowIso, tracked_total: rows.length,
    tracking_active: rows.filter(r => r.status === 'TRACKING').length,
    rug_events_total: rows.filter(r => r.rug_event).length,
    qualified_tracked: qualified.length, rejected_tracked: rejected.length,
    by_group, rows: rows.sort((a, b) => (b.entry_at || '').localeCompare(a.entry_at || '')).slice(0, 60),
    note: 'Paper evaluation. Entry reference = first observed price at/after first signal decision. Not advice, no trades executed.',
  };
}

// GeckoTerminal fallback: dexscreener's token endpoint 429s from Cloudflare egress (verified 2026-10-18).
export async function fetchGeckoPools(mint) {
  const r = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools`);
  if (!r.ok || !r.json || !Array.isArray(r.json.data)) return null;
  return r.json.data;
}

export function priceFromGecko(pools) {
  if (!Array.isArray(pools) || !pools.length) return null;
  const ok = pools.filter(p => p.attributes && p.attributes.base_token_price_usd);
  if (!ok.length) return null;
  const best = ok.reduce((m, p) => (parseFloat(p.attributes.reserve_in_usd || 0) > parseFloat(m.attributes.reserve_in_usd || 0) ? p : m), ok[0]);
  return { price_usd: parseFloat(best.attributes.base_token_price_usd),
           liquidity_usd: parseFloat(best.attributes.reserve_in_usd || 0),
           source: 'geckoterminal', pair: best.attributes.address || null };
}

// One cycle of price refreshes, budget-limited. Prioritizes oldest-refreshed tracked entities.
export async function runOutcomeRefresh(state, { budget = 4, subrequests = () => 0, subLimit = 40 } = {}) {
  const ids = trackedEntityIds(state);
  const byStale = ids.sort((a, b) => {
    const la = (state.outcomes[a] && state.outcomes[a].last_price_at) || '';
    const lb = (state.outcomes[b] && state.outcomes[b].last_price_at) || '';
    return la.localeCompare(lb);
  });
  let refreshed = 0, errors = 0, unavailable = 0;
  for (const id of byStale) {
    if (refreshed >= budget || subrequests() > subLimit) break;
    const ent = state.entities[id];
    try {
      let pi = null;
      const pairs = await fetchDexscreenerPairs(ent.mint);
      if (pairs !== null) pi = priceFromPairs(pairs);
      if (!pi) { // fallback: geckoterminal pools (dexscreener token endpoint blocked from CF egress)
        const pools = await fetchGeckoPools(ent.mint);
        if (pools !== null) pi = priceFromGecko(pools);
      }
      if (!pi) { unavailable++; continue; }
      updateOutcome(state, id, pi);
      refreshed++;
    } catch (e) { errors++; }
  }
  return { refreshed, errors, unavailable, tracked: ids.length };
}
