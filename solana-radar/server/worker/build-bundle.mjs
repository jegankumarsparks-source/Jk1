/* Regenerate src/engine.bundle.js from ../../index.html (engine section, verbatim). */
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const HERE=dirname(fileURLToPath(import.meta.url));
const html=readFileSync(join(HERE,'..','..','index.html'),'utf8');
const a=html.indexOf('const BUILD_MARKER=');
const b=html.indexOf('class PersistenceEngine');
if(a<0||b<0||b<=a)throw new Error('engine anchors not found');
const code=html.slice(a,b);
const hash=createHash('sha256').update(code).digest('hex');
const names='U,DEFAULT_SETTINGS,S,REG,RPC,DEX,DISCOVERY,VALIDATOR,WALLETS,CLUSTERS,RISK,SCORER,QUAL,PORT,MONITOR,APP_VERSION,SCORE_VERSION,RISK_POLICY_VERSION,THRESHOLDS_VERSION,BUILD_MARKER';
writeFileSync(join(HERE,'src','engine.bundle.js'),
  '/* GENERATED from solana-radar/index.html engine section (verbatim) — run build-bundle.mjs to refresh. sha256 '+hash+' */\n'
  +'export const ENGINE_HASH='+JSON.stringify(hash)+';\n'
  +code+'\nexport {'+names+'};\n');
console.log('bundle written, sha256',hash,'bytes',code.length);
