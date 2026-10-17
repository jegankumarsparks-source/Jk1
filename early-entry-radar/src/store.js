// Thin SQLite store. Locally backed by node:sqlite; in the Worker the same SQL runs on D1
// through the d1 adapter shim (worker/ entry prepares statements identically).
export function openStore(db) {
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  return {
    run, get, all,
    registerSource(s) {
      run(`INSERT INTO sources(source,source_type,auth_status,reliability_notes) VALUES(?,?,?,?)
           ON CONFLICT(source) DO NOTHING`, s.source, s.source_type, s.auth_status, s.reliability_notes);
    },
    recordHealth(h) {
      run(`INSERT OR REPLACE INTO source_health(source,checked_at,status,latency_ms,http_status,rate_limit,error)
           VALUES(?,?,?,?,?,?,?)`, h.source, h.checked_at, h.status, h.latency_ms, h.http_status, h.rate_limit, h.error);
    },
    // Idempotent: UNIQUE(source,source_id) + INSERT OR IGNORE. Returns {inserted, id}.
    insertRawEvent(e) {
      const r = run(`INSERT OR IGNORE INTO raw_events(source,source_id,url,observed_at,ingested_at,payload,retrieval_status)
                     VALUES(?,?,?,?,?,?,?)`,
        e.source, e.source_id, e.url ?? null, e.observed_at ?? null, e.ingested_at,
        JSON.stringify(e.payload), e.retrieval_status || 'ok');
      if (r.changes === 0) {
        const row = get(`SELECT id FROM raw_events WHERE source=? AND source_id=?`, e.source, e.source_id);
        return { inserted: false, id: row ? row.id : null };
      }
      return { inserted: true, id: Number(r.lastInsertRowid) };
    },
  };
}
