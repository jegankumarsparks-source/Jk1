// GeckoTerminal public API adapter: newest Solana pools (pool_created_at = launch evidence).
import { nowUTC, fetchJson } from '../util.js';

export const SOURCE = { source: 'geckoterminal', source_type: 'api', auth_status: 'none',
  reliability_notes: 'Public API, no key. Documented ~30 req/min (not verified).' };

export async function collect() {
  const url = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools';
  const r = await fetchJson(url, { headers: { accept: 'application/json' } });
  const ingested = nowUTC();
  if (!r.ok || !r.json || !Array.isArray(r.json.data)) {
    return { events: [], health: { source: SOURCE.source, checked_at: ingested, status: 'DEGRADED',
      latency_ms: r.latencyMs, http_status: r.httpStatus, rate_limit: r.rateLimit, error: r.error || 'unexpected payload' } };
  }
  const events = r.json.data.map(p => ({
    source: SOURCE.source,
    source_id: `pool:${p.attributes.address}`,
    url: `https://www.geckoterminal.com/solana/pools/${p.attributes.address}`,
    observed_at: p.attributes.pool_created_at || null,
    ingested_at: ingested,
    payload: p,
    retrieval_status: 'ok',
  }));
  return { events, health: { source: SOURCE.source, checked_at: ingested, status: 'LIVE',
    latency_ms: r.latencyMs, http_status: r.httpStatus, rate_limit: r.rateLimit, error: null } };
}
