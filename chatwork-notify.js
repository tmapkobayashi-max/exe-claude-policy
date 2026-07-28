// Chatwork通知機能（このフォークでの追加分。base: ueponx/claude-usage-extension MIT License）
// - しきい値超過通知
// - 平日朝夕の定時レポート（土日・日本の祝日はスキップ）

const CW_DEFAULTS = {
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

const METRIC_KEYS = ['currentSession', 'allModels', 'modelSpecific'];

const METRIC_LABELS = {
  currentSession: 'Current session（5時間セッション）',
  allModels: 'All models（週次）'
  // modelSpecificは固定名を持たない（例：Fable等、提供モデルにより変わる）。labelFor()で動的に決める
};

function labelFor(metricKey, metric) {
  if (metricKey === 'modelSpecific') {
    return metric && metric.name ? `${metric.name}（週次・モデル別）` : 'モデル別週次制限';
  }
  return METRIC_LABELS[metricKey] || metricKey;
}

async function cwGetSettings() {
  const stored = await chrome.storage.local.get(Object.keys(CW_DEFAULTS));
  return { ...CW_DEFAULTS, ...stored };
}

async function sendChatworkMessage(token, roomId, body) {
  const res = await fetch(`https://api.chatwork.com/v2/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: 'POST',
    headers: {
      'X-ChatWorkToken': token,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'body=' + encodeURIComponent(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Chatwork API ${res.status}: ${text}`);
  }
  return res.json();
}

// ---- しきい値通知 ----

async function checkOneMetricThreshold(metricKey, usageData, settings) {
  const metric = usageData[metricKey];
  if (!metric || typeof metric.percentage !== 'number') return;

  const flagKey = `cwNotified_${metricKey}`;
  const flags = await chrome.storage.local.get([flagKey]);
  const alreadyNotified = !!flags[flagKey];

  if (metric.percentage >= settings.thresholdPercent) {
    if (!alreadyNotified) {
      const label = labelFor(metricKey, metric);
      const body = `[info][title]Claude使用量アラート[/title]${label} が ${metric.percentage}% に達しました（しきい値 ${settings.thresholdPercent}%）。\nリセットまで：${metric.reset || '不明'}[/info]`;
      try {
        await sendChatworkMessage(settings.chatworkToken, settings.chatworkRoomId, body);
        await chrome.storage.local.set({ [flagKey]: true });
        console.log('[Claude Usage] Threshold notification sent for', metricKey);
      } catch (err) {
        console.error('[Claude Usage] Failed to send threshold notification:', err);
      }
    }
  } else if (alreadyNotified) {
    // しきい値を下回った＝リセットされたとみなし、次のサイクルに備えてフラグを戻す
    await chrome.storage.local.set({ [flagKey]: false });
  }
}

async function checkThresholdAndNotify(usageData) {
  if (!usageData) return;
  const settings = await cwGetSettings();
  if (!settings.thresholdEnabled || !settings.chatworkToken || !settings.chatworkRoomId) return;

  const metrics = settings.thresholdMetrics || {};
  for (const metricKey of METRIC_KEYS) {
    if (!metrics[metricKey]) continue;
    await checkOneMetricThreshold(metricKey, usageData, settings);
  }
}

// ---- 定時レポート ----

function formatReportMessage(usageData, label) {
  const lines = [`[info][title]Claude使用量レポート（${label}）[/title]`];
  let any = false;
  for (const key of METRIC_KEYS) {
    const m = usageData && usageData[key];
    if (m && typeof m.percentage === 'number') {
      any = true;
      lines.push(`${labelFor(key, m)}：${m.percentage}%（リセット：${m.reset || '不明'}）`);
    }
  }
  if (!any) lines.push('使用量データを取得できませんでした。');
  lines.push('[/info]');
  return lines.join('\n');
}

