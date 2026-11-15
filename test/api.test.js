const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db');
const { createApp } = require('../src/server');

async function startTestServer(options = {}) {
  const db = createDatabase(':memory:');
  const sent = [];
  const mockFetch = async (_url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  const app = createApp(db, { fetchImpl: mockFetch, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    sent,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

test('API CRUD, phone detection, renew, and settings work end-to-end', async () => {
  const srv = await startTestServer();
  try {
    // 1. Phone detection
    const detectRes = await fetch(`${srv.baseUrl}/api/phone/detect?number=%2B85291234567`);
    const detectData = await detectRes.json();
    assert.equal(detectData.countryCode, 'HK');
    assert.equal(detectData.countryName, '中国香港');

    // 2. Create eSIM
    const createRes = await fetch(`${srv.baseUrl}/api/esims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone_number: '+85291234567',
        carrier: 'ClubSIM',
        activation_date: '2026-01-01',
        cycle_days: 180,
        notes: '每年充值一次',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.country_code, 'HK');
    assert.equal(created.country_name, '中国香港');
    assert.equal(created.carrier, 'ClubSIM');
    assert.equal(created.expiry_date, '2026-06-30');

    // 3. List eSIMs
    const listRes = await fetch(`${srv.baseUrl}/api/esims`);
    const listData = await listRes.json();
    assert.equal(listData.items.length, 1);
    assert.equal(listData.stats.total, 1);

    // 4. Renew eSIM
    const renewRes = await fetch(`${srv.baseUrl}/api/esims/${created.id}/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-04-01' }),
    });
    assert.equal(renewRes.status, 200);
    const renewed = await renewRes.json();
    assert.equal(renewed.last_renew_date, '2026-04-01');
    assert.equal(renewed.expiry_date, '2026-09-28');

    // 5. Settings & Telegram test
    const putSettings = await fetch(`${srv.baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegram_bot_token: '111222:AAABBBCCC',
        telegram_chat_id: '555666',
        notify_hour: 10,
      }),
    });
    const settingsData = await putSettings.json();
    assert.equal(settingsData.telegram_configured, true);
    assert.equal(settingsData.notify_hour, 10);

    const testTgRes = await fetch(`${srv.baseUrl}/api/telegram/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(testTgRes.status, 200);
    assert.equal(srv.sent.length, 1);

    // 6. Delete eSIM
    const delRes = await fetch(`${srv.baseUrl}/api/esims/${created.id}`, {
      method: 'DELETE',
    });
    assert.equal(delRes.status, 200);
  } finally {
    await srv.close();
  }
});

test('Auth protection blocks unauthenticated API calls and allows login/logout with cookie', async () => {
  const srv = await startTestServer({
    auth: {
      username: 'admin',
      password: 'secret-password',
      secret: 'test-secret-key',
    },
  });
  try {
    // 1. Status shows enabled & unauthenticated
    const statusRes = await fetch(`${srv.baseUrl}/api/auth/status`);
    const statusData = await statusRes.json();
    assert.equal(statusData.enabled, true);
    assert.equal(statusData.authenticated, false);

    // 2. Protected route returns 401 without cookie
    const unauthRes = await fetch(`${srv.baseUrl}/api/esims`);
    assert.equal(unauthRes.status, 401);

    // 3. Wrong password returns 401
    const badLogin = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    assert.equal(badLogin.status, 401);

    // 4. Correct login returns 200 and sets HttpOnly session cookie
    const goodLogin = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret-password' }),
    });
    assert.equal(goodLogin.status, 200);
    const setCookie = goodLogin.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes('esim_session='));
    const cookiePair = setCookie.split(';')[0];

    // 5. Protected route works with cookie
    const authedRes = await fetch(`${srv.baseUrl}/api/esims`, {
      headers: { Cookie: cookiePair },
    });
    assert.equal(authedRes.status, 200);

    // 6. Status now shows authenticated
    const authedStatus = await fetch(`${srv.baseUrl}/api/auth/status`, {
      headers: { Cookie: cookiePair },
    });
    const authedStatusData = await authedStatus.json();
    assert.equal(authedStatusData.authenticated, true);
    assert.equal(authedStatusData.username, 'admin');

    // 7. Logout clears cookie
    const logoutRes = await fetch(`${srv.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookiePair },
    });
    assert.equal(logoutRes.status, 200);
    assert.match(logoutRes.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    await srv.close();
  }
});
