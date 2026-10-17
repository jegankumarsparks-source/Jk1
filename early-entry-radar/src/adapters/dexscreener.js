// Dexscreener public API adapter. token-profiles = newest tokens with declared links (pre/early market).
import { nowUTC, fetchJson } from '../util.js';

export const SOURCE = { source: 'dexscreener', source_type: 'api', auth_status: 'none',
  reliability_notes: 'Public API, no key. Documented ~300 req/min (not verified).' };

export async function collect() {
  const url = 'https://api.dexscreener.com/token-profiles/latest/v1';
  const r = await fetchJson(url);
  const ingested = nowUTC();
  if (!r.ok || !Array.isArray(r.json)) {
    return { events: [], health: { source: SOURCE.source, checked_at: ingested, status: 'DEGRADED',
      latency_ms: r.latencyMs, http_status: r.httpStatus, rate_limit: r.rateLimit, error: r.error || 'unexpected payload' } };
  }
  const events = r.json
    .filter(p => p.chainId === 'solana' && p.tokenAddress)
    .map(p => ({
      source: SOURCE.source,
      source_id: `profile:${p.tokenAddress}`,
      url: p.url || null,
      observed_at: null,                 // endpoint provides no per-item timestamp; honesty over invention
      ingested_at: ingested,
      payload: p,
      retrieval_status: 'ok',
    }));
  return { events, health: { source: SOURCE.source, checked_at: ingested, status: 'LIVE',
    latency_ms: r.latencyMs, http_status: r.httpStatus, rate_limit: r.rateLimit, error: null } };
}
