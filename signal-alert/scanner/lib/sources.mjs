// Live data sources (keyless). All fetches have timeouts; callers must treat throw as source outage.
const RPC=process.env.SOL_RPC||'https://solana-rpc.publicnode.com';
export const stats={rpcCalls:0,dexCalls:0,rugCalls:0,rateLimitErrors:0,errors:0};
async function j(url,opt={},t=12000,kind){
  const c=new AbortController();const to=setTimeout(()=>c.abort(),t);
  try{const r=await fetch(url,{...opt,signal:c.signal});
    if(r.status===429){stats.rateLimitErrors++;throw new Error('429 '+url.split('?')[0])}
    if(!r.ok)throw new Error(r.status+' '+url.split('?')[0]);return await r.json()}
  catch(e){stats.errors++;throw e}finally{clearTimeout(to)}
}
export async function rpc(method,params){
  stats.rpcCalls++;
  const r=await j(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},15000);
  if(r.error){if(/429|rate/i.test(JSON.stringify(r.error)))stats.rateLimitErrors++;throw new Error('rpc '+JSON.stringify(r.error).slice(0,150))}
  return r.result;
}
export const getSigs=(addr,until,limit=25)=>rpc('getSignaturesForAddress',[addr,{limit,...(until?{until}:{})}]);
export const getTx=(sig)=>rpc('getTransaction',[sig,{encoding:'jsonParsed',maxSupportedTransactionVersion:1,commitment:'confirmed'}]);
export async function dex(path){stats.dexCalls++;return j('https://api.dexscreener.com'+path,{},12000)}
export async function solUsd(){const r=await dex('/tokens/v1/solana/So11111111111111111111111111111111111111112');
  const p=r.filter(x=>x.quoteToken?.symbol==='USDC').sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0]; if(!p)throw new Error('no SOL price');return {price:+p.priceUsd,fetchedAt:Date.now()/1000,source:'dexscreener '+p.pairAddress}}
export async function rugcheck(mint){stats.rugCalls++;return j(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`,{},15000)}
export function summarizeRug(rc){
  if(!rc) return {checked:false};
  const markets=rc.markets||[];const pool=new Set();
  for(const m of markets){for(const k of [m.pubkey,m.liquidityA,m.liquidityB,m.lp?.lpMint])if(k)pool.add(k)}
  const hs=(rc.topHolders||[]).filter(h=>!pool.has(h.address)&&!pool.has(h.owner));
  const top10=hs.slice(0,10).reduce((s,h)=>s+(h.pct||0),0);
  const danger=(rc.risks||[]).filter(r=>r.level==='danger');
  return {checked:true,mintAuthority:!!rc.mintAuthority,freezeAuthority:!!rc.freezeAuthority,rugged:!!rc.rugged,
    rugDanger:danger.length>0,rugReason:danger.map(r=>r.name).join(', '),top10Pct:hs.length?+top10.toFixed(1):null,
    lpLockedPct:rc.markets?.[0]?.lp?.lpLockedPct??null,source:'rugcheck'};
}
export function marketFromPair(p){return {priceUsd:+p.priceUsd,liquidityUsd:p.liquidity?.usd,vol5m:p.volume?.m5,buys5m:p.txns?.m5?.buys,sells5m:p.txns?.m5?.sells,
  priceChange1hPct:p.priceChange?.h1,priceChange5mPct:p.priceChange?.m5,fetchedAt:Date.now()/1000,source:'dexscreener '+p.pairAddress,pair:p.pairAddress,symbol:p.baseToken?.symbol}}
