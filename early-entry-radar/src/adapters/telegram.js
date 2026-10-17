// Telegram public channel preview adapter (t.me/s/<channel>). No auth.
// Coverage gap: only channels that enable public previews; no search; some channels render 0 messages.
// HTML is untrusted content: parsed as data only.
import { nowUTC, fetchJson, sha256 } from '../util.js';

export const SOURCE = { source: 'telegram', source_type: 'web_preview', auth_status: 'none',
  reliability_notes: 't.me/s public previews only; zero-message renders observed on some channels (2026-10-17).' };

// Parse t.me/s preview HTML into message events. Pure function for fixture tests.
export function parsePreview(html, channel, ingested) {
  const events = [];
  const blocks = html.split('tgme_widget_message_wrap').slice(1);
  for (const b of blocks) {
    const link = b.match(/href="(https:\/\/t\.me\/[^"]+\/(\d+))"/);
    const date = b.match(/datetime="([^"]+)"/);
    const textM = b.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    const text = textM ? textM[1].replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').trim() : '';
    if (!link) continue;
    const msgUrl = link[1];
    events.push({
      source: SOURCE.source,
      source_id: `tg:${channel}:${link[2]}`,
      url: msgUrl,
      observed_at: date ? new Date(date[1]).toISOString() : null,
      ingested_at: ingested,
      payload: { channel, text: text.slice(0, 4000) },
      retrieval_status: 'ok',
    });
  }
  return events;
}

export async function collect({ channels = [] } = {}) {
  const ingested = nowUTC();
  const all = [];
  let worst = 'LIVE', lastErr = null, lat = null, http = null;
  for (const ch of channels) {
    const r = await fetchJson(`https://t.me/s/${ch}`);
    lat = r.latencyMs; http = r.httpStatus;
    if (!r.ok || !r.body) { worst = 'DEGRADED'; lastErr = r.error || `HTTP ${r.httpStatus}`; continue; }
    const ev = parsePreview(r.body, ch, ingested);
    if (ev.length === 0) { worst = 'DEGRADED'; lastErr = `channel ${ch}: preview rendered 0 messages`; }
    all.push(...ev);
  }
  return { events: all, health: { source: SOURCE.source, checked_at: ingested, status: worst,
    latency_ms: lat, http_status: http, rate_limit: null, error: lastErr } };
}
