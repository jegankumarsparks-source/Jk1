// READ ONLY: requests indicative quotes only. Never builds/signs/submits a transaction.
const WSOL='So11111111111111111111111111111111111111112';
let nextAllowed=0;
export async function fetchExitEvidence({mint,amountRaw,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const incomplete=reason=>({sellabilityVerified:false,exitQuoteVerified:false,status:'PENDING VALIDATION',reason});
 if(!/^\d+$/.test(String(amountRaw))||BigInt(amountRaw)<=0n)return incomplete('invalid exit amount');
 const wait=Math.max(0,nextAllowed-Date.now());if(wait)await sleep(wait);nextAllowed=Date.now()+2200;
 const url=new URL('https://api.jup.ag/swap/v1/quote');url.search=new URLSearchParams({inputMint:mint,outputMint:WSOL,amount:String(amountRaw),slippageBps:'100',instructionVersion:'V2'});
 try{
  const r=await fetchImpl(url,{signal:AbortSignal.timeout(10000)});if(!r.ok)return incomplete('quote HTTP '+r.status);
  const q=await r.json();
  if(q.inputMint!==mint||q.outputMint!==WSOL||q.inAmount!==String(amountRaw)||q.swapMode!=='ExactIn'||!q.routePlan?.length||!Number.isInteger(q.contextSlot)||!/^\d+$/.test(q.outAmount)||BigInt(q.outAmount)<=0n||!/^\d+$/.test(q.otherAmountThreshold)||BigInt(q.otherAmountThreshold)<=0n)return incomplete('quote fields invalid or no route');
  return {status:'PENDING VALIDATION',sellabilityVerified:false,exitQuoteVerified:true,reason:'Indicative route quote only; no execution simulation or realized exit',sourceUrl:url.href,fetchedAt:Date.now()/1000,contextSlot:q.contextSlot,inputAmountRaw:q.inAmount,outputAmountRaw:q.outAmount,minOutputRaw:q.otherAmountThreshold,priceImpactPct:q.priceImpactPct,route:q.routePlan.map(p=>({pool:p.swapInfo.ammKey,label:p.swapInfo.label})),executionStatus:'NOT VERIFIED'};
 }catch{return incomplete('quote unavailable')}
}
