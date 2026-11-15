const { getNowInTimezone, checkAndSendReminders } = require('./reminder');

function startScheduler(db, {
  intervalMs = 60 * 1000,
  logger = console,
  getNow = getNowInTimezone,
  checkReminders = checkAndSendReminders,
} = {}) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const settings = db.getSettings();
      const tz = settings.timezone || process.env.TZ || 'Asia/Shanghai';
      const notifyHour = Number(settings.notify_hour ?? process.env.NOTIFY_HOUR ?? 9);
      const notifyMinute = Number(settings.notify_minute ?? process.env.NOTIFY_MINUTE ?? 0);
      const now = getNow(tz);

      if (now.hour * 60 + now.minute >= notifyHour * 60 + notifyMinute) {
        const result = await checkReminders(db, { todayStr: now.date });
        if (result.sent > 0 || result.failed > 0) {
          logger.log(
            `[Scheduler] ${now.date} 检查完成: checked=${result.checked}, sent=${result.sent}, skipped=${result.skipped}, failed=${result.failed}`
          );
        }
      }
    } catch (err) {
      logger.error('[Scheduler] 检查提醒失败:', err);
    } finally {
      running = false;
    }
  }

  // Initial check 3 seconds after startup
  const startupTimer = setTimeout(() => {
    tick();
  }, 3000);
  startupTimer.unref();

  const intervalTimer = setInterval(() => {
    tick();
  }, intervalMs);
  intervalTimer.unref();

  return {
    tick,
    stop() {
      clearTimeout(startupTimer);
      clearInterval(intervalTimer);
    },
  };
}

module.exports = { startScheduler };
