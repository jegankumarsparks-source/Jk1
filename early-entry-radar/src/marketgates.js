// Market gates: a candidate becomes actionable only when every gate PASSes.
// Any unverifiable gate => DATA INCOMPLETE (no signal). Thresholds come from config.json
// and are configurable starting points, never presented as proven-profitable.
import { isValidMint, fetchJson } from './util.js';
import { fetchQuote } from './security.js';

const pass = (detail) => ({ result: 'PASS', detail });
const failg = (detail) => ({ result: 'FAIL', detail });
const unk = (reason) => ({ result: 'UNKNOWN', detail: { reason } });

export async function fetchDexscreenerPairs(mint) {
  const r = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (!r.ok || !r.json) return null;
  return Array.isArray(r.json.pairs) ? r.json.pairs : [];
}

export async function runMarketGates(mint, config = {}, nowMs = Date.now()) {
  const gates = {};
  gates.mint_verified = isValidMint(mint) ? pass({ mint }) : failg({ reason: 'invalid mint' });
  if (!gates.mint_verified || gates.mint_verified.result === 'FAIL') return { gates, verdict: 'DATA INCOMPLETE' };

  const pairs = await fetchDexscreenerPairs(mint);
  if (pairs === null) {
    gates.real_pool = unk('dexscreener unavailable');
    gates.fresh_data = unk('no market data');
    gates.tradable_liquidity = unk('no market data');
    gates.buy_sell_feasibility = unk('skipped: no pool');
    gates.price_impact = unk('skipped: no pool');
    return { gates, verdict: 'DATA INCOMPLETE' };
  }
  const solPairs = pairs.filter(p => p.chainId === 'solana');
  gates.real_pool = solPairs.length ? pass({ pools: solPairs.length, dexes: [...new Set(solPairs.map(p => p.dexId))].slice(0, 5) })
                                  : failg({ reason: 'no solana pool on dexscreener' });

  // freshness: pairCreatedAt / quote recency
  const newest = solPairs.reduce((m, p) => Math.max(m, p.pairCreatedAt || 0), 0);
  const ageSec = newest ? Math.round((nowMs - newest) / 1000) : null;
  gates.fresh_data = newest ? pass({ pool_age_sec: ageSec }) : unk('pool creation time missing');

  const liq = solPairs.reduce((m, p) => Math.max(m, (p.liquidity && p.liquidity.usd) || 0), 0);
  const minLiq = config.min_liquidity_usd ?? 5000;
  gates.tradable_liquidity = solPairs.length
    ? (liq >= minLiq ? pass({ max_liquidity_usd: liq, min_required: minLiq })
                     : failg({ max_liquidity_usd: liq, min_required: minLiq, note: 'configurable threshold' }))
    : unk('no pool');

  // buy + sell feasibility via jupiter quotes
  const buy = await fetchQuote('So11111111111111111111111111111111111111112', mint, config.quote_probe_sol_lamports || 100000000);
  await new Promise(r => setTimeout(r, 1200)); // lite-api 429s under burst (observed 2026-10-17)
  const sell = await fetchQuote(mint, 'So11111111111111111111111111111111111111112', config.quote_probe_token_amount || 1000000000);
  if (buy.kind === 'error' || sell.kind === 'error') {
    gates.buy_sell_feasibility = unk(`jupiter transient error (buy=${buy.kind}${buy.reason ? ':' + buy.reason : ''}, sell=${sell.kind}${sell.reason ? ':' + sell.reason : ''}) - not treated as infeasible`);
  } else if (buy.kind === 'quoted' && sell.kind === 'quoted') {
    gates.buy_sell_feasibility = pass({ buy_out: buy.quote.outAmount, sell_out: sell.quote.outAmount, note: 'quote-based, not executed' });
  } else {
    gates.buy_sell_feasibility = failg({ buy: buy.kind, sell: sell.kind, note: 'API healthy, missing route => genuine infeasibility signal' });
  }

  const maxImpact = config.max_price_impact_pct ?? 15;
  if (buy.kind === 'quoted') {
    const impact = Math.abs(parseFloat(buy.quote.priceImpactPct || '0'));
    gates.price_impact = impact <= maxImpact
      ? pass({ buy_price_impact_pct: impact, max_allowed: maxImpact })
      : failg({ buy_price_impact_pct: impact, max_allowed: maxImpact, note: 'configurable threshold' });
  } else gates.price_impact = unk(buy.kind === 'error' ? `jupiter error: ${buy.reason}` : 'no buy quote');

  let verdict = 'MARKET OK';
  for (const g of Object.values(gates)) if (g.result === 'FAIL') { verdict = 'LIQUIDITY INSUFFICIENT'; break; }
  if (verdict === 'MARKET OK') for (const g of Object.values(gates)) if (g.result === 'UNKNOWN') { verdict = 'DATA INCOMPLETE'; break; }
  return { gates, verdict };
}

export function persistGates(store, entityId, { gates }) {
  const at = new Date().toISOString();
  for (const [name, g] of Object.entries(gates)) {
    store.run(`INSERT INTO gate_results(entity_id,gate,result,detail,at) VALUES(?,?,?,?,?)`,
      entityId, name, g.result, JSON.stringify(g.detail || null), at);
  }
}
