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
export async function mentionFingerprint(text) {
  const norm = (text || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return (await sha256(norm)).slice(0, 24);
}

// Ingest mentions from raw events (telegram adapter payloads). Marks duplicates by fingerprint.
export async function ingestMentions(store, events) {
  const stats = { mentions: 0, duplicates: 0 };
  for (const e of events) {
    if (e.source !== 'telegram' && e.source !== 'reddit') continue;
    const text = (e.payload && e.payload.text) || '';
    if (!text.trim()) continue;
    const fp = await mentionFingerprint(text);
    const existing = store.findMentionByFingerprint(fp);
    const isDupe = existing ? 1 : 0;
    store.insertMention({ raw_event_id: e.id, entity_id: null, author: (e.payload && e.payload.channel) || null,
      url: e.url, published_at: e.observed_at, ingested_at: e.ingested_at, category: e.source === 'reddit' ? 'community' : categorizeMention(text),
      is_duplicate: isDupe, confidence: 'low', source: e.source, text: text.slice(0, 4000), fingerprint: fp });
    stats.mentions++; if (isDupe) stats.duplicates++;
  }
  return stats;
}

// Independent sources = distinct source channels with non-duplicate mentions.

