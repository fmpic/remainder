const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const { startScheduler } = require('../src/scheduler');
const { getNowInTimezone } = require('../src/reminder');

test('scheduler respects configured minutes, midnight and end of day', async () => {
  const db = createDatabase(':memory:');
  let now;
  let calls = 0;
  const scheduler = startScheduler(db, {
    getNow: (tz) => {
      assert.equal(tz, 'Asia/Shanghai');
      return { date: '2026-01-01', ...now };
    },
    checkReminders: async () => {
      calls++;
      return { sent: 0, failed: 0 };
    },
  });
  try {
    db.setSettings({ timezone: 'Asia/Shanghai', notify_hour: 14, notify_minute: 37 });
    now = { hour: 14, minute: 36 };
    await scheduler.tick();
    assert.equal(calls, 0);
    now.minute = 37;
    await scheduler.tick();
    assert.equal(calls, 1);
    now = { hour: 15, minute: 0 };
    await scheduler.tick();
    assert.equal(calls, 2); // Catch up after downtime; reminder logs handle deduplication.
    db.setSettings({ notify_hour: 23, notify_minute: 59 });
    now = { hour: 23, minute: 58 };
    await scheduler.tick();
    assert.equal(calls, 2);
    now.minute = 59;
    await scheduler.tick();
    assert.equal(calls, 3);
    db.setSettings({ notify_hour: 0, notify_minute: 0 });
    now = { hour: 0, minute: 0 };
    await scheduler.tick();
    assert.equal(calls, 4);
  } finally { scheduler.stop(); db.close(); }
});

test('timezone clock includes minutes, including UTC fallback', () => {
  for (const tz of ['Asia/Shanghai', 'Invalid/Timezone']) {
    const now = getNowInTimezone(tz);
    assert.ok(Number.isInteger(now.minute) && now.minute >= 0 && now.minute <= 59);
  }
});

test('settings round-trip minute precision and reject invalid minutes atomically', async () => {
  const db = createDatabase(':memory:');
  const server = createApp(db, { auth: { username: '', password: '' } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/settings`;
  const save = body => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(url)).json()).notify_minute, Number(process.env.NOTIFY_MINUTE ?? 0));
    for (const [hour, minute] of [[0, 0], [14, 37], [23, 59]]) {
      const response = await save({ notify_hour: hour, notify_minute: minute });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.notify_hour, hour);
      assert.equal(data.notify_minute, minute);
      assert.equal((await (await fetch(url)).json()).notify_minute, minute);
    }
    for (const minute of [-1, 60, 1.5, 'invalid']) {
      assert.equal((await save({ notify_hour: 8, notify_minute: minute })).status, 400);
      assert.equal(db.getSetting('notify_hour'), '23');
      assert.equal(db.getSetting('notify_minute'), '59');
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
