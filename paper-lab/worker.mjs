// ===== ENGINE (pure, testable) =====
const CFG_DEFAULT={start:500,bet:20,maxOpen:10,friction:0.03,auto:true,minScore:62,
 minLiq:8000,maxMc:3000000,minAgeMin:8,maxAgeH:36,stop:0.70,tp2:0.40,tp3:0.30,timeStopH:12,rugLiq:3000,scanSec:45};
function pickPair(pairs){let b=null;for(const p of pairs||[]){if(p.chainId!=='solana')continue;if(!b||(p.liquidity&&p.liquidity.usd||0)>(b.liquidity&&b.liquidity.usd||0))b=p;}return b}
function evalCoin(p,C,now){
 const liq=p.liquidity&&p.liquidity.usd||0,mc=p.marketCap||p.fdv||0,vol=p.volume||{},tx=p.txns||{},pc=p.priceChange||{};
 const ageMin=p.pairCreatedAt?(now-p.pairCreatedAt)/60000:null;
 const m5b=tx.m5?tx.m5.buys:0,m5s=tx.m5?tx.m5.sells:0,h1b=tx.h1?tx.h1.buys:0,h1s=tx.h1?tx.h1.sells:0;
 const buy5=(m5b+m5s)?m5b/(m5b+m5s):0.5,buy1=(h1b+h1s)?h1b/(h1b+h1s):0.5;
 const gates=[];
 gates.push(['Liquidity >= $'+C.minLiq,liq>=C.minLiq]);
 gates.push(['MCap <= $'+(C.maxMc/1e6)+'M',mc>0&&mc<=C.maxMc]);
 gates.push(['Age '+C.minAgeMin+'m-'+C.maxAgeH+'h',ageMin!==null&&ageMin>=C.minAgeMin&&ageMin<=C.maxAgeH*60]);
 gates.push(['Buys > sells (5m)',buy5>=0.55]);
 gates.push(['Not already vertical (1h < +400%)',(pc.h1||0)<400]);
 gates.push(['Liq/MCap >= 4%',mc>0&&liq/mc>=0.04]);
 const pass=gates.every(g=>g[1]);
 // headroom: how far mcap can plausibly run (target ceiling $5M)
 const headroom=mc>0?Math.min(10,5e6/mc):0;
 let s=0;const why=[];
 const mom=Math.max(0,Math.min(1,((pc.m5||0)+5)/30)); s+=mom*20; if(pc.m5>3)why.push('5m +'+Math.round(pc.m5)+'%');
 const hm=(pc.h1||0); const h1s_=hm>=10&&hm<=150?1:hm>150&&hm<400?0.5:hm>0?0.4:0; s+=h1s_*15; if(hm>=10)why.push('1h +'+Math.round(hm)+'%');
 s+=Math.max(0,Math.min(1,(buy5-0.5)/0.3))*15; if(buy5>=0.6)why.push('buyers '+Math.round(buy5*100)+'% (5m)');
 s+=Math.max(0,Math.min(1,(buy1-0.5)/0.25))*8;
 const turn=liq?(vol.h1||0)/liq:0; s+=Math.max(0,Math.min(1,turn/3))*12; if(turn>=1)why.push('vol/liq '+turn.toFixed(1)+'x');
 s+=Math.max(0,Math.min(1,(headroom-1)/4))*15; if(headroom>=3)why.push('room to '+headroom.toFixed(1)+'x');
 s+=Math.max(0,Math.min(1,(Math.log10(Math.max(liq,1))-3.8)/1.2))*10;
 const txc=(tx.m5?tx.m5.buys+tx.m5.sells:0); s+=Math.max(0,Math.min(1,txc/150))*5;
 if(ageMin!==null&&ageMin<20)s-=6; // very new = riskier
 s=Math.round(Math.max(0,Math.min(100,s)));
 let tier=null;
 if(headroom>=5&&s>=C.minScore+6)tier='5x';else if(headroom>=3&&s>=C.minScore)tier='3x';else if(headroom>=2&&s>=C.minScore-6)tier='2x';
 return {score:s,tier,headroom,gates,pass,why,liq,mc,ageMin,buy5,price:parseFloat(p.priceUsd)||0};
}
function newPos(coin,price,C,now,tier,score){
 const eff=price*(1+C.friction),cost=C.bet;
 return {id:coin.mint+'_'+now,mint:coin.mint,sym:coin.sym,name:coin.name,entry:price,entryEff:eff,entryTime:now,cost,units:cost/eff,rem:cost/eff,
  banked:0,tp2:false,tp3:false,tp5:false,peak:1,trough:1,stop:C.stop,tier,score,open:true,last:price,mult:1,events:[{t:now,e:'BUY',m:1,u:cost}]};
}
// manage one position given fresh price/liq; returns array of events, mutates pos
function managePos(pos,price,liq,now,C){
 const ev=[];if(!pos.open||!(price>0))return ev;
 pos.last=price;if(liq!=null)pos.lastLiq=liq;pos.mult=price/pos.entry;if(pos.mult>pos.peak)pos.peak=pos.mult;if(pos.trough==null||pos.mult<pos.trough)pos.trough=pos.mult;
 const sell=(frac,why)=>{const u=pos.rem*frac;const v=u*price*(1-C.friction);pos.rem-=u;pos.banked+=v;ev.push({t:now,e:why,m:pos.mult,u:v});};
 const closeAll=(why,val)=>{const v=val===undefined?pos.rem*price*(1-C.friction):val;pos.banked+=v;pos.rem=0;pos.open=false;pos.exitTime=now;pos.reason=why;pos.exitMult=pos.mult;ev.push({t:now,e:why,m:pos.mult,u:v});};
 if(liq!==null&&liq<C.rugLiq){closeAll('RUG',0);}
 else{
  if(pos.mult>=2&&!pos.tp2){pos.tp2=true;sell(C.tp2,'TP 2x');pos.stop=Math.max(pos.stop,1.0);}
  if(pos.mult>=3&&!pos.tp3){pos.tp3=true;sell(C.tp3/(1-C.tp2),'TP 3x');pos.stop=Math.max(pos.stop,2.0);}
  if(pos.mult>=5&&!pos.tp5&&pos.open){pos.tp5=true;closeAll('TP 5x');}
  if(pos.open&&pos.tp2){pos.stop=Math.max(pos.stop,pos.peak*0.65>=1?pos.peak*0.65:pos.stop);}
  if(pos.open&&pos.mult<=pos.stop){closeAll(pos.tp2?'TRAIL/BE STOP':'STOP');}
  else if(pos.open&&(now-pos.entryTime)/3600000>=C.timeStopH&&pos.mult<1.3){closeAll('TIME STOP');}
 }
 pos.pnl=pos.banked+(pos.open?pos.rem*price*(1-C.friction):0)-pos.cost;
 return ev;
}
function summarize(st){
 let cash=st.cfg.start,openVal=0,realised=0,bank=0;
 for(const p of st.pos){cash-=p.cost;cash+=p.banked;if(p.open)openVal+=p.rem*p.last*(1-st.cfg.friction);
  if(!p.open){const r=p.banked-p.cost;realised+=r;if(r>0)bank+=r;}}
 return {cash,openVal,equity:cash+openVal,realised,bank,pnl:cash+openVal-st.cfg.start};
}
function dayKey(t){return new Date(t).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'})}
function dayWise(st){const m={};for(const p of st.pos)if(!p.open){const d=dayKey(p.exitTime);m[d]=m[d]||{pnl:0,n:0,w:0};const r=p.banked-p.cost;m[d].pnl+=r;m[d].n++;if(r>0)m[d].w++;}return m}

// ===== WORKER =====
const DX='https://api.dexscreener.com';
async function jget(u){const r=await fetch(u);if(!r.ok)throw new Error(u.split('/')[3]+' '+r.status);return r.json()}
async function discover(){
 const all=[()=>jget(DX+'/token-profiles/latest/v1'),()=>jget(DX+'/token-boosts/latest/v1'),()=>jget(DX+'/token-boosts/top/v1'),()=>jget(DX+'/latest/dex/search?q=pumpswap%20solana'),()=>jget(DX+'/latest/dex/search?q=pump.fun%20solana'),()=>jget(DX+'/latest/dex/search?q=raydium%20solana')];
 const k=Math.floor(Date.now()/120000)%2;const src=await Promise.allSettled(all.filter((_,i)=>i%2===k).map(f=>f()));
 const set=new Set(),pairs=[];
 src.forEach(s=>{if(s.status!=='fulfilled')return;const v=s.value;if(Array.isArray(v))v.forEach(x=>x.chainId==='solana'&&set.add(x.tokenAddress));else (v.pairs||[]).forEach(p=>{if(p.chainId==='solana'){set.add(p.baseToken.address);pairs.push(p)}})});
 if(!src.some(s=>s.status==='fulfilled'))throw new Error('all sources failed: '+src.map(s=>s.reason&&s.reason.message).join(' | '));
 return {addrs:[...set],pairs};
}
async function fetchTokens(addrs){const out=[];for(let i=0;i<addrs.length;i+=30){try{out.push(...await jget(DX+'/tokens/v1/solana/'+addrs.slice(i,i+30).join(',')))}catch(e){}}return out}
const GT='https://api.geckoterminal.com/api/v2/networks/solana/tokens/';
async function fetchFallback(mints){const out={};for(const m of mints){try{const r=await jget(GT+m+'/pools');const pools=r&&r.data||[];
 if(!pools.length)continue;pools.sort((a,b)=>parseFloat(b.attributes.reserve_in_usd||0)-parseFloat(a.attributes.reserve_in_usd||0));
 const a=pools[0].attributes;out[m]={price:parseFloat(a.base_token_price_usd)||0,liq:parseFloat(a.reserve_in_usd)||0}}catch(e){}}return out}
function groupByMint(pairs){const g={};for(const p of pairs){const m=p.baseToken&&p.baseToken.address;if(!m)continue;(g[m]=g[m]||[]).push(p)}return g}
async function run(env){
 const raw=await env.BOOK.get('book');const ST=raw?JSON.parse(raw):{cfg:{...CFG_DEFAULT},pos:[],created:Date.now()};
 ST.cfg=Object.assign({},CFG_DEFAULT,ST.cfg);const now=Date.now();
 try{
  let d={addrs:[],pairs:[]},derr=null;try{d=await discover()}catch(e){derr=String(e.message||e)}
  const openM=ST.pos.filter(p=>p.open).map(p=>p.mint);
  const addrs=[...new Set([...openM,...d.addrs])].slice(0,100);
  const prs=await fetchTokens(addrs);const g=groupByMint(prs.concat(d.pairs));
  for(const p of ST.pos.filter(x=>x.open)){const b=pickPair(g[p.mint]);if(!b)continue;const ev=managePos(p,parseFloat(b.priceUsd)||0,b.liquidity?b.liquidity.usd:null,now,ST.cfg);if(ev.length)p.events.push(...ev);}
  // fallback: keyless GeckoTerminal pricing for open positions Dexscreener missed (e.g. 429)
  const missing=ST.pos.filter(x=>x.open&&!pickPair(g[x.mint])).map(x=>x.mint);
  let fbUsed=0;
  if(missing.length){const fb=await fetchFallback(missing);
   for(const p of ST.pos.filter(x=>x.open)){const f=fb[p.mint];if(!f)continue;const ev=managePos(p,f.price,f.liq,now,ST.cfg);if(ev.length)p.events.push(...ev);if(f.price>0)fbUsed++;}}
  if(!derr){
   const R=[];
   for(const m of Object.keys(g)){const b=pickPair(g[m]);if(!b||!b.baseToken)continue;const e=evalCoin(b,ST.cfg,now);R.push({mint:m,sym:b.baseToken.symbol,name:b.baseToken.name,pair:{priceChange:b.priceChange,volume:{h1:b.volume&&b.volume.h1}},e});}
   R.sort((a,b)=>(b.e.pass-a.e.pass)||(b.e.score-a.e.score));ST.radar=R.slice(0,40);
   if(ST.cfg.auto){for(const c of R){if(!(c.e.pass&&c.e.tier&&c.e.score>=ST.cfg.minScore-6))continue;
    if(ST.pos.filter(x=>x.open).length>=ST.cfg.maxOpen)break;
    if(ST.pos.some(x=>x.mint===c.mint&&(x.open||now-x.entryTime<6*3600e3)))continue;
    if(summarize(ST).cash<ST.cfg.bet)break;
    const p=newPos({mint:c.mint,sym:c.sym,name:c.name},c.e.price,ST.cfg,now,c.e.tier,c.e.score);p.auto=true;p.why=c.e.why;p.entryMc=c.e.mc;p.entryLiq=c.e.liq;ST.pos.push(p);}}
  }
  // on degraded discovery: keep last good radar, keep managing positions, no new entries
  if(!derr||prs.length||fbUsed)ST.lastScan=now;
  ST.err=derr?('dex discovery limited ('+derr+'); radar kept from last good scan; positions via '+(fbUsed?'gecko fallback':(prs.length?'dex tokens':'no price source - paused'))):null;
  ST.fb=(ST.fb||0)+fbUsed;
 }catch(e){ST.err=String(e.message||e)}
 ST.server=true;ST.runs=(ST.runs||0)+1;
 await env.BOOK.put('book',JSON.stringify(ST));return ST;
}
const CORS={'access-control-allow-origin':'*','content-type':'application/json','cache-control':'no-store'};
export default{
 async scheduled(ev,env,ctx){ctx.waitUntil(run(env))},
 async fetch(req,env,ctx){
  const u=new URL(req.url);
  if(u.pathname==='/api/book'){const raw=await env.BOOK.get('book');return new Response(raw||JSON.stringify({cfg:CFG_DEFAULT,pos:[],radar:[],server:true,empty:true}),{headers:CORS})}
  if(u.pathname==='/api/run'){const raw=await env.BOOK.get('book');const b=raw?JSON.parse(raw):{};if(b.lastScan&&Date.now()-b.lastScan<60000)return new Response(JSON.stringify({skipped:'scanned <60s ago'}),{headers:CORS});const r=await run(env);return new Response(JSON.stringify({ran:true,err:r.err,open:r.pos.filter(p=>p.open).length}),{headers:CORS})}
  if(u.pathname==='/api/health'){const raw=await env.BOOK.get('book');const b=raw?JSON.parse(raw):{};return new Response(JSON.stringify({ok:true,lastScan:b.lastScan||null,runs:b.runs||0,err:b.err||null,open:(b.pos||[]).filter(p=>p.open).length}),{headers:CORS})}
  return new Response('JK Paper Lab server. Paper only. /api/book /api/health',{headers:{'content-type':'text/plain'}});
 }
};
