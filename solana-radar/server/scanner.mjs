/* ============================================================
   SOLANA EARLY-WALLET RADAR — 24/7 SERVER SCANNER (paper only)
   Runs the EXACT engine code embedded in ../index.html
   (extracted between stable anchors, never edited here), on a
   5-minute GitHub Actions schedule. Keyless public data only
   (Dexscreener / RugCheck / public Solana RPC). No real money,
   no wallet signing, no keys. Engine rules are NOT changed:
   same discovery, validation, risk gates, scoring and v4 open
   entry qualification as the in-tab scanner.
   Driver-level (non-engine) differences vs the browser tab:
   - one pipeline cycle per run instead of a 10s loop
   - state persisted to server/state.json between runs
   - candidates idle >72h without an unconsumed signal are
     evicted (same as a fresh browser profile; prevents
     unbounded growth and stale candidates hogging analysis)
   - observational milestone marks (2x/3x/5x/10x vs the frozen
     signal price) refreshed for recent signals each cycle —
     observed marks, never executable fills
   Output: ../server-scan.json (public feed the page mirrors)
   ============================================================ */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE=dirname(fileURLToPath(import.meta.url));
const PAGE=join(HERE,'..','index.html');
const FEED=join(HERE,'..','server-scan.json');
const STATE=join(HERE,'state.json');
const DEADLINE=Date.now()+6.5*60*1000; // hard stop inside the 9-min job window

/* ---------- extract the engine verbatim from index.html ---------- */
function extractEngine(){
  const html=readFileSync(PAGE,'utf8');
  const a=html.indexOf('const BUILD_MARKER=');
  const b=html.indexOf('class PersistenceEngine');
  if(a<0||b<0||b<=a)throw new Error('engine anchors not found in index.html — refusing to run a partial copy');
  return html.slice(a,b);
}
function loadEngine(){
  const code=extractEngine();
  const documentStub={getElementById:()=>({textContent:'',style:{},classList:{add(){},remove(){}}})};
  const factory=new Function('document','window','navigator',
    code+'\n;return {U,DEFAULT_SETTINGS,S,REG,RPC,DEX,DISCOVERY,VALIDATOR,WALLETS,CLUSTERS,RISK,SCORER,QUAL,PORT,MONITOR,APP_VERSION,SCORE_VERSION,RISK_POLICY_VERSION,THRESHOLDS_VERSION,BUILD_MARKER};');
  return factory(documentStub,{},{});
}

const E=loadEngine();
const {U,S,REG,DISCOVERY,DEX,WALLETS,CLUSTERS,RISK,SCORER,QUAL,VALIDATOR,RPC}=E;

/* ---------- persistent state (driver-level, engine shapes kept) ---------- */
function loadState(){
  let st=null;
  try{ st=JSON.parse(readFileSync(STATE,'utf8')); }catch(e){ st=null; }
  if(!st||st.schema!==1)return {restored:false,cycleBase:0,milestones:{}};
  try{
    for(const c of st.candidates||[])S.candidates.set(c.mint,c);
    for(const w of st.wallets||[])S.wallets.set(w.address,w);
    for(const g of st.signals||[])S.signals.set(g.id,g);
    S.scoreHistory=st.scoreHistory||[];
    if(st.counters)S.diag.counters=st.counters;
    if(st.rejectReasons)S.diag.rejectReasons=st.rejectReasons;
    return {restored:true,cycleBase:st.cycleBase||0,milestones:st.milestones||{},
      carry:{dexBackoffUntil:st.dexBackoffUntil||0,dexBackoffStrikes:st.dexBackoffStrikes||0,
        dex429Streak:st.dex429Streak||0,lastBackstopTriggerAt:st.lastBackstopTriggerAt||0}};
  }catch(e){ console.log('state restore failed, starting clean:',e.message); return {restored:false,cycleBase:0,milestones:{}}; }
}
function saveState(extra){
  const candidates=[...S.candidates.values()];
  const wallets=[...S.wallets.values()];
  const signals=[...S.signals.values()];
  mkdirSync(HERE,{recursive:true});
  writeFileSync(STATE,JSON.stringify({schema:1,savedAt:U.now(),cycleBase:extra.cycle,
    counters:S.diag.counters,rejectReasons:S.diag.rejectReasons,
    candidates,wallets,signals,scoreHistory:S.scoreHistory.slice(-200),
    milestones:extra.milestones,
    dexBackoffUntil:extra.carry.dexBackoffUntil||0,dexBackoffStrikes:extra.carry.dexBackoffStrikes||0,
    dex429Streak:extra.carry.dex429Streak||0,lastBackstopTriggerAt:extra.carry.lastBackstopTriggerAt||0}));
}

