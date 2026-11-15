const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const { isValidDate, addDays, checkAndSendReminders } = require('../src/reminder');
const { sendTelegramMessage } = require('../src/telegram');
const { loadEnvironment, getListenHost } = require('../src/startup');

const card = { phone_number: '+85291234567', carrier: 'test', activation_date: '2026-01-01', cycle_days: 90 };

test('dates validate calendar days including leap years and years below 100', () => {
  for (const date of ['2026-99-99', '2026-02-29', '2026-02-31', '2026-00-01', '2026-01-00', 'not-a-date']) {
    assert.equal(isValidDate(date), false, date);
  }
  assert.equal(isValidDate('2024-02-29'), true);
  assert.equal(addDays('0099-01-01', 1), '0099-01-02');
  assert.throws(() => addDays('2026-02-31', 1));
});

test('API rejects invalid dates and settings without partial writes', async () => {
  const db = createDatabase(':memory:');
  const server = createApp(db, { auth: { username: '', password: '' } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = async (route, body, method = 'POST') => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await request('/api/esims', { ...card, activation_date: '2026-02-31' })).status, 400);
    const created = await (await request('/api/esims', card)).json();
    assert.equal((await request(`/api/esims/${created.id}`, { last_renew_date: '2026-99-99' }, 'PUT')).status, 400);
    assert.equal((await request(`/api/esims/${created.id}/renew`, { date: '2026-02-29' })).status, 400);
    db.setSetting('telegram_bot_token', 'original');
    for (const invalid of [{ notify_hour: 99 }, { timezone: 'Invalid/Zone' }]) {
      assert.equal((await request('/api/settings', { telegram_bot_token: 'replacement', ...invalid }, 'PUT')).status, 400);
      assert.equal(db.getSetting('telegram_bot_token'), 'original');
    }
    assert.equal((await request('/api/settings', { notify_hour: 10, timezone: 'Asia/Shanghai' }, 'PUT')).status, 200);
    assert.equal(db.getSetting('notify_hour'), '10');
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

test('settings transaction rolls back earlier writes if a later write fails', () => {
  const db = createDatabase(':memory:');
  try {
    db.setSetting('first', 'original');
    db.db.exec("CREATE TRIGGER reject_setting BEFORE INSERT ON settings WHEN NEW.key = 'reject' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => db.setSettings({ first: 'changed', reject: 'value' }));
    assert.equal(db.getSetting('first'), 'original');
  } finally { db.close(); }
});

test('concurrent checks send once and failed checks can be retried', async () => {
  const db = createDatabase(':memory:');
  try {
    db.setSettings({ telegram_bot_token: 'fake', telegram_chat_id: 'fake' });
    db.createEsim(card);
    let calls = 0;
    let fail = true;
    const fetchImpl = async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      if (fail) throw new Error('network failure');
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const options = { todayStr: '2026-03-02', fetchImpl, nowMs: 1000 };
    assert.equal((await checkAndSendReminders(db, options)).failed, 1);
    fail = false;
    assert.equal((await checkAndSendReminders(db, options)).sent, 0);
    options.nowMs += 15 * 60 * 1000;
    const results = await Promise.all(Array.from({ length: 5 }, () => checkAndSendReminders(db, options)));
    assert.equal(results.reduce((sum, result) => sum + result.sent, 0), 1);
    assert.equal(calls, 2);
  } finally { db.close(); }
});

test('a timed out card does not prevent delivery to the next card', async () => {
  const db = createDatabase(':memory:');
  try {
    db.setSettings({ telegram_bot_token: 'fake', telegram_chat_id: 'fake' });
    db.createEsim(card);
    db.createEsim(card);
    let calls = 0;
    const result = await checkAndSendReminders(db, {
      todayStr: '2026-03-02',
      fetchImpl: async () => {
        if (++calls === 1) throw new DOMException('Timed out', 'TimeoutError');
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    assert.equal(result.failed, 1);
    assert.equal(result.sent, 1);
    assert.equal(calls, 2);
  } finally { db.close(); }
});

test('Telegram fetch receives a timeout signal that cancels stalled requests', async () => {
  // Keep the event loop alive while AbortSignal.timeout uses an unreferenced timer.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(sendTelegramMessage({ token: 'fake', chatId: 'fake', text: 'test', timeoutMs: 20,
      fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }), { name: 'TimeoutError' });
  } finally { clearInterval(keepAlive); }
});

test('startup defaults to loopback and requires authentication for public binding', () => {
  assert.equal(getListenHost({}), '127.0.0.1');
  assert.equal(getListenHost({ HOST: '::1' }), '::1');
  assert.throws(() => getListenHost({ HOST: '0.0.0.0' }));
  assert.throws(() => getListenHost({ HOST: '0.0.0.0', AUTH_USERNAME: 'admin' }));
  assert.equal(getListenHost({ HOST: '0.0.0.0', AUTH_USERNAME: 'admin', AUTH_PASSWORD: 'secret' }), '0.0.0.0');
});

test('environment loader supports missing files and preserves exported variables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esim-env-'));
  const key = 'ESIM_REGRESSION_ENV';
  const old = process.env[key];
  try {
    loadEnvironment(path.join(dir, 'missing'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, `${key}=from-file\n`);
    delete process.env[key];
    loadEnvironment(envFile);
    assert.equal(process.env[key], 'from-file');
    process.env[key] = 'exported';
    loadEnvironment(envFile);
    assert.equal(process.env[key], 'exported');
  } finally {
    if (old === undefined) delete process.env[key]; else process.env[key] = old;
    fs.rmSync(dir, { recursive: true });
  }
});
