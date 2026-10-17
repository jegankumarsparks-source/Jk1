/* ============================================================
   SOLANA EARLY-WALLET RADAR — 24/7 SERVER SCANNER (Cloudflare Worker)
   Same runner as ../scanner.mjs, ported to a Workers cron trigger
   (cron every 5 minutes), free tier. Extracts the page's own engine code
   verbatim from solana-radar/index.html at run time — engine rules
   never change here. Keyless public data only (Dexscreener /
   RugCheck / public Solana RPC). Paper only: no real money, no
   wallet signing, no data API keys. State + public feed live in the
   repo (server/state.json, ../server-scan.json) via the GitHub
   contents API (GH_TOKEN secret, contents scope).
   ============================================================ */
const REPO='jegankumarsparks-source/Jk1';
/* free tier allows 50 subrequests per invocation; the engine spends them via
   global fetch. Count them so the driver can stop optional phases early and
   always reserve enough for the state+feed writes (heartbeat must never lose
   the write budget to analysis). */
let subCount=0;
{ const _f=globalThis.fetch;
  globalThis.fetch=(...a)=>{ subCount++; return _f(...a); }; }
const SUB_CUTOFF_ANALYZE=14; // stop starting new candidate analysis past this (counter under-reads vs runtime; padded)
const SUB_CUTOFF_MARKS=30;   // skip price-mark refresh past this
const SUB_CUTOFF_HARD=38;    // no discretionary fetch of any kind past this
const HEAVY_PHASE_DEADLINE_MS=12000; // wall-clock backstop: discretionary phases stop, writes always happen
let lastWriteError=null; // warm isolates only: surfaced once in the next feed, then cleared
const STATE_PATH='solana-radar/server/state.json';
const FEED_PATH='solana-radar/server-scan.json';
const PAGE_PATH='solana-radar/index.html';
const DEADLINE_MS=25000;

function b64(s){ const bytes=new TextEncoder().encode(s); let bin='';
  for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
  return btoa(bin); }

/* race a promise against a hard budget; late rejections are swallowed so a
   stalled source can never kill the cycle silently */
function withTimeout(p,ms,label){
  return new Promise((resolve,reject)=>{
    const t=setTimeout(()=>reject(new Error(label+' exceeded '+ms+'ms budget')),ms);
    p.then(v=>{clearTimeout(t);resolve(v);},e=>{clearTimeout(t);reject(e);});
    p.catch(()=>{});
  });
}

async function gh(env,method,path,body,raw){
  const r=await fetch('https://api.github.com/repos/'+REPO+'/contents/'+path+(method==='GET'&&path.indexOf('?')<0?'?ref=main':''),{
    method,headers:{Authorization:'Bearer '+env.GH_TOKEN,Accept:raw?'application/vnd.github.raw':'application/vnd.github+json','User-Agent':'jk-radar-scanner'},
    signal:AbortSignal.timeout(10000),
    body:body?JSON.stringify(body):undefined});
  if(r.status===404)return null;
  if(!r.ok){ const t=await r.text(); throw new Error('github '+method+' '+path+' -> '+r.status+' '+t.slice(0,160)); }
  return raw?r.text():r.json();
}

async function putFile(env,path,content,message){
  for(let a=0;a<3;a++){
    try{
      const meta=await gh(env,'GET',path);
      const body={message,content:b64(content),branch:'main'};
      if(meta&&meta.sha)body.sha=meta.sha;
      const r=await gh(env,'PUT',path,body);
      if(r&&r.content)return true;
    }catch(e){ if(a===2){console.log('putFile failed',path,e.message);return false;} await new Promise(r2=>setTimeout(r2,700*(a+1))); }
  }
  return false;
}

/* The engine ships as a generated static bundle (Workers forbid eval).
   build-bundle.mjs extracts it VERBATIM from index.html; at run time we
   re-extract the live page's engine section and compare hashes so any
   drift is labelled honestly in the feed instead of silently diverging. */
