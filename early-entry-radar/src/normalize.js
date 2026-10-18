// Normalization + entity resolution.
// Rules (directive):
//  - A verified Solana mint is the ONLY primary identity. Mint-bearing events attach to 'mint:<mint>'.
//  - Events without a valid mint create/attach to a provisional entity keyed by normalized
//    name+ticker+primary link. Name/ticker alone NEVER merges anything.
//  - A provisional entity is never auto-merged into a mint entity; a candidate_link row is
//    recorded (status UNVERIFIED) for later evidence-based confirmation (STEP 4/5).
import { isValidMint, extractMints, normalizeName, sha256, nowUTC } from './util.js';

async function provisionalId(name, ticker, primaryLink) {
  const key = `${normalizeName(name)}|${normalizeName(ticker)}|${normalizeName(primaryLink)}`;
  return `prov:${(await sha256(key)).slice(0, 24)}`;
}

function first(p, ...keys) { for (const k of keys) { if (p && p[k] != null && p[k] !== '') return p[k]; } return null; }

// Pull identity hints out of a raw event payload, per source shape.
export function extractIdentity(event) {
  const p = event.payload || {};
  let mint = null, name = null, ticker = null, links = [];
  if (event.source === 'pumpfun') {
    mint = p.mint; name = p.name; ticker = p.symbol;
    links = [p.website, p.twitter, p.telegram].filter(Boolean);
  } else if (event.source === 'dexscreener') {
    mint = p.tokenAddress; name = null; ticker = null;
    links = (p.links || []).map(l => l.url).filter(Boolean);
    name = first(p, 'name'); // dexscreener profiles carry no name; stays null
  } else if (event.source === 'geckoterminal') {
    const a = p.attributes || {};
    name = (a.name || '').split('/')[0].trim(); ticker = null;
    // base token address arrives via relationships in full responses; new_pools embeds it in name only.
    mint = (p.relationships && p.relationships.base_token && p.relationships.base_token.data)
      ? p.relationships.base_token.data.id.replace(/^solana_/, '') : null;
  } else if (event.source === 'telegram' || event.source === 'reddit') {
    name = null; ticker = null;
    mint = extractMints(p.text)[0] || null;
    links = (p.text.match(/https?:\/\/[^\s)]+/g) || []);
  }
  if (mint && !isValidMint(mint)) mint = null;  // invalid mint strings are never identities
  return { mint, name, ticker, links };
}

export async function resolveEntity(store, event, identity) {
  const now = nowUTC();
  let entityId;
  if (identity.mint) {
    entityId = `mint:${identity.mint}`;
    store.upsertEntity({ entity_id: entityId, kind: 'mint', mint: identity.mint, name: identity.name,
      ticker: identity.ticker, first_evidence_at: event.observed_at || event.ingested_at, created_at: now });
  } else if (identity.name || identity.ticker || identity.links.length) {
    entityId = await provisionalId(identity.name, identity.ticker, identity.links[0] || '');
    store.upsertEntity({ entity_id: entityId, kind: 'provisional', mint: null, name: identity.name,
      ticker: identity.ticker, first_evidence_at: event.observed_at || event.ingested_at, created_at: now });
  } else {
    return null; // no identity information at all: event stays unlinked, never guessed
  }
  return entityId;
}
