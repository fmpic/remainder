const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function createDatabase(dbPath = process.env.DB_PATH || './data/esim.db') {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS esims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      country_code TEXT NOT NULL DEFAULT '',
      country_name TEXT NOT NULL DEFAULT '',
      carrier TEXT NOT NULL,
      activation_date TEXT NOT NULL,
      last_renew_date TEXT NOT NULL,
      cycle_days INTEGER NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reminder_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      esim_id INTEGER NOT NULL,
      cycle_anchor_date TEXT NOT NULL,
      stage_days INTEGER NOT NULL,
      days_remaining INTEGER NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      sent_at TEXT NOT NULL,
      FOREIGN KEY (esim_id) REFERENCES esims(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_reminder_logs_esim_cycle
      ON reminder_logs (esim_id, cycle_anchor_date, stage_days);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Preserve existing history while separating reminders for changed expiry dates.
  if (!db.prepare('PRAGMA table_info(reminder_logs)').all().some(c => c.name === 'expiry_date')) {
    db.exec(`BEGIN;
      ALTER TABLE reminder_logs ADD COLUMN expiry_date TEXT;
      UPDATE reminder_logs SET expiry_date = (
        SELECT date(reminder_logs.cycle_anchor_date, '+' || esims.cycle_days || ' days')
        FROM esims WHERE esims.id = reminder_logs.esim_id
      );
      COMMIT;`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS reminder_retries (
    esim_id INTEGER PRIMARY KEY REFERENCES esims(id) ON DELETE CASCADE,
    expiry_date TEXT NOT NULL, failures INTEGER NOT NULL, retry_at INTEGER NOT NULL
  );`);

  function getRetryState(esimId, expiryDate) {
    return db.prepare('SELECT * FROM reminder_retries WHERE esim_id = ? AND expiry_date = ?').get(esimId, expiryDate);
  }

  function setRetryState(esimId, expiryDate, failures, retryAt) {
    db.prepare(`INSERT OR REPLACE INTO reminder_retries VALUES (?, ?, ?, ?)`).run(esimId, expiryDate, failures, retryAt);
  }

  function clearRetryState(esimId) {
    db.prepare('DELETE FROM reminder_retries WHERE esim_id = ?').run(esimId);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function listEsims() {
    return db
      .prepare('SELECT * FROM esims ORDER BY id DESC')
      .all();
  }

  function getEsimById(id) {
    return db.prepare('SELECT * FROM esims WHERE id = ?').get(id) || null;
  }

  function createEsim(data) {
    const now = nowIso();
    const stmt = db.prepare(`
      INSERT INTO esims (
        phone_number, country_code, country_name, carrier,
        activation_date, last_renew_date, cycle_days, notes, enabled,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.phone_number,
      data.country_code || '',
      data.country_name || '',
      data.carrier,
      data.activation_date,
      data.last_renew_date || data.activation_date,
      data.cycle_days,
      data.notes || '',
      data.enabled === false || data.enabled === 0 ? 0 : 1,
      now,
      now
    );
    return getEsimById(result.lastInsertRowid);
  }

  function updateEsim(id, data) {
    const existing = getEsimById(id);
    if (!existing) return null;

    const now = nowIso();
    const stmt = db.prepare(`
      UPDATE esims SET
        phone_number = ?,
        country_code = ?,
        country_name = ?,
        carrier = ?,
        activation_date = ?,
        last_renew_date = ?,
        cycle_days = ?,
        notes = ?,
        enabled = ?,
        updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
      data.phone_number ?? existing.phone_number,
      data.country_code ?? existing.country_code,
      data.country_name ?? existing.country_name,
      data.carrier ?? existing.carrier,
      data.activation_date ?? existing.activation_date,
      data.last_renew_date ?? existing.last_renew_date,
      data.cycle_days ?? existing.cycle_days,
      data.notes ?? existing.notes,
      data.enabled === undefined ? existing.enabled : data.enabled ? 1 : 0,
      now,
      id
    );
    return getEsimById(id);
  }

  function deleteEsim(id) {
    const result = db.prepare('DELETE FROM esims WHERE id = ?').run(id);
    return result.changes > 0;
  }

  function getSentStagesForCycle(esimId, cycleAnchorDate, expiryDate) {
    if (!expiryDate) {
      const esim = getEsimById(esimId);
      if (esim) {
        const date = new Date(`${cycleAnchorDate}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + Number(esim.cycle_days));
        expiryDate = date.toISOString().slice(0, 10);
      }
    }
    const rows = db
      .prepare(
        `SELECT stage_days FROM reminder_logs
         WHERE esim_id = ? AND cycle_anchor_date = ? AND expiry_date = ? AND status IN ('sent', 'skipped')`
      )
      .all(esimId, cycleAnchorDate, expiryDate);
    return new Set(rows.map((r) => r.stage_days));
  }

  function addReminderLog({
    esim_id,
    cycle_anchor_date,
    expiry_date,
    stage_days,
    days_remaining,
    status,
    message = '',
    error = '',
  }) {
    const stmt = db.prepare(`
      INSERT INTO reminder_logs (
        esim_id, cycle_anchor_date, expiry_date, stage_days, days_remaining, status, message, error, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      esim_id,
      cycle_anchor_date,
      expiry_date || (() => {
        const esim = getEsimById(esim_id);
        const date = new Date(`${cycle_anchor_date}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + Number(esim.cycle_days));
        return date.toISOString().slice(0, 10);
      })(),
      stage_days,
      days_remaining,
      status,
      message,
      error,
      nowIso()
    );
    return result.lastInsertRowid;
  }

  function listReminderLogs(limit = 100) {
    return db
      .prepare(
        `SELECT l.*, e.phone_number, e.country_name, e.carrier
         FROM reminder_logs l
         LEFT JOIN esims e ON e.id = l.esim_id
         ORDER BY l.id DESC
         LIMIT ?`
      )
      .all(limit);
  }

  function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  function setSetting(key, value) {
    const now = nowIso();
    db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, String(value ?? ''), now);
  }

  function setSettings(values) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of Object.entries(values)) setSetting(key, value);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const map = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }
    return map;
  }

  return {
    db,
    listEsims,
    getEsimById,
    createEsim,
    updateEsim,
    deleteEsim,
    getSentStagesForCycle,
    getRetryState,
    setRetryState,
    clearRetryState,
    addReminderLog,
    listReminderLogs,
    getSetting,
    setSetting,
    setSettings,
    getSettings,
    close: () => db.close(),
  };
}

module.exports = { createDatabase };
