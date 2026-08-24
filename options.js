const DEFAULTS = {
  chatworkToken: '',
  chatworkRoomId: '',
  thresholdEnabled: false,
  thresholdPercent: 80,
  thresholdMetrics: { currentSession: true, allModels: true, modelSpecific: true },
  dailyReportEnabled: false,
  morningTime: '09:00',
  eveningTime: '17:00',
  skipWeekend: true,
  skipHoliday: true
};

const $ = (id) => document.getElementById(id);

function fieldsFromForm() {
  return {
    chatworkToken: $('chatworkToken').value.trim(),
    chatworkRoomId: $('chatworkRoomId').value.trim(),
    thresholdEnabled: $('thresholdEnabled').checked,
    thresholdPercent: Number($('thresholdPercent').value) || DEFAULTS.thresholdPercent,
    thresholdMetrics: {
      currentSession: $('thresholdMetric_currentSession').checked,
      allModels: $('thresholdMetric_allModels').checked,
      modelSpecific: $('thresholdMetric_modelSpecific').checked
    },
    dailyReportEnabled: $('dailyReportEnabled').checked,
    morningTime: $('morningTime').value || DEFAULTS.morningTime,
    eveningTime: $('eveningTime').value || DEFAULTS.eveningTime,
    skipWeekend: $('skipWeekend').checked,
    skipHoliday: $('skipHoliday').checked
  };
}

function fillForm(settings) {
  $('chatworkToken').value = settings.chatworkToken;
  $('chatworkRoomId').value = settings.chatworkRoomId;
  $('thresholdEnabled').checked = settings.thresholdEnabled;
  $('thresholdPercent').value = settings.thresholdPercent;
  const metrics = settings.thresholdMetrics || DEFAULTS.thresholdMetrics;
  $('thresholdMetric_currentSession').checked = !!metrics.currentSession;
  $('thresholdMetric_allModels').checked = !!metrics.allModels;
  $('thresholdMetric_modelSpecific').checked = !!metrics.modelSpecific;
  $('dailyReportEnabled').checked = settings.dailyReportEnabled;
  $('morningTime').value = settings.morningTime;
  $('eveningTime').value = settings.eveningTime;
  $('skipWeekend').checked = settings.skipWeekend;
  $('skipHoliday').checked = settings.skipHoliday;
}

async function load() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  fillForm({ ...DEFAULTS, ...stored });
}

// ---- 動作ログ（診断用） ----

const OUTCOME_LABELS = {
  'reused-usage-tab-success': '既存の使用量タブを利用（表示への影響なし）',
  'reused-claude-tab-navigated-success': '既存のclaude.aiタブを一時流用（新規タブなし）',
  'created-new-tab-success': '新規タブを作成（一瞬表示された）',
  'reused-usage-tab-failed': '既存タブ利用→取得失敗',
  'reused-claude-tab-navigated-failed': '既存タブ流用→取得失敗',
  'created-new-tab-failed': '新規タブ作成→取得失敗',
  'reused-usage-tab-inject-failed': '既存タブ利用→スクリプト注入失敗',
  'reused-claude-tab-navigated-inject-failed': '既存タブ流用→スクリプト注入失敗',
  'created-new-tab-inject-failed': '新規タブ作成→スクリプト注入失敗',
  'retry-scheduled-1': '取得失敗→60秒後に再試行を予約（1回目）',
  'retry-scheduled-2': '取得失敗→60秒後に再試行を予約（2回目）',
  'gave-up-after-retries': '再試行しても取得できず、レポート送信を断念'
};

function formatLogTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function outcomeClass(outcome) {
  if (outcome === 'gave-up-after-retries') return 'log-fail';
  if (outcome.startsWith('retry-scheduled')) return 'log-flash';
  if (outcome.startsWith('created-new-tab')) return 'log-flash';
  if (outcome.includes('failed')) return 'log-fail';
  return 'log-quiet';
}

async function renderLog() {
  const { tabActivityLog } = await chrome.storage.local.get(['tabActivityLog']);
  const log = Array.isArray(tabActivityLog) ? tabActivityLog : [];
  const tbody = $('logTableBody');
  tbody.innerHTML = '';
  if (!log.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="log-empty">記録はまだありません</td></tr>';
    return;
  }
  [...log].reverse().forEach(entry => {
    const tr = document.createElement('tr');
    const label = OUTCOME_LABELS[entry.outcome] || entry.outcome;
    const time = document.createElement('td');
    time.textContent = formatLogTime(entry.time);
    const reason = document.createElement('td');
    reason.textContent = entry.reason;
    const outcome = document.createElement('td');
    outcome.textContent = label;
    outcome.className = outcomeClass(entry.outcome);
    tr.append(time, reason, outcome);
    tbody.appendChild(tr);
  });
}

// 失敗・再試行まわりの記録かどうか（「失敗だけコピー」の絞り込み用）
function isTroubleOutcome(outcome) {
  return outcome.includes('failed')
    || outcome.startsWith('retry-scheduled')
    || outcome === 'gave-up-after-retries';
}

