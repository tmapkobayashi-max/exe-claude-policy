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
  skipHoliday: true,
  // ---- 通知を止めるしくみ（2026/9/4）----
  // 2つある。役割が違うので分けている。
  //   notificationsMuted … 自分で戻すまでずっとオフ（マスタースイッチ）
  //   snoozeUntil        … その日ぶんだけオフ。翌朝の定時レポートの時刻に自動で戻る
  // 「戻し忘れて静かに止まったまま」を避けたいので、日常の一時停止はスヌーズのほうを使う。
  notificationsMuted: false,
  snoozeUntil: 0,
  accountManual: ''
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

// ---- Chatworkの見た目（2026/8/24）----
// 以前は「22%使用（残り78%）（リセット：…）」を3行並べていた。数字が文中に埋もれて、
// いちばん見たい「残り」が探さないと分からなかった。かといって行を増やすと縦に伸びる。
// → 行数は変えずに、各行の先頭を「色 → 残り% → バー」に組み替える。
// バーは固定10マスなので、ラベルの長さが違っても頭が揃う（等幅フォントに依存しない）。

const SHORT_LABELS = {
  currentSession: 'セッション(5h)',
  allModels: '週次・全体'
};

function shortLabelFor(metricKey, metric) {
  if (metricKey === 'modelSpecific') {
    return metric && metric.name ? `週次・${metric.name}` : '週次・モデル別';
  }
  return SHORT_LABELS[metricKey] || metricKey;
}

// 使った量を10マスで表す。左から埋まっていく＝ゲージが伸びるほど減っている。
// ⚠️ 2026/8/24：最初は「残りの多さ」を █ と ░ で描いたが、実機で2つ問題が出た。
//   ❶ ░ がChatworkの日本語フォントでほぼ塗りつぶしに見え、█ と区別がつかない
//      → 罫線素片をやめ、全角の ■ □ にした。字形がまったく違うので潰れない
//   ❷ ゲージは習慣的に「使用量」として読まれる。残りを描くと直感と逆になる
//      → ゲージは使用量。残りは数字で右に置く（小林さんの指摘）
function usageBar(usedPct) {
  if (typeof usedPct !== 'number') return '';
  const filled = Math.max(0, Math.min(10, Math.round(usedPct / 10)));
  return '■'.repeat(filled) + '□'.repeat(10 - filled);
}

// 残りが少ないほど赤くする。しきい値通知（既定80%到達＝残り20%）と地続きになるよう、
// 赤の境目は残り25%に置いている。
// 0〜100 を半角3桁に右寄せする。行をまたいで数字の桁が揃うので、拾い読みしやすくなる。
function pct3(n) {
  const t = `${n}%`;
  return t.length >= 4 ? t : ' '.repeat(4 - t.length) + t;
}

function severityMark(remainPct) {
  if (typeof remainPct !== 'number') return '';
  if (remainPct >= 50) return '🟢';
  if (remainPct >= 25) return '🟡';
  return '🔴';
}

const WEEKDAY_MAP = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };
const WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

// ---- リセット時刻の扱い ----
// claude.aiの使用量モーダルは、リセットを「22:00 (水)」（絶対）と「12時間39分後」（相対）の
// どちらでも書いてくる。相対表記をそのまま転記すると、取得から送信までのぶんだけ数字が古くなる。
// さらに、開きっぱなしの使用量タブを読み直さずに拾うと、何時間も前の表示がそのまま流れる。
// （2026/8/19：9:23のアラートと9:30の定時レポートが揃って「12時間39分後」を出した）
// そこで、取得時刻(capturedAt)を基準に絶対時刻へ変換して持ち回り、
// 送信する瞬間の Date.now() から残りを計算し直す。
// 表示も「リセット時刻（動かない）／あと◯時間◯分（減っていく）」の2本立てにして、
// 値が古いままなら人が見て気づけるようにする。

