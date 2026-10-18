// Security engine - fully independent from social/AI scoring.
// Every check returns { result: PASS|FAIL|UNKNOWN|NOT_APPLICABLE, evidence, provider, limitations, at }.
// A failed CRITICAL check blocks. UNKNOWN on a MANDATORY check blocks actionable signals.
// Nothing here ever calls a token "safe".
import { nowUTC, fetchJson, isValidMint } from './util.js';

export const CRITICAL = ['mint_authority', 'freeze_authority', 'non_transferable', 'sell_feasibility'];
export const MANDATORY = [...CRITICAL, 'holder_concentration'];

const ok = (evidence, provider, limitations = null) => ({ result: 'PASS', evidence, provider, limitations, at: nowUTC() });
const fail = (evidence, provider, limitations = null) => ({ result: 'FAIL', evidence, provider, limitations, at: nowUTC() });
const unknown = (reason, provider, limitations = null) => ({ result: 'UNKNOWN', evidence: { reason }, provider, limitations, at: nowUTC() });

export async function fetchGoPlus(mint) {
  const r = await fetchJson(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mint}`);
  if (!r.ok || !r.json || !r.json.result || !r.json.result[mint]) return null;
  return r.json.result[mint];
}
export async function fetchRugcheck(mint) {
  const r = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
  if (!r.ok || !r.json || !r.json.token) return null;
  return r.json;
}
// Jupiter quote. Three-way result (honesty fix after observing lite-api 429s under burst):
//   { kind:'quoted', quote }   - a real route exists
//   { kind:'no_route' }        - API answered fine, no route => genuine infeasibility signal
//   { kind:'error', reason }   - HTTP/rate-limit/network => UNKNOWN, never treated as infeasible
export async function fetchQuote(inputMint, outputMint, amount, slippageBps = 500) {
  const r = await fetchJson(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`);
  if (!r.ok) return { kind: 'error', reason: r.error || `HTTP ${r.httpStatus}` };
  if (!r.json || !r.json.outAmount) return { kind: 'no_route' };
  return { kind: 'quoted', quote: r.json };
}
// Solana mint account layout: [0..3] mintAuthority option tag, [4..35] authority,
// [36..43] supply, [44] decimals, [45] initialized, [46..49] freezeAuthority option, [50..81] authority.
export function parseMintAccount(base64) {
  try {
    const bin = atob(base64);
    if (bin.length < 82) return null;
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    const dv = new DataView(b.buffer);
    return {
      mint_authority_set: dv.getUint32(0, true) !== 0,
      decimals: dv.getUint8(44),
      initialized: dv.getUint8(45) !== 0,
      freeze_authority_set: dv.getUint32(46, true) !== 0,
    };
  } catch { return null; }
}
export async function fetchMintAccountPost(mint, rpc = 'https://api.mainnet-beta.solana.com') {
  try {
    const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [mint, { encoding: 'base64' }] }),
      signal: AbortSignal.timeout(20000) });
    const j = await res.json();
    const data = j && j.result && j.result.value && j.result.value.data && j.result.value.data[0];
    return data ? parseMintAccount(data) : null;
  } catch { return null; }
}