/* ---------- state hygiene (driver-level): bound growth ---------- */
function evict(){
  const cut=U.now()-72*3600*1000;
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
  }
}

/* ---------- one pipeline cycle (BOOT.scanNow equivalent, no UI/AUTO/local book) ---------- */
async function analyzeOne(mint){
  const c=S.candidates.get(mint); if(!c)return null;
  if(!c.rugcheck||(U.now()-c.rugcheck.fetchedAt)>10*60*1000){
    try{ c.rugcheck=await DEX.rugcheckReport(mint); c.fieldMeta.rugcheck={source:'rugcheck',observedAt:c.rugcheck.fetchedAt,status:'LIVE'}; }
    catch(e){ c.fieldMeta.rugcheck={source:'rugcheck',observedAt:U.now(),status:'ERROR'}; c.rugcheckError=String(e.message||e).slice(0,120); }
  }
  if(c.rugcheck){
    WALLETS.harvestFromToken(c);
    const recs=(c.rugcheck.topHolders||[]).filter(h=>h.address&&!h.insider).slice(0,S.settings.walletResearchPerCandidate||5);
    for(const h of recs){ if(Date.now()>DEADLINE)break; try{ await WALLETS.researchWallet(h.address); }catch(e){} }
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

async function refreshSignalMarks(milestones){
  const cut=U.now()-48*3600*1000;
  const recent=[...S.signals.values()].filter(g=>g.createdAt>cut).sort((a,b)=>b.createdAt-a.createdAt).slice(0,25);
  if(!recent.length)return {tracked:0};
  const mints=[...new Set(recent.map(g=>g.mint))];
  let prices={};
  try{ prices=await DISCOVERY.refreshPricesFor(mints); }catch(e){ return {tracked:0,error:String(e.message||e).slice(0,120)}; }
  let tracked=0;
  for(const g of recent){
    const pr=prices[g.mint];
    if(!pr||!pr.ok||pr.priceUsd==null)continue;
    tracked++;
    g.lastPrice=pr.priceUsd; g.lastPriceAt=pr.observedAt;
    g.multiple=g.signalPriceUsd?Math.round(pr.priceUsd/g.signalPriceUsd*100)/100:null;
    const ml=milestones[g.id]=milestones[g.id]||{hit:[]};
    if(g.multiple!=null&&g.multiple<=0.5&&!g.dumpHit)g.dumpHit={at:U.now(),price:pr.priceUsd,multiple:g.multiple};
      if(g.multiple!=null)for(const x of [1.5,2,3,5,10]){
      if(g.multiple>=x&&!ml.hit.find(h=>h.x===x))ml.hit.push({x,at:U.now(),price:pr.priceUsd});
    }
    g.milestonesHit=ml.hit;
  }
  return {tracked};
}

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

/* ---------- main ---------- */
/* backstop only: if the Cloudflare worker's heartbeat feed is fresh (<12 min),
   step aside — the worker is the primary 24/7 scanner. */
try{
  const cur=JSON.parse(readFileSync(FEED,'utf8'));
  const ageMin=cur&&cur.generatedAt?(Date.now()-cur.generatedAt)/60000:1e9;
  const dex=cur&&Array.isArray(cur.sources)?cur.sources.find(s=>s.id==='dexscreener'):null;
  const dexLive=dex&&dex.status==='LIVE';
  const cooldown=cur&&cur.dexBackoffUntil&&cur.dexBackoffUntil>Date.now();
  if(ageMin<12&&dexLive&&!cooldown){
    console.log('backstop skipped: worker heartbeat fresh, dexscreener LIVE, no cooldown armed (cycle '+cur.cycle+', '+Math.round(ageMin)+' min old)');
    process.exit(0);
  }
  if(cur&&cur.runner==='github-actions-backstop'&&ageMin<8){
    console.log('backstop skipped: another backstop cycle ran '+Math.round(ageMin)+' min ago (self-throttle)');
    process.exit(0);
  }
  console.log('backstop ACTIVE: '+(ageMin>=12?('worker heartbeat stale ('+Math.round(ageMin)+' min)'):(cooldown?('worker dexscreener in 429 cooldown until '+new Date(cur.dexBackoffUntil).toISOString()):('worker heartbeat fresh but dexscreener '+(dex?dex.status:'unknown'))))+' — covering from GitHub IPs');
}catch(e){ console.log('backstop ACTIVE: no readable feed ('+e.message+')'); }

const st=loadState();
const cycle=st.cycleBase+1;
const cycleStart=U.now();
const newSignals=[];
S.on('signal',g=>newSignals.push(g));
const errors=[];
try{
  const r=await DISCOVERY.runCycle();
  if(r&&r.errors&&r.errors.length)errors.push(...r.errors.map(e=>'discovery: '+e));
}catch(e){ errors.push('discovery cycle: '+(e.message||e)); }
let analyzed=0;
for(const c of S.candidates.values()){
  if(analyzed>=S.settings.maxRugcheckPerCycle)break;
  if(Date.now()>DEADLINE){ errors.push('deadline reached — remaining candidates deferred to next cycle'); break; }
  // only candidates whose market data was refreshed in THIS cycle (driver scheduling, engine unchanged)
  if((c.updatedAt||0)<cycleStart)continue;
  if(c.state==='DISCOVERED'||(c.state==='DATA_INCOMPLETE'&&c.market)){
    try{ await analyzeOne(c.mint); analyzed++; }catch(e){ errors.push('analyze '+U.short(c.mint)+': '+(e.message||e)); }
  }
}
const markRes=await refreshSignalMarks(st.milestones);
evict();

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

const feed={generatedAt:U.now(),generatedAtIso:new Date().toISOString(),
  scanner:'solana-radar-server',runner:'github-actions-backstop',engineSource:'index.html embedded engine, extracted verbatim at run time',
  buildMarker:E.BUILD_MARKER,appVersion:E.APP_VERSION,scoreVersion:E.SCORE_VERSION,
  riskPolicyVersion:E.RISK_POLICY_VERSION,thresholdsVersion:E.THRESHOLDS_VERSION,
  cycle,cycleStartedAt:cycleStart,cycleDurationMs:U.now()-cycleStart,
  schedule:'BACKSTOP via GitHub Actions (keyless, free tier) — runs only when the Cloudflare worker heartbeat is stale (>12 min); primary 24/7 scanner is the Cloudflare worker',
  stateRestored:st.restored,
  sources:REG.all().map(s=>({id:s.id,label:s.label,status:s.status,lastSuccess:s.lastSuccess,lastError:s.lastError,
    requestCount:s.requestCount,rateLimitCount:s.rateLimitCount})),
  counters:S.diag.counters,counts,
  analyzedThisCycle:analyzed,signalMarksTracked:markRes.tracked,
  newSignalsThisCycle:newSignals.map(publicSignal),
  recentSignals:signals,topCandidates:top,
  errors:errors.slice(0,20),
  notes:['PAPER ONLY — research signals, not financial advice, never executable trades.',
    'Engine code is the in-tab scanner engine extracted verbatim from index.html at run time; rules unchanged.',
    'Signal price is frozen at signal time; lastPrice/multiple are observed Dexscreener marks, not executable fills.',
    'Candidates idle >72h without an unconsumed signal are evicted (state hygiene); signals and wallets bounded.']};
writeFileSync(FEED,JSON.stringify(feed,null,1));
saveState({cycle,milestones:st.milestones,carry:st.carry||{}});
console.log('cycle',cycle,'ok · candidates',counts.total,'· signals(lifetime)',S.diag.counters.signals,'· new this cycle',newSignals.length,'· marks',markRes.tracked,'· sources',REG.all().map(s=>s.id+':'+s.status).join(','));
if(errors.length)console.log('errors:',errors.slice(0,6).join(' | '));
