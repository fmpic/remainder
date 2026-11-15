const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db');
const { checkAndSendReminders, enrichEsim } = require('../src/reminder');
const card = { phone_number: '+12025550123', carrier: 'Test', activation_date: '2026-01-01', cycle_days: 60 };
const success = async () => ({ ok: true, json: async () => ({ ok: true }) });
function setup() {
  const db = createDatabase(':memory:');
  db.setSettings({ telegram_bot_token: 'fake', telegram_chat_id: 'fake' });
  const esim = db.createEsim(card);
  return { db, esim };
}

test('changing cycle preserves history without suppressing new expiry reminders', async () => {
  const { db, esim } = setup();
  try {
    assert.equal((await checkAndSendReminders(db, { todayStr: '2026-02-27', fetchImpl: success })).sent, 1);
    db.updateEsim(esim.id, { cycle_days: 90 });
    assert.equal((await checkAndSendReminders(db, { todayStr: '2026-03-29', fetchImpl: success })).sent, 1);
    assert.equal(db.listReminderLogs().filter(l => l.status === 'sent').length, 2);
  } finally { db.close(); }
});

test('expiry and overdue reminders send once per day and stop after renewal or disabling', async () => {
  const { db, esim } = setup();
  try {
    for (const day of ['2026-02-27', '2026-03-02', '2026-03-03', '2026-03-07']) {
      const options = { todayStr: day, fetchImpl: success };
      assert.equal((await checkAndSendReminders(db, options)).sent, 1);
      assert.equal((await checkAndSendReminders(db, options)).sent, 0);
    }
    db.updateEsim(esim.id, { enabled: false });
    assert.equal((await checkAndSendReminders(db, { todayStr: '2026-03-08', fetchImpl: success })).sent, 0);
    db.updateEsim(esim.id, { enabled: true, last_renew_date: '2026-03-08' });
    assert.equal((await checkAndSendReminders(db, { todayStr: '2026-03-08', fetchImpl: success })).sent, 0);
  } finally { db.close(); }
});

test('short cycles expose actual sending stage to UI', () => {
  for (const cycle_days of [1, 2]) {
    const item = enrichEsim({ ...card, cycle_days }, '2026-01-01');
    assert.equal(item.stage_statuses.find(s => s.stage === cycle_days).status, 'due');
  }
});

test('retry backoff grows, honors Telegram retry_after across cards, and clears on success', async () => {
  const { db, esim } = setup();
  try {
    let calls = 0;
    const options = { todayStr: '2026-02-27', nowMs: 1000, fetchImpl: async () => {
      calls++;
      return { ok: false, status: 429, json: async () => ({ ok: false, parameters: { retry_after: 3600 } }) };
    } };
    assert.equal((await checkAndSendReminders(db, options)).failed, 1);
    db.createEsim(card);
    assert.equal((await checkAndSendReminders(db, options)).failed, 0);
    assert.equal(calls, 1);
    assert.equal(db.getRetryState(esim.id, '2026-03-02').retry_at, 3601000);
    options.nowMs += 3600000;
    options.fetchImpl = async () => { throw new Error('offline'); };
    assert.equal((await checkAndSendReminders(db, options)).failed, 2);
    assert.equal(db.getRetryState(esim.id, '2026-03-02').retry_at, options.nowMs + 1800000);
    options.nowMs += 1800000;
    options.fetchImpl = success;
    assert.equal((await checkAndSendReminders(db, options)).sent, 2);
    assert.equal(db.getRetryState(esim.id, '2026-03-02'), undefined);
  } finally { db.close(); }
});

test('legacy history migrates once and retry state survives reopening', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esim-migration-'));
  const file = path.join(dir, 'test.db');
  let db;
  try {
    db = createDatabase(file);
    const esim = db.createEsim(card);
    db.addReminderLog({ esim_id: esim.id, cycle_anchor_date: '2026-01-01', stage_days: 3, days_remaining: 3, status: 'sent' });
    db.close(); db = null;
    const legacy = new DatabaseSync(file);
    legacy.exec('ALTER TABLE reminder_logs DROP COLUMN expiry_date');
    legacy.close();
    db = createDatabase(file);
    assert.equal(db.getSentStagesForCycle(esim.id, '2026-01-01').has(3), true);
    db.setRetryState(esim.id, '2026-03-02', 2, 123456);
    db.close(); db = createDatabase(file);
    assert.equal(db.listReminderLogs().length, 1);
    assert.equal(db.getRetryState(esim.id, '2026-03-02').retry_at, 123456);
    db.updateEsim(esim.id, { cycle_days: 90 });
    assert.equal(db.getSentStagesForCycle(esim.id, '2026-01-01').has(3), false);
  } finally {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
