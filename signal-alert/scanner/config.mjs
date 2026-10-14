export const CONFIG = {
  minBuySol: 2, minBuyUsd: 500, tiers: [2,5,10,20],
  clusterWindowSec: 300, minIndependentWalletsForCluster: 2,
  maxTxAgeSec: 600,            // buy must be recent
  minLiquidityUsd: 20000, minVol5mUsd: 1000,
  maxPriceChange1hPct: 150,    // already pumped = not early
  maxTop10HolderPct: 60, maxSlippagePct: 5,
  feePct: 1.0,                 // est. round-trip fees %
  minSolUsdFreshSec: 180, minMarketFreshSec: 120,
  targetX: 1.5, outcomeWindowsMin: [5,10,30,60],
  dedupeWindowSec: 3600, tgMinIntervalMs: 1100,
};
