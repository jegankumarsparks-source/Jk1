// Gap-fill tests (2026-10-18 owner directive): reddit adapter, WATCHLIST tier, honesty preserved.
import { parseRss } from '../src/adapters/reddit.js';
import { decide } from '../src/decision.js';
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`); };

// T40: reddit RSS parsing
{
  const xml = readFileSync(new URL('./fixtures/reddit_rss.xml', import.meta.url), 'utf8');
  const ev = parseRss(xml, 'solana', '2026-10-18T05:00:00Z');
  t('T40a parses 2 entries', ev.length === 2, `got ${ev.length}`);
  t('T40b stable source ids', ev[0].source_id === 'reddit:solana:1abc2de');
  t('T40c html entities decoded', ev[1].payload.text === 'Weekly discussion & FAQ');
  t('T40d observed_at parsed', ev[0].observed_at === '2026-10-18T04:55:00.000Z');
}

// T41: WATCHLIST tier (gates loosened honestly)
const cfg = { min_signal_score: 40, watchlist_min_score: 20, min_liquidity_usd: 1000 };
const base = { identity: 'mint', launchStatus: 'LIVE MARKET VERIFIED', securityVerdict: 'PASS_WITH_FINDINGS',
  facts: { age_hours: 2, mean_source_reliability: 0.7, independent_sources: 2, independent_influencer_mentions: 1,
    disclosed_paid_mentions: 0, identity: 'mint', unique_mentions: 3 } };
{
  const d = decide({ ...base, marketVerdict: 'LIQUIDITY INSUFFICIENT' }, cfg);
  t('T41a liq-fail + decent score => WATCHLIST (not hidden)', d.state === 'WATCHLIST', `${d.state} score=${d.score}`);
  t('T41b watchlist keeps failure reason visible', /liquidity gate/.test(d.reasons.join(' ')));
  const lowFacts = { age_hours: 700, mean_source_reliability: 0, independent_sources: 0, independent_influencer_mentions: 0,
    disclosed_paid_mentions: 0, identity: 'mint', unique_mentions: 0, txn_count: 0, noncritical_findings: 4, data_completeness: 0 };
  const d2 = decide({ ...base, marketVerdict: 'LIQUIDITY INSUFFICIENT', facts: lowFacts }, cfg);
  t('T41c liq-fail + no score => honest LIQUIDITY INSUFFICIENT', d2.state === 'LIQUIDITY INSUFFICIENT', d2.state);
  const d3 = decide({ ...base, marketVerdict: 'MARKET OK' }, cfg);
  t('T41d all-pass + score>=40 => QUALIFIED', d3.state === 'QUALIFIED CANDIDATE', `${d3.state} score=${d3.score}`);
  const d4 = decide({ ...base, marketVerdict: 'MARKET OK', facts: lowFacts }, cfg);
  t('T41e low score => WATCHLIST or DISCOVERED, never fake QUALIFIED', ['WATCHLIST', 'DISCOVERED'].includes(d4.state), d4.state);
  const d5 = decide({ ...base, marketVerdict: 'MARKET OK', securityVerdict: 'REJECTED' }, cfg);
  t('T41f critical security fail STILL rejects (rug honesty)', d5.state === 'SECURITY REJECTED');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
