# Solana Early-Entry Intelligence Radar (v1.0)

New system. Shares no code, scoring rules, schemas, or data with any prior project
(solana-radar, signal-alert, social-radar, paper-lab, NEXUS). Paper only. Free tiers only.

## Layout
- `schema.sql` — D1/SQLite event store (append-only, UTC, idempotent)
- `src/util.js` — fetch w/ timeout+retry+backoff, UTC helpers, Solana mint validation (base58, 32 bytes)
- `src/adapters/` — pumpfun, dexscreener, geckoterminal, telegram (t.me/s previews)
- `src/store.js` — SQLite access layer (node:sqlite locally; D1 binding in the Worker)
- `src/normalize.js` — entity resolution. Mint = only primary identity. Provisional entities
  never merge on name/ticker. Invalid mints fall back to provisional.
- `src/ingest.js` — adapter -> raw_events (INSERT OR IGNORE dedupe on source+source_id) -> resolve -> evidence
- `test/run-tests.js` — `node --experimental-sqlite test/run-tests.js`

## Known source gaps (accepted, shown as GAP/OFFLINE in UI)
X/Twitter (no free API), Reddit (403 from datacenter IPs; needs free OAuth app creds),
Discord (needs per-server bot), Instagram (no free public access), GMGN (no public API —
link buttons are built only from validated mints).

## Hard rules
- Never invent timestamps, launch dates, addresses, or market data; NULL/MISSING is a valid value.
- No signal when critical data is missing/stale/contradictory. NO QUALIFIED SIGNAL is a valid output.
- Secrets only in Worker env vars. Nothing secret in repo, logs, or frontend.
