const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db');
const { checkAndSendReminders, enrichEsim } = require('../src/reminder');

test('checkAndSendReminders triggers at 30, 15, 7, 3 days and deduplicates per cycle', async () => {
  const db = createDatabase(':memory:');
  db.setSetting('telegram_bot_token', '123456:TEST_TOKEN');
  db.setSetting('telegram_chat_id', '999999');

  const sentMessages = [];
  const mockFetch = async (_url, opts) => {
    sentMessages.push(JSON.parse(opts.body));
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: sentMessages.length } }),
    };
  };

  // Activation 2026-01-01, cycle 90 days => expiry 2026-04-01
  const esim = db.createEsim({
    phone_number: '+44 7400 123456',
    country_code: 'GB',
    country_name: '英国',
    carrier: 'Giffgaff',
    activation_date: '2026-01-01',
    last_renew_date: '2026-01-01',
    cycle_days: 90,
    notes: '发短信保号',
  });

  // 35 days remaining (2026-02-25) -> no reminder
  let res = await checkAndSendReminders(db, { todayStr: '2026-02-25', fetchImpl: mockFetch });
  assert.equal(res.sent, 0);

  // 30 days remaining (2026-03-02) -> triggers 30d stage
  res = await checkAndSendReminders(db, { todayStr: '2026-03-02', fetchImpl: mockFetch });
  assert.equal(res.sent, 1);
  assert.equal(res.details[0].stage, 30);

  // Same day again -> deduplicated, no duplicate message
  res = await checkAndSendReminders(db, { todayStr: '2026-03-02', fetchImpl: mockFetch });
  assert.equal(res.sent, 0);

  // 15 days remaining (2026-03-17) -> triggers 15d stage
  res = await checkAndSendReminders(db, { todayStr: '2026-03-17', fetchImpl: mockFetch });
  assert.equal(res.sent, 1);
  assert.equal(res.details[0].stage, 15);

  // 7 days remaining (2026-03-25) -> triggers 7d stage
  res = await checkAndSendReminders(db, { todayStr: '2026-03-25', fetchImpl: mockFetch });
  assert.equal(res.sent, 1);
  assert.equal(res.details[0].stage, 7);

  // 3 days remaining (2026-03-29) -> triggers 3d stage
  res = await checkAndSendReminders(db, { todayStr: '2026-03-29', fetchImpl: mockFetch });
  assert.equal(res.sent, 1);
  assert.equal(res.details[0].stage, 3);

  assert.equal(sentMessages.length, 4);
  assert.match(sentMessages[3].text, /Giffgaff/);
  assert.match(sentMessages[3].text, /发短信保号/);

  // Renew resets cycle (new last_renew_date = 2026-03-29, expiry = 2026-06-27)
  db.updateEsim(esim.id, { last_renew_date: '2026-03-29' });
  const renewed = enrichEsim(db.getEsimById(esim.id), '2026-03-29', db.getSentStagesForCycle(esim.id, '2026-03-29'));
  assert.equal(renewed.days_remaining, 90);
  assert.equal(renewed.stage_statuses.every((s) => s.status === 'pending'), true);

  db.close();
});

test('checkAndSendReminders merges multiple crossed stages into one message', async () => {
  const db = createDatabase(':memory:');
  db.setSetting('telegram_bot_token', '123456:TEST_TOKEN');
  db.setSetting('telegram_chat_id', '999999');

  let calls = 0;
  const mockFetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ ok: true, result: { message_id: calls } }) };
  };

  // Expiry 2026-04-01, checked on 2026-03-26 (6 days left -> crosses 30, 15, 7)
  db.createEsim({
    phone_number: '+852 9123 4567',
    country_code: 'HK',
    country_name: '中国香港',
    carrier: 'CUniq',
    activation_date: '2026-01-01',
    last_renew_date: '2026-01-01',
    cycle_days: 90,
  });

  const res = await checkAndSendReminders(db, { todayStr: '2026-03-26', fetchImpl: mockFetch });
  assert.equal(res.sent, 1);
  assert.equal(res.skipped, 2); // 30 and 15 skipped/superseded by 7
  assert.equal(res.details[0].stage, 7);
  assert.equal(calls, 1);

  db.close();
});
