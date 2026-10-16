/* GENERATED from solana-radar/index.html engine section (verbatim) — run build-bundle.mjs to refresh. sha256 9e111e30ac0b79ccde1269c58e1e51c1d3e1a154c2620f2e5eb8fe07ccc6e623 */
export const ENGINE_HASH="9e111e30ac0b79ccde1269c58e1e51c1d3e1a154c2620f2e5eb8fe07ccc6e623";
const BUILD_MARKER='JK-SR-MAX-V1';
const APP_VERSION='1.7.1';
const SCORE_VERSION='score-v1.0';
const RISK_POLICY_VERSION='risk-v1.0';
const THRESHOLDS_VERSION='thresh-v1.0';
const SCHEMA_VERSION=2;

/* ---------- tiny utils ---------- */
const U={
  now:()=>Date.now(),
  fmt$(n){ if(n==null||isNaN(n))return '—'; const a=Math.abs(n);
    if(a>=1e9)return '$'+(n/1e9).toFixed(2)+'B'; if(a>=1e6)return '$'+(n/1e6).toFixed(2)+'M';
    if(a>=1e3)return '$'+(n/1e3).toFixed(1)+'k'; if(a>=1)return '$'+n.toFixed(2);
    if(a===0)return '$0'; return '$'+n.toPrecision(3); },
  fmtN(n){ if(n==null||isNaN(n))return '—'; const a=Math.abs(n);
    if(a>=1e9)return (n/1e9).toFixed(2)+'B'; if(a>=1e6)return (n/1e6).toFixed(2)+'M';
    if(a>=1e3)return (n/1e3).toFixed(1)+'k'; return String(Math.round(n*100)/100); },
  fmtPct(n){ return (n==null||isNaN(n))?'—':(n>=0?'+':'')+n.toFixed(1)+'%'; },
  age(ts){ if(!ts)return '—'; let s=Math.max(0,(U.now()-ts)/1000);
    if(s<60)return Math.floor(s)+'s'; if(s<3600)return Math.floor(s/60)+'m';
    if(s<86400)return Math.floor(s/3600)+'h '+(Math.floor(s/60)%60)+'m'; return Math.floor(s/86400)+'d'; },
  short(a){ return a?a.slice(0,4)+'…'+a.slice(-4):'—'; },
  esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); },
  uid(p){ return (p||'id')+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8); },
  clamp(n,a,b){ return Math.max(a,Math.min(b,n)); },
  toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.style.display='block';
    clearTimeout(t._h); t._h=setTimeout(()=>t.style.display='none',2400); }
};

/* ============================================================
   A. AppState — central store, settings, event bus, scan guard
   ============================================================ */
const DEFAULT_SETTINGS={
  pollIntervalSec:10,
  maxTokensPerCycle:12,
  maxRugcheckPerCycle:6,
  walletResearchPerCandidate:5,
  minLiquidityUsd:5000,
  minVolume24Usd:2000,
  scoreThreshold:55,
  minQualifiedWallets:1,
  criticalUnknownBlocks:true,
  signalCooldownHours:6,
  clusterWindowMin:120,
  top10ConcentrationFailPct:60,
  startCapital:200,
  entrySizeUsd:20,
  maxPositionPct:10,
  maxOpenPositions:5,
  feePct:0.5,
  slippagePct:1.0,
  stopLossPct:-35,
  trailingAfterX:2,
  trailingDropPct:40,
  maxHoldHours:72,
  liquidityExitPct:50,
  targetEquity:400,
  weights:{liquidity:20,activity:15,earlyWallets:20,clusters:15,distribution:15,marketBehavior:15},
  autoRefreshPrices:true,
  autoStartOnLoad:true,
  autoTradeEnabled:true,
  autoMaxPositions:6,
  rugLiquidityUsd:500,
  rugLiquidityDropPct:90
};
class AppState{
  constructor(){
    this.settings=JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.candidates=new Map();      // mint -> candidate
    this.wallets=new Map();         // address -> wallet record
    this.clusters=new Map();        // id -> cluster
    this.signals=new Map();         // id -> signal
    this.positions=new Map();       // id -> position (open+closed)
    this.trades=[];                 // trade events
    this.scoreHistory=[];           // score snapshots
    this.diag={scans:0,lastScanStart:null,lastScanEnd:null,lastScanOk:null,scanning:false,
      counters:{discovered:0,validated:0,rejected:0,incomplete:0,signals:0},
      rejectReasons:{},storage:'unknown',idbAvailable:false};
    this.listeners={};
    this.scanTimer=null; this.priceTimer=null;
    this.targetReached=false; this.cycleFrozen=false;
    this.ui={page:'overview',radarFilter:'all',radarSort:'score',radarSearch:'',radarPage:0,walletSearch:'',signalFilter:'all'};
  }
  on(evt,fn){ (this.listeners[evt]=this.listeners[evt]||[]).push(fn); }
  emit(evt,data){ (this.listeners[evt]||[]).forEach(fn=>{try{fn(data);}catch(e){console.error('listener',e);}}); }
  weightsValid(){ const w=this.settings.weights; const s=Object.values(w).reduce((a,b)=>a+(+b||0),0); return s===100; }
}
const S=new AppState();

/* ============================================================
   B. DataSourceRegistry — sources, health, fetch w/ timeout,
      backoff, dedupe, in-flight cancel, honest states
   ============================================================ */
