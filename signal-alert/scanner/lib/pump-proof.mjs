import fs from 'node:fs';
const layout=JSON.parse(fs.readFileSync(new URL('./pump-layout.json',import.meta.url)));
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes){let n=BigInt('0x'+Buffer.from(bytes).toString('hex'));let s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n}for(const b of bytes){if(b!==0)break;s='1'+s}return s;}
export function b58decode(s){let n=0n;for(const c of s){const i=alphabet.indexOf(c);if(i<0)throw Error('bad base58');n=n*58n+BigInt(i)}let b=n?Buffer.from(n.toString(16).padStart(Math.ceil(n.toString(16).length/2)*2,'0'),'hex'):Buffer.alloc(0);const z=s.match(/^1*/)[0].length;return Buffer.concat([Buffer.alloc(z),b]);}
function eventPrefix(b){
 if(!b.subarray(0,8).equals(Buffer.from(layout.event.discriminator)))return null;
 // Only fixed prefix through user quote token account is needed. Retain raw integer precision.
 let o=8,e={};
 for(const f of layout.fields){
  if(f.type==='pubkey'){if(b.length<o+32)return null;e[f.name]=b58encode(b.subarray(o,o+32));o+=32;}
  else if(f.type==='u64'||f.type==='i64'){if(b.length<o+8)return null;e[f.name]=f.type==='i64'?b.readBigInt64LE(o):b.readBigUInt64LE(o);o+=8;}
  else break;
  if(f.name==='user_quote_token_account')return e;
 }
 return null;
}
function scopedEvents(tx){
 const stack=[],events=[];
 for(const l of tx.meta.logMessages||[]){const inv=l.match(/^Program (\S+) invoke \[\d+\]$/);if(inv){stack.push(inv[1]);continue;}
  const end=l.match(/^Program (\S+) (success|failed:)/);if(end){if(stack.at(-1)===end[1])stack.pop();else return [];continue;}
  if(stack.at(-1)===layout.address&&l.startsWith('Program data: ')){try{const e=eventPrefix(Buffer.from(l.slice(14),'base64'));if(e)events.push(e)}catch{}}
 }
 return events;
}
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',TOKEN22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL='So11111111111111111111111111111111111111112';
export function provePumpBuy(tx,solUsd){
 const hold=reason=>({verified:false,reason});
 if(!tx||!tx.meta||!tx.transaction?.message?.instructions||tx.meta?.err||!Number.isFinite(solUsd)||solUsd<=0)return hold('failed transaction or missing SOL price');
 const keys=tx.transaction.message.accountKeys.map(k=>k.pubkey||k);
 const events=scopedEvents(tx);
 const proof=[];
 const scopes=[];
 for(const [idx,top] of tx.transaction.message.instructions.entries()){
  const inn=(tx.meta.innerInstructions||[]).find(g=>g.index===idx)?.instructions||[];
  if(top.programId===layout.address)scopes.push({ix:top,inner:inn});
  for(let k=0;k<inn.length;k++){
   const ix=inn[k];if(ix.programId!==layout.address)continue;
   const height=ix.stackHeight;if(!Number.isInteger(height))continue;
   let end=k+1;while(end<inn.length&&inn[end].stackHeight>height)end++;
   scopes.push({ix,inner:inn.slice(k+1,end)});
  }
 }
 for(const {ix,inner} of scopes){
  if(ix.programId!==layout.address||!ix.data)continue;
  let data;try{data=b58decode(ix.data)}catch{continue}
  const schema=layout.instructions.find(i=>data.subarray(0,8).equals(Buffer.from(i.discriminator)));if(!schema)continue;
  const a=Object.fromEntries(schema.accounts.map((n,i)=>[n.name,ix.accounts[i]]));
  // Narrow route: a signed buyer's isolated PumpSwap invocation with exact WSOL transfer evidence.
  const userKey=tx.transaction.message.accountKeys.find(k=>(k.pubkey||k)===a.user);
  if(a.quote_mint!==WSOL||!userKey?.signer)continue;
  const es=events.filter(e=>e.pool===a.pool&&e.user===a.user&&e.user_base_token_account===a.user_base_token_account&&e.user_quote_token_account===a.user_quote_token_account);
  if(es.length!==1)continue;const e=es[0];
  let quoteOut=0n,baseOut=0n;
  for(const t of inner){if(![TOKEN,TOKEN22].includes(t.programId))continue;const p=t.parsed;if(!p||!['transfer','transferChecked'].includes(p.type))continue;
   const i=p.info;const raw=i.amount??i.tokenAmount?.amount;if(!/^\d+$/.test(String(raw)))continue;const amount=BigInt(raw);
   if(i.source===a.user_quote_token_account&&i.authority===a.user)quoteOut+=amount;
   if(i.source===a.pool_base_token_account&&i.destination===a.user_base_token_account)baseOut+=amount;
  }
  if(baseOut!==e.base_amount_out||quoteOut<=0n||baseOut<=0n||quoteOut>e.max_quote_amount_in)continue;
  // Gross WSOL actually debited (includes protocol/creator/buyback transfers). Pending cashback is not counted as returned SOL.
  if(quoteOut!==e.quote_amount_in&&quoteOut!==e.user_quote_amount_in)continue;
  const bi=keys.indexOf(a.user_base_token_account);const pre=tx.meta.preTokenBalances?.find(b=>b.accountIndex===bi),post=tx.meta.postTokenBalances?.find(b=>b.accountIndex===bi);
  if(post?.owner!==a.user||post.mint!==a.base_mint||!Number.isInteger(post.uiTokenAmount?.decimals))continue;
  const delta=BigInt(post.uiTokenAmount.amount)-BigInt(pre?.uiTokenAmount.amount||0);
  if(delta!==baseOut)continue; // reject token transfer fees, other movements and incomplete balance evidence
  const spentSol=Number(quoteOut)/1e9,tokenAmount=Number(baseOut)/10**post.uiTokenAmount.decimals;
  if(!Number.isFinite(tokenAmount)||tokenAmount<=0)continue;
  proof.push({kind:'BUY',buyEvidence:'VERIFIED_SWAP_AND_SPEND',signer:a.user,mint:a.base_mint,pair:a.pool,signature:tx.transaction.signatures[0],blockTime:tx.blockTime,spentSol,spentUsd:spentSol*solUsd,tokenAmount,execPriceUsd:spentSol*solUsd/tokenAmount,quote:'SOL',proof:{program:layout.address,instruction:schema.name,eventQuoteRaw:String(quoteOut),eventBaseRaw:String(baseOut),solUsdSourceTime:'OBSERVATION_TIME_NOT_EXECUTION_TIME',scope:'RECONCILED_PUMPSWAP_WSOL_ONLY',spendBasis:'GROSS_WS0L_TRANSFER_DEBIT_NO_UNCLAIMED_CASHBACK',eventUserQuoteRaw:String(e.user_quote_amount_in),schemaSource:layout.source}});
 }
 return proof.length===1?{verified:true,buy:proof[0]}:hold('direct PumpSwap instruction/event/transfers/balance proof not uniquely reconciled');
}