import * as E from './engine.bundle.js';
async function engineDrift(html){
  try{
    const a=html.indexOf('const BUILD_MARKER=');
    const b=html.indexOf('class PersistenceEngine');
    if(a<0||b<0||b<=a)return 'anchors not found in live index.html — running bundled engine';
    const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(html.slice(a,b)));
    const hex=[...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,'0')).join('');
    return hex===E.ENGINE_HASH?null:('live index.html engine hash '+hex.slice(0,12)+' != bundle '+E.ENGINE_HASH.slice(0,12)+' — running bundled engine, redeploy worker to refresh');
  }catch(e){ return 'drift check failed: '+String(e.message||e).slice(0,100)+' — running bundled engine'; }
}

async function runCycle(env){
  subCount=0; // module scope survives warm isolates: reset per invocation
  const deadline=Date.now()+DEADLINE_MS;
  const phaseT={t0:Date.now()};
  let stateText=null,stateFetchError=null;
  const html=await withTimeout(gh(env,'GET',PAGE_PATH,null,true),12000,'page read');
  try{ stateText=await withTimeout(gh(env,'GET',STATE_PATH,null,true),12000,'state read'); }
  catch(e){ stateFetchError=String(e.message||e).slice(0,140); }
  phaseT.readMs=Date.now()-phaseT.t0;
  const drift=await engineDrift(html);
  const {U,S,REG,DISCOVERY,DEX,WALLETS,CLUSTERS,RISK,SCORER,QUAL}=E;
  /* fresh state each cycle (warm isolates reuse module singletons) */
  S.candidates.clear(); S.wallets.clear(); S.clusters.clear(); S.signals.clear();
  S.positions.clear(); S.trades=[]; S.scoreHistory=[];

  /* --- restore state --- */
  let st=null;
  try{ st=stateText?JSON.parse(stateText):null; }catch(e){ st=null; }
  let restored=false,cycleBase=0,milestones={};
  if(st&&st.schema===1){
    try{
      for(const c of st.candidates||[])S.candidates.set(c.mint,c);
      for(const w of st.wallets||[])S.wallets.set(w.address,w);
      for(const g of st.signals||[])S.signals.set(g.id,g);
      S.scoreHistory=st.scoreHistory||[];
      if(st.counters)S.diag.counters=st.counters;
      if(st.rejectReasons)S.diag.rejectReasons=st.rejectReasons;
      restored=true; cycleBase=st.cycleBase||0; milestones=st.milestones||{};
    }catch(e){ console.log('state restore failed, clean start:',e.message); }
  }

  const cycle=cycleBase+1;
  const cycleStart=Date.now();
  const newSignals=[];
  S.on('signal',g=>newSignals.push(g));
  const errors=[];
  if(drift)errors.push('ENGINE DRIFT: '+drift);
  const DISCOVERY_BUDGET_MS=20000;
  const heavyDeadline=Date.now()+HEAVY_PHASE_DEADLINE_MS;
  if(S&&S.settings){ S.settings.maxRugcheckPerCycle=Math.min(S.settings.maxRugcheckPerCycle||3,3); S.settings.walletResearchPerCandidate=Math.min(S.settings.walletResearchPerCandidate||3,3); }
  const subPhases={};
  let dexBackoffUntil=0, dexStrikes=(st&&st.dexBackoffStrikes)||0, dex429Streak=0;
  if(st&&st.dexBackoffUntil&&st.dexBackoffUntil>Date.now()){
    dexBackoffUntil=st.dexBackoffUntil;
    errors.push('discovery skipped: dexscreener 429 cooldown active until '+new Date(dexBackoffUntil).toISOString()+' (driver-level backoff, engine rules unchanged; heartbeat feed still written)');
  }else{
    const dT=Date.now();
    try{
      const r=await withTimeout(DISCOVERY.runCycle(),DISCOVERY_BUDGET_MS,'discovery');
      if(r&&r.errors&&r.errors.length)errors.push(...r.errors.map(e=>'discovery: '+e));
    }catch(e){ errors.push('discovery cycle: '+(e.message||e)); }
    phaseT.discoveryMs=Date.now()-dT;
    subPhases.afterDiscovery=subCount;
    const dex=REG.all().find(s=>s.id==='dexscreener');
    const dex429=dex&&dex.status==='DEGRADED'&&String(dex.lastError||'').includes('429');
    const discoveryStalled=(phaseT.discoveryMs||0)>=DISCOVERY_BUDGET_MS;
    if(dex429||discoveryStalled){
      dex429Streak=(st&&st.dex429Streak||0)+1;
      if(dex429Streak>=2){
        dexStrikes=Math.min((st&&st.dexBackoffStrikes||0)+1,3);
        const mins=10*dexStrikes;
        dexBackoffUntil=Date.now()+mins*60*1000;
        errors.push('dexscreener cooldown armed for '+mins+' min (strike '+dexStrikes+' after '+dex429Streak+' consecutive 429 cycles, driver-level; discovery resumes automatically, heartbeats continue)');
        errors.push('GitHub Actions backstop (separate egress IPs) covers discovery when its scheduled run lands — GitHub delays the 5-min cron in practice, so coverage is best-effort');
      }else{
        errors.push('dexscreener 429 this cycle — retrying next cycle (cooldown arms after 2 consecutive 429 cycles)');
      }
    }else{
      dex429Streak=0;
      if(dex&&dex.status==='LIVE')dexStrikes=0; // source recovered: back to short cooldown next time
    }
  }

  async function analyzeOne(mint){
    const c=S.candidates.get(mint); if(!c)return null;
    if(!c.rugcheck||(U.now()-c.rugcheck.fetchedAt)>10*60*1000){
      try{ c.rugcheck=await DEX.rugcheckReport(mint); c.fieldMeta.rugcheck={source:'rugcheck',observedAt:c.rugcheck.fetchedAt,status:'LIVE'}; }
      catch(e){ c.fieldMeta.rugcheck={source:'rugcheck',observedAt:U.now(),status:'ERROR'}; c.rugcheckError=String(e.message||e).slice(0,120); }
    }
    if(c.rugcheck){
      WALLETS.harvestFromToken(c);
      const recs=(c.rugcheck.topHolders||[]).filter(h=>h.address&&!h.insider).slice(0,S.settings.walletResearchPerCandidate||5);
      for(const h of recs){ if(Date.now()>deadline||Date.now()>heavyDeadline||subCount>SUB_CUTOFF_HARD)break; try{ await WALLETS.researchWallet(h.address); }catch(e){} }
      c.walletEvidence=(c.rugcheck.topHolders||[]).filter(h=>h.address).map(h=>{
        const w=S.wallets.get(h.address);
        return {address:h.address,pct:h.pct,insider:h.insider,state:w?w.state:'UNVERIFIED',
          qualified:w?WALLETS.isQualified(w):false,observedAt:U.now()};
      });
    }
    CLUSTERS.recompute();
    c.risk=RISK.analyze(c);
    return QUAL.evaluate(c);
  }

  let analyzed=0;
  for(const c of S.candidates.values()){
    if(analyzed>=Math.min(S.settings.maxRugcheckPerCycle||3,3))break;
    if(Date.now()>deadline||Date.now()>heavyDeadline){ errors.push('deadline reached — remaining candidates deferred to next cycle'); break; }
    if(subCount>SUB_CUTOFF_ANALYZE){ errors.push('subrequest budget reached ('+subCount+') — remaining analysis deferred (driver-level, protects heartbeat writes)'); break; }
    if((c.updatedAt||0)<cycleStart)continue;
    if(c.state==='DISCOVERED'||(c.state==='DATA_INCOMPLETE'&&c.market)){
      try{ await analyzeOne(c.mint); analyzed++; }catch(e){ errors.push('analyze '+U.short(c.mint)+': '+(e.message||e)); }
    }
  }

  subPhases.afterAnalysis=subCount;
  /* --- signal milestone marks (observed, never executable) --- */
  let marksTracked=0;
  if(subCount>SUB_CUTOFF_MARKS||Date.now()>heavyDeadline){ errors.push('marks refresh skipped: subrequest budget ('+subCount+') reserved for heartbeat writes'); }
  else { const cut=U.now()-48*3600*1000;
    const recent=[...S.signals.values()].filter(g=>g.createdAt>cut).sort((a,b)=>b.createdAt-a.createdAt).slice(0,25);
    if(recent.length){
      const mints=[...new Set(recent.map(g=>g.mint))];
      let prices={};
      try{ prices=await withTimeout(DISCOVERY.refreshPricesFor(mints),8000,'marks refresh'); }catch(e){ errors.push('marks: '+String(e.message||e).slice(0,120)); }
      for(const g of recent){
        const pr=prices[g.mint];
        if(!pr||!pr.ok||pr.priceUsd==null)continue;
        marksTracked++;
        g.lastPrice=pr.priceUsd; g.lastPriceAt=pr.observedAt;
        g.multiple=g.signalPriceUsd?Math.round(pr.priceUsd/g.signalPriceUsd*100)/100:null;
        const ml=milestones[g.id]=milestones[g.id]||{hit:[]};
        if(g.multiple!=null&&g.multiple<=0.5&&!g.dumpHit)g.dumpHit={at:U.now(),price:pr.priceUsd,multiple:g.multiple};
      if(g.multiple!=null)for(const x of [1.5,2,3,5,10]){
          if(g.multiple>=x&&!ml.hit.find(h=>h.x===x))ml.hit.push({x,at:U.now(),price:pr.priceUsd});
        }
        g.milestonesHit=ml.hit;
      }
    } }

  subPhases.afterMarks=subCount;
  /* --- eviction (state hygiene, same as scanner.mjs) --- */
  { const cut=U.now()-72*3600*1000;
    for(const [m,c] of [...S.candidates]){
      const sig=c.signalId&&S.signals.get(c.signalId);
      const keep=(sig&&!sig.consumed)||(c.updatedAt||c.firstObserved||0)>cut;
      if(!keep)S.candidates.delete(m);
    }
    if(S.candidates.size>600){
      const arr=[...S.candidates.values()].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
      const keep=new Set(arr.slice(0,600).map(c=>c.mint));
      for(const m of [...S.candidates.keys()])if(!keep.has(m)){
        const c=S.candidates.get(m); const sig=c.signalId&&S.signals.get(c.signalId);
        if(!(sig&&!sig.consumed))S.candidates.delete(m);
      }
    }
    if(S.wallets.size>2000){
      const arr=[...S.wallets.values()].sort((a,b)=>((b.lastResearchAt||b.firstObserved||0)-(a.lastResearchAt||a.firstObserved||0)));
      const keep=new Set(arr.slice(0,2000).map(w=>w.address));
      for(const a of [...S.wallets.keys()])if(!keep.has(a))S.wallets.delete(a);
    }
    if(S.signals.size>300){
      const arr=[...S.signals.values()].sort((a,b)=>b.createdAt-a.createdAt);
      const keep=new Set(arr.slice(0,300).map(g=>g.id));
      for(const id of [...S.signals.keys()])if(!keep.has(id)){
        const g=S.signals.get(id); if(g&&g.consumed)S.signals.delete(id); else if(g&&arr.indexOf(g)>=300)S.signals.delete(id);
      }
    } }

  function publicSignal(g){
    return {id:g.id,mint:g.mint,symbol:g.symbol||null,name:g.name||null,createdAt:g.createdAt,
      signalPriceUsd:g.signalPriceUsd,score:g.score,riskVerdict:g.evidence?g.evidence.riskVerdict:null,
      liquidityUsd:g.evidence?g.evidence.liquidityUsd:null,volume24:g.evidence?g.evidence.volume24:null,
      qualifiedWallets:g.evidence?g.evidence.qualifiedWallets:null,
      pairAddress:g.evidence?g.evidence.pairAddress:null,dexId:g.evidence?g.evidence.dexId:null,
      lastPrice:g.lastPrice!=null?g.lastPrice:null,lastPriceAt:g.lastPriceAt||null,
      multiple:g.multiple!=null?g.multiple:null,
      milestonesHit:g.milestonesHit||[],dumpHit:g.dumpHit||null,
      links:{dexscreener:'https://dexscreener.com/solana/'+(g.evidence&&g.evidence.pairAddress?g.evidence.pairAddress:g.mint),
        gmgn:'https://gmgn.ai/sol/token/'+g.mint,solscan:'https://solscan.io/token/'+g.mint},
      paperOnly:true};
  }

  const all=[...S.candidates.values()];
  const counts={total:all.length,
    validated:all.filter(c=>c.validation&&c.validation.status==='VALIDATED').length,
    paperSignals:all.filter(c=>c.state==='PAPER_SIGNAL').length,
    dataIncomplete:all.filter(c=>c.state==='DATA_INCOMPLETE').length,
    watchlist:all.filter(c=>c.state==='WATCHLIST').length};
  const top=all.filter(c=>c.score).sort((a,b)=>b.score.total-a.score.total).slice(0,10).map(c=>({
    mint:c.mint,symbol:c.market?c.market.symbol:null,state:c.state,score:c.score.total,
    riskVerdict:c.risk?c.risk.verdict:null,liquidityUsd:c.market?c.market.liquidityUsd:null,
    mcap:c.market?c.market.mcap:null,observedAt:c.market?c.market.observedAt:null,
    links:{dexscreener:'https://dexscreener.com/solana/'+(c.market&&c.market.pairAddress?c.market.pairAddress:c.mint),
      gmgn:'https://gmgn.ai/sol/token/'+c.mint,solscan:'https://solscan.io/token/'+c.mint}}));
  const signals=[...S.signals.values()].sort((a,b)=>b.createdAt-a.createdAt).slice(0,15).map(publicSignal);

  const srcList=REG.all().map(s=>({id:s.id,label:s.label,status:s.status,lastSuccess:s.lastSuccess,lastError:s.lastError,
    requestCount:s.requestCount,rateLimitCount:s.rateLimitCount}));
  { const skipped=errors.some(e=>e.indexOf('discovery skipped')===0);
    for(const s2 of srcList){
      if((s2.id==='rugcheck'||s2.id==='solanarpc')&&s2.status==='NOT_OBSERVED'){
        s2.note=skipped?'not exercised - discovery skipped during dexscreener 429 cooldown'
          :'not exercised this cycle (no refreshed candidates needed them)';
      }
    } }

  const feed={generatedAt:U.now(),generatedAtIso:new Date().toISOString(),
    scanner:'solana-radar-server',runner:'cloudflare-worker-cron',
    engineSource:'index.html embedded engine, extracted verbatim at run time',
    buildMarker:E.BUILD_MARKER,appVersion:E.APP_VERSION,scoreVersion:E.SCORE_VERSION,
    riskPolicyVersion:E.RISK_POLICY_VERSION,thresholdsVersion:E.THRESHOLDS_VERSION,
    cycle,cycleStartedAt:cycleStart,cycleDurationMs:U.now()-cycleStart,
    schedule:'every 5 min via Cloudflare Workers cron (free tier, keyless data) — runs whether or not any tab is open. Backstop: GitHub Actions cron (requested every 5 min; GitHub delays it in practice — observed every 2-3 h). When it runs it skips while this worker is healthy with dexscreener LIVE, and covers discovery from separate egress IPs during dexscreener 429 cooldowns or worker outages.',
    engineDrift:drift,
    stateRestored:restored,
    sources:srcList,
    counters:S.diag.counters,counts,
    analyzedThisCycle:analyzed,signalMarksTracked:marksTracked,
    newSignalsThisCycle:newSignals.map(publicSignal),
    recentSignals:signals,topCandidates:top,
    errors:errors.slice(0,20),
    notes:['PAPER ONLY — research signals, not financial advice, never executable trades.',
      'Engine code is the in-tab scanner engine extracted verbatim from index.html into a static bundle (hash-checked every cycle against the live page; drift is labelled, never silent); rules unchanged.',
      'Signal price is frozen at signal time; lastPrice/multiple are observed Dexscreener marks, not executable fills.',
      'Candidates idle >72h without an unconsumed signal are evicted (state hygiene); signals and wallets bounded.']};

  feed.driver='worker-budget-v2 2026-10-17';
  feed.phaseMs=phaseT;
  feed.dexBackoffUntil=dexBackoffUntil||null;
  feed.dexBackoffStrikes=dexStrikes||0;
  feed.dex429Streak=dex429Streak||0;
  feed.stateReadError=stateFetchError;
  feed.subrequests=subCount;
  feed.subPhases=subPhases;
  feed.notes.push('Driver enforces hard per-phase time budgets and always writes this heartbeat feed, even when a data source stalls; a stalled source is labelled in errors, never silent.');

  /* when our dex is in 429 cooldown and the GitHub backstop just wrote a fresh cycle
     with dexscreener LIVE, inherit its dex row so the page shows one stable truth.
     dexBackoffUntil stays in the feed, so the backstop keeps covering discovery
     until our own cooldown expires. */
  if(dexBackoffUntil>Date.now()){
    try{
      const curRaw=await withTimeout(gh(env,'GET',FEED_PATH,null,true),8000,'feed read');
      const cj=curRaw&&JSON.parse(curRaw);
      const cdex=cj&&Array.isArray(cj.sources)?cj.sources.find(s=>s.id==='dexscreener'):null;
      if(cj&&cj.runner==='github-actions-backstop'&&cdex&&cdex.status==='LIVE'&&(Date.now()-(cj.generatedAt||0))<12*60*1000){
        const fd=feed.sources.find(s=>s.id==='dexscreener');
        if(fd){ fd.status='LIVE'; fd.note='via GitHub backstop (its cycle '+cj.cycle+', '+Math.round((Date.now()-cj.generatedAt)/60000)+' min ago) while worker dex in 429 cooldown ('+Math.ceil((dexBackoffUntil-Date.now())/60000)+' min left)'; delete fd.lastError; }
      }
    }catch(e){ /* keep this worker's own dex row */ }
  }

  const stateOut=JSON.stringify({schema:1,savedAt:U.now(),cycleBase:cycle,
    counters:S.diag.counters,rejectReasons:S.diag.rejectReasons,
    candidates:[...S.candidates.values()],wallets:[...S.wallets.values()],signals:[...S.signals.values()],
    scoreHistory:S.scoreHistory.slice(-200),milestones,dexBackoffUntil:dexBackoffUntil||0,dexBackoffStrikes:dexStrikes||0,dex429Streak:dex429Streak||0});

  /* never overwrite good state with a blank one after a failed state read */
  if(lastWriteError){ feed.errors=feed.errors||[]; feed.errors.push('previous cycle: '+lastWriteError); feed.previousWriteError=lastWriteError; }
  const ok1=stateFetchError?(console.log('state write SKIPPED - state read failed:',stateFetchError),false)
    :await putFile(env,STATE_PATH,stateOut,'radar-server: state cycle '+cycle+' (worker)');
  feed.stateWritten=ok1;
  const ok2=await putFile(env,FEED_PATH,JSON.stringify(feed,null,1),'radar-server: scan cycle '+cycle+' '+new Date().toISOString()+' (worker)');
  lastWriteError=(!ok1||!ok2)?('cycle '+cycle+' github write failed (state:'+ok1+' feed:'+ok2+') - one heartbeat lost, writes retried next cycle'):null;
  console.log('worker cycle',cycle,'ok · restored',restored,'· candidates',counts.total,'· new signals',newSignals.length,'· marks',marksTracked,'· state write',ok1,'· feed write',ok2,'· sources',REG.all().map(s=>s.id+':'+s.status).join(','));
}

export default{
  async scheduled(event,env,ctx){ ctx.waitUntil(runCycle(env).catch(e=>console.log('cycle error',e&&e.message||e))); },
  async fetch(req,env){ return new Response(JSON.stringify({ok:true,service:'jk-radar-scanner',note:'cron-only worker; no manual trigger. Feed: '+FEED_PATH}),{headers:{'Content-Type':'application/json'}}); }
};
