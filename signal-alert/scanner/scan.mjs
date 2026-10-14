import {CONFIG as C} from './config.mjs';
import {Store} from './lib/store.mjs';
import {classifyTx} from './lib/classify.mjs';
import {provePumpBuy} from './lib/pump-proof.mjs';
import {fetchMintEvidence} from './lib/mint-evidence.mjs';
import {provePumpSell} from './lib/pump-sell-proof.mjs';
import {fetchExitEvidence} from './lib/exit-evidence.mjs';
import {evaluate,walletQuality} from './lib/engine.mjs';
import {formatAlert,sendTelegram} from './lib/telegram.mjs';
import * as S from './lib/sources.mjs';
const now=()=>Date.now()/1000;
const MAX_TX=+process.env.MAX_TX||40, MAX_PAIRS=+process.env.MAX_PAIRS||12;

export async function runCycle({store,deps=S,mode=process.env.MODE||'LIVE',tg={token:process.env.TG_TOKEN,chatId:process.env.TG_CHAT_ID},log=console.log,releasePolicy=process.env.RELEASE_POLICY||'STRICT'}={}){
  const t0=now(); const health=store.read('health',{});
  const st=store.read('state',{cursors:{},buys:[],watch:[],marketHistory:{}});st.marketHistory??={};st.sells??=[]; const sigs=store.read('signals',[]);
  const ledger=store.read('tg_ledger',{}); const seenTx=new Set(st.buys.map(b=>b.signature)); const rej=store.read('rejections',[]);
  const h={mode,releaseStatus:releasePolicy==='TIERED_PROVABLE'?'TIERED ALERTS - future exits and wallet independence UNVERIFIED':'OBSERVATION ONLY - signal validation incomplete',cycleStart:t0,sources:{},errors:[]};
  let sol; try{sol=await deps.solUsd();h.sources.solUsd='ok'}catch(e){h.sources.solUsd='DOWN';h.errors.push('solUsd '+e.message);store.write('health',{...health,...h,lastCycleOk:false});return {ok:false,reason:'SOL/USD unavailable - fail closed'}}
  // 1 discovery: boosted + latest profiles + top boosts (solana), then market snapshot per mint
  let mints=[];
  try{for(const p of ['/token-boosts/top/v1','/token-boosts/latest/v1','/token-profiles/latest/v1']){const r=await deps.dex(p);mints.push(...r.filter(x=>x.chainId==='solana').map(x=>x.tokenAddress))}h.sources.discovery='ok'}catch(e){h.sources.discovery='DEGRADED';h.errors.push('discovery '+e.message)}
  mints=[...new Set([...mints,...st.watch])].slice(0,60);
  const pairs={};
  try{for(let i=0;i<mints.length;i+=30){const r=await deps.dex('/tokens/v1/solana/'+mints.slice(i,i+30).join(','));for(const p of r){const m=p.baseToken.address;if(p.quoteToken?.symbol!=='SOL'&&p.quoteToken?.symbol!=='USDC')continue;if(!pairs[m]||(p.liquidity?.usd||0)>(pairs[m].liquidity?.usd||0))pairs[m]=p}}h.sources.market='ok'}catch(e){h.sources.market='DOWN';h.errors.push('market '+e.message)}
  const eligible=Object.values(pairs).filter(p=>(p.liquidity?.usd||0)>=C.minLiquidityUsd&&(p.volume?.m5||0)>0).sort((a,b)=>(b.volume?.m5||0)-(a.volume?.m5||0)).slice(0,MAX_PAIRS);
  st.watch=eligible.map(p=>p.baseToken.address);
  // 2 new transactions per pair since cursor
  let txBudget=MAX_TX,rpcFail=0,newBuys=0;
  for(const p of eligible){
    if(txBudget<=0)break;
    let list;try{list=await deps.getSigs(p.pairAddress,st.cursors[p.pairAddress],20)}catch(e){rpcFail++;h.errors.push('sigs '+e.message);continue}
    let fullyProcessed=list.length<20; // a full page may hide missed events; do not claim complete coverage
    for(const s of list.filter(s=>!s.err&&s.blockTime&&t0-s.blockTime<=C.maxTxAgeSec&&!seenTx.has(s.signature))){
      if(txBudget--<=0){fullyProcessed=false;break;}
      try{const tx=await deps.getTx(s.signature);const sellProof=provePumpSell(tx,sol.price);if(sellProof.verified)st.sells.push({...sellProof.sell,observedAt:t0});const proof=provePumpBuy(tx,sol.price);const c=proof.verified?proof.buy:classifyTx(tx,sol.price);
        if(['BUY','BUY_CANDIDATE'].includes(c.kind)&&c.mint===p.baseToken.address){st.buys.push({...c,pair:p.pairAddress,symbol:p.baseToken.symbol,observedAt:t0});seenTx.add(c.signature);newBuys++}
      }catch(e){fullyProcessed=false;rpcFail++;h.errors.push('tx '+e.message)}
    }
    if(fullyProcessed&&list.length)st.cursors[p.pairAddress]=list[0].signature;
    if(!fullyProcessed)h.errors.push('transaction coverage incomplete for '+p.pairAddress);
  }
  h.sources.rpc=rpcFail?(rpcFail>=3?'DEGRADED':'PARTIAL'):'ok';
  st.sells=[...new Map(st.sells.filter(s=>t0-s.blockTime<=3600).map(s=>[s.signature,s])).values()];
  st.buys=st.buys.filter(b=>t0-b.blockTime<=3600);
  // 3 evaluate candidates
  const byMint={};for(const b of st.buys)if(t0-b.blockTime<=C.clusterWindowSec*2)(byMint[b.mint]??=[]).push(b);
  let qualified=0;const hist=store.read('wallet_history',{});
  for(const [mint,buys] of Object.entries(byMint)){
    const p=pairs[mint];if(!p)continue;
    if(!buys.some(b=>b.spentUsd>=C.minBuyUsd||(b.spentSol||0)>=C.minBuySol-1e-6)&&new Set(buys.map(b=>b.signer)).size<C.minIndependentWalletsForCluster)continue;
    let safety={checked:false};
    try{safety=deps.summarizeRug(await deps.rugcheck(mint));h.sources.rugcheck='ok'}catch(e){h.sources.rugcheck='DOWN';h.errors.push('rugcheck '+e.message)}
    const market=deps.marketFromPair(p);
    const history=st.marketHistory[mint]||[];const previous=history.filter(x=>t0-x.t>=60&&t0-x.t<=900).at(-1);
    market.liquidityDropPct=previous?Math.max(0,(previous.liquidityUsd-market.liquidityUsd)/previous.liquidityUsd*100):null;
    if(deps.rpc)try{const mintEvidence=await fetchMintEvidence(mint,deps.rpc);safety={...safety,...mintEvidence};if(mintEvidence.unsupportedExtensions?.length){safety.checked=false;}}catch(e){h.errors.push('mint evidence unavailable');safety.authoritiesVerified=false;}
    history.push({t:t0,liquidityUsd:market.liquidityUsd});st.marketHistory[mint]=history.filter(x=>t0-x.t<=3600);
    if(releasePolicy==='TIERED_PROVABLE'){
      safety.observedSellVerified=st.sells.some(s=>s.mint===mint&&s.pair===p.pairAddress&&t0>=s.blockTime&&t0-s.blockTime<=C.clusterWindowSec);
      const biggest=buys.filter(b=>b.buyEvidence==='VERIFIED_SWAP_AND_SPEND').sort((a,b)=>b.spentUsd-a.spentUsd)[0];
      if(biggest&&safety.observedSellVerified){
        const exit=await (deps.fetchExitEvidence||fetchExitEvidence)({mint,amountRaw:biggest.proof.eventBaseRaw});
        safety.exitQuoteVerified=exit.exitQuoteVerified===true&&now()-exit.fetchedAt<=60;
        safety.exitEvidence=exit;
        const minimumUsd=Number(exit.minOutputRaw)/1e9*sol.price;
        safety.exitQuoteCostPct=100*(1-minimumUsd/(biggest.tokenAmount*market.priceUsd))+C.feePct;
      }
      if(rpcFail||h.errors.length)safety.checked=false; // partial coverage never becomes tiered qualification
    }
    const ev=evaluate({releasePolicy,buys,market,safety,solUsdFetchedAt:sol.fetchedAt,hist,funders:{}},t0);
    const key=mint+':'+ev.independent+':'+Math.floor((ev.totalUsd||0)/500);
    if(ev.status!=='QUALIFIED'){rej.push({t:t0,mint,pair:p.pairAddress,chartUrl:p.url,symbol:market.symbol,status:ev.status,reasons:ev.reasons,warns:ev.warns});continue}
    if(sigs.some(s=>s.key===key||(s.mint===mint&&t0-s.signalTime<C.dedupeWindowSec&&s.independent>=ev.independent&&ev.totalUsd<s.totalUsd*1.5)))continue; // dedupe: only materially new
    const wq=ev.wallets.map(w=>walletQuality(w,hist).label);
    const sig={schemaVersion:2,status:mode==='LIVE'?'QUALIFIED':'TEST',id:'S'+Math.floor(t0)+mint.slice(0,4),key,mode,mint,symbol:market.symbol,pair:p.pairAddress,chartUrl:p.url,signalTime:t0,refPrice:market.priceUsd,refSource:market.source,liquidityUsd:market.liquidityUsd,
      topBuy:ev.topBuy,independent:ev.independent,walletCount:ev.walletCount,tier:ev.tier,verification:ev.verification,exitEvidence:safety.exitEvidence,observedSell:safety.observedSellVerified,totalUsd:ev.totalUsd,score:ev.score,why:ev.why,warns:ev.warns,exitCostPct:ev.exitCostPct,walletQuality:[...new Set(wq)].join('/'),
      detectedAt:t0,obsLatencySec:+(t0-ev.topBuy.blockTime).toFixed(1),outcome:{status:'PENDING VALIDATION',maxUp:1,maxDown:1,hit:{},snap:{}}};
    const r=await sendTelegram({...tg,text:formatAlert(sig),key:'tg:'+key,ledger});
    sig.telegram={sent:r.sent,error:r.error||null,at:r.sent?now():null,latencySec:r.sent?+(now()-ev.topBuy.blockTime).toFixed(1):null};
    sigs.push(sig);qualified++;log('SIGNAL',sig.symbol,sig.telegram);
  }
  // 4 outcome tracking against signal reference price
  for(const s of sigs.filter(s=>s.outcome.status==='PENDING VALIDATION'&&!s.outcome.monitoringEnded&&s.mode===mode)){
    const age=(t0-s.signalTime)/60;
    try{const r=await deps.dex('/tokens/v1/solana/'+s.mint);const p=r.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
      if(!p){s.outcome.note='price unavailable';continue}
      const m=deps.marketFromPair(p);const x=m.priceUsd/s.refPrice;const execAdj=x*(1-s.exitCostPct/100);
      s.outcome.maxUp=Math.max(s.outcome.maxUp,x);s.outcome.maxDown=Math.min(s.outcome.maxDown||x,x);s.outcome.lastPrice=m.priceUsd;s.outcome.lastLiq=m.liquidityUsd;
      for(const lvl of [1.5,2,3]) if(age<=60&&x>=lvl&&!s.outcome.hit[lvl]){const exec=false;s.outcome.hit[lvl]={atMin:+age.toFixed(1),price:m.priceUsd,executableByLiquidity:exec,executionStatus:'NOT VERIFIED',exitAdjX:+execAdj.toFixed(3)}}
      for(const w of C.outcomeWindowsMin) if(age>=w&&!s.outcome.snap[w]) s.outcome.snap[w]=age-w<=1?{x:+x.toFixed(3),liq:m.liquidityUsd,observedAt:t0,actualAgeMin:age}:{status:'NOT OBSERVED',actualAgeMin:age};
      if(m.liquidityUsd<0.3*s.liquidityUsd)s.outcome.liquidityCollapse=true;
      if(age>=60){s.outcome.status='PENDING VALIDATION';s.outcome.monitoringEnded=true;s.outcome.note='Polling marks do not prove executable hits or absence of missed spikes';}
    }catch(e){h.errors.push('outcome '+e.message)}
  }
  store.write('state',st);store.write('signals',sigs);store.write('tg_ledger',ledger);store.write('rejections',rej.slice(-200));
  const hh={...h,lastScanAt:now(),lastCycleOk:!h.errors.length,cycleSec:+(now()-t0).toFixed(1),pairsWatched:eligible.length,newBuys,qualified,solUsd:sol.price,apiStats:{...S.stats},telegramConfigured:!!(tg.token&&tg.chatId)};
  store.write('health',hh);log('cycle',JSON.stringify({...hh,errors:h.errors.length}));return {ok:true,...hh};
}
if(process.argv[1].endsWith('scan.mjs')) runCycle({store:new Store(process.env.DATA_DIR||'./data')}).catch(e=>{console.error('FATAL',e.message);process.exit(1)});
