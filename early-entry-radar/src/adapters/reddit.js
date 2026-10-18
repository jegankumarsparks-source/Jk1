// Reddit public RSS adapter (r/<sub>/new.rss). No auth.
// Verified 2026-10-18: .json endpoints 403 from datacenter IPs; RSS works but 429s fast
// under shared-IP load. Adapter fetches ONE feed per call and treats 429/403 as
// INTERMITTENT (honest badge), never retries in-loop. Reliable path = user's own free
// Reddit OAuth app (documented GAP until then).
import { nowUTC, fetchJson } from '../util.js';

export const SOURCE = { source: 'reddit', source_type: 'rss', auth_status: 'none',
  reliability_notes: 'public RSS; datacenter IPs 429/403 intermittently (verified 2026-10-18); expect INTERMITTENT status.' };

// Parse RSS XML into post events. Pure function for fixture tests.
export function parseRss(xml, sub, ingested) {
  const events = [];
  const items = xml.split('<entry>').slice(1);
  for (const it of items) {
    const title = (it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (it.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    const updated = (it.match(/<updated>([^<]+)<\/updated>/) || [])[1] || null;
    const idm = link.match(/comments\/([a-z0-9]+)\//i);
    if (!idm) continue;
    const clean = title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    events.push({
      source: SOURCE.source,
      source_id: `reddit:${sub}:${idm[1]}`,
      url: link,
      observed_at: updated ? new Date(updated).toISOString() : null,
      ingested_at: ingested,
      payload: { subreddit: sub, text: clean.slice(0, 2000) },
      retrieval_status: 'ok',
    });
  }
  return events;
}

export async function collect({ subreddits = ['solana'] } = {}) {
  const ingested = nowUTC();
  const all = [];
  let okCount = 0, lastErr = null, lat = null, http = null;
  for (const sub of subreddits) {
    const r = await fetchJson(`https://www.reddit.com/r/${sub}/new.rss`);
    lat = r.latencyMs; http = r.httpStatus;
    if (!r.ok || !r.body) { lastErr = r.error || `HTTP ${r.httpStatus}`; continue; }
    const ev = parseRss(r.body, sub, ingested);
    if (ev.length) okCount++; else lastErr = `r/${sub}: 0 items parsed`;
    all.push(...ev);
  }
  const status = okCount === subreddits.length ? 'LIVE' : okCount > 0 ? 'DEGRADED' : 'INTERMITTENT';
  return { events: all, health: { source: SOURCE.source, checked_at: ingested, status,
    latency_ms: lat, http_status: http, rate_limit: lastErr && /429/.test(lastErr) ? 'reddit shared-IP 429 (see GAP note)' : null, error: lastErr } };
}