// "1日2時間後" "12時間39分後" "45分後" → 取得時刻からのミリ秒
function parseRelativeReset(resetStr) {
  const s = (resetStr || '').replace(/\s/g, '');
  const m = s.match(/^(?:(\d+)日)?(?:(\d+)時間)?(?:(\d+)分)?後$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return ((+m[1] || 0) * 24 * 60 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 60000;
}

// "22:00 (水)" → 基準時刻より後にくる直近のその曜日・時刻
function parseWeekdayReset(resetStr, baseMs) {
  const m = (resetStr || '').match(/^(\d{1,2}):(\d{2})\s*\(([日月火水木金土])\)$/);
  if (!m) return null;
  const base = new Date(baseMs);
  for (let i = 0; i < 8; i++) {
    const c = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, +m[1], +m[2], 0, 0);
    if (c.getDay() === WEEKDAY_MAP[m[3]] && c.getTime() >= baseMs) return c.getTime();
  }
  return null;
}

// 取得時点の表記 → 絶対時刻(ms)。解釈できなければ null
function resolveResetAt(resetStr, capturedAt) {
  const base = typeof capturedAt === 'number' ? capturedAt : Date.now();
  const rel = parseRelativeReset(resetStr);
  if (rel !== null) return base + rel;
  return parseWeekdayReset(resetStr, base);
}

function formatHM(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatClock(ms) {
  return `${formatHM(ms)}（${WEEKDAY_NAMES[new Date(ms).getDay()]}）`;
}

function formatCountdown(ms) {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes <= 0) return 'まもなく';
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) return `あと${days}日${hours}時間`;
  if (hours > 0) return `あと${hours}時間${mins}分`;
  return `あと${mins}分`;
}

// 送信する瞬間に組み立てる。capturedAt は使用量データを取得した時刻。
function formatResetDetail(resetStr, capturedAt) {
  if (!resetStr) return '不明';
  const resetAt = resolveResetAt(resetStr, capturedAt);
  if (resetAt === null) return resetStr; // 想定外の表記はそのまま出す
  return `${formatClock(resetAt)}／${formatCountdown(resetAt - Date.now())}`;
}

function formatMetricLine(label, metric, capturedAt) {
  const remainPct = typeof metric.percentage === 'number' ? 100 - metric.percentage : null;
  if (remainPct === null) {
    return `${label}：${metric.percentage}%（リセット：${formatResetDetail(metric.reset, capturedAt)}）`;
  }
  // 「色 → 使用% → 残り% → 使用ゲージ → ラベル → リセット」の順（2026/8/24 小林さんの案）。
  // 色を左端に置くと、上から下へ目を落とすだけで危ないものが分かる。
  // 色・数字（pct3で3桁右寄せ）・ゲージ（固定10マス）がすべて固定幅なので、
  // ラベルの長さがバラバラでも、行頭からラベルの頭まで全部揃う。
  return `${severityMark(remainPct)} 使用${pct3(metric.percentage)}／残り${pct3(remainPct)} ${usageBar(metric.percentage)}  ${label} ${formatResetDetail(metric.reset, capturedAt)}`;
}

async function cwGetSettings() {
  const stored = await chrome.storage.local.get(Object.keys(CW_DEFAULTS));
  return { ...CW_DEFAULTS, ...stored };
}

// ---- 通知を止めるしくみ（2026/9/4）----

// 「今日はもう送らない」を押したとき、いつまで止めるかを決める。
// 翌日の「朝の定時レポートの時刻」まで。
// ⚠️ 0時に戻す作りにはしない。深夜にしきい値アラートが鳴る形になるため
//    （2026/9/1にLINE配信枠の通知が0:36に鳴って直したのと同じ話）。
function computeSnoozeUntil(morningTime, now = new Date()) {
  const [h, m] = String(morningTime || '09:00').split(':').map(n => parseInt(n, 10));
  const until = new Date(now);
  until.setDate(until.getDate() + 1);
  until.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
  return until.getTime();
}

// 送ってよいか。止まっているときは理由も返す（画面に出すため）。
function notificationGate(settings, now = Date.now()) {
  if (settings.notificationsMuted) {
    return { blocked: true, reason: 'muted', text: '通知を全部止める がオンです' };
  }
  const until = Number(settings.snoozeUntil) || 0;
  if (until > now) {
    return { blocked: true, reason: 'snoozed', until, text: `今日は送りません（${formatSnoozeUntil(until)}に再開）` };
  }
  return { blocked: false };
}

