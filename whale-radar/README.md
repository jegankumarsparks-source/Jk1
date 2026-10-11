# JK Whale Radar 2.0 - Entry Catcher

Laptop-first Solana whale-entry radar. It watches a capped list of wallets (max 100)
and posts an ENTRY ALERT the moment a tracked wallet actually gains a token in a
confirmed on-chain transaction - the "whale entering, coin starting to hype" moment.

**Live app:** open `index.html` (served via GitHub Pages).

## What it does

- **WHALE FINDER, two tiers**
  - `PROVEN` - wallets that were verified early holders of a tracked coin before an
    observed 2x move (the original snapshot logic).
  - `SEED` (always labeled UNVERIFIED) - top holders of coins that already moved 2x
    in 24h (>= +100% h24 change, >= $50k liquidity), pulled from RugCheck public reports.
    Their early entry was not observed, so they never show as proven.
- **ENTRY CATCHER** - watched wallets are polled for fresh signatures; a positive token
  balance change becomes an alert only after the quality gate: liquidity >= $25k, priced
  pair, token still qualified. Two or more wallets entering the same coin = CONFLUENCE.
- **HYPE METER** - each alert card carries live velocity tiles (5m / 1h / 24h price
  change, buys vs sells) refreshed every cycle.
- **Watchlist cap 100**, priority-polled 10 per cycle, proven wallets first.
- **Paper lab** - $200 virtual bank, $10 stake per alert. Paper only, never real money.

## Run it

Open the app and it starts scanning. Use the **PAUSE / RESUME** button in the header to
stop and restart anytime; the pause state is remembered in local storage.
Data sources are free public endpoints (Dexscreener, RugCheck, public Solana RPC
with automatic fallback). No API keys, no accounts.

## Honest rules

- Few accurate signals over many: every alert requires a real on-chain balance change.
- Seed wallets are labeled UNVERIFIED; nothing is presented as guaranteed profit.
- Network errors appear in the activity log and never create signals.
