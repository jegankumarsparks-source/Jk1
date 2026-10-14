// Read-only mint account proof, including conservative Token-2022 extension gate.
const programs=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const supportedExtensions=new Set(['metadataPointer','tokenMetadata']);
export async function fetchMintEvidence(mint,rpc){
 const r=await rpc('getAccountInfo',[mint,{encoding:'jsonParsed',commitment:'confirmed'}]);const a=r?.value,p=a?.data?.parsed,i=p?.info;
 if(!programs.has(a?.owner)||p?.type!=='mint'||!i?.isInitialized||!Object.hasOwn(i,'mintAuthority')||!Object.hasOwn(i,'freezeAuthority')||!Number.isInteger(r?.context?.slot))return {authoritiesVerified:false,status:'DATA INCOMPLETE',reason:'mint RPC schema incomplete'};
 const unknown=(i.extensions||[]).map(x=>x.extension).filter(e=>!supportedExtensions.has(e));
 return {authoritiesVerified:true,mintAuthority:i.mintAuthority!==null,freezeAuthority:i.freezeAuthority!==null,decimals:i.decimals,supplyRaw:i.supply,slot:r.context.slot,checkedAt:Date.now()/1000,tokenProgram:a.owner,unsupportedExtensions:unknown,sellabilityVerified:false,status:unknown.length?'PENDING VALIDATION':'AUTHORITY_CHECK_ONLY',reason:unknown.length?'unsupported token extensions: '+unknown.join(', '):'authorities checked; sellability is a separate check'};
}