class DataSourceRegistry{
  constructor(){ this.sources={}; this.inflight=new Map(); }
  register(id,cfg){ this.sources[id]={id,label:cfg.label||id,kind:cfg.kind||'rest',
    status:'NOT_OBSERVED',lastSuccess:null,lastError:null,errorCount:0,timeoutCount:0,rateLimitCount:0,
    requestCount:0,note:cfg.note||'',backoffUntil:0}; }
  get(id){ return this.sources[id]; }
  all(){ return Object.values(this.sources); }
  markOk(id){ const s=this.sources[id]; if(!s)return; s.status='LIVE'; s.lastSuccess=U.now(); s.lastError=null; }
  markErr(id,err,kind){ const s=this.sources[id]; if(!s)return; s.errorCount++; s.lastError=String(err).slice(0,160);
    if(kind==='timeout')s.timeoutCount++; if(kind==='ratelimit'){s.rateLimitCount++; s.backoffUntil=U.now()+60000;}
    s.status=(s.errorCount>2)?'ERROR':'DEGRADED'; }
  /* fetchJSON with timeout, abort, rate-limit backoff, dedupe of identical in-flight GETs */
  async fetchJSON(sourceId,url,opts={}){
    const s=this.sources[sourceId];
    if(s&&s.backoffUntil>U.now()) throw Object.assign(new Error('source in rate-limit backoff'),{kind:'ratelimit'});
    const key=url+JSON.stringify(opts.body||'');
    if(!opts.body&&this.inflight.has(key)) return this.inflight.get(key);
    const p=this._doFetch(sourceId,url,opts).finally(()=>this.inflight.delete(key));
    if(!opts.body)this.inflight.set(key,p);
    return p;
  }
  async _doFetch(sourceId,url,opts){
    const timeoutMs=opts.timeoutMs||12000; const retries=opts.retries==null?1:opts.retries;
    let lastErr=null;
    for(let attempt=0;attempt<=retries;attempt++){
      const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(),timeoutMs);
      try{
        const s=this.sources[sourceId]; if(s)s.requestCount++;
        const res=await fetch(url,{method:opts.method||(opts.body?'POST':'GET'),
          headers:opts.body?{'Content-Type':'application/json'}:undefined,
          body:opts.body?JSON.stringify(opts.body):undefined,signal:ctl.signal});
        clearTimeout(to);
        if(res.status===429||res.status===403){
          lastErr=Object.assign(new Error('HTTP '+res.status),{kind:'ratelimit'});
          if(attempt<retries){await new Promise(r=>setTimeout(r,4000+attempt*2000));continue;}
          throw lastErr;
        }
        if(!res.ok) throw new Error('HTTP '+res.status);
        const data=await res.json();
        this.markOk(sourceId);
        return {data,fetchedAt:U.now(),url};
      }catch(e){
        clearTimeout(to);
        if(e.name==='AbortError'){ lastErr=Object.assign(new Error('timeout after '+timeoutMs+'ms'),{kind:'timeout'}); }
        else if(!e.kind){ lastErr=e; } else lastErr=e;
        if(attempt<retries){ await new Promise(r=>setTimeout(r,3500+attempt*2500)); continue; }
      }
    }
    this.markErr(sourceId,lastErr&&lastErr.message||'unknown',lastErr&&lastErr.kind);
    throw lastErr||new Error('fetch failed');
  }
}
const REG=new DataSourceRegistry();
REG.register('dexscreener',{label:'Dexscreener (public, keyless)',note:'REST market feed — not a complete historical on-chain feed. Rate limits apply.'});
REG.register('rugcheck',{label:'RugCheck (public, keyless)',note:'Token risk report: authorities, holders, liquidity. topHolders may be null on mega-caps.'});
REG.register('solanarpc',{label:'Solana JSON-RPC (PublicNode)',note:'Keyless public RPC. Browser polling is not a backend indexer or persistent WebSocket.'});

/* ============================================================
   C. SolanaRpcAdapter — JSON-RPC via keyless endpoints
   ============================================================ */
class SolanaRpcAdapter{
  constructor(){ this.endpoints=['https://solana-rpc.publicnode.com','https://api.mainnet-beta.solana.com']; this.ep=0; }
  async call(method,params,opts={}){
    const body={jsonrpc:'2.0',id:1,method,params};
    let lastErr=null;
    for(let e=0;e<this.endpoints.length;e++){
      const url=this.endpoints[(this.ep+e)%this.endpoints.length];
      try{
        const r=await REG.fetchJSON('solanarpc',url,{body,timeoutMs:15000,retries:opts.retries==null?1:opts.retries});
        if(r.data&&r.data.error) throw new Error('RPC error: '+(r.data.error.message||JSON.stringify(r.data.error)).slice(0,120));
        return {result:r.data?r.data.result:null,fetchedAt:r.fetchedAt,url};
      }catch(err){ lastErr=err; }
    }
    throw lastErr||new Error('all RPC endpoints failed');
  }
  async getSignaturesForAddress(addr,limit=25){
    try{ const r=await this.call('getSignaturesForAddress',[addr,{limit}]);
      return {signatures:Array.isArray(r.result)?r.result:[],fetchedAt:r.fetchedAt,supported:true};
    }catch(e){ return {signatures:null,fetchedAt:U.now(),supported:false,error:String(e.message||e).slice(0,120)}; }
  }
  async getBalance(addr){
    try{ const r=await this.call('getBalance',[addr]);
      return {lamports:r.result&&r.result.value!=null?r.result.value:null,fetchedAt:r.fetchedAt,supported:true};
    }catch(e){ return {lamports:null,fetchedAt:U.now(),supported:false,error:String(e.message||e).slice(0,120)}; }
  }
}
const RPC=new SolanaRpcAdapter();

/* ============================================================
   D. DexDataAdapter — Dexscreener + RugCheck normalization
   ============================================================ */
class DexDataAdapter{
  /* --- Dexscreener: latest token profiles (new tokens across chains) --- */
  async latestProfiles(){
    const r=await REG.fetchJSON('dexscreener','https://api.dexscreener.com/token-profiles/latest/v1',{timeoutMs:12000,retries:1});
    const arr=Array.isArray(r.data)?r.data:[];
    return {items:arr.filter(x=>x&&x.chainId==='solana'&&x.tokenAddress),fetchedAt:r.fetchedAt};
  }
  /* --- Dexscreener: latest boosted tokens (activity feed) --- */
  async latestBoosts(){
    const r=await REG.fetchJSON('dexscreener','https://api.dexscreener.com/token-boosts/latest/v1',{timeoutMs:12000,retries:1});
    const arr=Array.isArray(r.data)?r.data:[];
    return {items:arr.filter(x=>x&&x.chainId==='solana'&&x.tokenAddress),fetchedAt:r.fetchedAt};
  }
  /* --- Dexscreener: full pair data for one mint --- */
  async tokenPairs(mint){
    const r=await REG.fetchJSON('dexscreener','https://api.dexscreener.com/latest/dex/tokens/'+encodeURIComponent(mint),{timeoutMs:12000,retries:1});
    const pairs=r.data&&Array.isArray(r.data.pairs)?r.data.pairs:[];
    const sol=pairs.filter(p=>p&&p.chainId==='solana');
    return {pairs:sol,fetchedAt:r.fetchedAt};
  }
  /* pick best (highest-liquidity) Solana pair */
  bestPair(pairs){
    if(!pairs||!pairs.length)return null;
    return pairs.slice().sort((a,b)=>((b.liquidity&&b.liquidity.usd)||0)-((a.liquidity&&a.liquidity.usd)||0))[0];
  }
  /* normalize a Dexscreener pair into our candidate market fields */
  normalizePair(p){
    if(!p)return null;
    return {
      pairAddress:p.pairAddress||null, dexId:p.dexId||null,
      symbol:(p.baseToken&&p.baseToken.symbol)||null, name:(p.baseToken&&p.baseToken.name)||null,
      quoteSymbol:(p.quoteToken&&p.quoteToken.symbol)||null,
      priceUsd:p.priceUsd!=null?parseFloat(p.priceUsd):null,
      priceNative:p.priceNative!=null?parseFloat(p.priceNative):null,
      liquidityUsd:(p.liquidity&&p.liquidity.usd!=null)?p.liquidity.usd:null,
      liquidityBase:(p.liquidity&&p.liquidity.base!=null)?p.liquidity.base:null,
      liquidityQuote:(p.liquidity&&p.liquidity.quote!=null)?p.liquidity.quote:null,
      mcap:(p.marketCap!=null)?p.marketCap:null, fdv:(p.fdv!=null)?p.fdv:null,
      volume:{m5:(p.volume&&p.volume.m5!=null)?p.volume.m5:null,h1:(p.volume&&p.volume.h1!=null)?p.volume.h1:null,
        h6:(p.volume&&p.volume.h6!=null)?p.volume.h6:null,h24:(p.volume&&p.volume.h24!=null)?p.volume.h24:null},
      priceChange:{m5:(p.priceChange&&p.priceChange.m5!=null)?p.priceChange.m5:null,h1:(p.priceChange&&p.priceChange.h1!=null)?p.priceChange.h1:null,
        h6:(p.priceChange&&p.priceChange.h6!=null)?p.priceChange.h6:null,h24:(p.priceChange&&p.priceChange.h24!=null)?p.priceChange.h24:null},
      txns:{m5:this._tx(p.txns&&p.txns.m5),h1:this._tx(p.txns&&p.txns.h1),h6:this._tx(p.txns&&p.txns.h6),h24:this._tx(p.txns&&p.txns.h24)},
      pairCreatedAt:p.pairCreatedAt||null,
      source:'dexscreener',observedAt:U.now(),
      // methodology labels (honesty)
      mcapMethod:'marketCap as reported by Dexscreener (circulating assumption by source — not independently verified)',
      fdvMethod:'FDV = price x total supply as reported by Dexscreener',
      uniqueTraders:'NOT_SUPPORTED — Dexscreener public feed gives aggregate buys/sells only, not unique traders'
    };
  }
  _tx(t){ return t?{buys:t.buys!=null?t.buys:null,sells:t.sells!=null?t.sells:null}:{buys:null,sells:null}; }
  /* --- RugCheck report --- */
  async rugcheckReport(mint){
    const r=await REG.fetchJSON('rugcheck','https://api.rugcheck.xyz/v1/tokens/'+encodeURIComponent(mint)+'/report',{timeoutMs:15000,retries:1});
    const d=r.data||{};
    return {
      mint,
      mintAuthority:(d.token&&'mintAuthority'in d.token)?d.token.mintAuthority:undefined,
      freezeAuthority:(d.token&&'freezeAuthority'in d.token)?d.token.freezeAuthority:undefined,
      mutable:(d.tokenMeta&&'mutable'in d.tokenMeta)?d.tokenMeta.mutable:undefined,
      supply:(d.token&&d.token.supply!=null)?d.token.supply:null,
      decimals:(d.token&&d.token.decimals!=null)?d.token.decimals:null,
      topHolders:Array.isArray(d.topHolders)?d.topHolders.slice(0,25).map(h=>({address:h.address||null,pct:h.pct!=null?h.pct:null,insider:!!h.insider,uiAmount:h.uiAmount!=null?h.uiAmount:null})):null,
      totalMarketLiquidity:d.totalMarketLiquidity!=null?d.totalMarketLiquidity:null,
      score:d.score!=null?d.score:null,
      risks:Array.isArray(d.risks)?d.risks.map(x=>({name:x.name||'unknown',level:x.level||'info',description:x.description||''})) : [],
      rugged:!!d.rugged,
      markets:Array.isArray(d.markets)?d.markets.length:null,
      fetchedAt:r.fetchedAt,source:'rugcheck'
    };
  }
}
const DEX=new DexDataAdapter();

