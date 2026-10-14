# Solana Early Buy Alerts (alert only - no trading, no real money)
- index.html: single-file app (GitHub Pages). Reads data/*.json.
- scanner/: Node 22 scanner. Run by .github/workflows/signal-scan.yml every 5 min (4 cycles ~60s apart per run).
- Secrets: repo Actions secrets TG_TOKEN and TG_CHAT_ID only. Never in files.
- Tests: cd scanner && node --test test/run.mjs
- Data/schema: data/signals.json (signal + outcome records), rejections.json, health.json; state.json/tg_ledger.json are scanner state (cursors, dedupe).
- Limits: poll latency ~1-5 min plus Actions queue delay; free public data sources (Dexscreener, RugCheck, publicnode RPC) with unverified rate limits.
