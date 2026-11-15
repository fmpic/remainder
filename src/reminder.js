const {
  getTelegramConfig,
  formatReminderMessage,
  sendTelegramMessage,
} = require('./telegram');
const { getFlagEmoji } = require('./phone');

// 提前 30 天（一个月）、15 天、7 天、3 天
const REMINDER_STAGES = [30, 15, 7, 3];

function isValidDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === dateStr;
}

function parseDateUTC(dateStr) {
  if (!isValidDate(dateStr)) throw new Error('无效日期 (YYYY-MM-DD)');
  return new Date(`${dateStr}T00:00:00.000Z`).getTime();
}

function formatDateUTC(ms) {
  const dt = new Date(ms);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, days) {
  const ms = parseDateUTC(dateStr) + days * 86400000;
  return formatDateUTC(ms);
}

function diffDays(targetDateStr, baseDateStr) {
  return Math.round((parseDateUTC(targetDateStr) - parseDateUTC(baseDateStr)) / 86400000);
}

function getNowInTimezone(tz = process.env.TZ || 'Asia/Shanghai') {
  const now = new Date();
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const map = {};
    for (const p of parts) {
      map[p.type] = p.value;
    }
    const hour = Number(map.hour === '24' ? '0' : map.hour);
    return {
      date: `${map.year}-${map.month}-${map.day}`,
      hour,
      minute: Number(map.minute),
    };
  } catch {
    return {
      date: now.toISOString().slice(0, 10),
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
    };
  }
}

function getApplicableStages(cycleDays) {
  const filtered = REMINDER_STAGES.filter((s) => s < cycleDays);
  // If cycle is very short (e.g. <= 3 days), still allow stage 3 if <= cycleDays
  if (filtered.length === 0 && cycleDays >= 1) {
    return [Math.min(3, cycleDays)];
  }
  return filtered;
}

function enrichEsim(esim, todayStr, sentStages = new Set()) {
  const anchorDate = esim.last_renew_date || esim.activation_date;
  const expiry_date = addDays(anchorDate, Number(esim.cycle_days));
  const days_remaining = diffDays(expiry_date, todayStr);
  const applicableStages = getApplicableStages(Number(esim.cycle_days));

  let status = 'normal';
  if (days_remaining < 0) {
    status = 'expired';
  } else if (days_remaining <= 3) {
    status = 'critical';
  } else if (days_remaining <= 7) {
    status = 'danger';
  } else if (days_remaining <= 15) {
    status = 'warning';
  } else if (days_remaining <= 30) {
    status = 'upcoming';
  }

  const displayStages = [...new Set([...REMINDER_STAGES, ...applicableStages])];
  if (days_remaining <= 0) displayStages.push(days_remaining);
  const stage_statuses = displayStages.map((stage) => {
    if (stage > 0 && !applicableStages.includes(stage)) {
      return { stage, status: 'na' };
    }
    if (sentStages.has(stage)) {
      return { stage, status: 'sent' };
    }
    if (days_remaining <= stage) {
      return { stage, status: 'due' };
    }
    return { stage, status: 'pending' };
  });

  return {
    ...esim,
    enabled: Boolean(esim.enabled),
    flag: getFlagEmoji(esim.country_code),
    cycle_anchor_date: anchorDate,
    expiry_date,
    days_remaining,
    status,
    stage_statuses,
  };
}

// All entry points sharing this database must serialize the read/send/log sequence.
const reminderQueues = new WeakMap();

async function checkAndSendReminders(db, options = {}) {
  const previous = reminderQueues.get(db) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => runReminderCheck(db, options));
  reminderQueues.set(db, current);
  try {
    return await current;
  } finally {
    if (reminderQueues.get(db) === current) reminderQueues.delete(db);
  }
}