/* ============================================================
   E. TokenDiscoveryEngine — discovery pipeline, dedupe, snapshots
   ============================================================ */
class TokenDiscoveryEngine{
  constructor(){ this.seenQueue=[]; }
  /* One discovery cycle. Never overlaps (guarded by AppState.diag.scanning). */
  async runCycle(){
    if(S.diag.scanning){ console.log('scan already running — skip overlap'); return {skipped:true}; }
    S.diag.scanning=true; S.diag.lastScanStart=U.now(); S.emit('scanState');
    const errors=[]; let newMints=[];
    try{
      // 1) gather candidate mints from two feeds
      let feedItems=[];
      try{ const pr=await DEX.latestProfiles(); feedItems=feedItems.concat(pr.items.map(x=>({mint:x.tokenAddress,feed:'profiles',feedAt:pr.fetchedAt}))); }
      catch(e){ errors.push('profiles: '+(e.message||e)); }
      try{ const bo=await DEX.latestBoosts(); feedItems=feedItems.concat(bo.items.map(x=>({mint:x.tokenAddress,feed:'boosts',feedAt:bo.fetchedAt}))); }
      catch(e){ errors.push('boosts: '+(e.message||e)); }
      // dedupe by mint, keep both feed tags
      const byMint=new Map();
      for(const it of feedItems){ if(!byMint.has(it.mint))byMint.set(it.mint,it); else byMint.get(it.mint).feed+='+'+it.feed; }
      // 2) enrich a bounded number with pair data (bounded concurrency 2)
      const mints=[...byMint.keys()];
      const fresh=mints.filter(m=>!S.candidates.has(m));
      const stale=mints.filter(m=>S.candidates.has(m)&&(U.now()-(S.candidates.get(m).market?.observedAt||0))>S.settings.pollIntervalSec*1000);
      const toFetch=fresh.concat(stale).slice(0,S.settings.maxTokensPerCycle);
      for(let i=0;i<toFetch.length;i+=2){
        const batch=toFetch.slice(i,i+2);
        await Promise.all(batch.map(async m=>{
          try{
            const tp=await DEX.tokenPairs(m);
            const best=DEX.bestPair(tp.pairs);
            if(!best){ this._touch(m,byMint.get(m),null,'NO_SOLANA_PAIR'); return; }
            const norm=DEX.normalizePair(best);
            this._touch(m,byMint.get(m),norm,null);
            if(!S.candidates.get(m)._counted){ S.candidates.get(m)._counted=true; S.diag.counters.discovered++; }
          }catch(e){ errors.push('pairs '+U.short(m)+': '+(e.message||e)); this._touchError(m,byMint.get(m),e); }
        }));
      }
      newMints=fresh;
      S.diag.lastScanOk=true;
    }catch(e){ S.diag.lastScanOk=false; errors.push('cycle: '+(e.message||e)); }
    S.diag.scans++; S.diag.lastScanEnd=U.now(); S.diag.scanning=false;
    S.emit('scanState'); S.emit('data');
    return {errors,newMintsCount:newMints.length};
  }
  _touch(mint,feedInfo,norm,noPairReason){
    const t=U.now();
    let c=S.candidates.get(mint);
    if(!c){
      c={mint,firstObserved:t,launchTime:null,launchTimeNote:'first-seen time is our observation, NOT a verified launch time',
        ageConfidence:'LOW — based on first observation + pairCreatedAt when available',
        feeds:[],state:'DISCOVERED',stateHistory:[{state:'DISCOVERED',at:t,reason:'first seen in '+((feedInfo&&feedInfo.feed)||'feed')}],
        market:null,rugcheck:null,walletEvidence:[],risk:null,score:null,qualification:null,
        rejectionReasons:[],cooldownUntil:0,signalId:null,_counted:false,fieldMeta:{}};
      S.candidates.set(mint,c);
    }
    if(feedInfo&&!c.feeds.includes(feedInfo.feed))c.feeds.push(feedInfo.feed);
    if(norm){
      c.market=norm;
      c.fieldMeta.market={source:'dexscreener',observedAt:norm.observedAt,status:'LIVE'};
      if(norm.pairCreatedAt){ c.pairCreatedAt=norm.pairCreatedAt;
        c.ageConfidence='MEDIUM — pairCreatedAt from Dexscreener (pool creation, may differ from token launch)'; }
      c.lastError=null;
    }
    if(noPairReason){ c.noPairReason=noPairReason; }
    c.updatedAt=t;
  }
  _touchError(mint,feedInfo,e){
    let c=S.candidates.get(mint);
    if(!c){ this._touch(mint,feedInfo,null,null); c=S.candidates.get(mint); }
    c.lastError=String(e.message||e).slice(0,140);
    c.fieldMeta.market={source:'dexscreener',observedAt:U.now(),status:'ERROR'};
  }
  /* manual refresh of one candidate */
  async refreshCandidate(mint){
    const tp=await DEX.tokenPairs(mint);
    const best=DEX.bestPair(tp.pairs);
    if(!best)throw new Error('no Solana pair found');
    this._touch(mint,null,DEX.normalizePair(best),null);
    S.emit('data');
  }
  /* refresh prices for open positions only (cheap, 1 call per mint) */
  async refreshPricesFor(mints){
    const out={};
    for(const m of mints){
      try{ const tp=await DEX.tokenPairs(m); const best=DEX.bestPair(tp.pairs);
        if(best){ out[m]={priceUsd:best.priceUsd!=null?parseFloat(best.priceUsd):null,
          liquidityUsd:(best.liquidity&&best.liquidity.usd!=null)?best.liquidity.usd:null,observedAt:U.now(),ok:true};
          const c=S.candidates.get(m); if(c)this._touch(m,null,DEX.normalizePair(best),null); }
        else out[m]={ok:false,error:'no pair'};
      }catch(e){ out[m]={ok:false,error:String(e.message||e).slice(0,100)}; }
    }
    return out;
  }
}
const DISCOVERY=new TokenDiscoveryEngine();