// Helius RPC (owner's free-tier key, vault 'SEWL Helius API key', approved 2026-10-18):
// unlocks getTokenLargestAccounts (blocked on free public RPCs) and reliable mint-account reads.
const heliusUrl = () => globalThis.EER_HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${globalThis.EER_HELIUS_KEY}` : null;

async function rpcPost(url, method, params) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
    const j = await res.json();
    return j && j.result !== undefined ? j.result : null;
  } catch { return null; }
}

// top-1 holder share from on-chain largest accounts. null on any failure.
export async function fetchHolderConcentrationChain(mint) {
  const url = heliusUrl(); if (!url) return null;
  const [largest, supply] = await Promise.all([
    rpcPost(url, 'getTokenLargestAccounts', [mint]),
    rpcPost(url, 'getTokenSupply', [mint])]);
  const arr = largest && largest.value; const ui = supply && supply.value && supply.value.uiAmount;
  if (!Array.isArray(arr) || !arr.length || !ui) return null;
  const top = arr[0];
  return { top_holder_pct: (top.uiAmount || 0) / ui, top_address: top.address, holder_sample: arr.length, supply: ui };
}

export async function runSecurityChecks(mint, config = {}) {
  const checks = {};
  if (!isValidMint(mint)) {
    for (const c of MANDATORY) checks[c] = fail({ reason: 'invalid mint string' }, 'local');
    return { checks, verdict: 'REJECTED' };
  }
  // Sequential with light spacing: jupiter lite-api 429s under burst (observed 2026-10-17).
  const gp = await fetchGoPlus(mint);
  const rc = await fetchRugcheck(mint);
  const acct = await fetchMintAccountPost(mint, heliusUrl() || 'https://api.mainnet-beta.solana.com');
  const sellQ = await fetchQuote(mint, 'So11111111111111111111111111111111111111112', config.quote_probe_token_amount || 1000000000);
  await new Promise(r => setTimeout(r, 1200));
  const buyQ = await fetchQuote('So11111111111111111111111111111111111111112', mint, config.quote_probe_sol_lamports || 100000000);
  const prov = 'goplus+rugcheck+solana_rpc+jupiter';

  // mint authority (cross-checked: GoPlus + on-chain parse)
  if (!gp) checks.mint_authority = unknown('goplus unavailable', prov, 'single-provider outage');
  else if (gp.mintable && gp.mintable.status === '0') {
    const chain = acct ? { onchain_mint_authority_set: acct.mint_authority_set } : { onchain: 'unavailable' };
    checks.mint_authority = acct && acct.mint_authority_set
      ? fail({ goplus_mintable: gp.mintable, ...chain, conflict: 'goplus says revoked, chain says set' }, prov)
      : ok({ goplus_mintable: gp.mintable, ...chain }, prov);
  } else checks.mint_authority = fail({ goplus_mintable: gp.mintable }, prov);

  if (!gp) checks.freeze_authority = unknown('goplus unavailable', prov);
  else if (gp.freezable && gp.freezable.status === '0') {
    const chain = acct ? { onchain_freeze_authority_set: acct.freeze_authority_set } : { onchain: 'unavailable' };
    checks.freeze_authority = acct && acct.freeze_authority_set
      ? fail({ goplus_freezable: gp.freezable, ...chain, conflict: 'goplus says revoked, chain says set' }, prov)
      : ok({ goplus_freezable: gp.freezable, ...chain }, prov);
  } else checks.freeze_authority = fail({ goplus_freezable: gp.freezable }, prov);

  if (!gp) checks.non_transferable = unknown('goplus unavailable', prov);
  else checks.non_transferable = gp.non_transferable === '1'
    ? fail({ non_transferable: gp.non_transferable }, 'goplus')
    : ok({ non_transferable: gp.non_transferable, default_account_state: gp.default_account_state, transfer_fee: gp.transfer_fee }, 'goplus',
         gp.default_account_state !== '1' ? `default_account_state=${gp.default_account_state} (frozen-by-default risk)` : null);

  // sell feasibility: a real sell route must quote successfully (honeypot proxy check).
  // no_route = FAIL (API healthy, no route). error = UNKNOWN (we cannot tell).
  if (sellQ.kind === 'no_route') checks.sell_feasibility = fail({ reason: 'jupiter: no sell route' }, 'jupiter', 'aggregator routing, not a simulated on-chain swap');
  else if (sellQ.kind === 'error') checks.sell_feasibility = unknown(`jupiter error: ${sellQ.reason}`, 'jupiter', 'transient errors are never treated as infeasibility');
  else checks.sell_feasibility = ok({ outAmount: sellQ.quote.outAmount, priceImpactPct: sellQ.quote.priceImpactPct, buy_also_quoted: buyQ.kind === 'quoted' }, 'jupiter', 'quote-based feasibility, not an executed swap');

  // holder concentration: on-chain via Helius when key present (2026-10-18+), GoPlus fallback.
  const chain = await fetchHolderConcentrationChain(mint);
  if (chain) {
    const maxTop = config.max_top_holder_pct ?? 0.30;
    const ev = { ...chain, provider_note: 'on-chain getTokenLargestAccounts via Helius free tier' };
    checks.holder_concentration = chain.top_holder_pct > maxTop
      ? fail(ev, 'helius', `threshold ${maxTop} is configurable, not a proven boundary`)
      : ok(ev, 'helius');
  } else if (!gp || !Array.isArray(gp.holders) || gp.holders.length === 0) {
    checks.holder_concentration = unknown('goplus holders unavailable', 'goplus',
      globalThis.EER_HELIUS_KEY ? 'helius call failed this cycle; goplus empty' : 'getTokenLargestAccounts blocked on free public RPC tiers (verified 2026-10-17); GoPlus is the only free holder source');
  } else {
    const top = parseFloat(gp.holders[0].percent || '0');
    const maxTop = config.max_top_holder_pct ?? 0.30;
    const bonded = gp.holders[0].tag === 'bonding_curve' || gp.holders[0].is_locked === 1;
    const ev = { top_holder_pct: top, holder_count: gp.holder_count, top_tag: gp.holders[0].tag || null, top_is_locked: gp.holders[0].is_locked };
    checks.holder_concentration = (!bonded && top > maxTop)
      ? fail(ev, 'goplus', `threshold ${maxTop} is configurable, not a proven boundary`)
      : ok(ev, 'goplus');
  }

  // rugcheck aggregate (advisory, never critical on its own; records flags)
  if (!rc) checks.rugcheck_flags = unknown('rugcheck unavailable', 'rugcheck');
  else {
    const risks = (rc.risks || []).map(r => r.name);
    checks.rugcheck_flags = { result: risks.length ? 'FAIL' : 'PASS', evidence: { score: rc.score, risks: risks.slice(0, 10) }, provider: 'rugcheck', limitations: 'advisory aggregate; individual checks above govern', at: nowUTC() };
  }

  return { checks, verdict: verdictFromChecks(checks) };
}

// Single source of truth for verdicts: only CRITICAL FAILs reject; MANDATORY UNKNOWNs => INCOMPLETE.
// Advisory checks (rugcheck_flags etc.) never reject on their own.
export function verdictFromChecks(checks) {
  let verdict = 'PASS_WITH_FINDINGS';
  for (const c of CRITICAL) if (checks[c] && checks[c].result === 'FAIL') verdict = 'REJECTED';
  if (verdict !== 'REJECTED') for (const m of MANDATORY) if (!checks[m] || checks[m].result === 'UNKNOWN') verdict = 'INCOMPLETE';
  return verdict;
}

// Rebuild a verdict from stored check rows (worker cache path). Rows newest-first win per check.
export function verdictFromRows(rows) {
  const checks = {};
  for (const r of rows) if (!(r.check_name in checks)) checks[r.check_name] = { result: r.result };
  return verdictFromChecks(checks);
}

export function persistSecurity(store, entityId, { checks, verdict }) {
  const at = new Date().toISOString();
  for (const [name, c] of Object.entries(checks)) {
    store.insertSecurityResult({ entity_id: entityId, check_name: name, result: c.result,
      evidence: JSON.stringify(c.evidence || null), provider: c.provider || null, limitations: c.limitations || null, at: c.at || at });
  }
  store.insertSecurityResult({ entity_id: entityId, check_name: '_verdict', result: verdict, evidence: null, provider: 'engine', limitations: null, at });
  return verdict;
}
