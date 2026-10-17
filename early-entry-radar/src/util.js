// Shared utilities. Worker-safe (global fetch, no node APIs except crypto).
import { createHash } from 'node:crypto';

export const nowUTC = () => new Date().toISOString();

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58].map((c, i) => [c, BigInt(i)]));

// Validate a Solana address: base58, decodes to exactly 32 bytes.
export function isValidMint(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  let n = 0n;
  for (const ch of s) {
    const v = B58_MAP.get(ch);
    if (v === undefined) return false;
    n = n * 58n + v;
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = hex.length / 2;
  const leadingZeros = s.match(/^1*/)[0].length;
  return bytes + leadingZeros === 32;
}

// Extract candidate mint addresses from free text.
export function extractMints(text) {
  if (!text) return [];
  const out = new Set();
  for (const m of text.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g)) {
    if (isValidMint(m[0])) out.add(m[0]);
  }
  return [...out];
}

export const normalizeName = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// fetch with timeout, retries and exponential backoff. Never throws on HTTP errors;
// returns a structured result so adapters can record retrieval status honestly.
export async function fetchJson(url, { timeoutMs = 20000, retries = 2, headers = {} } = {}) {
  let attempt = 0, lastErr = null;
  while (attempt <= retries) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'early-entry-radar/0.1 (+research; respectful polling)', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latency = Date.now() - started;
      const body = await res.text();
      let json = null;
      try { json = JSON.parse(body); } catch { /* non-JSON body */ }
      return {
        ok: res.ok, httpStatus: res.status, latencyMs: latency, json, body,
        rateLimit: res.headers.get('x-ratelimit-limit')
          ? `${res.headers.get('x-ratelimit-remaining')}/${res.headers.get('x-ratelimit-limit')}`
          : null,
        error: res.ok ? null : `HTTP ${res.status}`,
      };
    } catch (e) {
      lastErr = String(e && e.message || e);
      const backoff = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      if (attempt < retries) await new Promise(r => setTimeout(r, backoff));
    }
    attempt++;
  }
  return { ok: false, httpStatus: 0, latencyMs: null, json: null, body: null, rateLimit: null, error: lastErr };
}