/* ============================================================
   F. TokenValidationEngine — identity + freshness validation
   ============================================================ */
class TokenValidationEngine{
  validate(c){
    const problems=[]; const checks=[];
    const fresh=c.market&&(U.now()-c.market.observedAt)<3*S.settings.pollIntervalSec*1000;
    checks.push({name:'Token+pool identity (mint & pair present)',ok:!!(c.mint&&c.market&&c.market.pairAddress),critical:true});
    checks.push({name:'Market data fresh (<3 poll cycles)',ok:!!fresh,critical:true});
    checks.push({name:'Liquidity field present (not null)',ok:c.market&&c.market.liquidityUsd!=null,critical:false});
    checks.push({name:'Price field present',ok:c.market&&c.market.priceUsd!=null,critical:true});
    const failed=checks.filter(x=>!x.ok);
    const critFail=failed.filter(x=>x.critical);
    let status;
    if(!c.market){ status='DATA_INCOMPLETE'; problems.push('no market data (source failure or no Solana pair)'); }
    else if(critFail.length){ status='DATA_INCOMPLETE'; problems.push(...critFail.map(x=>x.name)); }
    else status='VALIDATED';
    return {status,checks,problems,validatedAt:U.now()};
  }
}
const VALIDATOR=new TokenValidationEngine();

/* ============================================================
   G. WalletResearchEngine — wallet records, honest evidence states
   ============================================================ */
class WalletResearchEngine{
  /* harvest candidate wallets from a token's rugcheck topHolders */
  harvestFromToken(c){
    if(!c.rugcheck||!Array.isArray(c.rugcheck.topHolders))return {added:0,reason:'topHolders NOT_SUPPORTED or null for this token'};
    let added=0; const t=U.now();
    for(const h of c.rugcheck.topHolders.slice(0,12)){
      if(!h.address)continue;
      let w=S.wallets.get(h.address);
      if(!w){
        w={address:h.address,firstObserved:t,state:'UNVERIFIED',
          observations:[],tokensSeen:[],qualityScore:null,qualityNote:'score requires enough verified observations',
          realizedPnl:null,realizedPnlNote:'NOT_SUPPORTED — realized PnL needs full tx + cost-basis reconstruction (indexer), not available in this single file',
          unrealizedNote:'estimated from current holder share only — not a trade result',
          dataGaps:['full trade history (needs indexer)','funding sources (needs indexer)'],
          sigCount:null,lastSigAt:null,insiderFlags:0};
        S.wallets.set(h.address,w);
      }
      if(!w.tokensSeen.includes(c.mint)){ w.tokensSeen.push(c.mint); }
      w.observations.push({t,mint:c.mint,pct:h.pct,insider:h.insider,source:'rugcheck'});
      if(w.observations.length>200)w.observations=w.observations.slice(-200);
      if(h.insider)w.insiderFlags++;
      added++;
    }
    return {added};
  }
  /* research one wallet deeper via RPC signatures (bounded) */
  async researchWallet(addr){
    const w=S.wallets.get(addr); if(!w)return null;
    const sig=await RPC.getSignaturesForAddress(addr,25);
    if(!sig.supported){ w.state='DATA_INCOMPLETE'; w.dataGaps.push('RPC signature fetch failed: '+(sig.error||'')); w.lastResearchAt=U.now(); return w; }
    w.sigCount=sig.signatures.length;
    w.lastSigAt=sig.signatures.length?sig.signatures[0].blockTime*1000:null;
    if(w.sigCount<5) w.state='INSUFFICIENT_SAMPLE';
    else w.state='LIMITED_HISTORY'; // honest ceiling: we cannot fully reconstruct trades in-browser
    w.qualityScore=this._quality(w);
    w.lastResearchAt=U.now();
    return w;
  }
  _quality(w){
    // quality score only with enough evidence; 0-100 conservative
    if(w.state==='INSUFFICIENT_SAMPLE'||w.state==='DATA_INCOMPLETE'||w.state==='UNVERIFIED')return null;
    let q=30;
    q+=Math.min(30,(w.tokensSeen.length-1)*10);
    q+=Math.min(20,Math.floor((w.sigCount||0)/5)*2);
    q-=Math.min(30,w.insiderFlags*15);
    return U.clamp(q,0,100);
  }
  isQualified(w){
    // qualified = enough evidence to count as an independent observation (not "smart money")
    return w&&(w.state==='LIMITED_HISTORY'||w.state==='VERIFIED_HISTORY')&&w.insiderFlags===0&&(w.qualityScore==null||w.qualityScore>=20);
  }
}
const WALLETS=new WalletResearchEngine();

/* ============================================================
   H. WalletClusterEngine — observable correlated activity
   ============================================================ */