function formatSnoozeUntil(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

// ---- どのアカウントの数字か（2026/9/4）----
// 数字だけだと、誰の数字かが見えない。アカウントを切り替えると黙って別人の数字が出る。
// ⭐ 毎回「同じです」と書くと読み飛ばされるので、変わったときだけ1行出す
//    （0件でも鳴らす通知と同じ考え方で、変化にだけ意味を持たせる）。
// 🚫 非公開API（/api/bootstrap 等）は使わない。黙って壊れるため。
//    ページ本文から拾えなければ「アカウント不明」として扱い、それも「変化」として1回だけ知らせる。
// ⚠️ 「見る」と「覚える」を分けている（peek / commit）。
// 1つの関数で読んだ瞬間に覚えてしまうと、
// 「しきい値を超えていないので結局1通も送らなかった」回で変化を食べてしまい、
// あとの定時レポートで知らせられなくなる。**送れたときだけ覚える。**
async function peekAccountChange(usageData) {
  // 自動で読み取れたものを優先。ダメなら設定画面の手入力を使う。
  // ⚠️ どちらも無ければ null（＝「アカウント不明」）。黙って空にはしない。
  const { accountManual } = await chrome.storage.local.get(['accountManual']);
  const current = (usageData && usageData.account) || (accountManual || '').trim() || null;
  const { cwLastSeenAccount } = await chrome.storage.local.get(['cwLastSeenAccount']);
  const first = cwLastSeenAccount === undefined;
  const previous = first ? null : cwLastSeenAccount;

  if (!first && previous === current) return { line: '', current, changed: false };

  // ★2026/9/4：メールアドレスを読むのをやめたので、
  // 前回の値がメールで今回が表示名なら、それは「アカウントが変わった」のではなく
  // こちらの作りが変わっただけ。黙って覚え直す（メールをもう一度Chatworkへ出さない）。
  if (previous && String(previous).indexOf('@') !== -1 && current && String(current).indexOf('@') === -1) {
    await commitAccount(current);
    return { line: '', current, changed: false };
  }

  const label = current || 'アカウント不明';
  const line = first
    ? `👤 このレポートのアカウント：${label}`
    : `🔴 アカウントが変わりました：${label}（前回：${previous || 'アカウント不明'}）`;
  return { line, current, changed: true };
}

async function commitAccount(current) {
  await chrome.storage.local.set({ cwLastSeenAccount: current === undefined ? null : current });
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

async function checkOneMetricThreshold(metricKey, usageData, settings, accountLine = '') {
  const metric = usageData[metricKey];
  if (!metric || typeof metric.percentage !== 'number') return;

  const flagKey = `cwNotified_${metricKey}`;
  const flags = await chrome.storage.local.get([flagKey]);
  const alreadyNotified = !!flags[flagKey];

  if (metric.percentage >= settings.thresholdPercent) {
    if (!alreadyNotified) {
      const label = labelFor(metricKey, metric);
      const remainPct = 100 - metric.percentage;
      const bodyLines = [`[info][title]🔴 Claude使用量アラート｜${label}[/title]`];
      if (accountLine) bodyLines.push(accountLine);
      bodyLines.push(`使用${metric.percentage}%／残り${remainPct}% ${usageBar(metric.percentage)}（しきい値 ${settings.thresholdPercent}% に到達）`);
      bodyLines.push(`リセット：${formatResetDetail(metric.reset, usageData.capturedAt)}[/info]`);
      const body = bodyLines.join('\n');
      // ★送る前にフラグを立てる（2026/8/25）。
      // 送ってから立てると、送信中（数百ミリ秒）に入ってきた別の呼び出しが
      // 「まだ通知していない」と読んでしまい、同じアラートが2通出る。
      // 失敗したときは戻すので、送れなかったのに黙るということは起きない。
      await chrome.storage.local.set({ [flagKey]: true });
      try {
        await sendChatworkMessage(settings.chatworkToken, settings.chatworkRoomId, body);
        console.log('[Claude Usage] Threshold notification sent for', metricKey);
        return true;
      } catch (err) {
        await chrome.storage.local.set({ [flagKey]: false });
        console.error('[Claude Usage] Failed to send threshold notification:', err);
      }
    }
  } else if (alreadyNotified) {
    // しきい値を下回った＝リセットされたとみなし、次のサイクルに備えてフラグを戻す
    await chrome.storage.local.set({ [flagKey]: false });
  }
  return false;
}

// ★同時に走らせない（2026/8/25）。
// この関数は2か所から呼ばれる。
//   ❶ データ取得のたび（background.js の取得処理の末尾。await していない）
//   ❷ 定時レポートの送信直後（下の handleDailyReport）
// 朝9:30のレポートは❷の中で取得を走らせるので、❶と❷がほぼ同時に始まる。
// 前後関係が保証されないため、両方が「まだ通知していない」と読んで2通送っていた。
// 直前の実行が終わるまで待たせて、1本ずつ通す。
let cwThresholdChain = Promise.resolve();

async function checkThresholdAndNotify(usageData) {
  const run = cwThresholdChain.then(
    () => checkThresholdAndNotifyInner(usageData),
    () => checkThresholdAndNotifyInner(usageData)
  );
  // 失敗しても鎖は切らない（次の呼び出しが止まってしまうため）
  cwThresholdChain = run.catch(() => {});
  return run;
}

async function checkThresholdAndNotifyInner(usageData) {
  if (!usageData) return;
  const settings = await cwGetSettings();
  if (!settings.thresholdEnabled || !settings.chatworkToken || !settings.chatworkRoomId) return;

  // 止めているあいだは送らない。⚠️ フラグ（cwNotified_*）は触らない。
  // ここで下げてしまうと、再開したときに超過中の項目がもう一度鳴る。
  const gate = notificationGate(settings);
  if (gate.blocked) {
    console.log('[Claude Usage] Threshold notification suppressed:', gate.reason);
    return;
  }

  const metrics = settings.thresholdMetrics || {};
  // アカウント行は1回だけ載せる。複数の項目が同時に超えても、知らせるのは最初の1通でよい。
  const acct = await peekAccountChange(usageData);
  let accountLine = acct.line;
  for (const metricKey of METRIC_KEYS) {
    if (!metrics[metricKey]) continue;
    const sent = await checkOneMetricThreshold(metricKey, usageData, settings, accountLine);
    // 実際に送れた回だけ、アカウント行を使い切ったことにする
    if (sent && accountLine) {
      await commitAccount(acct.current);
      accountLine = '';
    }
  }
}

// ---- 定時レポート ----

function formatReportMessage(usageData, label, accountLine = '') {
  const capturedAt = usageData && usageData.capturedAt;
  const lines = [`[info][title]Claude使用量レポート（${label}）[/title]`];
  // アカウント行は「変わったときだけ」入る（accountChangeLine が空文字を返す）。
  // いちばん上に置く。数字を読む前に「誰の数字か」が目に入る順番にするため。
  if (accountLine) lines.push(accountLine);
  let any = false;
  for (const key of METRIC_KEYS) {
    const m = usageData && usageData[key];
    if (m && typeof m.percentage === 'number') {
      any = true;
      lines.push(formatMetricLine(shortLabelFor(key, m), m, capturedAt));
    }
  }
  if (!any) lines.push('使用量データを取得できませんでした。');
  // いつ時点の数値かを必ず添える。古い値が混ざったときに人が気づける唯一の手掛かりになる。
  if (any && typeof capturedAt === 'number') lines.push(`（数値の取得：${formatHM(capturedAt)}）`);
  lines.push('[/info]');
  return lines.join('\n');
}

// ---- 遅刻したアラームの判定 ----
// PCのスリープ中やChrome終了中は chrome.alarms が鳴らず、復帰時にまとめて配信される。
// そのまま処理すると「朝9時に夕方レポートが届く」（2026/8/18に発生。朝と夕方で数値が
// 完全に一致するのが目印）。alarm.scheduledTime と現在時刻の差で遅刻を判定し、
// 大きく遅れた回は送らずに捨てる（次の定時に回す）。
const DAILY_REPORT_LATE_TOLERANCE_MS = 30 * 60 * 1000;

function lateByMs(scheduledTime) {
  if (typeof scheduledTime !== 'number') return 0; // 判定材料が無ければ従来どおり送る
  return Date.now() - scheduledTime;
}

function isTooLate(scheduledTime) {
  return lateByMs(scheduledTime) > DAILY_REPORT_LATE_TOLERANCE_MS;
}

// ---- 定時レポートの再試行 ----
// 取得は「Chrome起動直後でタブがまだ読み込まれていない」「モーダルの描画が遅い」など、
// 時間をおけば直る理由で失敗することが多い。以前は失敗したらそこで終わりだったため、
// 通知が黙って欠測していた（2026/8/3朝）。
// service workerは待機中に停止されるので、setTimeoutではなくalarmで再試行を予約する。
const DAILY_REPORT_RETRY_PREFIX = 'dailyReportRetry:';
const DAILY_REPORT_MAX_RETRIES = 2;
const DAILY_REPORT_RETRY_DELAY_MS = 60 * 1000;

function slotFromLabel(label) {
  return label === '朝' ? 'morning' : 'evening';
}

function labelFromSlot(slot) {
  return slot === 'morning' ? '朝' : '夕方';
}

async function getRetryAttempt(slot) {
  const { dailyReportRetryAttempt } = await chrome.storage.local.get(['dailyReportRetryAttempt']);
  return (dailyReportRetryAttempt || {})[slot] || 0;
}

async function setRetryAttempt(slot, attempt) {
  const { dailyReportRetryAttempt } = await chrome.storage.local.get(['dailyReportRetryAttempt']);
  const state = dailyReportRetryAttempt || {};
  if (attempt > 0) {
    state[slot] = attempt;
  } else {
    delete state[slot];
  }
  await chrome.storage.local.set({ dailyReportRetryAttempt: state });
}

async function clearRetryState(slot) {
  await setRetryAttempt(slot, 0);
  await chrome.alarms.clear(DAILY_REPORT_RETRY_PREFIX + slot);
}

// background.jsのアラームリスナーから呼ばれる入口（再試行分）
async function handleDailyReportRetryAlarm(alarmName, scheduledTime) {
  const slot = alarmName.slice(DAILY_REPORT_RETRY_PREFIX.length);
  if (slot !== 'morning' && slot !== 'evening') return;
  if (isTooLate(scheduledTime)) {
    console.log('[Claude Usage] Skip stale daily report retry:', slot);
    await clearRetryState(slot);
    await logTabEvent(`daily-report-${slot}`, 'skipped-stale-retry');
    return;
  }
  console.log('[Claude Usage] Daily report retry firing:', slot);
  await sendDailyReport(labelFromSlot(slot));
}

async function sendDailyReport(label) {
  const settings = await cwGetSettings();
  const slot = slotFromLabel(label);
  if (!settings.dailyReportEnabled || !settings.chatworkToken || !settings.chatworkRoomId) return;

  const gate = notificationGate(settings);
  if (gate.blocked) {
    console.log('[Claude Usage] Daily report suppressed:', gate.reason, label);
    await clearRetryState(slot);
    await logTabEvent(`daily-report-${slot}`, `skipped-${gate.reason}`);
    return;
  }

  const today = new Date();
  if (await isWeekendOrHoliday(today, settings)) {
    console.log('[Claude Usage] Skip daily report (weekend/holiday):', today.toDateString());
    await clearRetryState(slot);
    return;
  }

  const attempt = await getRetryAttempt(slot);
  const reason = `daily-report-${slot}${attempt ? `-retry${attempt}` : ''}`;

  try {
    const { usageData } = await fetchUsageDataFromPage(reason);
    const acct = await peekAccountChange(usageData);
    const body = formatReportMessage(usageData, label, acct.line);
    await sendChatworkMessage(settings.chatworkToken, settings.chatworkRoomId, body);
    if (acct.changed) await commitAccount(acct.current);
    console.log('[Claude Usage] Daily report sent:', label, attempt ? `(retry ${attempt})` : '');
    await clearRetryState(slot);
    // 定時レポートのタイミングでしきい値も合わせてチェックしておく
    await checkThresholdAndNotify(usageData);
  } catch (err) {
    console.error('[Claude Usage] Failed to send daily report:', err);

    if (attempt < DAILY_REPORT_MAX_RETRIES) {
      const next = attempt + 1;
      await setRetryAttempt(slot, next);
      chrome.alarms.create(DAILY_REPORT_RETRY_PREFIX + slot, { when: Date.now() + DAILY_REPORT_RETRY_DELAY_MS });
      console.log('[Claude Usage] Daily report retry scheduled:', slot, 'attempt', next);
      await logTabEvent(reason, `retry-scheduled-${next}`);
    } else {
      // 再試行しきっても駄目だった。動作ログに残し、オプション画面から追えるようにする。
      console.error('[Claude Usage] Daily report giving up after retries:', slot);
      await clearRetryState(slot);
      await logTabEvent(reason, 'gave-up-after-retries');
    }
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
async function handleDailyAlarm(alarmName, scheduledTime) {
  const label = alarmName === 'dailyMorningReport' ? '朝' : '夕方';
  const slot = slotFromLabel(label);

  if (isTooLate(scheduledTime)) {
    // 遅刻分は送らない。送ると古いラベルに今の数値が乗って誤解を生む。
    const lateMin = Math.round(lateByMs(scheduledTime) / 60000);
    console.log('[Claude Usage] Skip stale daily report:', label, `${lateMin}min late`);
    await clearRetryState(slot);
    await logTabEvent(`daily-report-${slot}`, `skipped-stale-${lateMin}min`);
  } else {
    await sendDailyReport(label);
  }

  // 次回分を再スケジュール（遅刻で捨てた場合も、次の定時は通常どおり鳴らす）
  const settings = await cwGetSettings();
  if (settings.dailyReportEnabled) {
    const timeKey = alarmName === 'dailyMorningReport' ? 'morningTime' : 'eveningTime';
    chrome.alarms.create(alarmName, { when: nextOccurrence(settings[timeKey]) });
  }
}
