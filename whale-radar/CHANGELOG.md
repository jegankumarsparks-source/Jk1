# Changelog

## v1.0 (JK-WR2-V1) - 2026-10-11
- Rebuilt as entry catcher: ENTRY ALERTS feed replaces "acquisitions" wording.
- Two whale tiers: PROVEN (observed early holder before 2x) and SEED
  (UNVERIFIED - top holders of already-2x hype coins via RugCheck).
- Watchlist capped at 100 wallets; priority polling 10 per cycle, proven first.
- Entry quality gate: liquidity >= $25k + priced pair.
- CONFLUENCE tier when >=2 watched wallets enter the same coin.
- Hype velocity tiles (5m/1h/24h, buys/sells) on every alert card.
- Header PAUSE / RESUME button; engine state persists across reloads.
- Desktop laptop cockpit: all panels visible in a 3-column grid (>=1024px);
  mobile keeps the tab layout.
- Cycle cadence 60s; scan-now button overrides pause for a manual cycle.
- Carried over from the fixed build: RPC 3-endpoint fallback (PublicNode ->
  mainnet-beta -> OnFinality) and RugCheck top-holders snapshots.