class WalletClusterEngine{
  recompute(){
    S.clusters.clear();
    const windowMs=S.settings.clusterWindowMin*60000;
    // map wallet -> tokens it appears on (from observations)
    for(const w of S.wallets.values()){
      if(w.tokensSeen.length<2)continue;
      // group this wallet's observations per token
      for(const mint of w.tokensSeen){
        const obs=w.observations.filter(o=>o.mint===mint); if(!obs.length)continue;
        const key=mint;
        let cl=S.clusters.get(key);
        if(!cl){ cl={id:'cl_'+key.slice(0,8),mint:key,wallets:new Set(),firstAt:obs[0].t,lastAt:obs[0].t,
          confidence:'LOW',reasons:[],fundingNote:'common funding detection: NOT_SUPPORTED — requires indexer across funding transactions',
          independenceNote:'correlated activity observed; common ownership NOT proven and NOT assumed'};
          S.clusters.set(key,cl); }
        cl.wallets.add(w.address);
        cl.firstAt=Math.min(cl.firstAt,obs[0].t); cl.lastAt=Math.max(cl.lastAt,obs[obs.length-1].t);
      }
    }
    // finalize
    for(const cl of S.clusters.values()){
      cl.rawCount=cl.wallets.size;
      const qual=[...cl.wallets].filter(a=>WALLETS.isQualified(S.wallets.get(a)));
      cl.independentQualified=qual.length; // counted separately from raw count, per spec
      cl.reasons=[];
      cl.reasons.push(cl.rawCount+' wallets appear as holders on this token while also holding other watched tokens');
      if(cl.independentQualified>0)cl.reasons.push(cl.independentQualified+' of these have enough history to count as qualified observations');
      if(cl.rawCount>=3){ cl.confidence='MEDIUM'; } else cl.confidence='LOW';
      if(cl.rawCount<2){ cl.confidence='INSUFFICIENT_DATA'; cl.reasons.push('fewer than 2 correlated wallets — cluster not established'); }
      cl.wallets=[...cl.wallets];
      cl.updatedAt=U.now();
    }
    return S.clusters;
  }
}
const CLUSTERS=new WalletClusterEngine();

/* ============================================================
   I. RiskAnalysisEngine — fail-closed checklist
   Every check: PASS / FAIL / UNKNOWN / NOT_SUPPORTED. UNKNOWN != PASS.
   ============================================================ */
class RiskAnalysisEngine{
  analyze(c){
    const checks=[]; const rc=c.rugcheck; const m=c.market;
    const add=(key,label,state,scope,critical)=>({key,label,state,scope,critical:!!critical});
    // 1. mint authority
    if(!rc)checks.push(add('mintAuthority','Mint authority revoked','UNKNOWN','RugCheck report not fetched — authority status unverified',true));
    else if(rc.mintAuthority===undefined)checks.push(add('mintAuthority','Mint authority revoked','UNKNOWN','field missing in RugCheck response',true));
    else checks.push(add('mintAuthority','Mint authority revoked',rc.mintAuthority?'FAIL':'PASS',rc.mintAuthority?'mint authority ACTIVE — supply can be inflated':'mintAuthority null — verified revoked',true));
    // 2. freeze authority
    if(!rc)checks.push(add('freezeAuthority','Freeze authority revoked','UNKNOWN','RugCheck report not fetched',true));
    else if(rc.freezeAuthority===undefined)checks.push(add('freezeAuthority','Freeze authority revoked','UNKNOWN','field missing in RugCheck response',true));
    else checks.push(add('freezeAuthority','Freeze authority revoked',rc.freezeAuthority?'FAIL':'PASS',rc.freezeAuthority?'freeze authority ACTIVE — holder accounts can be frozen':'freezeAuthority null — verified revoked',true));
    // 3. mutable metadata (non-critical)
    if(!rc||rc.mutable===undefined)checks.push(add('mutable','Metadata immutable','UNKNOWN','metadata mutability not verified',false));
    else checks.push(add('mutable','Metadata immutable',rc.mutable?'UNKNOWN':'PASS',rc.mutable?'metadata mutable — name/logo can change (common, not critical)':'metadata immutable',false));
    // 4. top-holder concentration
    if(!rc||!Array.isArray(rc.topHolders))checks.push(add('concentration','Top-holder concentration','UNKNOWN','topHolders unavailable (null on some tokens) — distribution unverified',true));
    else{
      const top10=rc.topHolders.slice(0,10).reduce((a,h)=>a+(h.pct||0),0);
      const st=top10>S.settings.top10ConcentrationFailPct?'FAIL':'PASS';
      checks.push(add('concentration','Top-10 holders ≤ '+S.settings.top10ConcentrationFailPct+'%',st,'top10 hold '+top10.toFixed(1)+'% of supply',true));
    }
    // 5. liquidity size
    if(!m||m.liquidityUsd==null)checks.push(add('liquidity','Liquidity ≥ $'+U.fmtN(S.settings.minLiquidityUsd),'UNKNOWN','liquidity missing — not a zero, just unobserved',true));
    else checks.push(add('liquidity','Liquidity ≥ $'+U.fmtN(S.settings.minLiquidityUsd),m.liquidityUsd>=S.settings.minLiquidityUsd?'PASS':'FAIL','liquidity '+U.fmt$(m.liquidityUsd),false));
    // 6. LP lock/burn evidence
    checks.push(add('lpLock','LP locked/burned evidence','NOT_SUPPORTED','no keyless verifiable LP-lock dataset in-browser — no lock/burn claim made',false));
    // 7. volume sanity
    if(!m||m.volume.h24==null)checks.push(add('volume','24h volume present','UNKNOWN','volume missing',false));
    else checks.push(add('volume','24h volume ≥ $'+U.fmtN(S.settings.minVolume24Usd),m.volume.h24>=S.settings.minVolume24Usd?'PASS':'FAIL','24h volume '+U.fmt$(m.volume.h24),false));
    // 8. buy/sell balance
    if(m&&m.txns.h24&&m.txns.h24.buys!=null&&(m.txns.h24.buys+m.txns.h24.sells)>0){
      const tot=m.txns.h24.buys+m.txns.h24.sells; const ratio=m.txns.h24.buys/tot;
      const st=(ratio<0.15||ratio>0.92)?'UNKNOWN':'PASS';
      checks.push(add('balance','Buy/sell balance sane',st,'24h buys '+m.txns.h24.buys+' / sells '+m.txns.h24.sells+(st==='UNKNOWN'?' — extreme imbalance, possible wash or one-sided flow':''),false));
    }else checks.push(add('balance','Buy/sell balance sane','UNKNOWN','txn counts missing',false));
    // 9. rugcheck flagged risks
    if(rc&&rc.rugged)checks.push(add('rugged','Not marked rugged','FAIL','RugCheck marks this token as rugged',true));
    else if(rc)checks.push(add('rugged','Not marked rugged','PASS','no rugged flag in RugCheck report',true));
    else checks.push(add('rugged','Not marked rugged','UNKNOWN','RugCheck report not fetched',true));
    // 10. abnormal volume spike
    if(m&&m.volume.m5!=null&&m.volume.h24!=null&&m.volume.h24>0){
      const spike=m.volume.m5/(m.volume.h24/288); // 5m share vs even share (288 5m windows/day)
      checks.push(add('volSpike','No abnormal volume spike',spike>25?'UNKNOWN':'PASS','5m volume is '+spike.toFixed(1)+'x an even-share window'+(spike>25?' — possible manipulation or news event, unverified':''),false));
    }else checks.push(add('volSpike','No abnormal volume spike','UNKNOWN','volume windows missing',false));
    // 11. transaction depth
    if(m&&m.txns.h24&&m.txns.h24.buys!=null){ const depth=m.txns.h24.buys+(m.txns.h24.sells||0);
      checks.push(add('txDepth','Adequate transaction depth',depth<30?'UNKNOWN':'PASS','24h txns: '+depth+(depth<30?' — very thin, price easily manipulated':''),false));
    }else checks.push(add('txDepth','Adequate transaction depth','UNKNOWN','txn counts missing',false));
    // 12. LP ownership
    checks.push(add('lpOwner','LP ownership verified','NOT_SUPPORTED','LP token ownership needs lock/burn dataset — unverified',false));
    // 13. deployer holdings
    if(rc&&Array.isArray(rc.topHolders)){ const ins=rc.topHolders.filter(h=>h.insider);
      checks.push(add('devHold','Deployer/insider holdings',ins.length?'UNKNOWN':'PASS',ins.length?ins.length+' insider-flagged holder(s) in top holders — deployer share unverified':'no insider-flagged top holders in RugCheck snapshot',false));
    }else checks.push(add('devHold','Deployer/insider holdings','UNKNOWN','holder data unavailable',false));
    // 14. stale/inconsistent market data
    if(m&&m.observedAt){ const stale=(U.now()-m.observedAt)>3*S.settings.pollIntervalSec*1000;
      checks.push(add('freshness','Market data not stale',stale?'FAIL':'PASS','market data observed '+U.age(m.observedAt)+' ago',true));
    }else checks.push(add('freshness','Market data not stale','UNKNOWN','no market observation timestamp',true));
    // 15. pool identity
    checks.push(add('poolId','Token/pool identity verified',(m&&m.pairAddress&&m.dexId)?'PASS':'UNKNOWN',(m&&m.pairAddress)?'pair '+U.short(m.pairAddress)+' on '+(m.dexId||'?'):'pair identity not established',true));
    // 16. malicious-address datasets
    checks.push(add('malicious','Known malicious-address lists','NOT_SUPPORTED','no keyless malicious-address dataset integrated',false));
    // verdict
    const critFail=checks.filter(x=>x.critical&&x.state==='FAIL');
    const critUnknown=checks.filter(x=>x.critical&&x.state==='UNKNOWN');
    let verdict;
    if(critFail.length)verdict='FAIL';
    else if(critUnknown.length)verdict='UNKNOWN'; // critical UNKNOWN prevents qualification (fail-closed)
    else verdict='PASS';
    return {verdict,checks,analyzedAt:U.now(),policyVersion:RISK_POLICY_VERSION,
      note:'PASS means no critical check failed with available evidence — it does NOT mean safe. NOT_SUPPORTED/UNKNOWN checks remain unverified.'};
  }
}
const RISK=new RiskAnalysisEngine();