async function runReminderCheck(
  db,
  {
    todayStr,
    fetchImpl = fetch,
    dryRun = false,
    nowMs = Date.now(),
  } = {}
) {
  const settings = db.getSettings();
  const tz = settings.timezone || process.env.TZ || 'Asia/Shanghai';
  const today = todayStr || getNowInTimezone(tz).date;
  const tgConfig = getTelegramConfig(db);

  const esims = db.listEsims();
  const summary = {
    today,
    checked: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    telegramConfigured: tgConfig.configured,
    details: [],
  };

  for (const raw of esims) {
    if (!raw.enabled) continue;
    summary.checked += 1;

    const anchorDate = raw.last_renew_date || raw.activation_date;
    const expiryDate = addDays(anchorDate, Number(raw.cycle_days));
    const sentStages = db.getSentStagesForCycle(raw.id, anchorDate, expiryDate);
    const esim = enrichEsim(raw, today, sentStages);
    const applicableStages = getApplicableStages(Number(raw.cycle_days));
    // Catch up only today, not every missed overdue day.
    if (esim.days_remaining <= 0) applicableStages.push(esim.days_remaining);

    // Find all applicable stages where days_remaining <= stage and not yet sent/skipped
    const dueStages = applicableStages
      .filter((stage) => esim.days_remaining <= stage && !sentStages.has(stage))
      .sort((a, b) => a - b); // smallest (most urgent) first

    if (dueStages.length === 0) {
      continue;
    }

    const targetStage = dueStages[0];
    const supersededStages = dueStages.slice(1);
    const message = formatReminderMessage(esim, targetStage);

    if (dryRun) {
      summary.details.push({
        esim_id: esim.id,
        phone_number: esim.phone_number,
        stage: targetStage,
        days_remaining: esim.days_remaining,
        status: 'dry_run',
      });
      continue;
    }

    const retry = db.getRetryState(raw.id, expiryDate);
    if (nowMs < Number(db.getSetting('telegram_retry_until') || 0) || (retry && nowMs < retry.retry_at)) {
      summary.skipped += 1;
      continue;
    }
    function deferRetry(retryAfterSeconds = 0) {
      const failures = (retry?.failures || 0) + 1;
      const delay = Math.max(Math.min(15 * 60 * 1000 * 2 ** Math.min(failures - 1, 10), 6 * 60 * 60 * 1000), retryAfterSeconds * 1000);
      db.setRetryState(raw.id, expiryDate, failures, nowMs + delay);
      if (retryAfterSeconds > 0) db.setSetting('telegram_retry_until', String(nowMs + retryAfterSeconds * 1000));
    }

    if (!tgConfig.configured) {
      deferRetry();
      summary.failed += 1;
      const errMsg = 'Telegram Bot Token 或 Chat ID 未配置';
      db.addReminderLog({
        esim_id: esim.id,
        cycle_anchor_date: anchorDate,
        expiry_date: expiryDate,
        stage_days: targetStage,
        days_remaining: esim.days_remaining,
        status: 'failed',
        message,
        error: errMsg,
      });
      summary.details.push({
        esim_id: esim.id,
        phone_number: esim.phone_number,
        stage: targetStage,
        days_remaining: esim.days_remaining,
        status: 'failed',
        error: errMsg,
      });
      continue;
    }

    try {
      await sendTelegramMessage({
        token: tgConfig.token,
        chatId: tgConfig.chatId,
        text: message,
        fetchImpl,
      });

      db.addReminderLog({
        esim_id: esim.id,
        cycle_anchor_date: anchorDate,
        expiry_date: expiryDate,
        stage_days: targetStage,
        days_remaining: esim.days_remaining,
        status: 'sent',
        message,
      });
      db.clearRetryState(raw.id);
      summary.sent += 1;

      for (const s of supersededStages) {
        db.addReminderLog({
          esim_id: esim.id,
          cycle_anchor_date: anchorDate,
          expiry_date: expiryDate,
          stage_days: s,
          days_remaining: esim.days_remaining,
          status: 'skipped',
          message: `已被更紧急的 ${targetStage} 天提醒合并覆盖`,
        });
        summary.skipped += 1;
      }

      summary.details.push({
        esim_id: esim.id,
        phone_number: esim.phone_number,
        stage: targetStage,
        days_remaining: esim.days_remaining,
        status: 'sent',
      });
    } catch (err) {
      deferRetry(err.retryAfterSeconds);
      summary.failed += 1;
      db.addReminderLog({
        esim_id: esim.id,
        cycle_anchor_date: anchorDate,
        expiry_date: expiryDate,
        stage_days: targetStage,
        days_remaining: esim.days_remaining,
        status: 'failed',
        message,
        error: err.message,
      });
      summary.details.push({
        esim_id: esim.id,
        phone_number: esim.phone_number,
        stage: targetStage,
        days_remaining: esim.days_remaining,
        status: 'failed',
        error: err.message,
      });
    }
  }

  return summary;
}

module.exports = {
  REMINDER_STAGES,
  isValidDate,
  addDays,
  diffDays,
  getNowInTimezone,
  getApplicableStages,
  enrichEsim,
  checkAndSendReminders,
};
