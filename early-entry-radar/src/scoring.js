// Transparent, configurable score. Components and weights live in config.json under "score".
// The score EXPLAINS and RANKS; it never overrides security gates or market gates.
export const DEFAULT_WEIGHTS = {
  discovery_earliness: 1.0, source_reliability: 1.0, independent_confirmation: 1.0,
  influencer_evidence: 0.5, identity_confidence: 1.5, social_momentum: 0.5,
  onchain_activity: 1.0, liquidity_execution: 1.0, security_risk: 1.5, freshness_completeness: 1.0,
};

// Each component returns 0..1 with its raw inputs, so every score is explainable.
export function scoreCandidate(facts, weights = DEFAULT_WEIGHTS) {
  const c = {};
  // earliness: 1.0 at first sight, decays to 0 at 7 days
  const ageH = facts.age_hours ?? 0;
  c.discovery_earliness = Math.max(0, 1 - ageH / (24 * 7));
  // source reliability: weighted mean of reliability tiers of confirming sources (config-provided)
  c.source_reliability = facts.mean_source_reliability ?? 0;
  // independent confirmation: 1 = 3+ independent sources
  c.independent_confirmation = Math.min(1, (facts.independent_sources ?? 0) / 3);
  // influencer evidence: quality-weighted (paid disclosures count AGAINST, see decision engine)
  c.influencer_evidence = Math.min(1, (facts.independent_influencer_mentions ?? 0) / 3);
  // identity: verified mint = 1, provisional = 0.2, unknown = 0
  c.identity_confidence = facts.identity === 'mint' ? 1 : facts.identity === 'provisional' ? 0.2 : 0;
  // social momentum: deduped mentions, saturates at 20
  c.social_momentum = Math.min(1, (facts.unique_mentions ?? 0) / 20);
  // on-chain activity: transactions in first window, saturates at 500
  c.onchain_activity = Math.min(1, (facts.txn_count ?? 0) / 500);
  // liquidity/execution: 1 at 10x min liquidity, scaled; 0 if below gate
  c.liquidity_execution = facts.liquidity_usd && facts.min_liquidity_usd
    ? Math.min(1, facts.liquidity_usd / (10 * facts.min_liquidity_usd)) : 0;
  // security risk: 1 = no findings; subtract 0.25 per non-critical finding
  c.security_risk = Math.max(0, 1 - 0.25 * (facts.noncritical_findings ?? 0));
  // freshness/completeness: fraction of mandatory data points present and fresh
  c.freshness_completeness = facts.data_completeness ?? 0;

  let score = 0, wsum = 0;
  const breakdown = {};
  for (const [k, v] of Object.entries(c)) {
    const w = weights[k] ?? 1;
    score += w * v; wsum += w;
    breakdown[k] = { value: Math.round(v * 1000) / 1000, weight: w, raw: rawFor(k, facts) };
  }
  return { score: Math.round((score / wsum) * 100), breakdown }; // 0..100
}
function rawFor(k, f) {
  return { discovery_earliness: f.age_hours, source_reliability: f.mean_source_reliability,
    independent_confirmation: f.independent_sources, influencer_evidence: f.independent_influencer_mentions,
    identity_confidence: f.identity, social_momentum: f.unique_mentions, onchain_activity: f.txn_count,
    liquidity_execution: f.liquidity_usd, security_risk: f.noncritical_findings,
    freshness_completeness: f.data_completeness }[k];
}
