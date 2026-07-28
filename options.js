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
