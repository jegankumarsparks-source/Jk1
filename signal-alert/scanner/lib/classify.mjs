export const WSOL='So11111111111111111111111111111111111111112';
const QUOTE={ [WSOL]:'SOL','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':'USDC','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':'USDT'};
const amt=(b)=>Number(b?.uiTokenAmount?.uiAmountString ?? b?.uiTokenAmount?.uiAmount ?? 0);
// Returns {kind:'BUY'|'SELL'|'TRANSFER'|'LIQUIDITY'|'FAILED'|'OTHER', ...}
export function classifyTx(tx, solUsd){
  if(!tx||!tx.meta) return {kind:'OTHER',reason:'no meta'};
  if(tx.meta.err) return {kind:'FAILED'};
  const keys=tx.transaction.message.accountKeys.map(k=>k.pubkey||k);
  const signer=keys[0];
  const fee=(tx.meta.fee||0)/1e9;
  const dSolRaw=(tx.meta.postBalances[0]-tx.meta.preBalances[0])/1e9;
  const delta={}; // mint -> signer-owned net change
  const seen=new Set();
  for(const b of [...(tx.meta.preTokenBalances||[]),...(tx.meta.postTokenBalances||[])]){ if(b.owner!==signer) continue; seen.add(b.mint+'|'+b.accountIndex); }
  for(const b of tx.meta.preTokenBalances||[]) if(b.owner===signer) delta[b.mint]=(delta[b.mint]||0)-amt(b);
  for(const b of tx.meta.postTokenBalances||[]) if(b.owner===signer) delta[b.mint]=(delta[b.mint]||0)+amt(b);
  // quote spent: native SOL (fee added back) + wSOL account delta, or stable delta
  const solNet=dSolRaw+fee+(delta[WSOL]||0);
  const usdNet=(delta['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']||0)+(delta['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']||0);
  const gained=Object.entries(delta).filter(([m,d])=>!QUOTE[m]&&d>1e-12);
  const lost=Object.entries(delta).filter(([m,d])=>!QUOTE[m]&&d<-1e-12);
  const spentSol=solNet<0?-solNet:0, spentUsdStable=usdNet<0?-usdNet:0;
  const base={signer,signature:tx.transaction.signatures[0],blockTime:tx.blockTime};
  if(gained.length&&lost.length>=1&&(spentSol>0||spentUsdStable>0)) return {kind:'LIQUIDITY',...base,reason:'multiple non-quote tokens moved (LP add/remove)'};
  if(gained.length===1&&lost.length===0){
    if(spentSol<=0.001&&spentUsdStable<=0.5) return {kind:'TRANSFER',...base,mint:gained[0][0],reason:'token received without paying SOL/stable'};
    const usd=spentUsdStable>0?spentUsdStable:spentSol*solUsd;
    // ignore dust-only purchases where SOL change is just rent
    return {kind:'BUY_CANDIDATE',buyEvidence:'UNVERIFIED_BALANCE_DELTA',...base,mint:gained[0][0],tokenAmount:gained[0][1],spentSol:spentUsdStable>0?null:spentSol,spentUsd:usd,quote:spentUsdStable>0?'STABLE':'SOL',execPriceUsd:usd/gained[0][1]};
  }
  if(lost.length===1&&gained.length===0&&(solNet>0||usdNet>0)) return {kind:'SELL',...base,mint:lost[0][0]};
  return {kind:'OTHER',...base};
}
