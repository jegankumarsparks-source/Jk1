const LEVELS=[2,3,5,10,20,30];
const mintValid=m=>typeof m==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m);
function discovered(raw,at){if(!mintValid(raw.mint))return null;return {mint:raw.mint,symbol:String(raw.symbol||'Unnamed token').slice(0,40),discoveredAt:at,source:raw.source||'PumpPortal creation feed',signature:raw.signature||null,unverified:true,series:{},latest:null,missingSince:null,hits:[],dumpObserved:false};}
function applyMark(c,m,at){
 if(!Number.isFinite(m.cap)||m.cap<=0||!m.series)return [];
 const b=c.series[m.series]??={first:m.cap,at,hits:[],peak:m.cap,low:m.cap};
 b.peak=Math.max(b.peak,m.cap);b.low=Math.min(b.low,m.cap);
 const multiple=m.cap/b.first,events=[];
 for(const n of LEVELS)if(multiple>=n&&!b.hits.includes(n)){b.hits.push(n);events.push({type:'MILESTONE',level:n,multiple,at,baseline:b.first,baselineAt:b.at,mark:m});}
 if(multiple<=0.5&&!b.dump){b.dump=true;c.dumpObserved=true;events.push({type:'DUMP_OBSERVED',multiple,at,baseline:b.first,baselineAt:b.at,mark:m});}
 c.latest={...m,at,multiple,baseline:b.first,baselineAt:b.at};c.missingSince=null;
 for(const e of events)c.hits.push({type:e.type,level:e.level||null,at,series:m.series,multiple});
 return events;
}
const moneyFormat=new Intl.NumberFormat('en-US',{maximumFractionDigits:2});
const money=n=>Number.isFinite(n)?'$'+moneyFormat.format(n):'NOT OBSERVED';
function card(c,event){const m=event.mark||c.latest,b=m?.baseline??event.baseline,t=m?.baselineAt??event.baselineAt;
 const iso=n=>new Date(n).toISOString();
 return [`${event.type==='DISCOVERY'?'NEW COIN OBSERVED':event.type==='DUMP_OBSERVED'?'DUMP OBSERVED':event.level+'x MARK OBSERVED'} - UNVERIFIED`,
 `Token: ${c.symbol}`,`CA: ${c.mint}`,`Detected: ${iso(c.discoveredAt)}`,
 `First observed MCAP: ${money(b)}${t?' at '+iso(t):' (awaiting first reliable mark)'}`,
 `Current MCAP: ${money(m?.cap)}${m?.capSol?' / '+m.capSol.toFixed(3)+' SOL':''}`,
 `Liquidity: ${money(m?.liquidityUsd)}`,`Multiple: ${Number.isFinite(event.multiple??m?.multiple)?(event.multiple??m.multiple).toFixed(2)+'x':'NOT OBSERVED'}`,
 `Source/series: ${m?.series||c.source}`,`Observed: ${iso(event.at)}`,
 `Dexscreener: ${m?.chartUrl||'https://dexscreener.com/solana/'+c.mint}`,`GMGN: https://gmgn.ai/sol/token/${c.mint}`,`Solscan: https://solscan.io/token/${c.mint}`,
 'Informational / paper only. Not buy advice. MCAP marks are not executable returns. Coverage has gaps; losses and missing data are retained.'
 ].join('\n');}

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,opt={}){const r=await fetch(url,{...opt,signal:AbortSignal.timeout(9000)});if(!r.ok)throw Error('source HTTP '+r.status);return r.json();}
async function windowFeed(ms,provider='PumpPortal'){
 const fallback=provider==='PumpDev',url=fallback?'wss://pumpdev.io/ws':'wss://pumpportal.fun/api/data';
 const ws=new WebSocket(url),events=[];let error=false,detail=null,opened=false;
 ws.addEventListener('error',e=>{error=true;detail=String(e.message||e.error?.message||'WebSocket network error').slice(0,240);});
 try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(provider+' WS connect timeout')),12000);const fail=e=>{clearTimeout(timer);reject(Error(provider+' '+(e.message||'WS connect failed')));};ws.addEventListener('open',()=>{opened=true;clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',fail,{once:true});ws.addEventListener('close',e=>{if(!opened){clearTimeout(timer);reject(Error(provider+' WS closed before open '+e.code));}},{once:true});});
 ws.addEventListener('message',e=>{try{const x=JSON.parse(e.data);if(fallback&&x.type==='connectionStatus'&&x.connected===false){error=true;detail='upstream connectionStatus false';}if(x.type==='error'){error=true;detail=String(x.code||x.message||'provider error').slice(0,240);}if(mintValid(x.mint)&&['create','migration'].includes(x.txType)){
 // PumpDev documents marketCapSol/Quote as fully diluted values, not MCAP.
 // Use it for discovery only. Dexscreener supplies separate reliable MCAP marks.
 const item={...x,receivedAt:Date.now(),feedProvider:provider};if(fallback){delete item.marketCapSol;delete item.marketCapQuote;}events.push(item);
 }}catch{}});
 ws.addEventListener('close',e=>{if(opened){error=true;detail??='WS closed '+e.code;}});
 ws.send(JSON.stringify({method:'subscribeNewToken'}));if(!fallback)ws.send(JSON.stringify({method:'subscribeMigration'}));
 await delay(ms);return {events,error,detail,provider};
 }finally{if(ws.readyState===1){try{ws.send(JSON.stringify({method:'unsubscribeNewToken'}));if(!fallback)ws.send(JSON.stringify({method:'unsubscribeMigration'}));}catch{}ws.close();}else if(ws.readyState===0){try{ws.close();}catch{}}}
}
async function rpc(env,op,p={}){if(env.__metrics)env.__metrics.supabaseRequests++;return json(env.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/rpc/signal_alert_rpc',{method:'POST',headers:{'content-type':'application/json',apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY},body:JSON.stringify({op,p})});}
async function claimPriority(env){
 const headers={apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY,'content-type':'application/json'};
 const base=env.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/signal_alert_outbox';
 const read=async filter=>{env.__metrics.supabaseRequests++;return json(base+'?select=id,body&status=eq.PENDING&order=created.asc&limit=60&'+filter,{headers});};
 const priority=await read('body=not.like.NEW%20COIN*');let rows=priority;
 if(rows.length<60){env.__metrics.supabaseRequests++;const newest=await json(base+'?select=id,body&status=eq.PENDING&order=created.desc&limit=1&body=like.NEW%20COIN*',{headers});const launches=await read('body=like.NEW%20COIN*');rows=rows.concat(newest,launches).filter((x,i,a)=>a.findIndex(y=>y.id===x.id)===i).slice(0,60);}
 if(!rows.length)return [];
 env.__metrics.supabaseRequests++;return json(base+'?status=eq.PENDING&id=in.('+rows.map(x=>encodeURIComponent('"'+x.id+'"')).join(',')+')&select=id,body',{method:'PATCH',headers:{...headers,Prefer:'return=representation'},body:JSON.stringify({status:'SENDING'})});
}
async function cycle(env){
 env={...env,__metrics:{supabaseRequests:0}};
 const start=Date.now(),health={start,mode:'INFORMATIONAL_UNVERIFIED',coverage:'INCOMPLETE LAUNCH COVERAGE. Bounded feed windows have gaps. Detection time is not launch time.',sources:{},errors:[],externalCalls:0};
 let lease;const leaseWaitStart=Date.now();do{const now=Date.now();lease=await rpc(env,'lease',{until:now+600000,now});if(lease.acquired)break;if(Date.now()-leaseWaitStart>=360000)return {skipped:'active cycle after bounded360secwait'};await delay(2300);}while(true);health.leaseWaitMs=Date.now()-leaseWaitStart;
 try{
 let sol=null;const candidates=new Map();let dexBackoffUntil=0,telegramCooldownUntil=0;
 try{env.__metrics.supabaseRequests++;const rows=await json(env.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/signal_alert_meta?key=eq.health&select=value',{headers:{apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY}});dexBackoffUntil=Number(rows[0]?.value?.dexBackoffUntil||0);telegramCooldownUntil=Number(rows[0]?.value?.telegramCooldownUntil||0);}catch{}
 const noteDexError=e=>{if(e.message.includes('429'))dexBackoffUntil=Date.now()+20*60000;};
 if(Date.now()>=dexBackoffUntil)try{health.externalCalls++;const p=await json('https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112');const best=p.filter(p=>p.quoteToken?.symbol==='USDC').sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];if(best&&+best.priceUsd>0)sol={price:+best.priceUsd,at:Date.now()};}catch(e){noteDexError(e);health.errors.push('SOL/USD not observed: '+e.message);}
 for(const endpoint of ['token-profiles/latest/v1','token-boosts/latest/v1']){if(Date.now()<dexBackoffUntil){health.sources[endpoint]='RATE LIMIT BACKOFF';continue;}try{health.externalCalls++;const rows=await json('https://api.dexscreener.com/'+endpoint);for(const p of rows)if(p.chainId==='solana'&&mintValid(p.tokenAddress))if(!candidates.has(p.tokenAddress))candidates.set(p.tokenAddress,{mint:p.tokenAddress,source:'Dexscreener '+endpoint,receivedAt:Date.now()});health.sources[endpoint]='OBSERVED';}catch(e){noteDexError(e);health.sources[endpoint]='UNAVAILABLE';health.errors.push(endpoint+': '+e.message);}}
 health.windowStart=Date.now();
 let feed=null;
 try{health.externalCalls++;feed=await windowFeed(Number(env.WINDOW_MS||120000));health.sources.pumpportal=feed.error?'INTERRUPTED':'WINDOW OBSERVED';if(feed.error)health.errors.push('PumpPortal window interrupted: '+(feed.detail||'unknown'));}
 catch(e){health.sources.pumpportal='UNAVAILABLE';health.errors.push('PumpPortal window unavailable: '+String(e.message).slice(0,240));}
 if(!feed){try{health.externalCalls++;feed=await windowFeed(Number(env.WINDOW_MS||120000),'PumpDev');health.sources.pumpdev=feed.error?'INTERRUPTED':'LAUNCH WINDOW OBSERVED';health.migrationCoverage='DEGRADED: PumpDev fallback is new launches only; global migrations unavailable';if(feed.error)health.errors.push('PumpDev window interrupted: '+(feed.detail||'unknown'));}catch(e){health.sources.pumpdev='UNAVAILABLE';health.errors.push('PumpDev fallback unavailable: '+String(e.message).slice(0,240));}}
 if(feed){health.launchFeedProvider=feed.provider;health.launchFeedEvents=feed.events.length;for(const e of feed.events){const old=candidates.get(e.mint);if(!old)candidates.set(e.mint,{...e,markAt:e.receivedAt,source:e.feedProvider+' '+e.txType+' (processed/unconfirmed)'});else if(old.marketCapSol===undefined)candidates.set(e.mint,{...e,...old,marketCapSol:e.marketCapSol,markAt:e.receivedAt,symbol:old.symbol||e.symbol});}}
 health.windowEnd=Date.now();
 const existing=new Map((await rpc(env,'load',{mints:[...candidates.keys()]})).map(c=>[c.mint,c]));
 const old=await json(env.SUPABASE_URL+'/rest/v1/signal_alert_coins?select=data&order=checked.asc&limit=180',{headers:{apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY}});for(const row of old)if(!existing.has(row.data.mint))existing.set(row.data.mint,row.data);
 const newly=[];for(const [m,raw]of candidates){if(!existing.has(m)){const c=discovered(raw,raw.receivedAt||Date.now());existing.set(m,c);newly.push(m);if(sol&&raw.marketCapSol>0)applyMark(c,{cap:raw.marketCapSol*sol.price,capSol:raw.marketCapSol,series:'PUMPPORTAL_CAP_SOL_USD_AT_OBSERVATION',liquidityUsd:null,conversion:sol},raw.markAt||raw.receivedAt);}}
 const market=new Map();const addresses=[...existing.keys()];const scanned=new Set();
 // Four batches maximum keeps the free subrequest budget bounded. Rotation avoids winner-only selection.
 for(let i=0;i<addresses.length;i+=30){if(Date.now()<dexBackoffUntil){health.sources.market='RATE LIMIT BACKOFF';break;}addresses.slice(i,i+30).forEach(m=>scanned.add(m));try{health.externalCalls++;const ps=await json('https://api.dexscreener.com/tokens/v1/solana/'+addresses.slice(i,i+30).join(','));for(const p of ps){if(p.chainId!=='solana')continue;const m=p.baseToken?.address;if(!existing.has(m))continue;const old=market.get(m);if(!old||(p.liquidity?.usd||0)>(old.liquidity?.usd||0))market.set(m,p);}health.sources.market='OBSERVED';}catch(e){noteDexError(e);health.sources.market='UNAVAILABLE';health.errors.push('market: '+e.message);}}
 const coinsToWrite=[],eventsToWrite=[];let eventCount=0;
 for(const [m,c]of existing){const p=market.get(m);const eventList=[];
 if(p){c.symbol=String(p.baseToken?.symbol||c.symbol).slice(0,40);const cap=Number(p.marketCap);if(Number.isFinite(cap)&&cap>0){const series='DEXSCREENER_MARKETCAP_'+p.pairAddress;eventList.push(...applyMark(c,{cap,series,liquidityUsd:Number.isFinite(p.liquidity?.usd)?p.liquidity.usd:null,chartUrl:p.url},Date.now()));}else{c.missingSince??=Date.now();c.markStatus='MARKET CAP NOT OBSERVED (FDV not substituted)';}}
 else{c.missingSince??=Date.now();c.markStatus='MARKET DATA NOT OBSERVED';}
 if(newly.includes(m))eventList.unshift({type:'DISCOVERY',at:c.discoveredAt,mark:c.latest});
 for(const e of eventList){const id=m+':'+e.type+':'+(e.level||0)+':'+(e.mark?.series||'none');eventsToWrite.push({id,mint:m,body:card(c,e),created:e.at});eventCount++;}
 coinsToWrite.push({mint:m,data:c,updated:Date.now(),checked:scanned.has(m)?Date.now():0});
 }
 await rpc(env,'save',{coins:coinsToWrite,events:eventsToWrite});
 health.delivered=0;const deliveryResults=[];
 if(env.TG_TOKEN&&env.TG_CHAT_ID&&env.DELIVERY_ENABLED==='true'){
 // A separate durable key survives a later health-write failure.
 try{env.__metrics.supabaseRequests++;const rows=await json(env.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/signal_alert_meta?key=eq.telegram_cooldown&select=value',{headers:{apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY}});telegramCooldownUntil=Math.max(telegramCooldownUntil,Number(rows[0]?.value?.until||0));}catch(e){health.errors.push('Telegram cooldown check unavailable: '+e.message);telegramCooldownUntil=Math.max(telegramCooldownUntil,Date.now()+60000);}
 health.telegramCooldownUntil=telegramCooldownUntil;
 const due=Date.now()<telegramCooldownUntil?[]:await claimPriority(env);
 for(const e of due){
  let result={id:e.id,status:'DELIVERY_UNKNOWN',delivery:{note:'Network result uncertain; do not auto-resend'}};
  try{health.externalCalls++;const r=await fetch('https://api.telegram.org/bot'+env.TG_TOKEN+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:env.TG_CHAT_ID,text:e.body,disable_web_page_preview:true}),signal:AbortSignal.timeout(8000)});const j=await r.json();
   if(j.ok){result={id:e.id,status:'SENT',delivery:{messageId:j.result.message_id,sentAt:Date.now()}};health.delivered++;}
   else if(r.status===429||j.error_code===429){
    const raw=Number(j.parameters?.retry_after),seconds=Number.isFinite(raw)&&raw>0?Math.ceil(raw):60;
    telegramCooldownUntil=Date.now()+seconds*1000;health.telegramCooldownUntil=telegramCooldownUntil;
    result={id:e.id,status:'PENDING',delivery:{http:429,retryAfterSeconds:seconds,retryAfterProvided:Number.isFinite(raw)&&raw>0,retryNotBefore:telegramCooldownUntil}};
    health.errors.push('Telegram rate limited; remaining batch not attempted; cooldown until '+new Date(telegramCooldownUntil).toISOString());
    for(let attempt=1;attempt<=3;attempt++)try{env.__metrics.supabaseRequests++;await json(env.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/signal_alert_meta?on_conflict=key',{method:'POST',headers:{'content-type':'application/json',apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY,Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({key:'telegram_cooldown',value:{until:telegramCooldownUntil}})});break;}catch(e){if(attempt===3)health.errors.push('Telegram cooldown persistence failed: '+e.message);else await delay(attempt*2000);}
   }else result={id:e.id,status:'BLOCKED',delivery:{http:r.status}};
  }catch{}
  deliveryResults.push(result);
  if(result.delivery?.http===429){for(const remaining of due.slice(deliveryResults.length))deliveryResults.push({id:remaining.id,status:'PENDING',delivery:{notAttempted:true,reason:'Telegram cooldown',retryNotBefore:telegramCooldownUntil}});break;}
  await delay(1100);
 }
 // Preserve exact response receipts before the DB write, so a persistence outage
 // cannot erase Telegram message IDs. This log contains no tokens or message bodies.
 console.log(JSON.stringify({type:'DELIVERY_RECEIPTS',runId:env.GITHUB_RUN_ID||null,events:deliveryResults}));
 let receiptsSaved=false;
 for(let attempt=1;attempt<=3;attempt++){
  try{await rpc(env,'deliveries',{events:deliveryResults});receiptsSaved=true;break;}
  catch(e){console.log(JSON.stringify({type:'RECEIPT_WRITE_FAILED',attempt,error:String(e.message).slice(0,240)}));if(attempt<3)await delay(attempt*2000);}
 }
 health.deliveryReceiptsPersisted=receiptsSaved;
 if(!receiptsSaved)health.errors.push('DELIVERY RECEIPTS NOT PERSISTED: do not resend SENDING rows; recover exact receipts from DELIVERY_RECEIPTS run log');
 }
 health.runtime='GITHUB_ACTIONS';health.trigger=env.GITHUB_EVENT_NAME||'UNKNOWN';try{const ds=await json(env.SUPABASE_URL+'/rest/v1/signal_alert_meta?key=eq.dispatch&select=value',{headers:{apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY}});const d=ds[0]?.value;if(d?.accepted&&d.at<=start&&start-d.at<180000)health.scheduler={type:'CLOUDFLARE_CRON',scheduledAt:d.scheduledAt,acceptedAt:d.at};}catch{}health.runId=env.GITHUB_RUN_ID||null;health.cadence='5 minutes best effort; 120-second feed window with gaps';health.dexBackoffUntil=dexBackoffUntil;health.discovered=newly.length;health.coinsChecked=existing.size;health.eventsQueued=eventCount;health.finishedAt=Date.now();health.durationMs=Date.now()-start;health.deliveryEnabled=env.DELIVERY_ENABLED==='true';health.supabaseRequests=env.__metrics.supabaseRequests+2;health.totalExternalCalls=health.externalCalls+health.supabaseRequests;
 await rpc(env,'health',health);return health;
 }finally{await rpc(env,'release');}
}

const health=await cycle(process.env);console.log(JSON.stringify(health));