// 表と同じ3列を、そのまま貼り付けられるタブ区切りテキストにする
function logRowsToText(entries) {
  const header = ['時刻', 'きっかけ', '結果'].join('\t');
  const lines = entries.map(e => [
    formatLogTime(e.time),
    e.reason,
    OUTCOME_LABELS[e.outcome] || e.outcome
  ].join('\t'));
  return [header, ...lines].join('\n');
}

async function copyLog(onlyTrouble) {
  const { tabActivityLog } = await chrome.storage.local.get(['tabActivityLog']);
  const log = Array.isArray(tabActivityLog) ? tabActivityLog : [];
  // 画面と同じ「新しい順」で出す
  const target = [...log].reverse().filter(e => !onlyTrouble || isTroubleOutcome(e.outcome));

  if (!target.length) {
    showResult($('copyResult'), true, onlyTrouble ? '失敗の記録はありません' : '記録はまだありません');
    return;
  }
  try {
    await navigator.clipboard.writeText(logRowsToText(target));
    showResult($('copyResult'), true, `${target.length}件コピーしました`);
  } catch (err) {
    showResult($('copyResult'), false, 'コピーに失敗しました：' + err.message);
  }
}

$('refreshLogBtn').addEventListener('click', renderLog);
$('copyFailLogBtn').addEventListener('click', () => copyLog(true));
$('copyLogBtn').addEventListener('click', () => copyLog(false));
$('clearLogBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ tabActivityLog: [] });
  renderLog();
});

// ---- CSVエクスポート/インポート ----

function csvEscape(value) {
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function settingsToCsv(settings) {
  const flat = {
    chatworkToken: settings.chatworkToken,
    chatworkRoomId: settings.chatworkRoomId,
    thresholdEnabled: settings.thresholdEnabled,
    thresholdPercent: settings.thresholdPercent,
    'thresholdMetrics.currentSession': settings.thresholdMetrics.currentSession,
    'thresholdMetrics.allModels': settings.thresholdMetrics.allModels,
    'thresholdMetrics.modelSpecific': settings.thresholdMetrics.modelSpecific,
    dailyReportEnabled: settings.dailyReportEnabled,
    morningTime: settings.morningTime,
    eveningTime: settings.eveningTime,
    skipWeekend: settings.skipWeekend,
    skipHoliday: settings.skipHoliday
  };
  const rows = [['key', 'value'], ...Object.entries(flat)];
  return rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
}

// 簡易CSVパーサ（key,valueの2列を想定。値のダブルクォート囲み・エスケープに対応）
function csvParse(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // skip
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvToSettings(text) {
  const map = {};
  for (const cols of csvParse(text)) {
    if (cols.length < 2 || cols[0] === '') continue;
    if (cols[0] === 'key' && cols[1] === 'value') continue; // header
    map[cols[0]] = cols[1];
  }
  const toBool = (v) => v === 'true';
  return {
    chatworkToken: map.chatworkToken ?? DEFAULTS.chatworkToken,
    chatworkRoomId: map.chatworkRoomId ?? DEFAULTS.chatworkRoomId,
    thresholdEnabled: toBool(map.thresholdEnabled),
    thresholdPercent: Number(map.thresholdPercent) || DEFAULTS.thresholdPercent,
    thresholdMetrics: {
      currentSession: toBool(map['thresholdMetrics.currentSession']),
      allModels: toBool(map['thresholdMetrics.allModels']),
      modelSpecific: toBool(map['thresholdMetrics.modelSpecific'])
    },
    dailyReportEnabled: toBool(map.dailyReportEnabled),
    morningTime: map.morningTime || DEFAULTS.morningTime,
    eveningTime: map.eveningTime || DEFAULTS.eveningTime,
    skipWeekend: toBool(map.skipWeekend),
    skipHoliday: toBool(map.skipHoliday)
  };
}

function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

$('exportBtn').addEventListener('click', () => {
  const csv = settingsToCsv(fieldsFromForm());
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `claude-usage-chatwork-settings_${dateStamp()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const settings = csvToSettings(text);
    fillForm(settings);
    showResult($('importResult'), true, '読み込みました。内容を確認して「保存する」を押してください');
  } catch (err) {
    showResult($('importResult'), false, '読み込みに失敗しました：' + err.message);
  } finally {
    e.target.value = '';
  }
});

function showResult(el, ok, message) {
  el.textContent = message;
  el.className = 'result ' + (ok ? 'ok' : 'ng');
}

$('saveBtn').addEventListener('click', async () => {
  const settings = fieldsFromForm();
  await chrome.storage.local.set(settings);
  chrome.runtime.sendMessage({ action: 'settingsUpdated' });
  showResult($('saveResult'), true, '保存しました');
});

$('testSendBtn').addEventListener('click', async () => {
  const { chatworkToken, chatworkRoomId } = fieldsFromForm();
  if (!chatworkToken || !chatworkRoomId) {
    showResult($('testResult'), false, 'トークンとルームIDを入力してください');
    return;
  }
  showResult($('testResult'), true, '送信中…');
  const response = await chrome.runtime.sendMessage({
    action: 'testChatworkMessage',
    chatworkToken,
    chatworkRoomId
  });
  if (response && response.success) {
    showResult($('testResult'), true, '送信できました（Chatworkを確認してください）');
  } else {
    showResult($('testResult'), false, '失敗：' + (response && response.error ? response.error : '不明なエラー'));
  }
});

load();
renderLog();
