// TEST fixtures are synthetic and labelled TEST. They never feed LIVE data.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';
import {classifyTx,WSOL} from '../lib/classify.mjs';import {evaluate} from '../lib/engine.mjs';import {sendTelegram,formatAlert} from '../lib/telegram.mjs';
import {Store} from '../lib/store.mjs';import {runCycle} from '../scan.mjs';import {summarizeRug,marketFromPair} from '../lib/sources.mjs';
const MINT='TESTmint1111111111111111111111111111111111pump';const W1='Wallet1'+'1'.repeat(37),W2='Wallet2'+'2'.repeat(37),W3='Wallet3'+'3'.repeat(37);
const tb=(owner,mint,ui,idx=1)=>({accountIndex:idx,mint,owner,uiTokenAmount:{uiAmountString:String(ui),uiAmount:ui}});
function tx({signer=W1,solDelta=0,fee=5000,pre=[],post=[],err=null,sig='sig'+Math.random(),t=Date.now()/1000-30}){
  return {blockTime:t,transaction:{signatures:[sig],message:{accountKeys:[{pubkey:signer},{pubkey:'pool'}]}},meta:{err,fee,preBalances:[10e9,1e9],postBalances:[10e9+solDelta*1e9-fee,1e9],preTokenBalances:pre,postTokenBalances:post}};}
const buyTx=(o={})=>tx({solDelta:-(o.sol??3),pre:[],post:[tb(o.signer??W1,MINT,5000)],...o});
const SOL=100;
test('1 confirmed buy detected',()=>{const c=classifyTx(buyTx(),SOL);assert.equal(c.kind,'BUY');assert.equal(c.mint,MINT);assert.equal(c.signer,W1);assert.ok(c.signature)});
test('2 SOL/USD value uses current price, wSOL leg counted, fee excluded',()=>{
  let c=classifyTx(buyTx({sol:3}),100);assert.ok(Math.abs(c.spentSol-3)<1e-6);assert.ok(Math.abs(c.spentUsd-300)<1e-4);
  c=classifyTx(buyTx({sol:3}),250);assert.ok(Math.abs(c.spentUsd-750)<1e-3);
  const w=tx({solDelta:0,pre:[tb(W1,WSOL,5,2)],post:[tb(W1,WSOL,1,2),tb(W1,MINT,10)]});c=classifyTx(w,100);assert.ok(Math.abs(c.spentSol-4)<1e-6);
  // threshold is dual: 2 SOL at SOL=$100 = $200 <$500 but >=2SOL qualifies by SOL rule; USD rule independent
  assert.ok(classifyTx(buyTx({sol:2}),100).spentSol>=2-1e-6)});
test('3 multiple independent wallets',()=>{const buys=[W1,W2,W3].map((s,i)=>({...classifyTx(buyTx({signer:s,sol:1}),SOL),signer:s}));
  const ev=evaluate(cand(buys));assert.equal(ev.status,'QUALIFIED');assert.equal(ev.independent,3);
  const same=evaluate(cand(buys,{funders:{[W1]:'F',[W2]:'F',[W3]:'F'}}));assert.ok(!same.independent||same.independent===1)});
test('4 buy vs sale vs transfer vs liquidity vs failed',()=>{
  const sale=tx({solDelta:2,pre:[tb(W1,MINT,5000)],post:[]});assert.equal(classifyTx(sale,SOL).kind,'SELL');
  const xfer=tx({solDelta:0,pre:[],post:[tb(W1,MINT,5000)]});assert.equal(classifyTx(xfer,SOL).kind,'TRANSFER');
  const lp=tx({solDelta:-5,pre:[tb(W1,MINT,5000)],post:[tb(W1,'LPmint',50)]});assert.notEqual(classifyTx(lp,SOL).kind,'BUY');
  assert.equal(classifyTx(buyTx({err:{InstructionError:1}}),SOL).kind,'FAILED')});