/* ============================================================
   J. CandidateScoringEngine — versioned 0-100 evidence scoring
   Weights are design weights, not proven predictive. Missing
   data earns 0 for that component and is labelled.
   ============================================================ */
class CandidateScoringEngine{
  score(c){
    const w=S.settings.weights; const comps=[];
    const comp=(key,label,max,points,inputs,evidence,dataState)=>({key,label,max,points:U.clamp(Math.round(points*10)/10,0,max),inputs,evidence,dataState});
    const m=c.market||{};
    // 1. Liquidity
    if(m.liquidityUsd==null)comps.push(comp('liquidity','Liquidity',w.liquidity,0,{liquidityUsd:null},'liquidity unobserved — 0 points (missing data is never full points)','MISSING'));
    else{ const l=m.liquidityUsd; const pts=l>=100000?1:l>=50000?.8:l>=25000?.6:l>=10000?.45:l>=5000?.3:l>0?.1:0;
      comps.push(comp('liquidity','Liquidity',w.liquidity,pts*w.liquidity,{liquidityUsd:l},'banded by USD liquidity','LIVE')); }
    // 2. Activity/volume
    if(m.volume==null||m.volume.h24==null)comps.push(comp('activity','Activity / volume',w.activity,0,{v24:null},'volume unobserved','MISSING'));
    else{ const v=m.volume.h24; const pts=v>=250000?1:v>=100000?.8:v>=50000?.6:v>=20000?.45:v>=5000?.25:v>0?.1:0;
      comps.push(comp('activity','Activity / volume',w.activity,pts*w.activity,{volume24:v},'banded by 24h volume','LIVE')); }
    // 3. Early-wallet evidence
    { const ev=c.walletEvidence||[]; const qual=ev.filter(e=>e.qualified);
      const pts=qual.length>=4?1:qual.length===3?.75:qual.length===2?.5:qual.length===1?.3:0;
      comps.push(comp('earlyWallets','Early-wallet evidence',w.earlyWallets,pts*w.earlyWallets,{observedWallets:ev.length,qualified:qual.length},
        qual.length?qual.length+' qualified wallet(s) with early-observation evidence':'no qualified early-wallet evidence — not proof of absence, just unobserved',ev.length?'LIVE':'MISSING')); }
    // 4. Qualified cluster evidence
    { const cl=[...S.clusters.values()].find(x=>x.mint===c.mint);
      if(!cl)comps.push(comp('clusters','Qualified cluster evidence',w.clusters,0,{},'no cluster observed for this token','NOT_OBSERVED'));
      else{ const pts=cl.confidence==='MEDIUM'?.6:cl.confidence==='LOW'?.3:0;
        comps.push(comp('clusters','Qualified cluster evidence',w.clusters,pts*w.clusters,{raw:cl.rawCount,independentQualified:cl.independentQualified,confidence:cl.confidence},
          'cluster confidence '+cl.confidence+'; '+cl.independentQualified+' independent qualified of '+cl.rawCount+' raw','LIVE')); } }
    // 5. Token/holder distribution
    { const rc=c.rugcheck;
      if(!rc||!Array.isArray(rc.topHolders))comps.push(comp('distribution','Token/holder distribution',w.distribution,0,{},'holder distribution unverified (topHolders unavailable)','MISSING'));
      else{ const top10=rc.topHolders.slice(0,10).reduce((a,h)=>a+(h.pct||0),0);
        const pts=top10<=20?1:top10<=35?.7:top10<=50?.4:top10<=60?.15:0;
        comps.push(comp('distribution','Token/holder distribution',w.distribution,pts*w.distribution,{top10Pct:Math.round(top10*10)/10},'banded by top-10 concentration (lower is better)','LIVE')); } }
    // 6. Risk-adjusted market behavior
    { let pts=.5; const evid=[]; const inputs={};
      if(c.risk){ if(c.risk.verdict==='PASS'){pts+=.3;evid.push('risk gates PASS');} else if(c.risk.verdict==='UNKNOWN'){pts+=0;evid.push('risk UNKNOWN — no bonus');} else {pts-=.4;evid.push('risk FAIL penalty');} }
      else evid.push('risk not analyzed — neutral base');
      if(m.txns&&m.txns.h24&&m.txns.h24.buys!=null&&(m.txns.h24.buys+m.txns.h24.sells)>0){
        const r=m.txns.h24.buys/(m.txns.h24.buys+m.txns.h24.sells); inputs.buyRatio=Math.round(r*100)/100;
        if(r>=0.4&&r<=0.75){pts+=.2;evid.push('healthy buy/sell balance');} else evid.push('imbalanced flow — no bonus'); }
      comps.push(comp('marketBehavior','Risk-adjusted market behavior',w.marketBehavior,U.clamp(pts,0,1)*w.marketBehavior,inputs,evid.join('; '),'LIVE')); }
    const total=Math.round(comps.reduce((a,x)=>a+x.points,0)*10)/10;
    const snapshot={id:U.uid('sc'),mint:c.mint,total,components:comps,weights:JSON.parse(JSON.stringify(w)),
      scoreVersion:SCORE_VERSION,computedAt:U.now(),
      disclaimer:'Design weights, not proven predictive. A high score never overrides a failed or unknown mandatory risk gate.'};
    S.scoreHistory.push(snapshot); if(S.scoreHistory.length>500)S.scoreHistory=S.scoreHistory.slice(-500);
    c.score=snapshot;
    return snapshot;
  }
}
const SCORER=new CandidateScoringEngine();

