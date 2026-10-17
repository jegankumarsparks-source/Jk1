// Thin SQLite store. Locally backed by node:sqlite; in the Worker the same SQL runs on D1
// through the d1 adapter shim (worker/ entry prepares statements identically).
export function openStore(db) {
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  return {
    run, get, all,
    upsertEntity(u) {
      run(`INSERT INTO entities(entity_id,kind,mint,name,ticker,first_evidence_at,created_at)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(entity_id) DO UPDATE SET
             name = COALESCE(entities.name, excluded.name),
             ticker = COALESCE(entities.ticker, excluded.ticker),
             first_evidence_at = MIN(entities.first_evidence_at, excluded.first_evidence_at)`,
        u.entity_id, u.kind, u.mint ?? null, u.name ?? null, u.ticker ?? null, u.first_evidence_at, u.created_at);
    },
    addEvidence(entity_id, raw_event_id, field, at) {
      run(`INSERT OR IGNORE INTO entity_evidence(entity_id,raw_event_id,field,linked_at) VALUES(?,?,?,?)`, entity_id, raw_event_id, field, at);
    },
    findMentionByFingerprint(fp) { return get(`SELECT id FROM mentions WHERE fingerprint=?`, fp) || null; },
    insertMention(m) {
      run(`INSERT INTO mentions(raw_event_id,entity_id,author,url,published_at,ingested_at,category,is_duplicate,confidence,text,fingerprint)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        m.raw_event_id, m.entity_id ?? null, m.author ?? null, m.url ?? null, m.published_at ?? null, m.ingested_at,
        m.category, m.is_duplicate ? 1 : 0, m.confidence, m.text, m.fingerprint);
    },
    getEntityLaunchStatus(id) { const r = get(`SELECT launch_status FROM entities WHERE entity_id=?`, id); return r ? r.launch_status : null; },
    setEntityLaunchStatus(id, status) { run(`UPDATE entities SET launch_status=? WHERE entity_id=?`, status, id); },
    logLaunchStatus(entity_id, from, to, reasons, at) {
      run(`INSERT INTO launch_status_log(entity_id,from_status,to_status,reasons,at) VALUES(?,?,?,?,?)`, entity_id, from, to, reasons, at);
    },
    latestSignalState(id) {
      const r = get(`SELECT to_state FROM signal_state_log WHERE entity_id=? ORDER BY id DESC LIMIT 1`, id);
      return r ? r.to_state : null;
    },
    logSignalState(r) {
      run(`INSERT INTO signal_state_log(entity_id,from_state,to_state,reasons,score,score_breakdown,at) VALUES(?,?,?,?,?,?,?)`,
        r.entity_id, r.from_state, r.to_state, r.reasons, r.score, r.score_breakdown, r.at);
    },
    latestSignalStates() {
      return all(`SELECT entity_id, to_state, score, at FROM signal_state_log s1
                  WHERE id IN (SELECT MAX(id) FROM signal_state_log GROUP BY entity_id)`);
    },
    insertSecurityResult(r) {
      run(`INSERT INTO security_results(entity_id,check_name,result,evidence,provider,limitations,at) VALUES(?,?,?,?,?,?,?)`,
        r.entity_id, r.check_name, r.result, r.evidence, r.provider, r.limitations, r.at);
    },
    insertGateResult(r) {
      run(`INSERT INTO gate_results(entity_id,gate,result,detail,at) VALUES(?,?,?,?,?)`, r.entity_id, r.gate, r.result, r.detail, r.at);
    },
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
