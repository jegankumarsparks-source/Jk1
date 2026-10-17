// Social evidence engine: mention categorization, duplicate/copy detection, independent-source count.
// Followers/likes are never treated as proof. Engagement metrics that a source does not expose
// stay MISSING. Coordination signals are risk indicators only - computed in STEP 5/6.
import { sha256, nowUTC } from './util.js';

// Precedence: paid disclosure and warnings first (safety), then speculation (hedged framing
// beats launch vocabulary), then announcement, criticism, endorsement. 'unknown' is valid.
const RULES = [
  ['disclosed_paid', /\b(ad|sponsored|paid promo|paid partnership|#ad|promotion)\b/i],
  ['warning', /\b(scam|rug|honeypot|fake|avoid|warning|exploit|hack)\b/i],
  ['speculation', /\b(might|could|rumou?r|heard|maybe|expect)\b/i],
  ['announcement', /\b(launch(?:es|ing)?|presale|whitelist|airdrop|mint|tge|countdown|contract address|CA:)\b/i],
  ['criticism', /\b(overrated|dump|sell|dead|ponzi|disappointed|exit)\b/i],
  ['endorsement', /\b(gem|bullish|100x|moon|buy|ape|love this|biggest)\b/i],
];

// Transparent keyword categorization. 'unknown' is a valid, honest outcome.
export function categorizeMention(text) {
  const t = text || '';
  for (const [cat, re] of RULES) if (re.test(t)) return cat;
  return 'unknown';
}

// Normalized text fingerprint for copy/repost detection.
export function mentionFingerprint(text) {
  return sha256((text || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 24);
}

// Ingest mentions from raw events (telegram adapter payloads). Marks duplicates by fingerprint.
export function ingestMentions(store, events) {
  const stats = { mentions: 0, duplicates: 0 };
  for (const e of events) {
    if (e.source !== 'telegram') continue;
    const text = (e.payload && e.payload.text) || '';
    if (!text.trim()) continue;
    const fp = mentionFingerprint(text);
    const existing = store.get(`SELECT id FROM mentions WHERE fingerprint=?`, fp);
    const isDupe = existing ? 1 : 0;
    store.run(`INSERT INTO mentions(raw_event_id,entity_id,author,url,published_at,ingested_at,category,is_duplicate,confidence,text,fingerprint)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      e.id, null, (e.payload && e.payload.channel) || null, e.url, e.observed_at, e.ingested_at,
      categorizeMention(text), isDupe, 'low', text.slice(0, 4000), fp);
    stats.mentions++; if (isDupe) stats.duplicates++;
  }
  return stats;
}

// Independent sources = distinct source channels with non-duplicate mentions.
export function independentSourceCount(store, entityId) {
  const row = store.get(`SELECT COUNT(DISTINCT author) c FROM mentions WHERE entity_id=? AND is_duplicate=0`, entityId);
  return row ? row.c : 0;
}