/* ============================================================
   K. SignalQualificationEngine — gated state machine
   ============================================================ */
class SignalQualificationEngine{
  /* full evaluation of one candidate -> new state + reasons */
  evaluate(c){
    const reasons=[]; const t=U.now();
    const set=(st,why)=>{ if(c.state!==st){c.state=st;c.stateHistory.push({state:st,at:t,reason:why});} return st; };
    // rejection memory
    c.rejectionReasons=[];
    // 1. validation
    const v=VALIDATOR.validate(c); c.validation=v;
    if(v.status!=='VALIDATED'){ const why='validation incomplete: '+v.problems.join('; ');
      c.rejectionReasons.push(why); S.diag.counters.incomplete++; return set('DATA_INCOMPLETE',why); }
    // 2. v4 OPEN ENTRY (owner typed override 2026-10-13 "All rules remove pannidu"): risk, score and
    //    wallet evidence are still computed and SHOWN for research, but NONE of them gates a paper entry.
    const rk=c.risk||RISK.analyze(c); c.risk=rk;
    const sc=SCORER.score(c);
    const qualW=(c.walletEvidence||[]).filter(e=>e.qualified).length;
    // 5. cooldown / duplicate
    if(c.cooldownUntil&&c.cooldownUntil>t){ const why='cooldown until '+new Date(c.cooldownUntil).toLocaleTimeString();
      c.rejectionReasons.push(why); return set('WATCHLIST',why); }
    if(c.signalId&&S.signals.get(c.signalId)&&!S.signals.get(c.signalId).consumed){ return 'PAPER_SIGNAL'; }
    // ALL GATES PASSED -> create signal
    const sig={id:U.uid('sig'),mint:c.mint,symbol:c.market.symbol,name:c.market.name,createdAt:t,
      signalPriceUsd:c.market.priceUsd,signalPriceAt:t,
      signalPriceNote:'PAPER reference - exact price at signal time. Live price moves; this value never updates.',
      score:sc.total,scoreVersion:SCORE_VERSION,thresholdsVersion:THRESHOLDS_VERSION,riskPolicyVersion:RISK_POLICY_VERSION,
      evidence:{liquidityUsd:c.market.liquidityUsd,volume24:c.market.volume.h24,qualifiedWallets:qualW,
        riskVerdict:rk.verdict,pairAddress:c.market.pairAddress,dexId:c.market.dexId,
        scoreSnapshotId:sc.id,scoreBreakdown:sc.components},
      state:'PAPER_SIGNAL',consumed:false,
      paperOnly:true,note:'PAPER SIGNAL — research only. Not financial advice. Not a guarantee of profit or early entry.'};
    S.signals.set(sig.id,sig); c.signalId=sig.id; S.diag.counters.signals++;
    set('PAPER_SIGNAL','v4 open entry: validated identity + fresh market evidence, NO entry screens (risk '+rk.verdict+' / score '+sc.total+' / wallets '+qualW+' = research display only)');
    S.emit('signal',sig);
    return 'PAPER_SIGNAL';
  }
}
const QUAL=new SignalQualificationEngine();

/* ============================================================
   L. PaperPortfolioEngine — $200 virtual, honest accounting
   ============================================================ */