async function sendDailyReport(label) {
  const settings = await cwGetSettings();
  if (!settings.dailyReportEnabled || !settings.chatworkToken || !settings.chatworkRoomId) return;

  const today = new Date();
  if (await isWeekendOrHoliday(today, settings)) {
    console.log('[Claude Usage] Skip daily report (weekend/holiday):', today.toDateString());
    return;
  }

  try {
    const { usageData } = await fetchUsageDataFromPage();
    const body = formatReportMessage(usageData, label);
    await sendChatworkMessage(settings.chatworkToken, settings.chatworkRoomId, body);
    console.log('[Claude Usage] Daily report sent:', label);
    // 定時レポートのタイミングでしきい値も合わせてチェックしておく
    await checkThresholdAndNotify(usageData);
  } catch (err) {
    console.error('[Claude Usage] Failed to send daily report:', err);
  }
}

// ---- 祝日判定（内閣府公表CSVを取得・キャッシュ） ----

const HOLIDAY_CSV_URL = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
const HOLIDAY_REFRESH_MS = 30 * 24 * 60 * 60 * 1000; // 30日ごとに再取得

async function refreshHolidayListIfNeeded() {
  const { holidayList, holidayFetchedAt } = await chrome.storage.local.get(['holidayList', 'holidayFetchedAt']);
  const isStale = !holidayFetchedAt || (Date.now() - holidayFetchedAt) > HOLIDAY_REFRESH_MS;
  if (holidayList && !isStale) return holidayList;

  try {
    const res = await fetch(HOLIDAY_CSV_URL);
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('shift-jis').decode(buf);
    const list = {};
    text.split(/\r?\n/).slice(1).forEach(line => {
      const [dateStr] = line.split(',');
      if (!dateStr) return;
      const m = dateStr.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
      if (!m) return;
      const key = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
      list[key] = true;
    });
    await chrome.storage.local.set({ holidayList: list, holidayFetchedAt: Date.now() });
    console.log('[Claude Usage] Holiday list refreshed:', Object.keys(list).length, 'days');
    return list;
  } catch (err) {
    console.error('[Claude Usage] Failed to refresh holiday list, using cache if any:', err);
    return holidayList || {};
  }
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function isWeekendOrHoliday(date, settings) {
  const day = date.getDay(); // 0=日, 6=土
  if (settings.skipWeekend !== false && (day === 0 || day === 6)) return true;
  if (!settings.skipHoliday) return false;
  const list = await refreshHolidayListIfNeeded();
  return !!list[dateKey(date)];
}

// ---- 朝夕アラームのスケジューリング ----

function nextOccurrence(hhmm) {
  const [h, m] = (hhmm || '09:00').split(':').map(Number);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

async function scheduleDailyAlarms() {
  const settings = await cwGetSettings();
  await chrome.alarms.clear('dailyMorningReport');
  await chrome.alarms.clear('dailyEveningReport');
  if (!settings.dailyReportEnabled) {
    console.log('[Claude Usage] Daily report disabled, alarms cleared');
    return;
  }
  chrome.alarms.create('dailyMorningReport', { when: nextOccurrence(settings.morningTime) });
  chrome.alarms.create('dailyEveningReport', { when: nextOccurrence(settings.eveningTime) });
  console.log('[Claude Usage] Daily alarms scheduled:', settings.morningTime, settings.eveningTime);
}

// background.jsのアラームリスナーから呼ばれる入口（朝/夕方どちらも共通処理）
async function handleDailyAlarm(alarmName) {
  const label = alarmName === 'dailyMorningReport' ? '朝' : '夕方';
  await sendDailyReport(label);
  // 翌日分を再スケジュール
  const settings = await cwGetSettings();
  if (settings.dailyReportEnabled) {
    const timeKey = alarmName === 'dailyMorningReport' ? 'morningTime' : 'eveningTime';
    chrome.alarms.create(alarmName, { when: nextOccurrence(settings[timeKey]) });
  }
}
