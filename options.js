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
  skipHoliday: true,
  notificationsMuted: false,
  snoozeUntil: 0,
  accountManual: ''
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
    skipHoliday: $('skipHoliday').checked,
    // ⚠️ マスターオフは即時保存だが、「保存する」でも一緒に書く。
    //    ここに含めないと、保存のたびに false へ戻ってしまう。
    notificationsMuted: $('notificationsMuted').checked,
    accountManual: $('accountManual').value.trim()
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
  $('notificationsMuted').checked = !!settings.notificationsMuted;
  $('accountManual').value = settings.accountManual || '';
  paintMuteState();
}

// ---- 通知を止める（2026/9/4）----
// 「いま止まっているか」を、探さずに分かる形で出す。
// ⭐ 止めたこと自体を忘れるのがいちばん怖いので、状態は必ず文字で書く。
async function paintMuteState() {
  const { snoozeUntil } = await chrome.storage.local.get(['snoozeUntil']);
  const muted = $('notificationsMuted').checked;
  const until = Number(snoozeUntil) || 0;
  const snoozed = until > Date.now();

  const card = document.querySelector('.card--mute');
  if (card) card.classList.toggle('is-muted', muted || snoozed);

  const state = $('snoozeState');
  const btn = $('snoozeBtn');
  if (muted) {
    state.textContent = '「通知を全部止める」がオンです';
    state.className = 'result is-active';
    btn.disabled = true;
    btn.textContent = '今日はもう送らない';
    return;
  }
  btn.disabled = false;
  if (snoozed) {
    const d = new Date(until);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    state.textContent = `今日は送りません（${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm} に再開）`;
    state.className = 'result is-active';
    btn.textContent = '今すぐ送信を再開する';
  } else {
    state.textContent = '';
    state.className = 'result';
    btn.textContent = '今日はもう送らない';
  }
}

function computeSnoozeUntil(morningTime) {
  const parts = String(morningTime || '09:00').split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const until = new Date();
  until.setDate(until.getDate() + 1);
  until.setHours(isNaN(h) ? 9 : h, isNaN(m) ? 0 : m, 0, 0);
  return until.getTime();
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
    skipHoliday: toBool(map.skipHoliday),
    notificationsMuted: toBool(map.notificationsMuted),
    accountManual: map.accountManual || DEFAULTS.accountManual
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
  paintMuteState();
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

// ---- 通知を止める（2026/9/4）----
// ⭐ マスターオフだけは「保存する」を待たずに即時反映する。
//    止めたいときは今すぐ止まってほしいのに、保存を押し忘れて鳴り続ける、が起きるため。
$('notificationsMuted').addEventListener('change', async () => {
  await chrome.storage.local.set({ notificationsMuted: $('notificationsMuted').checked });
  chrome.runtime.sendMessage({ action: 'settingsUpdated' });
  paintMuteState();
});

$('snoozeBtn').addEventListener('click', async () => {
  const { snoozeUntil } = await chrome.storage.local.get(['snoozeUntil']);
  const snoozed = (Number(snoozeUntil) || 0) > Date.now();
  if (snoozed) {
    await chrome.storage.local.set({ snoozeUntil: 0 });
  } else {
    // 「朝の時刻」は画面の値を使う（保存前に変えていても、見えているとおりに効く）
    await chrome.storage.local.set({ snoozeUntil: computeSnoozeUntil($('morningTime').value) });
  }
  paintMuteState();
});

// 別の場所（ウィジェットの🔔）で変えられたら、開いている設定画面も追従させる
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.usageData || changes.cwLastSeenAccount) paintAccount();
  if (changes.snoozeUntil || changes.notificationsMuted) {
    if (changes.notificationsMuted) {
      $('notificationsMuted').checked = !!changes.notificationsMuted.newValue;
    }
    paintMuteState();
  }
});


// ---- どのアカウントの数字か（2026/9/4）----
// 数字だけだと誰の数字かが見えない。アカウントを切り替えると黙って別人の数字が出る。
// ここは「いま拾えているアカウント」を、設定を触る前に見せるための行。
// ⚠️ Chatworkの通知は「変わったときだけ」1行出す作りなので、
//    ふだんは通知に出ない。だからこの画面ではいつでも見えるようにしておく。
async function paintAccount() {
  const { usageData, lastUpdate, cwLastSeenAccount, accountManual } =
    await chrome.storage.local.get(['usageData', 'lastUpdate', 'cwLastSeenAccount', 'accountManual']);

  const bar = $('acctBar');
  const main = $('acctMain');
  const sub = $('acctSub');
  if (!bar || !main || !sub) return;

  const auto = (usageData && usageData.account) || null;
  const source = (usageData && usageData.accountSource) || null;
  const manual = (accountManual || '').trim();
  const captured = (usageData && usageData.capturedAt) || lastUpdate || null;

  bar.classList.remove('is-unknown', 'is-pending');

  if (!usageData) {
    main.textContent = 'まだ使用量を取得していません';
    sub.textContent = 'claude.ai の使用量ページを開くか、「取得し直す」を押してください';
    bar.classList.add('is-unknown');
    return;
  }

  const bits = [];
  if (auto) {
    main.textContent = auto;
    bits.push('claude.aiのページから自動で読み取り（' + (SOURCE_LABELS[source] || '取得元不明') + '）');
  } else if (manual) {
    main.textContent = manual;
    bits.push('手入力の表示名を使っています（ページからは読み取れませんでした）');
  } else {
    main.textContent = 'アカウント不明';
    bar.classList.add('is-unknown');
    bits.push('ページからメールアドレスを読み取れませんでした。下の欄に表示名を入れておくと、そちらを使います');
  }

  if (captured) bits.push('数値の取得：' + fmtClock(captured));

  // Chatworkへ最後に知らせたものと食い違っていたら、次の通知で「変わりました」が出る
  const effective = auto || manual || null;
  if (cwLastSeenAccount !== undefined && cwLastSeenAccount !== effective) {
    bar.classList.add('is-pending');
    bits.push('⚠️ Chatworkへ最後に知らせたのは「' + (cwLastSeenAccount || 'アカウント不明') +
      '」です（次の通知で「変わりました」を1行出します）');
  }
  sub.textContent = bits.join(' ／ ');
}

// どこから拾えたか。取れないときの切り分けに使う。
const SOURCE_LABELS = {
  menu: 'アカウントメニュー（開いていたので、メールアドレスが取れました）',
  name: 'アカウントメニューのボタン',
  text: '見えている本文',
  attr: '画面の属性',
  html: 'ページの埋め込みデータ'
};

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

$('accountManual').addEventListener('input', () => {
  // 打っている最中に見た目が変わると分かりやすいので、保存を待たずに反映する。
  // ⚠️ 保存されるのは「保存する」を押したとき（fieldsFromForm に入れてある）。
  chrome.storage.local.set({ accountManual: $('accountManual').value.trim() }, paintAccount);
});

$('acctRefreshBtn').addEventListener('click', () => {
  const btn = $('acctRefreshBtn');
  btn.disabled = true;
  btn.textContent = '取得中…';
  chrome.runtime.sendMessage({ action: 'fetchUsageData', reason: 'options-account-refresh' }, () => {
    btn.disabled = false;
    btn.textContent = '取得し直す';
    paintAccount();
  });
});

load();
renderLog();
paintAccount();
