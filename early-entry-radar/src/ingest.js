// Ingestion pipeline: adapters -> raw_events (idempotent) -> normalize -> entities/evidence.
import { extractIdentity, resolveEntity, } from './normalize.js';
import { nowUTC } from './util.js';

export function ingestEvents(store, events) {
  const stats = { received: events.length, inserted: 0, duplicates: 0, entities_touched: new Set(), unlinked: 0 };
  for (const e of events) {
    const { inserted, id } = store.insertRawEvent(e);
    if (!inserted) { stats.duplicates++; continue; }
    stats.inserted++;
    const identity = extractIdentity(e);
    const entityId = resolveEntity(store, e, identity);
    if (!entityId) { stats.unlinked++; continue; }
    const field = identity.mint ? 'mint' : 'profile';
    store.run(`INSERT OR IGNORE INTO entity_evidence(entity_id,raw_event_id,field,linked_at) VALUES(?,?,?,?)`,
      entityId, id, field, nowUTC());
    stats.entities_touched.add(entityId);
  }
  stats.entities_touched = stats.entities_touched.size;
  return stats;
}

export async function runCollectors(store, adapters, opts = {}) {
  const out = {};
  for (const a of adapters) {
    store.registerSource(a.SOURCE);
    const { events, health } = await a.collect(opts[a.SOURCE.source] || {});
    store.recordHealth(health);
    out[a.SOURCE.source] = { health, ingest: ingestEvents(store, events) };
  }
  return out;
}