function cand(buys,over={}){const n=Date.now()/1000;return {buys,market:{priceUsd:1,liquidityUsd:80000,vol5m:5000,buys5m:30,sells5m:10,priceChange1hPct:10,fetchedAt:n},safety:{checked:true,top10Pct:25},solUsdFetchedAt:n,hist:{},funders:{},...over}}
const good=()=>[{...classifyTx(buyTx({sol:6}),SOL),signer:W1}];
test('6 stale/missing market data -> DATA INCOMPLETE',()=>{const n=Date.now()/1000;
  assert.equal(evaluate(cand(good(),{market:null})).status,'DATA INCOMPLETE');
  assert.equal(evaluate(cand(good(),{market:{priceUsd:1,liquidityUsd:1e5,fetchedAt:n-999}})).status,'DATA INCOMPLETE');
  assert.equal(evaluate(cand(good(),{solUsdFetchedAt:n-999})).status,'DATA INCOMPLETE');
  assert.equal(evaluate(cand(good(),{safety:{checked:false}})).status,'PENDING VALIDATION')});
test('8 rug / liquidity risk rejected even with huge buy',()=>{
  const big=[{...classifyTx(buyTx({sol:50}),SOL),signer:W1}];
  for(const s of [{checked:true,mintAuthority:true},{checked:true,freezeAuthority:true},{checked:true,rugged:true},{checked:true,top10Pct:95}]) assert.equal(evaluate(cand(big,{safety:s})).status,'REJECTED');
  const m=cand(big).market;assert.equal(evaluate(cand(big,{market:{...m,liquidityUsd:3000}})).status,'REJECTED');
  assert.equal(evaluate(cand(big,{market:{...m,liquidityDropPct:60}})).status,'REJECTED');
  assert.equal(evaluate(cand(big,{market:{...m,priceChange1hPct:400}})).status,'REJECTED');
  const r=summarizeRug({mintAuthority:null,freezeAuthority:null,risks:[{level:'danger',name:'Top 10 holders high ownership'}],topHolders:[{address:'a',owner:'o',pct:80}],markets:[]});assert.equal(r.rugDanger,true)});
test('wallet history never fabricated: unknown -> warning, not credible',()=>{const ev=evaluate(cand(good()));assert.equal(ev.status,'QUALIFIED');assert.ok(ev.warns.some(w=>/DATA INCOMPLETE/.test(w)))});
test('9 telegram: retry, success, duplicate protection, no token leak',async()=>{
  let calls=0;const ledger={};const f=async()=>{calls++;if(calls<3)return {status:500,json:async()=>({ok:false,description:'boom'})};return {status:200,json:async()=>({ok:true,result:{message_id:42}})}};
  const r=await sendTelegram({token:'SECRETTOKEN',chatId:'1',text:'x',key:'k1',ledger,fetchImpl:f,sleep:async()=>{}});assert.equal(r.sent,true);assert.equal(r.attempts,3);
  const d=await sendTelegram({token:'SECRETTOKEN',chatId:'1',text:'x',key:'k1',ledger,fetchImpl:f,sleep:async()=>{}});assert.equal(d.duplicate,true);assert.equal(calls,3);
  const bad=await sendTelegram({token:'SECRETTOKEN',chatId:'1',text:'x',key:'k2',ledger:{},fetchImpl:async()=>{throw new Error('net SECRETTOKEN down')},sleep:async()=>{}});assert.equal(bad.sent,false);assert.ok(!JSON.stringify(bad).includes('SECRETTOKEN'));
  const none=await sendTelegram({token:'',chatId:'',text:'x',key:'k3',ledger:{}});assert.equal(none.sent,false)});
// ---- pipeline tests with mock deps (mode TEST) ----
function mkDeps({price=1,liq=80000,sol=100,rpcFail=false,buysTx=[buyTx({sol:6,sig:'S1'})],rug={checked:true,top10Pct:20}}={}){
  const pair={pairAddress:'PAIR1',baseToken:{address:MINT,symbol:'TST'},quoteToken:{symbol:'SOL'},priceUsd:String(price),liquidity:{usd:liq},volume:{m5:5000},txns:{m5:{buys:30,sells:10}},priceChange:{h1:10,m5:2}};
  const o={price,pair,calls:{sigs:[],tx:0}};
  return {o,solUsd:async()=>({price:sol,fetchedAt:Date.now()/1000,source:'mock'}),
  dex:async(p)=>p.startsWith('/token-')?[{chainId:'solana',tokenAddress:MINT}]:[{...o.pair,priceUsd:String(o.price)}],
  getSigs:async(a,until)=>{if(rpcFail)throw new Error('429 rate limited');o.calls.sigs.push(until);return buysTx.filter(t=>!until||t.transaction.signatures[0]!==until).map(t=>({signature:t.transaction.signatures[0],blockTime:t.blockTime}))},
  getTx:async(s)=>{o.calls.tx++;return buysTx.find(t=>t.transaction.signatures[0]===s)},
  rugcheck:async()=>({}),summarizeRug:()=>rug,marketFromPair:(p)=>({...marketFromPair(p),fetchedAt:Date.now()/1000})};}
