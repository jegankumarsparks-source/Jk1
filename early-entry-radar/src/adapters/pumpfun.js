// pump.fun public frontend API adapter. Source: https://frontend-api-v3.pump.fun
// No auth. Observed limit: 60 req/min (x-ratelimit headers). Data is untrusted source content.
import { nowUTC } from '../util.js';

export const SOURCE = { source: 'pumpfun', source_type: 'api', auth_status: 'none',
  reliability_notes: 'Official pump.fun frontend API, undocumented; 60 req/min observed 2026-10-17.' };

export async function collect({ limit = 20 } = {}) {
  const url = `https://frontend-api-v3.pump.fun/coins/currently-live?limit=${limit}&offset=0`;
  const { fetchJson } = await import('../util.js');
  const r = await fetchJson(url);
  const ingested = nowUTC();
  if (!r.ok || !Array.isArray(r.json)) {
    return { events: [], health: { source: SOURCE.source, checked_at: ingested, status: 'DEGRADED',
      latency_ms: r.latencyMs, http_status: r.httpStatus, rate_limit: r.rateLimit, error: r.error || 'unexpected payload' } };
  }
  const events = r.json.map(c => ({
    source: SOURCE.source,
    source_id: c.mint,                                   // mint is the provider-native unique id
    url: `https://pump.fun/coin/${c.mint}`,
    observed_at: c.created_timestamp ? new Date(c.created_timestamp).toISOString() : null,
    ingested_at: ingested,
    payload: c,
    retrieval_status: 'ok',
  }));
  return { events, health: { source: SOURCE.source, checked_at: ingested, status: 'LIVE',
    latency_ms: r.latencyMs, http_status: r.httpStatus, rate_limit: r.rateLimit, error: null } };
}
