// STEP 4 tests: pre-launch status engine + social evidence. Fixtures only (deterministic).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { computeLaunchStatus, applyLaunchStatus, classifyAnnouncement } from '../src/prelaunch.js';
import { categorizeMention, mentionFingerprint, ingestMentions } from '../src/social.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const store = openStore(db);
store.registerSource({source:'telegram',source_type:'web_preview',auth_status:'none',reliability_notes:'test'});
store.registerSource({source:'pumpfun',source_type:'api',auth_status:'none',reliability_notes:'test'});
store.registerSource({source:'geckoterminal',source_type:'api',auth_status:'none',reliability_notes:'test'});

const results = [];
const check = (n, ok, ev) => { results.push(ok); console.log(`${ok?'PASS':'FAIL'}  ${n}  | ${ev}`); };
const ts = new Date().toISOString();

// T7: claimed future launch time + official announcement => PRE-LAUNCH CONFIRMED BY EVIDENCE
{
  const r = computeLaunchStatus({ mentions: [
    { text: 'Official: $ZKRA launches on Oct 20, 2026 at 14:00 UTC on our site zkra.example', published_at: ts },
  ], evidence: [] });
  check('T7_claimed_time_confirmed', r.status === 'PRE-LAUNCH CONFIRMED BY EVIDENCE' && r.claimed_launch_text,
    `status="${r.status}" claim="${r.claimed_launch_text}"`);
}
// T8: "soon" never becomes a launch date; status PRE-LAUNCH UNVERIFIED; original stored
{
  const r = computeLaunchStatus({ mentions: [{ text: '$ZKRA launching soon, big things coming!', published_at: ts }], evidence: [] });
  const c = classifyAnnouncement('$ZKRA launching soon, big things coming!');
  check('T8_soon_is_not_a_date', r.status === 'PRE-LAUNCH UNVERIFIED' && r.claimed_launch_text === null && c.claimed_time_text === null && c.original.includes('launching soon'),
    `status="${r.status}" claim=null original-statement-stored=yes`);
}
// T9: mint created but no pool => LAUNCH DETECTED; pool added => LIVE MARKET VERIFIED (transition logged)
{
  store.run(`INSERT INTO entities(entity_id,kind,mint,name,first_evidence_at,created_at) VALUES('mint:X','mint','X','T',?,?)`, ts, ts);
  let r = computeLaunchStatus({ mentions: [], evidence: [{ source: 'pumpfun', observed_at: ts, payload: {} }] });
  const t1 = applyLaunchStatus(store, 'mint:X', r);
  r = computeLaunchStatus({ mentions: [], evidence: [
    { source: 'pumpfun', observed_at: ts, payload: {} },
    { source: 'geckoterminal', observed_at: ts, payload: {} }] });
  const t2 = applyLaunchStatus(store, 'mint:X', r);
  const log = store.all(`SELECT from_status,to_status FROM launch_status_log ORDER BY id`);
  check('T9_detected_then_market_verified', t1.to === 'LAUNCH DETECTED' && t2.from === 'LAUNCH DETECTED' && t2.to === 'LIVE MARKET VERIFIED' && log.length === 2,
    `transitions: ${log.map(l => `${l.from_status||'∅'}→${l.to_status}`).join(' , ')} (audit log rows=${log.length})`);
}
// T10: explicit cancel => CANCELLED OR DELAYED; past vague window with no evidence => STATUS UNKNOWN, never inferred
{
  const r1 = computeLaunchStatus({ mentions: [{ text: 'Launch delayed, new date TBA', published_at: ts }], evidence: [] });
  const r2 = computeLaunchStatus({ mentions: [], evidence: [] });
  check('T10_cancel_explicit_only', r1.status === 'CANCELLED OR DELAYED' && r2.status === 'STATUS UNKNOWN',
    `explicit-delay="${r1.status}"; no-evidence="${r2.status}" (not inferred)`);
}
// T11: social categorization + duplicate detection + independent count
{
  const cats = [
    ['CA: 4W9nkDkmhVokuv84yeNkSMHQxh1Ta35GMkYMsACbpump fair launch now', 'announcement'],
    ['This is a sponsored post, paid promo for $XYZ', 'disclosed_paid'],
    ['Warning: looks like a honeypot, avoid', 'warning'],
    ['might launch next month, heard from a friend', 'speculation'],
    ['nice weather today', 'unknown'],
  ];
  const catOk = cats.every(([t, want]) => categorizeMention(t) === want);
  const mkEv = (id, ch, text) => ({ id, source: 'telegram', source_id: `tg:${ch}:${id}`, url: `https://t.me/${ch}/${id}`,
    observed_at: ts, ingested_at: ts, payload: { channel: ch, text } });
  // need raw_events parents for FK
  const evs = [mkEv(1, 'chanA', 'GEM ALERT $ZKRA 100x buy now'), mkEv(2, 'chanB', 'GEM ALERT $ZKRA 100x buy now'), mkEv(3, 'chanC', 'Different take: $ZKRA scam warning')];
  for (const e of evs) store.insertRawEvent(e);
  const st = ingestMentions(store, evs);
  check('T11_social_categories_dupes', catOk && st.mentions === 3 && st.duplicates === 1,
    `categories 5/5 correct=${catOk}; mentions=${st.mentions} duplicates_flagged=${st.duplicates} (same text, 2 channels)`);
}

const failed = results.filter(r => !r).length;
console.log(`\n== STEP4 SUMMARY: ${results.length - failed}/${results.length} PASS, ${failed} FAIL ==`);
process.exit(failed ? 1 : 0);
