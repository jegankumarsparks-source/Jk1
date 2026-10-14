import {CONFIG as C} from '../config.mjs';
export function formatAlert(sig){
  const ist=new Date(sig.signalTime*1000).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:false});
  return [`🚨 SOLANA EARLY BUY SIGNAL${sig.mode==='TEST'?' [TEST - NOT LIVE]':''}`,sig.tier||'VERIFICATION INCOMPLETE','',
  `Token: ${sig.symbol||'?'}`,`Mint: ${sig.mint}`,`Signal time: ${ist} IST`,
  `Reference price: $${sig.refPrice} (${sig.refSource})`,
  `Confirmed buy: ${sig.topBuy.spentSol!=null?sig.topBuy.spentSol.toFixed(2)+' SOL / ':''}$${sig.topBuy.spentUsd.toFixed(0)}`,
  `Wallets buying: ${sig.walletCount??sig.independent} observed addresses (independence UNVERIFIED)`,
  `Wallet quality: ${sig.walletQuality}`,
  `Liquidity: $${Math.round(sig.liquidityUsd)}`,`Risk status: PROVABLE GATES PASS; future exit UNVERIFIED`,
  `Rule score (not a probability): ${sig.score} (${sig.why.join('; ')})`,
  sig.warns.length?`Warnings: ${sig.warns.join('; ')}`:null,
  `Potential outcome levels: 1.5x / 2x / 3x`,
  `Price chart: https://dexscreener.com/solana/${sig.pair||sig.mint}`,
  `Token explorer: https://solscan.io/token/${sig.mint}`,
  `Transaction: https://solscan.io/tx/${sig.topBuy.signature}`,'',
  'Signal status: QUALIFIED - NOT A GUARANTEE'].filter(x=>x!==null).join('\n');
}
// send(fetchImpl) with retry/backoff and idempotency via sent-ledger. Token from env only.
export async function sendTelegram({token,chatId,text,key,ledger,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
  if(ledger[key]?.ok) return {sent:false,duplicate:true};
  if(!token||!chatId) return {sent:false,error:'telegram not configured'};
  let last;
  for(let a=0;a<4;a++){
    try{
      const r=await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true})});
      const j=await r.json();
      if(j.ok){ledger[key]={ok:true,at:Date.now(),messageId:j.result?.message_id};return {sent:true,messageId:j.result?.message_id,attempts:a+1}}
      last=j.description||('http '+r.status);
      await sleep(((j.parameters?.retry_after)||2**a)*1000);
    }catch(e){last=String(e.message).replace(token,'***');await sleep(2**a*1000)}
  }
  ledger[key]={ok:false,error:last,at:Date.now()};
  return {sent:false,error:last};
}
