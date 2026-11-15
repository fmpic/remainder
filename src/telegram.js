const { getFlagEmoji } = require('./phone');

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getTelegramConfig(db) {
  const settings = db ? db.getSettings() : {};
  const token = (settings.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (settings.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || '').trim();
  return {
    token,
    chatId,
    configured: Boolean(token && chatId),
  };
}

function formatReminderMessage(esim, stageDays) {
  const flag = getFlagEmoji(esim.country_code);
  const countryDisplay = esim.country_name
    ? `${flag} ${escapeHtml(esim.country_name)}`
    : `${flag} 未知国家`;

  let urgencyEmoji = '🔔';
  let urgencyLabel = `提前 ${stageDays} 天提醒`;
  if (esim.days_remaining <= 0) {
    urgencyEmoji = '🚨';
    urgencyLabel = esim.days_remaining === 0 ? '今天到期！' : `已过期 ${Math.abs(esim.days_remaining)} 天`;
  } else if (esim.days_remaining <= 3) {
    urgencyEmoji = '🚨';
    urgencyLabel = `仅剩 ${esim.days_remaining} 天`;
  } else if (esim.days_remaining <= 7) {
    urgencyEmoji = '⚠️';
    urgencyLabel = `剩余 ${esim.days_remaining} 天`;
  } else if (esim.days_remaining <= 15) {
    urgencyEmoji = '⏳';
    urgencyLabel = `剩余 ${esim.days_remaining} 天`;
  } else {
    urgencyEmoji = '📅';
    urgencyLabel = `剩余 ${esim.days_remaining} 天`;
  }

  const lines = [
    `${urgencyEmoji} <b>eSIM 保号提醒（${escapeHtml(urgencyLabel)}）</b>`,
    '',
    `📱 <b>号码：</b><code>${escapeHtml(esim.phone_number)}</code>`,
    `🌍 <b>国家/地区：</b>${countryDisplay}`,
    `📡 <b>运营商：</b>${escapeHtml(esim.carrier)}`,
    `📆 <b>到期日期：</b><b>${escapeHtml(esim.expiry_date)}</b>`,
    `🔄 <b>保号周期：</b>每 ${esim.cycle_days} 天（上次保号：${escapeHtml(esim.last_renew_date)}）`,
  ];

  if (esim.notes && esim.notes.trim()) {
    lines.push(`📝 <b>备注：</b>${escapeHtml(esim.notes.trim())}`);
  }

  lines.push('');
  lines.push('请及时完成保号操作（充值/发短信/拨打电话等），并在网页端点击「已保号」重置周期。');

  return lines.join('\n');
}

async function sendTelegramMessage({ token, chatId, text, fetchImpl = fetch, timeoutMs = 15000 }) {
  if (!token || !chatId) {
    throw new Error('Telegram Bot Token 或 Chat ID 未配置');
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const errMsg = data.description || `HTTP ${response.status}`;
    const error = new Error(`Telegram API 错误: ${errMsg}`);
    const retryAfter = Number(data.parameters?.retry_after);
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterSeconds = retryAfter;
    throw error;
  }

  return data.result;
}

module.exports = {
  escapeHtml,
  getTelegramConfig,
  formatReminderMessage,
  sendTelegramMessage,
};
