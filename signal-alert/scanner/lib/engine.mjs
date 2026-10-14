import {CONFIG as C} from '../config.mjs';
// Wallet quality is DATA INCOMPLETE unless a verified history record is supplied (never fabricated).
export function walletQuality(w,hist){
  const h=hist?.[w];
  if(!h||h.trades==null) return {label:'DATA INCOMPLETE',credible:false};
  if(h.trades<10) return {label:'INSUFFICIENT SAMPLE',credible:false,trades:h.trades};
  const credible=h.earlyWinRate>=0.5&&!h.rugExposure;
  return {label:credible?'CREDIBLE':'WEAK',credible,trades:h.trades,earlyWinRate:h.earlyWinRate};
}
// Independence: wallets funded by the same funder are one cluster.
export function independentWallets(wallets,funders={}){
  const groups=new Set(); let unknown=0;
  for(const w of wallets){const f=funders[w]; if(f) groups.add(f); else {groups.add('self:'+w); unknown++;}}
  return {count:groups.size,fundingUnknown:unknown};
}
export function evaluate(cand,now=Date.now()/1000){
  const reasons=[],warns=[]; const fail=(s,r)=>({status:s,reasons:[r,...reasons],warns});
  const {buys,market,safety,solUsdAt,solUsdFetchedAt,hist,funders}=cand;
  if(!buys?.length) return fail('NOT OBSERVED','no confirmed buys');
  if(!market||market.priceUsd==null||market.liquidityUsd==null) return fail('DATA INCOMPLETE','market data missing');
  if(now-market.fetchedAt>C.minMarketFreshSec) return fail('DATA INCOMPLETE','market data stale');
  if(!solUsdFetchedAt||now-solUsdFetchedAt>C.minSolUsdFreshSec) return fail('DATA INCOMPLETE','SOL/USD price stale');
  if(!safety||safety.checked!==true) return fail('PENDING VALIDATION','safety checks not completed');
  const recent=buys.filter(b=>now-b.blockTime<=C.maxTxAgeSec);
  if(!recent.length) return fail('REJECTED','buys too old');
  const sig=recent.filter(b=>b.spentUsd>=C.minBuyUsd||(b.spentSol!=null&&b.spentSol>=C.minBuySol-1e-6));
  const wallets=[...new Set(recent.map(b=>b.signer))];
  const ind=independentWallets(wallets,funders);
  const totalUsd=recent.reduce((s,b)=>s+b.spentUsd,0);
  const cluster=ind.count>=C.minIndependentWalletsForCluster;
  if(!sig.length&&!cluster) return fail('REJECTED','no buy above threshold and no cluster');
  // safety gates (explicit reasons)
  if(safety.mintAuthority) reasons.push('mint authority not revoked');
  if(safety.freezeAuthority) reasons.push('freeze authority present');
  if(safety.rugged||safety.rugDanger) reasons.push('rug/danger flag: '+(safety.rugReason||'source flag'));
  if(safety.top10Pct!=null&&safety.top10Pct>C.maxTop10HolderPct) reasons.push(`top10 holders ${safety.top10Pct}% > ${C.maxTop10HolderPct}%`);
  if(safety.top10Pct==null) warns.push('holder concentration unknown');
  if(market.liquidityUsd<C.minLiquidityUsd) reasons.push(`liquidity $${Math.round(market.liquidityUsd)} < $${C.minLiquidityUsd}`);
  if(market.liquidityDropPct>30) reasons.push('liquidity fell >30% recently');
  if((market.vol5m??0)<C.minVol5mUsd) reasons.push('5m volume too low');
  if(market.sells5m!=null&&market.buys5m!=null&&market.sells5m>market.buys5m*2) reasons.push('sell-heavy flow');
  if(market.priceChange1hPct!=null&&market.priceChange1hPct>C.maxPriceChange1hPct) reasons.push(`already +${market.priceChange1hPct}% 1h (not early)`);
  const slip=totalUsd/Math.max(market.liquidityUsd,1)*100; // crude impact of an equal-size exit
  const exitCost=C.feePct+Math.min(slip,50);
  if(slip>C.maxSlippagePct) warns.push(`buy size ${slip.toFixed(1)}% of liquidity`);
  if(exitCost>=33) reasons.push('1.5x upside consumed by costs');
  if(reasons.length) return {status:'REJECTED',reasons,warns};
  // scoring (explainable)
  const q=wallets.map(w=>walletQuality(w,hist));
  const credible=q.filter(x=>x.credible).length;
  let score=0; const why=[];
  const add=(n,t)=>{score+=n;why.push(`+${n} ${t}`)};
  add(sig.length?20:0,'single buy above threshold'); 
  const tier=[...C.tiers].reverse().find(t=>recent.some(b=>(b.spentSol||0)>=t)); if(tier) add(5+tier/2,`buy tier >=${tier} SOL`);
  if(ind.count>=2) add(10*Math.min(ind.count,4),`${ind.count} independent wallets`);
  if(credible) add(15*Math.min(credible,2),`${credible} historically credible wallet(s)`); else warns.push('wallet history: DATA INCOMPLETE / INSUFFICIENT SAMPLE');
  if(market.buys5m&&market.sells5m!=null&&market.buys5m>market.sells5m) add(10,'buy>sell flow 5m');
  if(market.liquidityUsd>=100000) add(5,'liquidity >= $100k');
  if(ind.fundingUnknown) warns.push(`${ind.fundingUnknown} wallet funding source unverified`);
  if(score<35) return {status:'REJECTED',reasons:[`score ${score} < 35`],warns,score,why};
  return {status:'QUALIFIED',reasons:[],warns,score,why,wallets,independent:ind.count,totalUsd,topBuy:recent.slice().sort((a,b)=>b.spentUsd-a.spentUsd)[0],exitCostPct:+exitCost.toFixed(2)};
}
export function signalKey(c,ev){return c.mint+':'+ev.independent+':'+Math.floor(ev.totalUsd/500)}
