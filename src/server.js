const path = require('node:path');
const express = require('express');
const { createDatabase } = require('./db');
const { detectPhoneInfo, getCountryName } = require('./phone');
const {
  enrichEsim,
  isValidDate,
  getNowInTimezone,
  checkAndSendReminders,
} = require('./reminder');
const { getTelegramConfig, sendTelegramMessage } = require('./telegram');
const { startScheduler } = require('./scheduler');
const { createAuthManager } = require('./auth');

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 10) return '******';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function createApp(db, { fetchImpl = fetch, auth: authConfig } = {}) {
  const app = express();
  const auth = createAuthManager(authConfig);
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  function getToday() {
    const settings = db.getSettings();
    const tz = settings.timezone || process.env.TZ || 'Asia/Shanghai';
    return getNowInTimezone(tz).date;
  }

  function enrichAndSort(rawList) {
    const today = getToday();
    return rawList
      .map((raw) => {
        const anchor = raw.last_renew_date || raw.activation_date;
        const sentStages = db.getSentStagesForCycle(raw.id, anchor);
        return enrichEsim(raw, today, sentStages);
      })
      .sort((a, b) => a.days_remaining - b.days_remaining);
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/auth/status', (req, res) => {
    const session = auth.getSession(req);
    res.json({
      enabled: auth.enabled,
      authenticated: session.authenticated,
      username: session.username,
    });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!auth.enabled) {
      return res.json({ ok: true, enabled: false });
    }
    const { username, password } = req.body || {};
    if (!auth.verifyCredentials(username, password)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    auth.setSessionCookie(req, res, auth.username);
    return res.json({ ok: true, username: auth.username });
  });

  app.post('/api/auth/logout', (_req, res) => {
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.use('/api', auth.requireAuth);

  app.get('/api/phone/detect', (req, res) => {
    const number = String(req.query.number || '');
    res.json(detectPhoneInfo(number));
  });

  app.get('/api/esims', (_req, res) => {
    const items = enrichAndSort(db.listEsims());
    const stats = {
      total: items.length,
      upcoming: items.filter((i) => i.enabled && i.days_remaining >= 0 && i.days_remaining <= 30).length,
      urgent: items.filter((i) => i.enabled && i.days_remaining >= 0 && i.days_remaining <= 7).length,
      expired: items.filter((i) => i.enabled && i.days_remaining < 0).length,
    };
    res.json({ items, stats, today: getToday() });
  });

  app.post('/api/esims', (req, res) => {
    const {
      phone_number,
      country_code,
      country_name,
      carrier,
      activation_date,
      last_renew_date,
      cycle_days,
      notes,
      enabled,
    } = req.body || {};

    if (!phone_number || !String(phone_number).trim()) {
      return res.status(400).json({ error: '请填写手机号码' });
    }
    if (!carrier || !String(carrier).trim()) {
      return res.status(400).json({ error: '请填写运营商' });
    }
    if (!activation_date || !isValidDate(activation_date)) {
      return res.status(400).json({ error: '请填写有效的开通日期 (YYYY-MM-DD)' });
    }
    const renewDate = last_renew_date ? String(last_renew_date) : String(activation_date);
    if (!isValidDate(renewDate)) {
      return res.status(400).json({ error: '请填写有效的最近保号日期 (YYYY-MM-DD)' });
    }
    const cycle = Number(cycle_days);
    if (!Number.isInteger(cycle) || cycle < 1 || cycle > 3650) {
      return res.status(400).json({ error: '保号周期必须是 1 到 3650 之间的整数天数' });
    }

    const detected = detectPhoneInfo(String(phone_number));
    const finalCountryCode = (country_code ?? detected.countryCode ?? '').trim().toUpperCase();
    const finalCountryName =
      (country_name && String(country_name).trim()) ||
      (finalCountryCode ? getCountryName(finalCountryCode) : '') ||
      detected.countryName ||
      '';

    const created = db.createEsim({
      phone_number: detected.formatted || String(phone_number).trim(),
      country_code: finalCountryCode,
      country_name: finalCountryName,
      carrier: String(carrier).trim(),
      activation_date: String(activation_date),
      last_renew_date: renewDate,
      cycle_days: cycle,
      notes: notes ? String(notes).trim() : '',
      enabled: enabled === undefined ? true : Boolean(enabled),
    });

    const today = getToday();
    const enriched = enrichEsim(created, today, new Set());
    res.status(201).json(enriched);
  });

  app.put('/api/esims/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.getEsimById(id);
    if (!existing) {
      return res.status(404).json({ error: '未找到该 eSIM 记录' });
    }

    const body = req.body || {};
    const nextPhone = body.phone_number !== undefined ? String(body.phone_number).trim() : existing.phone_number;
    if (!nextPhone) {
      return res.status(400).json({ error: '手机号码不能为空' });
    }

    const nextCarrier = body.carrier !== undefined ? String(body.carrier).trim() : existing.carrier;
    if (!nextCarrier) {
      return res.status(400).json({ error: '运营商不能为空' });
    }

    const nextActivation =
      body.activation_date !== undefined ? String(body.activation_date) : existing.activation_date;
    if (!isValidDate(nextActivation)) {
      return res.status(400).json({ error: '开通日期格式无效 (YYYY-MM-DD)' });
    }

    const nextRenew =
      body.last_renew_date !== undefined ? String(body.last_renew_date) : existing.last_renew_date;
    if (!isValidDate(nextRenew)) {
      return res.status(400).json({ error: '最近保号日期格式无效 (YYYY-MM-DD)' });
    }

    const nextCycle = body.cycle_days !== undefined ? Number(body.cycle_days) : existing.cycle_days;
    if (!Number.isInteger(nextCycle) || nextCycle < 1 || nextCycle > 3650) {
      return res.status(400).json({ error: '保号周期必须是 1 到 3650 之间的整数天数' });
    }

    let nextCountryCode = existing.country_code;
    let nextCountryName = existing.country_name;
    let formattedPhone = nextPhone;

    if (body.phone_number !== undefined && body.phone_number !== existing.phone_number) {
      const detected = detectPhoneInfo(nextPhone);
      formattedPhone = detected.formatted || nextPhone;
      if (body.country_code === undefined && detected.countryCode) {
        nextCountryCode = detected.countryCode;
      }
      if (body.country_name === undefined && detected.countryName) {
        nextCountryName = detected.countryName;
      }
    }

    if (body.country_code !== undefined) {
      nextCountryCode = String(body.country_code).trim().toUpperCase();
    }
    if (body.country_name !== undefined) {
      nextCountryName = String(body.country_name).trim();
    } else if (body.country_code !== undefined && nextCountryCode) {
      nextCountryName = getCountryName(nextCountryCode);
    }

    const updated = db.updateEsim(id, {
      phone_number: formattedPhone,
      country_code: nextCountryCode,
      country_name: nextCountryName,
      carrier: nextCarrier,
      activation_date: nextActivation,
      last_renew_date: nextRenew,
      cycle_days: nextCycle,
      notes: body.notes !== undefined ? String(body.notes).trim() : existing.notes,
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : Boolean(existing.enabled),
    });

    const today = getToday();
    const sentStages = db.getSentStagesForCycle(updated.id, updated.last_renew_date);
    res.json(enrichEsim(updated, today, sentStages));
  });

  app.post('/api/esims/:id/renew', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.getEsimById(id);
    if (!existing) {
      return res.status(404).json({ error: '未找到该 eSIM 记录' });
    }

    const today = getToday();
    const renewDate = req.body?.date ? String(req.body.date) : today;
    if (!isValidDate(renewDate)) {
      return res.status(400).json({ error: '续期日期格式无效 (YYYY-MM-DD)' });
    }

    const updated = db.updateEsim(id, { last_renew_date: renewDate });
    const sentStages = db.getSentStagesForCycle(updated.id, updated.last_renew_date);
    res.json(enrichEsim(updated, today, sentStages));
  });

  app.delete('/api/esims/:id', (req, res) => {
    const id = Number(req.params.id);
    const deleted = db.deleteEsim(id);
    if (!deleted) {
      return res.status(404).json({ error: '未找到该 eSIM 记录' });
    }
    res.json({ ok: true });
  });

  app.get('/api/settings', (_req, res) => {
    const settings = db.getSettings();
    const tg = getTelegramConfig(db);
    res.json({
      telegram_configured: tg.configured,
      telegram_bot_token_masked: maskToken(tg.token),
      telegram_chat_id: tg.chatId,
      notify_hour: Number(settings.notify_hour ?? process.env.NOTIFY_HOUR ?? 9),
      notify_minute: Number(settings.notify_minute ?? process.env.NOTIFY_MINUTE ?? 0),
      timezone: settings.timezone || process.env.TZ || 'Asia/Shanghai',
    });
  });

  app.put('/api/settings', (req, res) => {
    const { telegram_bot_token, telegram_chat_id, notify_hour, notify_minute, timezone } = req.body || {};

    const updates = {};
    if (telegram_bot_token !== undefined && String(telegram_bot_token).trim() !== '') {
      updates.telegram_bot_token = String(telegram_bot_token).trim();
    }
    if (telegram_chat_id !== undefined) {
      updates.telegram_chat_id = String(telegram_chat_id).trim();
    }
    if (notify_hour !== undefined) {
      const hour = Number(notify_hour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return res.status(400).json({ error: '提醒时间必须在 0 到 23 之间' });
      }
      updates.notify_hour = String(hour);
    }
    if (notify_minute !== undefined) {
      const minute = Number(notify_minute);
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        return res.status(400).json({ error: '提醒分钟必须在 0 到 59 之间' });
      }
      updates.notify_minute = String(minute);
    }
    if (timezone !== undefined && String(timezone).trim() !== '') {
      const tz = String(timezone).trim();
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
      } catch {
        return res.status(400).json({ error: '无效的时区' });
      }
      updates.timezone = tz;
    }
    db.setSettings(updates);

    const tg = getTelegramConfig(db);
    const settings = db.getSettings();
    res.json({
      ok: true,
      telegram_configured: tg.configured,
      telegram_bot_token_masked: maskToken(tg.token),
      telegram_chat_id: tg.chatId,
      notify_hour: Number(settings.notify_hour ?? process.env.NOTIFY_HOUR ?? 9),
      notify_minute: Number(settings.notify_minute ?? process.env.NOTIFY_MINUTE ?? 0),
      timezone: settings.timezone || process.env.TZ || 'Asia/Shanghai',
    });
  });

  app.post('/api/telegram/test', async (req, res) => {
    try {
      const saved = getTelegramConfig(db);
      const token = (req.body?.telegram_bot_token || saved.token || '').trim();
      const chatId = (req.body?.telegram_chat_id || saved.chatId || '').trim();

      if (!token || !chatId) {
        return res.status(400).json({ error: '请先填写 Telegram Bot Token 和 Chat ID' });
      }

      const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      await sendTelegramMessage({
        token,
        chatId,
        text: `✅ <b>eSIM 保号提醒服务测试消息</b>\n\n您的 Telegram Bot 配置成功！\n当前时间：${now}\n提醒节点：提前 30 天、15 天、7 天、3 天`,
        fetchImpl,
      });

      res.json({ ok: true, message: '测试消息已发送，请检查您的 Telegram' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/reminders/check', async (_req, res) => {
    try {
      const result = await checkAndSendReminders(db, { fetchImpl });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/reminders/logs', (req, res) => {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    res.json({ items: db.listReminderLogs(limit) });
  });

  return app;
}

if (require.main === module) {
  const { loadEnvironment, getListenHost } = require('./startup');
  loadEnvironment();
  const host = getListenHost();
  const port = Number(process.env.PORT || 3000);
  const db = createDatabase(process.env.DB_PATH || './data/esim.db');
  const app = createApp(db);
  const scheduler = startScheduler(db);

  const server = app.listen(port, host, () => {
    console.log(`eSIM 保号提醒服务已启动: http://${host}:${port}`);
  });

  function shutdown() {
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