const mkStore=()=>new Store(fs.mkdtempSync(os.tmpdir()+'/r2-'));
const tgOK=()=>({token:null,chatId:null});
test('5 duplicate tx/signal suppression across cycles',async()=>{const s=mkStore(),d=mkDeps();
  await runCycle({store:s,deps:d,mode:'TEST',tg:tgOK(),log(){}});await runCycle({store:s,deps:d,mode:'TEST',tg:tgOK(),log(){}});await runCycle({store:s,deps:d,mode:'TEST',tg:tgOK(),log(){}});
  const sigs=s.read('signals',[]);assert.equal(sigs.length,1);assert.equal(s.read('state').buys.length,1)});
test('7 RPC throttling/outage fails closed, no alert, health shows outage',async()=>{const s=mkStore();const r=await runCycle({store:s,deps:mkDeps({rpcFail:true}),mode:'TEST',tg:tgOK(),log(){}});
  assert.equal(s.read('signals',[]).length,0);assert.notEqual(s.read('health').sources.rpc,'ok');
  const d=mkDeps();d.solUsd=async()=>{throw new Error('down')};const r2=await runCycle({store:s,deps:d,mode:'TEST',tg:tgOK(),log(){}});assert.equal(r2.ok,false)});
test('12 scanner restart recovers cursor (no re-processing of known tx)',async()=>{const s=mkStore(),d=mkDeps();
  await runCycle({store:s,deps:d,mode:'TEST',tg:tgOK(),log(){}});const tx1=d.o.calls.tx;
  const s2=new Store(s.dir); await runCycle({store:s2,deps:d,mode:'TEST',tg:tgOK(),log(){}});assert.equal(d.o.calls.tx,tx1);assert.equal(s2.read('state').cursors.PAIR1,'S1')});
test('13+14 signal->outcome linkage uses signal reference price; exit cost recorded',async()=>{const s=mkStore(),d=mkDeps({price:1});
  await runCycle({store:s,deps:d,mode:'TEST',tg:tgOK(),log(){}});let sig=s.read('signals')[0];assert.equal(sig.refPrice,1);assert.equal(sig.outcome.status,'PENDING VALIDATION');assert.ok(sig.exitCostPct>0);
  d.o.price=1.6;await runCycle({store:s,deps:d,mode:'TEST',tg:tgOK(),log(){}});sig=s.read('signals')[0];
  assert.ok(sig.outcome.hit['1.5']);assert.ok(!sig.outcome.hit['2']);assert.ok(sig.outcome.hit['1.5'].exitAdjX<1.6);
  d.o.price=0.5;d.o.pair.liquidity={usd:5000};await runCycle({store:s,deps:d,mode:'TEST',tg:tgOK(),log(){}});sig=s.read('signals')[0];assert.equal(sig.outcome.liquidityCollapse,true);assert.ok(sig.outcome.maxDown<=0.5)});
test('alert text: contains required fields, TEST label, no secrets',()=>{const s=mkStore(),d=mkDeps();return runCycle({store:s,deps:d,mode:'TEST',tg:tgOK(),log(){}}).then(()=>{const t=formatAlert(s.read('signals')[0]);
  for(const k of ['Token:','Mint:','Signal time:','Reference price:','Confirmed buy:','Liquidity:','Transaction: https://solscan.io/tx/','QUALIFIED - NOT A GUARANTEE','[TEST - NOT LIVE]'])assert.ok(t.includes(k),k)})});
test('15 pipeline->telegram (mock fetch) delivers once',async()=>{const s=mkStore(),d=mkDeps();let n=0;const orig=globalThis.fetch;globalThis.fetch=async()=>{n++;return {status:200,json:async()=>({ok:true,result:{message_id:7}})}};
  try{await runCycle({store:s,deps:d,mode:'TEST',tg:{token:'T',chatId:'1'},log(){}});await runCycle({store:s,deps:d,mode:'TEST',tg:{token:'T',chatId:'1'},log(){}})}finally{globalThis.fetch=orig}
  assert.equal(n,1);assert.equal(s.read('signals')[0].telegram.sent,true)});
