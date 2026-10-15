const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,opt={}){const r=await fetch(url,{...opt,signal:AbortSignal.timeout(9000)});if(!r.ok)throw Error('source HTTP '+r.status);return r.json();}
async function windowFeed(ms){
 // Cloudflare outbound WebSocket is fetch Upgrade, not browser WebSocket constructor.
 const r=await fetch('https://pumpportal.fun/api/data',{headers:{Upgrade:'websocket'}});const ws=r.webSocket;if(!ws)throw Error('feed handshake failed');ws.accept();
 const events=[];let error=false;ws.addEventListener('message',e=>{try{const x=JSON.parse(e.data);if(mintValid(x.mint)&&['create','migration'].includes(x.txType))events.push({...x,receivedAt:Date.now()});}catch{}});
 ws.addEventListener('error',()=>error=true);ws.send(JSON.stringify({method:'subscribeNewToken'}));ws.send(JSON.stringify({method:'subscribeMigration'}));await delay(ms);ws.close();return {events,error};
}
async function rpc(env,op,p={}){if(env.__metrics)env.__metrics.supabaseRequests++;return json(env.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/rpc/signal_alert_rpc',{method:'POST',headers:{'content-type':'application/json',apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY},body:JSON.stringify({op,p})});}
async function claimPriority(env){
 const headers={apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY,'content-type':'application/json'};
 const base=env.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/signal_alert_outbox';
 const read=async filter=>{env.__metrics.supabaseRequests++;return json(base+'?select=id,body&status=eq.PENDING&order=created.asc&limit=10&'+filter,{headers});};
 const priority=await read('body=not.like.NEW%20COIN*');let rows=priority;
 if(rows.length<10)rows=rows.concat((await read('body=like.NEW%20COIN*')).slice(0,10-rows.length));
 if(!rows.length)return [];
 env.__metrics.supabaseRequests++;return json(base+'?status=eq.PENDING&id=in.('+rows.map(x=>encodeURIComponent('"'+x.id+'"')).join(',')+')&select=id,body',{method:'PATCH',headers:{...headers,Prefer:'return=representation'},body:JSON.stringify({status:'SENDING'})});
}
async function cycle(env){
 env={...env,__metrics:{supabaseRequests:0}};
 const start=Date.now(),health={start,mode:'INFORMATIONAL_UNVERIFIED',coverage:'INCOMPLETE LAUNCH COVERAGE. Bounded feed windows have gaps. Detection time is not launch time.',sources:{},errors:[],externalCalls:0};
 const lease=await rpc(env,'lease',{until:start+300000,now:start});if(!lease.acquired)return {skipped:'active cycle'};
 try{
 let sol=null;const candidates=new Map();let dexBackoffUntil=0;
 try{env.__metrics.supabaseRequests++;const rows=await json(env.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/signal_alert_meta?key=eq.health&select=value',{headers:{apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY}});dexBackoffUntil=Number(rows[0]?.value?.dexBackoffUntil||0);}catch{}
 const noteDexError=e=>{if(e.message.includes('429'))dexBackoffUntil=Date.now()+20*60000;};
 if(Date.now()>=dexBackoffUntil)try{health.externalCalls++;const p=await json('https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112');const best=p.filter(p=>p.quoteToken?.symbol==='USDC').sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];if(best&&+best.priceUsd>0)sol={price:+best.priceUsd,at:Date.now()};}catch(e){noteDexError(e);health.errors.push('SOL/USD not observed: '+e.message);}
 for(const endpoint of ['token-profiles/latest/v1','token-boosts/latest/v1']){if(Date.now()<dexBackoffUntil){health.sources[endpoint]='RATE LIMIT BACKOFF';continue;}try{health.externalCalls++;const rows=await json('https://api.dexscreener.com/'+endpoint);for(const p of rows)if(p.chainId==='solana'&&mintValid(p.tokenAddress))if(!candidates.has(p.tokenAddress))candidates.set(p.tokenAddress,{mint:p.tokenAddress,source:'Dexscreener '+endpoint,receivedAt:Date.now()});health.sources[endpoint]='OBSERVED';}catch(e){noteDexError(e);health.sources[endpoint]='UNAVAILABLE';health.errors.push(endpoint+': '+e.message);}}
 health.windowStart=Date.now();
 try{health.externalCalls++;const feed=await windowFeed(Number(env.WINDOW_MS||75000));for(const e of feed.events){const old=candidates.get(e.mint);if(!old)candidates.set(e.mint,{...e,markAt:e.receivedAt,source:'PumpPortal '+e.txType+' (processed/unconfirmed)'});else if(old.marketCapSol===undefined)candidates.set(e.mint,{...e,...old,marketCapSol:e.marketCapSol,markAt:e.receivedAt,symbol:old.symbol||e.symbol});}health.sources.pumpportal=feed.error?'INTERRUPTED':'WINDOW OBSERVED';}catch{health.sources.pumpportal='UNAVAILABLE';health.errors.push('PumpPortal window unavailable');}
 health.windowEnd=Date.now();
 const existing=new Map((await rpc(env,'load',{mints:[...candidates.keys()]})).map(c=>[c.mint,c]));
 const newly=[];for(const [m,raw]of candidates){if(!existing.has(m)){const c=discovered(raw,raw.receivedAt||Date.now());existing.set(m,c);newly.push(m);if(sol&&raw.marketCapSol>0)applyMark(c,{cap:raw.marketCapSol*sol.price,capSol:raw.marketCapSol,series:'PUMPPORTAL_CAP_SOL_USD_AT_OBSERVATION',liquidityUsd:null,conversion:sol},raw.markAt||raw.receivedAt);}}
 const market=new Map();const addresses=[...existing.keys()];const scanned=new Set();
 // Four batches maximum keeps the free subrequest budget bounded. Rotation avoids winner-only selection.
 for(let i=0;i<Math.min(addresses.length,120);i+=30){if(Date.now()<dexBackoffUntil){health.sources.market='RATE LIMIT BACKOFF';break;}addresses.slice(i,i+30).forEach(m=>scanned.add(m));try{health.externalCalls++;const ps=await json('https://api.dexscreener.com/tokens/v1/solana/'+addresses.slice(i,i+30).join(','));for(const p of ps){if(p.chainId!=='solana')continue;const m=p.baseToken?.address;if(!existing.has(m))continue;const old=market.get(m);if(!old||(p.liquidity?.usd||0)>(old.liquidity?.usd||0))market.set(m,p);}health.sources.market='OBSERVED';}catch(e){noteDexError(e);health.sources.market='UNAVAILABLE';health.errors.push('market: '+e.message);}}
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
 const due=await claimPriority(env);
 for(const e of due){
  let result={id:e.id,status:'DELIVERY_UNKNOWN',delivery:{note:'Network result uncertain; do not auto-resend'}};
  try{health.externalCalls++;const r=await fetch('https://api.telegram.org/bot'+env.TG_TOKEN+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:env.TG_CHAT_ID,text:e.body,disable_web_page_preview:true}),signal:AbortSignal.timeout(8000)});const j=await r.json();
   if(j.ok){result={id:e.id,status:'SENT',delivery:{messageId:j.result.message_id,sentAt:Date.now()}};health.delivered++;}
   else result={id:e.id,status:r.status===429?'PENDING':'BLOCKED',delivery:{http:r.status}};
  }catch{}
  deliveryResults.push(result);await delay(1100);
 }
 await rpc(env,'deliveries',{events:deliveryResults});
 }
 health.dexBackoffUntil=dexBackoffUntil;health.discovered=newly.length;health.coinsChecked=existing.size;health.eventsQueued=eventCount;health.finishedAt=Date.now();health.durationMs=Date.now()-start;health.deliveryEnabled=env.DELIVERY_ENABLED==='true';health.supabaseRequests=env.__metrics.supabaseRequests+2;health.totalExternalCalls=health.externalCalls+health.supabaseRequests;
 await rpc(env,'health',health);return health;
 }finally{await rpc(env,'release');}
}
async function dispatchAction(event,env){
 const at=Date.now();let state={at,scheduledAt:event.scheduledTime,cron:event.cron,trigger:'CLOUDFLARE_CRON',workflow:'signal-alert.yml'};
 try{const r=await fetch('https://api.github.com/repos/jegankumarsparks-source/Jk1/actions/workflows/signal-alert.yml/dispatches',{method:'POST',headers:{authorization:'Bearer '+env.GH_DISPATCH_TOKEN,'content-type':'application/json',accept:'application/vnd.github+json','user-agent':'SignalAlert-free-dispatch'},body:JSON.stringify({ref:'main'}),signal:AbortSignal.timeout(10000)});state.http=r.status;state.accepted=r.status===204;}catch{state.accepted=false;state.error='Dispatch network unavailable';}
 await json(env.SUPABASE_URL+'/rest/v1/signal_alert_meta?on_conflict=key',{method:'POST',headers:{apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY,'content-type':'application/json',Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({key:'dispatch',value:state})});console.log(JSON.stringify(state));return state;
}
export default {
 async scheduled(event,env,ctx){if(event.cron==='1-56/5 * * * *')ctx.waitUntil(dispatchAction(event,env));},
 async fetch(request,env){
 const url=new URL(request.url);const headers={'content-type':'application/json','access-control-allow-origin':'https://jegankumarsparks-source.github.io','cache-control':'no-store'};
 if(request.method==='GET'&&url.pathname==='/alerts'){const after=url.searchParams.get('after')||'0';if(!/^\d{1,16}$/.test(after))return new Response('Invalid cursor',{status:400});return new Response(JSON.stringify(await rpc(env,'relay',{after})),{headers});}
 if(request.method==='GET'&&url.pathname==='/data'){
 const data=await rpc(env,'public');const ds=await json(env.SUPABASE_URL+'/rest/v1/signal_alert_meta?key=eq.dispatch&select=value',{headers:{apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY}});data.dispatch=ds[0]?.value||null;const recent=await json(env.SUPABASE_URL.replace(/\/$/,'')+'/rest/v1/signal_alert_coins?select=data&order=data->>discoveredAt.desc&limit=100',{headers:{apikey:env.SUPABASE_SERVICE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_KEY}});data.coins=recent.map(x=>x.data);return new Response(JSON.stringify(data),{headers});}
 if(request.method==='POST'&&url.pathname==='/run'&&request.headers.get('authorization')==='Bearer '+env.ADMIN_TOKEN)return new Response(JSON.stringify(await cycle(env)),{headers});
 return new Response('Not found',{status:404});
 }
};
