const state = {
  items: [],
  today: '',
  filter: 'all',
  search: '',
  settings: null,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = isError ? 'toast error' : 'toast';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.classList.add('hidden');
  }, 3200);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    showLoginView();
    throw new Error(data.error || '请先登录');
  }
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

function showLoginView() {
  $('appView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  $('loginError').classList.add('hidden');
}

function showAppView(authEnabled) {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  if (authEnabled) {
    $('btnLogout').classList.remove('hidden');
  } else {
    $('btnLogout').classList.add('hidden');
  }
}

function openModal(id) {
  $(id).classList.remove('hidden');
}

function closeModal(id) {
  $(id).classList.add('hidden');
}

function getCountdownBadge(item) {
  if (!item.enabled) {
    return '<span class="badge badge-muted">已暂停提醒</span>';
  }
  const d = item.days_remaining;
  if (d < 0) {
    return `<span class="badge badge-critical">已过期 ${Math.abs(d)} 天</span>`;
  }
  if (d === 0) {
    return '<span class="badge badge-critical">今天到期</span>';
  }
  if (d <= 3) {
    return `<span class="badge badge-critical">剩余 ${d} 天</span>`;
  }
  if (d <= 7) {
    return `<span class="badge badge-danger">剩余 ${d} 天</span>`;
  }
  if (d <= 15) {
    return `<span class="badge badge-warning">剩余 ${d} 天</span>`;
  }
  if (d <= 30) {
    return `<span class="badge badge-warning">剩余 ${d} 天</span>`;
  }
  return `<span class="badge badge-success">剩余 ${d} 天</span>`;
}

function renderStagePills(stages) {
  return stages
    .map((s) => {
      const label = s.stage === 0 ? '到期当天' : s.stage < 0 ? `逾期${Math.abs(s.stage)}天` : `${s.stage}天`;
      if (s.status === 'sent') {
        return `<span class="stage-pill sent" title="本周期已发送">✓ ${label}</span>`;
      }
      if (s.status === 'due') {
        return `<span class="stage-pill due" title="已进入提醒窗口">! ${label}</span>`;
      }
      if (s.status === 'na') {
        return `<span class="stage-pill na" title="周期较短不适用">${label}</span>`;
      }
      return `<span class="stage-pill" title="待提醒">${label}</span>`;
    })
    .join('');
}

function renderList() {
  const container = $('esimList');
  const q = state.search.trim().toLowerCase();

  const filtered = state.items.filter((item) => {
    if (state.filter === 'upcoming' && !(item.days_remaining >= 0 && item.days_remaining <= 30)) {
      return false;
    }
    if (state.filter === 'urgent' && !(item.days_remaining >= 0 && item.days_remaining <= 7)) {
      return false;
    }
    if (state.filter === 'expired' && !(item.days_remaining < 0)) {
      return false;
    }
    if (q) {
      const hay = `${item.phone_number} ${item.country_name} ${item.carrier} ${item.notes}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>${state.items.length === 0 ? '还没有添加任何 eSIM，点击右上角「+ 添加 eSIM」开始吧！' : '没有符合筛选条件的 eSIM'}</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map(
      (item) => `
    <article class="esim-card ${item.enabled ? '' : 'disabled'}" data-id="${item.id}">
      <div class="esim-card-header">
        <div class="esim-identity">
          <div class="esim-flag">${escapeHtml(item.flag || '🌐')}</div>
          <div>
            <div class="esim-phone">${escapeHtml(item.phone_number)}</div>
            <div class="esim-sub">
              <span>${escapeHtml(item.country_name || '未知国家')}</span>
              <span class="carrier-pill">${escapeHtml(item.carrier)}</span>
            </div>
          </div>
        </div>
        ${getCountdownBadge(item)}
      </div>

      <div class="esim-meta">
        <div class="meta-item">
          <span>到期日期</span>
          <strong>${escapeHtml(item.expiry_date)}</strong>
        </div>
        <div class="meta-item">
          <span>保号周期</span>
          <strong>每 ${item.cycle_days} 天</strong>
        </div>
        <div class="meta-item">
          <span>开通日期</span>
          <strong>${escapeHtml(item.activation_date)}</strong>
        </div>
        <div class="meta-item">
          <span>最近保号</span>
          <strong>${escapeHtml(item.last_renew_date)}</strong>
        </div>
      </div>

      <div class="stages-row">
        <span style="color: var(--muted);">提醒节点：</span>
        ${renderStagePills(item.stage_statuses || [])}
      </div>

      ${item.notes ? `<div class="esim-notes">📝 ${escapeHtml(item.notes)}</div>` : ''}

      <div class="esim-actions">
        <button class="btn btn-success btn-sm" data-action="renew" data-id="${item.id}">✓ 已保号 (重置周期)</button>
        <div class="btn-group">
          <button class="btn btn-secondary btn-sm" data-action="edit" data-id="${item.id}">编辑</button>
          <button class="btn btn-danger btn-sm" data-action="delete" data-id="${item.id}">删除</button>
        </div>
      </div>
    </article>
  `
    )
    .join('');
}

async function loadEsims() {
  const data = await api('/api/esims');
  state.items = data.items || [];
  state.today = data.today || '';
  $('statTotal').textContent = data.stats.total;
  $('statUpcoming').textContent = data.stats.upcoming;
  $('statUrgent').textContent = data.stats.urgent;
  $('statExpired').textContent = data.stats.expired;
  renderList();
}

async function loadSettings() {
  const data = await api('/api/settings');
  state.settings = data;
  const badge = $('tgStatusBadge');
  if (data.telegram_configured) {
    badge.className = 'badge badge-success';
    badge.textContent = 'Telegram 已配置';
  } else {
    badge.className = 'badge badge-warning';
    badge.textContent = 'Telegram 未配置';
  }
}

async function loadLogs() {
  const data = await api('/api/reminders/logs?limit=30');
  const container = $('logsContainer');
  const items = data.items || [];
  if (items.length === 0) {
    container.innerHTML = '<div style="color: var(--muted); font-size: 13px;">暂无提醒发送记录</div>';
    return;
  }

  container.innerHTML = items
    .map((log) => {
      let badge = '<span class="badge badge-success">已发送</span>';
      if (log.status === 'failed') {
        badge = `<span class="badge badge-critical" title="${escapeHtml(log.error)}">失败</span>`;
      } else if (log.status === 'skipped') {
        badge = '<span class="badge badge-muted">已合并</span>';
      }
      const time = new Date(log.sent_at).toLocaleString('zh-CN');
      return `
        <div class="log-item">
          <div class="log-main">
            ${badge}
            <strong>${escapeHtml(log.phone_number || `eSIM #${log.esim_id}`)}</strong>
            <span>(${escapeHtml(log.carrier || '')})</span>
            <span>· 节点 ${log.stage_days} 天 / 剩余 ${log.days_remaining} 天</span>
            ${log.error ? `<span style="color: var(--critical);">${escapeHtml(log.error)}</span>` : ''}
          </div>
          <div class="log-time">${escapeHtml(time)}</div>
        </div>
      `;
    })
    .join('');
}

let detectTimer = null;
function schedulePhoneDetect(number) {
  clearTimeout(detectTimer);
  const hint = $('phoneDetectHint');
  if (!number.trim()) {
    hint.className = 'detect-hint';
    hint.textContent = '输入带国际区号的号码（如 +44、+1、+852）将自动识别国家';
    return;
  }
  detectTimer = setTimeout(async () => {
    try {
      const info = await api(`/api/phone/detect?number=${encodeURIComponent(number)}`);
      if (info.detected) {
        hint.className = 'detect-hint detected';
        hint.textContent = `${info.flag} 已识别国家/地区：${info.countryName} (+${info.callingCode})${info.isValid ? ' · 号码格式有效' : ''}`;
        $('countryCodeInput').value = info.countryCode;
        $('countryNameInput').value = info.countryName;
      } else {
        hint.className = 'detect-hint';
        hint.textContent = '暂未识别国家，请加上国际区号（例如 +44 或 +852）或手动填写国家';
      }
    } catch {
      // ignore transient errors
    }
  }, 150);
}

function openAddModal() {
  $('esimModalTitle').textContent = '添加 eSIM';
  $('esimId').value = '';
  $('phoneInput').value = '';
  $('countryCodeInput').value = '';
  $('countryNameInput').value = '';
  $('carrierInput').value = '';
  const today = state.today || new Date().toISOString().slice(0, 10);
  $('activationDateInput').value = today;
  $('lastRenewDateInput').value = today;
  $('cycleDaysInput').value = '180';
  $('notesInput').value = '';
  $('enabledInput').checked = true;
  $('phoneDetectHint').className = 'detect-hint';
  $('phoneDetectHint').textContent = '输入带国际区号的号码（如 +44、+1、+852）将自动识别国家';
  openModal('esimModal');
}

function openEditModal(item) {
  $('esimModalTitle').textContent = '编辑 eSIM';
  $('esimId').value = item.id;
  $('phoneInput').value = item.phone_number;
  $('countryCodeInput').value = item.country_code || '';
  $('countryNameInput').value = item.country_name || '';
  $('carrierInput').value = item.carrier;
  $('activationDateInput').value = item.activation_date;
  $('lastRenewDateInput').value = item.last_renew_date;
  $('cycleDaysInput').value = item.cycle_days;
  $('notesInput').value = item.notes || '';
  $('enabledInput').checked = Boolean(item.enabled);
  $('phoneDetectHint').className = 'detect-hint detected';
  $('phoneDetectHint').textContent = `${item.flag || '🌐'} 当前国家/地区：${item.country_name || '未设置'}`;
  openModal('esimModal');
}

function openSettingsModal() {
  const s = state.settings || {};
  $('tgTokenInput').value = '';
  $('tgTokenCurrent').textContent = s.telegram_bot_token_masked
    ? `当前已保存 Token：${s.telegram_bot_token_masked}`
    : '尚未配置 Bot Token';
  $('tgChatIdInput').value = s.telegram_chat_id || '';
  $('notifyTimeInput').value = `${String(s.notify_hour ?? 9).padStart(2, '0')}:${String(s.notify_minute ?? 0).padStart(2, '0')}`;
  $('timezoneInput').value = s.timezone || 'Asia/Shanghai';
  openModal('settingsModal');
}

function bindEvents() {
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('loginError');
    errEl.classList.add('hidden');
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: $('loginUsername').value.trim(),
          password: $('loginPassword').value,
        }),
      });
      $('loginPassword').value = '';
      showAppView(true);
      await Promise.all([loadSettings(), loadEsims(), loadLogs()]);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  $('btnLogout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      showLoginView();
    }
  });

  $('btnAddEsim').addEventListener('click', openAddModal);
  $('btnSettings').addEventListener('click', openSettingsModal);
  $('btnRefreshLogs').addEventListener('click', () => loadLogs().catch((e) => showToast(e.message, true)));

  $('btnCheckNow').addEventListener('click', async () => {
    try {
      const res = await api('/api/reminders/check', { method: 'POST' });
      showToast(`检查完成：共 ${res.checked} 个，发送 ${res.sent} 条，失败 ${res.failed} 条`);
      await Promise.all([loadEsims(), loadLogs()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal-backdrop').forEach((bg) => {
    bg.addEventListener('click', () => bg.closest('.modal').classList.add('hidden'));
  });

  $('phoneInput').addEventListener('input', (e) => {
    schedulePhoneDetect(e.target.value);
  });

  $('activationDateInput').addEventListener('change', (e) => {
    if (!$('esimId').value && !$('lastRenewDateInput').dataset.touched) {
      $('lastRenewDateInput').value = e.target.value;
    }
  });
  $('lastRenewDateInput').addEventListener('input', () => {
    $('lastRenewDateInput').dataset.touched = '1';
  });

  document.querySelectorAll('.chip[data-days]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('cycleDaysInput').value = chip.dataset.days;
    });
  });

  $('esimForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('esimId').value;
    const payload = {
      phone_number: $('phoneInput').value.trim(),
      country_code: $('countryCodeInput').value.trim(),
      country_name: $('countryNameInput').value.trim(),
      carrier: $('carrierInput').value.trim(),
      activation_date: $('activationDateInput').value,
      last_renew_date: $('lastRenewDateInput').value || $('activationDateInput').value,
      cycle_days: Number($('cycleDaysInput').value),
      notes: $('notesInput').value.trim(),
      enabled: $('enabledInput').checked,
    };

    try {
      if (id) {
        await api(`/api/esims/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('eSIM 信息已更新');
      } else {
        await api('/api/esims', { method: 'POST', body: JSON.stringify(payload) });
        showToast('eSIM 已添加');
      }
      closeModal('esimModal');
      await loadEsims();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const [hour, minute] = $('notifyTimeInput').value.split(':').map(Number);
    const payload = {
      telegram_chat_id: $('tgChatIdInput').value.trim(),
      notify_hour: hour,
      notify_minute: minute,
      timezone: $('timezoneInput').value.trim(),
    };
    const token = $('tgTokenInput').value.trim();
    if (token) {
      payload.telegram_bot_token = token;
    }

    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
      showToast('设置已保存');
      closeModal('settingsModal');
      await Promise.all([loadSettings(), loadEsims()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('btnTestTelegram').addEventListener('click', async () => {
    try {
      const payload = {
        telegram_bot_token: $('tgTokenInput').value.trim() || undefined,
        telegram_chat_id: $('tgChatIdInput').value.trim() || undefined,
      };
      const res = await api('/api/telegram/test', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      showToast(res.message || '测试消息已发送');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderList();
  });

  document.querySelectorAll('.filter-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tabs .tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.filter = tab.dataset.filter;
      renderList();
    });
  });

  $('esimList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const action = btn.dataset.action;
    const item = state.items.find((x) => x.id === id);
    if (!item) return;

    try {
      if (action === 'edit') {
        openEditModal(item);
      } else if (action === 'renew') {
        await api(`/api/esims/${id}/renew`, { method: 'POST', body: JSON.stringify({}) });
        showToast('已重置保号周期');
        await loadEsims();
      } else if (action === 'delete') {
        if (!confirm(`确定要删除 ${item.phone_number} (${item.carrier}) 吗？`)) return;
        await api(`/api/esims/${id}`, { method: 'DELETE' });
        showToast('已删除');
        await loadEsims();
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

async function init() {
  bindEvents();
  try {
    const authStatus = await api('/api/auth/status');
    if (authStatus.enabled && !authStatus.authenticated) {
      showLoginView();
      return;
    }
    showAppView(authStatus.enabled);
    await Promise.all([loadSettings(), loadEsims(), loadLogs()]);
  } catch (err) {
    showToast(err.message, true);
  }
}

init();
