// JK SOCIAL RADAR - server scanner (GitHub Actions, every 5 min)
// Free keyless sources only. Never fabricates: a source that fails is marked, not faked.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });

const TG_CHANNELS = [
  ['Pumpfunpremium', 'Pumpfun Premium'],
  ['shitcoingemsalert', 'ShitCoin Gems Alert'],
  ['Solana_Pumpfun_calls', 'Solana Pumpfun Calls'],
  ['pumpfuncalls_sol', 'PumpFun Autocalls'],
  ['SeekrTrending', 'Seekr Trending'],
  ['pumpfunearlytrending', 'Pumpfun Early Trending'],
  ['spacemancallzsolana', 'Spaceman Callz'],
  ['CalebDegens', 'Caleb Degens'],
  ['eddydegen', 'Eddy Degen'],
  ['lowtaxsolana', 'Lowtax Solana'],
  ['solana_calls_memecoins', 'Eddy Calls (Solana Insider)'],
];
const CA_RE = /\b[1-9A-HJ-NP-Za-km-z]{38,44}\b/g;
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;
const MILESTONES = [1.5, 2, 3, 5, 10, 20];
const KEEP_MS = 72 * 3600e3;
const now = Date.now();

const j = async (url, opt = {}) => {
  const r = await fetch(url, { headers: { 'user-agent': 'jk-social-radar/1.0' }, signal: AbortSignal.timeout(20000), ...opt });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
const tryJ = async (url) => { try { return await j(url); } catch { return null; } };

function loadState() {
  try { return JSON.parse(readFileSync(join(ROOT, 'server', 'state.json'), 'utf8')); }
  catch { return { coins: {}, alerts: [] }; }
}
const state = loadState();
state.coins ||= {}; state.alerts ||= [];

const sources = [];   // truth panel
const coins = new Map(); // ca -> aggregated coin
const addSourceToCoin = (ca, s) => {
  const c = coins.get(ca); if (!c) return;
  if (!c.sources.some(x => x.type === s.type && x.label === s.label && x.url === s.url)) c.sources.push(s);
};

function upsertCoin(ca, patch) {
  const prev = coins.get(ca) || { ca, sources: [], firstSeen: now };
  const c = { ...prev, ...patch, sources: prev.sources };
  if (patch.sources) c.sources = patch.sources;
  coins.set(ca, c);
  return c;
}

// ---- 1. Dexscreener token profiles (coins with socials: X/TG/website pages) ----
{
  const d = await tryJ('https://api.dexscreener.com/token-profiles/latest/v1');
  const sol = Array.isArray(d) ? d.filter(x => x.chainId === 'solana') : [];
  for (const x of sol) {
    const links = Array.isArray(x.links) ? x.links : [];
    const tw = links.find(l => l.type === 'twitter')?.url || null;
    const tg = links.find(l => l.type === 'telegram')?.url || null;
    const web = links.find(l => l.label === 'Website' || l.type === 'website')?.url || null;
    const c = upsertCoin(x.tokenAddress, {
      name: x.description?.slice(0, 90) || '', icon: x.icon || null,
      twitter: tw, telegram: tg, website: web,
    });
    addSourceToCoin(x.tokenAddress, { type: 'dex', label: 'Dexscreener profile (has X/TG page)', url: x.url, time: now });
    if (tw) addSourceToCoin(x.tokenAddress, { type: 'xpage', label: 'X / Twitter page', url: tw, time: now });
  }
  sources.push({ name: 'Dexscreener token profiles', type: 'dex', status: d ? 'live' : 'offline', detail: d ? `${sol.length} Solana tokens with social pages` : 'fetch failed', updatedAt: now });
}

// ---- 2. Dexscreener boosts (paid promotion = "being promoted") ----
for (const ep of ['https://api.dexscreener.com/token-boosts/latest/v1', 'https://api.dexscreener.com/token-boosts/top/v1']) {
  const d = await tryJ(ep);
  const sol = Array.isArray(d) ? d.filter(x => x.chainId === 'solana') : [];
  for (const x of sol) {
    const links = Array.isArray(x.links) ? x.links : [];
    const c = upsertCoin(x.tokenAddress, {
      icon: x.icon || coins.get(x.tokenAddress)?.icon || null,
      boost: Math.max(x.amount || 0, coins.get(x.tokenAddress)?.boost || 0),
      twitter: links.find(l => l.type === 'twitter')?.url || coins.get(x.tokenAddress)?.twitter || null,
      telegram: links.find(l => l.type === 'telegram')?.url || coins.get(x.tokenAddress)?.telegram || null,
    });
    addSourceToCoin(x.tokenAddress, { type: 'boost', label: `Dexscreener BOOST x${x.amount ?? '?'} (paid promo)`, url: x.url, time: now, amount: x.amount ?? 0 });
  }
  sources.push({ name: ep.includes('top') ? 'Dexscreener top boosts' : 'Dexscreener latest boosts', type: 'boost', status: d ? 'live' : 'offline', detail: d ? `${sol.length} Solana tokens` : 'fetch failed', updatedAt: now });
}

// ---- 3. GeckoTerminal new pools = just launched ----
{
  const d = await tryJ('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1');
  const rows = d?.data || [];
  for (const p of rows) {
    const a = p.attributes || {};
    const rel = p.relationships?.base_token?.data?.id || '';
    const ca = rel.replace('solana_', '');
    if (!ca || ca === 'So11111111111111111111111111111111111111112') continue;
    upsertCoin(ca, {
      name: a.name?.split(' / ')[0] || coins.get(ca)?.name || '',
      launchAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
      geckoPrice: +a.base_token_price_usd || null,
      liq: +a.reserve_in_usd || null,
    });
    addSourceToCoin(ca, { type: 'launch', label: 'New pool (just launched)', url: `https://www.geckoterminal.com/solana/pools/${p.id?.replace('solana_', '')}`, time: a.pool_created_at ? Date.parse(a.pool_created_at) : now });
  }
  sources.push({ name: 'GeckoTerminal new pools', type: 'launch', status: d ? 'live' : 'offline', detail: d ? `${rows.length} newest Solana pools` : 'fetch failed', updatedAt: now });
}

// ---- 4. Telegram public channel scrape (t.me/s/ preview pages) ----
const tgMentions = []; // {ca?, ticker?, channel, label, url, time, text}
for (const [handle, label] of TG_CHANNELS) {
  let status = 'offline', detail = 'fetch failed', lastPost = null;
  try {
    const r = await fetch(`https://t.me/s/${handle}`, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) jk-social-radar/1.0' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const blocks = [...html.matchAll(/data-post="([A-Za-z0-9_]+)\/(\d+)"[\s\S]*?(?=data-post=|$)/g)];
    let msgCount = 0, caCount = 0;
    for (const b of blocks) {
      const [, ch, id] = b;
      const seg = b[0];
      const tMatch = seg.match(/datetime="([^"]+)"/);
      const time = tMatch ? Date.parse(tMatch[1]) : null;
      if (time && (!lastPost || time > lastPost)) lastPost = time;
      const txtMatch = seg.match(/js-message_text"[^>]*>([\s\S]*?)<\/div>/);
      if (!txtMatch) continue;
      msgCount++;
      const text = txtMatch[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&#0?36;/g, '$').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
      const cas = text.match(CA_RE) || [];
      const tickers = [...text.matchAll(TICKER_RE)].map(m => m[1].toUpperCase());
      if (cas.length === 0 && tickers.length === 0) continue;
      if (cas.length) caCount += cas.length;
      tgMentions.push({ cas, tickers, channel: handle, label, url: `https://t.me/${ch}/${id}`, time: time || now, text: text.slice(0, 280) });
    }
    if (msgCount > 0) {
      const ageH = lastPost ? (now - lastPost) / 3600e3 : 999;
      status = ageH < 48 ? 'live' : 'stale';
      detail = `${msgCount} recent posts, ${caCount} contract addresses, last ${ageH < 1 ? Math.round(ageH * 60) + ' min' : Math.round(ageH) + ' h'} ago`;
    } else detail = 'no readable posts';
  } catch (e) { detail = String(e.message || e); }
  sources.push({ name: `Telegram: ${label}`, type: 'telegram', status, detail, updatedAt: now, lastPost, url: `https://t.me/s/${handle}` });
}

// attach TG mentions to coins
for (const m of tgMentions) {
  for (const ca of m.cas.slice(0, 3)) {
    upsertCoin(ca, {});
    addSourceToCoin(ca, { type: 'telegram', label: `TG: ${m.label}`, url: m.url, time: m.time, text: m.text });
  }
}

// ---- 5. Enrich all CAs with Dexscreener pairs (price/mcap/symbol) ----
const cas = [...coins.keys()];
for (let i = 0; i < cas.length; i += 30) {
  const batch = cas.slice(i, i + 30);
  const d = await tryJ(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`);
  const pairs = d?.pairs || [];
  const byCa = new Map();
  for (const p of pairs) {
    if (p.chainId !== 'solana') continue;
    const ca = p.baseToken?.address;
    if (!ca) continue;
    const prev = byCa.get(ca);
    if (!prev || (+p.liquidity?.usd || 0) > (+prev.liquidity?.usd || 0)) byCa.set(ca, p);
  }
  for (const ca of batch) {
    const p = byCa.get(ca);
    const c = coins.get(ca); if (!c) continue;
    if (p) {
      c.symbol = p.baseToken?.symbol || c.symbol || null;
      c.name = c.name && c.name.length > 3 ? c.name : (p.baseToken?.name || c.name);
      c.price = +p.priceUsd || null;
      c.mcap = p.marketCap || p.fdv || c.mcap || null;
      c.liq = p.liquidity?.usd || c.liq || null;
      c.chg24 = p.priceChange?.h24 ?? null;
      c.dexUrl = p.url || `https://dexscreener.com/solana/${ca}`;
      c.pairAge = p.pairCreatedAt || null;
      c.hasPair = true;
    } else {
      c.hasPair = false;
      c.dexUrl = c.dexUrl || `https://dexscreener.com/solana/${ca}`;
    }
  }
  await new Promise(r => setTimeout(r, 350));
}

// ---- 6. Merge with state, compute alerts ----
const out = [];
for (const [ca, c] of coins) {
  const s = state.coins[ca] || {};
  const firstSeen = s.firstSeen || c.firstSeen || now;
  const firstPrice = (s.firstPriceSrc === 'dex' && s.firstPrice) ? s.firstPrice : (c.price || null);
  const fired = s.fired || [];
  const entry = {
    ...c,
    symbol: c.symbol || (c.name ? c.name.split(' ')[0].slice(0, 10).toUpperCase() : 'UNKNOWN'),
    firstSeen, firstPrice, fired,
    sourceCount: new Set(c.sources.map(x => x.type === 'telegram' ? x.label : x.type)).size,
    tgCount: c.sources.filter(x => x.type === 'telegram').length,
  };
  entry.mult = (entry.price && firstPrice) ? entry.price / firstPrice : null;
  // launch time fallback
  if (!entry.launchAt && c.pairAge) entry.launchAt = c.pairAge;
  state.coins[ca] = { firstSeen, firstPrice, firstPriceSrc: firstPrice ? 'dex' : null, fired, lastSeen: now, symbol: entry.symbol };
  // milestone alerts
  if (entry.mult) {
    for (const m of MILESTONES) {
      if (entry.mult >= m && !fired.includes(m)) {
        fired.push(m);
        state.alerts.unshift({ ca, symbol: entry.symbol, name: entry.name, icon: entry.icon, mult: m, price: entry.price, mcap: entry.mcap, time: now, dexUrl: entry.dexUrl });
      }
    }
    state.coins[ca].fired = fired;
    entry.fired = fired;
  }
  out.push(entry);
}

// prune state
for (const [ca, s] of Object.entries(state.coins)) if (now - (s.lastSeen || 0) > KEEP_MS) delete state.coins[ca];
state.alerts = state.alerts.slice(0, 80);

// sort feed: confluence first, then recency
out.sort((a, b) => (b.sourceCount - a.sourceCount) || (b.tgCount - a.tgCount) || ((b.sources.at(-1)?.time || 0) - (a.sources.at(-1)?.time || 0)));

const upcoming = out.filter(c => c.hasPair === false);
const launches = out.filter(c => c.launchAt).sort((a, b) => (b.launchAt || 0) - (a.launchAt || 0)).slice(0, 60);

// static honesty entries
sources.push({ name: 'X / Twitter big-account watch (e.g. Elon Musk)', type: 'x', status: 'offline', detail: 'No free X data source exists - X removed free API/search access. Not shown rather than faked.', updatedAt: now });
sources.push({ name: 'Discord servers', type: 'discord', status: 'offline', detail: 'No free public Discord data source - needs a bot inside each server. Not shown rather than faked.', updatedAt: now });

writeFileSync(join(DATA, 'feed.json'), JSON.stringify({ updatedAt: now, coinCount: out.length, coins: out.slice(0, 300) }));
writeFileSync(join(DATA, 'alerts.json'), JSON.stringify({ updatedAt: now, alerts: state.alerts }));
writeFileSync(join(DATA, 'launches.json'), JSON.stringify({ updatedAt: now, launches, upcoming: upcoming.slice(0, 40) }));
writeFileSync(join(DATA, 'sources.json'), JSON.stringify({ updatedAt: now, sources }));
writeFileSync(join(ROOT, 'server', 'state.json'), JSON.stringify(state));
console.log(`coins=${out.length} alerts=${state.alerts.length} upcoming=${upcoming.length} tgMentions=${tgMentions.length}`);
console.log(sources.map(s => `${s.status.toUpperCase().padEnd(7)} ${s.name}`).join('\n'));
