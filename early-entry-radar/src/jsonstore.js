// JSON-backed store for the Cloudflare Worker (no SQLite in Workers). Same domain methods as sqlstore.
// State shape: { seq, sources:{}, raw_events:[], entities:{}, entity_evidence:[], mentions:[],
//   security_results:[], gate_results:[], launch_status_log:[], signal_state_log:[], source_health:[] }
export function emptyState() {
  return { seq: 0, sources: {}, raw_events: [], entities: {}, entity_evidence: [], mentions: [],
    security_results: [], gate_results: [], launch_status_log: [], signal_state_log: [], source_health: [] };
}
// Keep state bounded (free-tier friendly). Append-only logs trimmed oldest-first.
const CAPS = { raw_events: 5000, entity_evidence: 8000, mentions: 3000, security_results: 4000,
  gate_results: 4000, launch_status_log: 2000, signal_state_log: 2000, source_health: 2000 };
export function capState(s) {
  for (const [k, cap] of Object.entries(CAPS)) if (s[k] && s[k].length > cap) s[k] = s[k].slice(-cap);
  return s;
}

// Repo-backed storage must stay small (GitHub contents API caps ~1MB/file). Keep only
// the fields the pipeline and dashboard actually use.
export function slimPayload(source, p) {
  if (!p || typeof p !== 'object') return p;
  if (source === 'pumpfun') {
    const { mint, name, symbol, description, creator, created_timestamp, twitter, telegram, website, complete, bonding_curve } = p;
    return { mint, name, symbol, description: (description || '').slice(0, 280), creator, created_timestamp, twitter, telegram, website, complete, bonding_curve };
  }
  if (source === 'dexscreener') {
    const { chainId, tokenAddress, url, icon, description, links } = p;
    return { chainId, tokenAddress, url, icon, description: (description || '').slice(0, 280), links };
  }
  if (source === 'geckoterminal') {
    const a = p.attributes || {};
    return { attributes: { address: a.address, name: a.name, pool_created_at: a.pool_created_at,
      base_token_price_usd: a.base_token_price_usd, fdv_usd: a.fdv_usd, market_cap_usd: a.market_cap_usd,
      reserve_in_usd: a.reserve_in_usd, transactions: a.transactions ? { h24: a.transactions.h24 } : null },
      relationships: p.relationships ? { base_token: p.relationships.base_token } : undefined };
  }
  if (source === 'telegram') return { channel: p.channel, text: (p.text || '').slice(0, 500) };
  return p;
}

export function openJsonStore(state) {
  const s = state;
  return {
    state: s,
    registerSource(src) { if (!s.sources[src.source]) s.sources[src.source] = src; },
    recordHealth(h) { s.source_health.push(h); },
    insertRawEvent(e) {
      if (s.raw_events.some(r => r.source === e.source && r.source_id === e.source_id)) {
        const ex = s.raw_events.find(r => r.source === e.source && r.source_id === e.source_id);
        return { inserted: false, id: ex.id };
      }
      const id = ++s.seq;
      s.raw_events.push({ id, ...e, payload: slimPayload(e.source, e.payload), url: e.url ?? null, observed_at: e.observed_at ?? null, retrieval_status: e.retrieval_status || 'ok' });
      return { inserted: true, id };
    },
    upsertEntity(u) {
      const ex = s.entities[u.entity_id];
      if (!ex) { s.entities[u.entity_id] = { ...u, launch_status: 'STATUS UNKNOWN' }; return; }
      if (!ex.name && u.name) ex.name = u.name;
      if (!ex.ticker && u.ticker) ex.ticker = u.ticker;
      if (u.first_evidence_at && u.first_evidence_at < ex.first_evidence_at) ex.first_evidence_at = u.first_evidence_at;
    },
    addEvidence(entity_id, raw_event_id, field, at) {
      if (!s.entity_evidence.some(x => x.entity_id === entity_id && x.raw_event_id === raw_event_id && x.field === field))
        s.entity_evidence.push({ entity_id, raw_event_id, field, linked_at: at });
    },
    findMentionByFingerprint(fp) { return s.mentions.find(m => m.fingerprint === fp) || null; },
    insertMention(m) { s.mentions.push({ id: ++s.seq, ...m }); },
    getEntityLaunchStatus(id) { return s.entities[id] ? s.entities[id].launch_status : null; },
    setEntityLaunchStatus(id, status) { if (s.entities[id]) s.entities[id].launch_status = status; },
    logLaunchStatus(entity_id, from, to, reasons, at) { s.launch_status_log.push({ entity_id, from_status: from, to_status: to, reasons, at }); },
    latestSignalState(id) {
      const rows = s.signal_state_log.filter(r => r.entity_id === id);
      return rows.length ? rows[rows.length - 1].to_state : null;
    },
    logSignalState(r) { s.signal_state_log.push(r); },
    latestSignalStates() {
      const m = new Map();
      s.signal_state_log.forEach((r, i) => m.set(r.entity_id, { ...r, _i: i }));
      return [...m.values()];
    },
    insertSecurityResult(r) { s.security_results.push(r); },
    insertGateResult(r) { s.gate_results.push(r); },
  };
}