class PaperPortfolioEngine{
  cash(){ return this._cash==null?S.settings.startCapital:this._cash; }
  setCash(v){ this._cash=Math.round(v*100)/100; }
  reset(){ this._cash=null; this._peakEq=null; }
  openCount(){ return [...S.positions.values()].filter(p=>p.status==='OPEN').length; }
  openPositions(){ return [...S.positions.values()].filter(p=>p.status==='OPEN'); }
  cost(){ return (S.settings.entrySizeUsd)*(1+(S.settings.feePct+S.settings.slippagePct)/100); }
  canEnter(){
    if(S.cycleFrozen)return {ok:false,reason:'TARGET_REACHED — cycle complete, entries frozen'};
    if(this.openCount()>=S.settings.maxOpenPositions)return {ok:false,reason:'max open positions reached ('+S.settings.maxOpenPositions+')'};
    if(this.cash()<this.cost())return {ok:false,reason:'insufficient paper cash ('+U.fmt$(this.cash())+' < '+U.fmt$(this.cost())+')'};
    return {ok:true};
  }
  enter(c){
    const gate=this.canEnter(); if(!gate.ok)return {ok:false,reason:gate.reason};
    if(!c.market||c.market.priceUsd==null)return {ok:false,reason:'no executable price — stale/missing price is never used for entry'};
    if((U.now()-c.market.observedAt)>5*60*1000)return {ok:false,reason:'price older than 5 minutes — refresh before entry (stale price never executable)'};
    const entrySize=Math.min(S.settings.entrySizeUsd,S.settings.startCapital*S.settings.maxPositionPct/100);
    const fee=entrySize*S.settings.feePct/100, slip=entrySize*S.settings.slippagePct/100;
    const spend=entrySize+fee+slip;
    const effPrice=c.market.priceUsd*(1+S.settings.slippagePct/100);
    const qty=entrySize/effPrice;
    const pos={id:U.uid('pos'),mint:c.mint,symbol:c.market.symbol,openedAt:U.now(),
      entryPrice:effPrice,rawEntryPrice:c.market.priceUsd,qty,entrySizeUsd:entrySize,feeUsd:fee,slippageUsd:slip,
      status:'OPEN',peakPrice:effPrice,entryLiquidity:c.market.liquidityUsd,
      scoreAtEntry:c.score?c.score.total:null,scoreVersion:SCORE_VERSION,strategy:'early-wallet radar '+APP_VERSION,
      milestonesHit:[],exitReason:null,closedAt:null,exitPrice:null,exitValueUsd:null,realizedPnl:null,
      lastPrice:c.market.priceUsd,lastPriceAt:U.now(),paperOnly:true};
    this.setCash(this.cash()-spend);
    S.positions.set(pos.id,pos);
    this._trade({t:U.now(),type:'ENTRY',posId:pos.id,mint:c.mint,symbol:pos.symbol,price:effPrice,qty,usd:entrySize,fee,slip,
      reason:'signal-qualified entry',scoreVersion:SCORE_VERSION});
    const sig=c.signalId&&S.signals.get(c.signalId); if(sig){sig.consumed=true;sig.positionId=pos.id;}
    c.state='PAPER_POSITION_OPEN'; c.stateHistory=c.stateHistory||[]; c.stateHistory.push({state:'PAPER_POSITION_OPEN',at:U.now(),reason:'paper entry '+U.fmt$(entrySize)});
    S.emit('data');
    return {ok:true,pos};
  }
  exit(pos,reason,price){
    if(pos.status!=='OPEN')return {ok:false,reason:'position not open'};
    if(price==null||isNaN(price))return {ok:false,reason:'no executable exit price — marked UNAVAILABLE, position stays open'};
    const gross=pos.qty*price*(1-S.settings.slippagePct/100);
    const fee=gross*S.settings.feePct/100;
    const net=gross-fee;
    pos.status='CLOSED'; pos.closedAt=U.now(); pos.exitPrice=price; pos.exitValueUsd=Math.round(net*100)/100;
    pos.realizedPnl=Math.round((net-pos.entrySizeUsd-pos.feeUsd-pos.slippageUsd)*100)/100;
    pos.exitReason=reason;
    this.setCash(this.cash()+net);
    this._trade({t:U.now(),type:'EXIT',posId:pos.id,mint:pos.mint,symbol:pos.symbol,price,qty:pos.qty,usd:Math.round(net*100)/100,fee:Math.round(fee*100)/100,reason});
    const c=S.candidates.get(pos.mint); if(c){c.state='PAPER_POSITION_CLOSED';c.cooldownUntil=U.now()+S.settings.signalCooldownHours*3600000;
      c.stateHistory=c.stateHistory||[]; c.stateHistory.push({state:'PAPER_POSITION_CLOSED',at:U.now(),reason});}
    S.emit('data');
    return {ok:true,net:pos.exitValueUsd,pnl:pos.realizedPnl};
  }
  unrealized(pos){
    if(pos.status!=='OPEN'||pos.lastPrice==null)return null;
    return Math.round((pos.qty*pos.lastPrice-pos.entrySizeUsd-pos.feeUsd-pos.slippageUsd)*100)/100;
  }
  equity(){ let eq=this.cash(); let anyNull=false;
    for(const p of this.openPositions()){ if(p.lastPrice==null){anyNull=true;continue;} eq+=p.qty*p.lastPrice; }
    return {equity:Math.round(eq*100)/100,valuationsComplete:!anyNull}; }
  stats(){
    const closed=[...S.positions.values()].filter(p=>p.status==='CLOSED');
    const wins=closed.filter(p=>(p.realizedPnl||0)>0);
    const realized=Math.round(closed.reduce((a,p)=>a+(p.realizedPnl||0),0)*100)/100;
    const eq=this.equity();
    // max drawdown from equity curve recorded in trades timeline (approx via peak equity tracking)
    this._peakEq=Math.max(this._peakEq||S.settings.startCapital,eq.equity);
    const mdd=this._peakEq>0?Math.round((this._peakEq-eq.equity)/this._peakEq*1000)/10:0;
    return {open:this.openCount(),closed:closed.length,wins:wins.length,
      winRate:closed.length?Math.round(wins.length/closed.length*100):null,
      realizedPnl:realized,equity:eq.equity,valuationsComplete:eq.valuationsComplete,maxDrawdownPct:mdd};
  }
  checkTarget(){
    const eq=this.equity();
    if(!S.cycleFrozen&&eq.valuationsComplete&&eq.equity>=S.settings.targetEquity){
      S.cycleFrozen=true; S.targetReached=true;
      this._trade({t:U.now(),type:'TARGET_REACHED',usd:eq.equity,reason:'verified equity >= '+S.settings.targetEquity+' — new entries frozen, cycle marked complete. A target met in paper accounting, not a profit guarantee.'});
      S.emit('target');
    }
  }
  _trade(ev){ ev.id=U.uid('tr'); S.trades.push(ev); if(S.trades.length>1000)S.trades=S.trades.slice(-1000); }
}
const PORT=new PaperPortfolioEngine();

/* ============================================================
   M. PositionMonitoringEngine — exit policy enforcement
   ============================================================ */
class PositionMonitoringEngine{
  async run(){
    const open=PORT.openPositions(); if(!open.length)return {checked:0};
    const mints=[...new Set(open.map(p=>p.mint))];
    const prices=await DISCOVERY.refreshPricesFor(mints);
    for(const p of open){
      const pr=prices[p.mint];
      if(!pr||!pr.ok||pr.priceUsd==null){ p.priceStale=true; continue; }
      p.priceStale=false; p.lastPrice=pr.priceUsd; p.lastPriceAt=pr.observedAt;
      p.peakPrice=Math.max(p.peakPrice,pr.priceUsd);
      const mult=pr.priceUsd/p.entryPrice;
      // milestone monitoring (events, not profit guarantees)
      for(const x of [2,3,5,10]){ if(mult>=x&&!p.milestonesHit.includes(x)){ p.milestonesHit.push(x);
        PORT._trade({t:U.now(),type:'MILESTONE',posId:p.id,mint:p.mint,symbol:p.symbol,price:pr.priceUsd,reason:x+'x milestone reached (milestone != profit guarantee)'}); } }
      // stop-loss / invalidation
      const pnlPct=(pr.priceUsd-p.entryPrice)/p.entryPrice*100;
      if(pnlPct<=S.settings.stopLossPct){ PORT.exit(p,'stop-loss hit ('+pnlPct.toFixed(1)+'% <= '+S.settings.stopLossPct+'%)',pr.priceUsd); continue; }
      // trailing profit protection after configured multiple
      if(mult>=S.settings.trailingAfterX){
        const drop=(p.peakPrice-pr.priceUsd)/p.peakPrice*100;
        if(drop>=S.settings.trailingDropPct){ PORT.exit(p,'trailing exit: '+drop.toFixed(1)+'% drop from peak after '+S.settings.trailingAfterX+'x',pr.priceUsd); continue; }
      }
      // liquidity deterioration
      if(p.entryLiquidity&&pr.liquidityUsd!=null&&pr.liquidityUsd<p.entryLiquidity*S.settings.liquidityExitPct/100){
        PORT.exit(p,'liquidity deterioration: '+U.fmt$(pr.liquidityUsd)+' < '+S.settings.liquidityExitPct+'% of entry liquidity',pr.priceUsd); continue; }
      // risk deterioration
      const c=S.candidates.get(p.mint);
      if(c&&c.risk&&c.risk.verdict==='FAIL'){ PORT.exit(p,'risk deterioration: risk verdict now FAIL',pr.priceUsd); continue; }
      // max holding period
      if(S.settings.maxHoldHours>0&&(U.now()-p.openedAt)>S.settings.maxHoldHours*3600000){
        PORT.exit(p,'max holding period reached ('+S.settings.maxHoldHours+'h)',pr.priceUsd); continue; }
    }
    PORT.checkTarget();
    return {checked:open.length};
  }
}
const MONITOR=new PositionMonitoringEngine();

/* ============================================================
   N. PersistenceEngine — IndexedDB (localStorage fallback)
   ============================================================ */

export {U,DEFAULT_SETTINGS,S,REG,RPC,DEX,DISCOVERY,VALIDATOR,WALLETS,CLUSTERS,RISK,SCORER,QUAL,PORT,MONITOR,APP_VERSION,SCORE_VERSION,RISK_POLICY_VERSION,THRESHOLDS_VERSION,BUILD_MARKER};
