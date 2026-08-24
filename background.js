// バックグラウンドスクリプト

// Chatwork通知機能（しきい値通知・平日朝夕の定時レポート）はこのフォークでの追加分
importScripts('chatwork-notify.js');

// インストール時とブラウザ起動時の初期化
async function initializeExtension() {
  console.log('[Claude Usage] Initializing extension...');
  
  // 現在の設定を取得
  const result = await chrome.storage.local.get(['widgetVisible']);
  
  // widgetVisibleが未設定の場合はデフォルトでtrueに設定
  let isEnabled;
  if (result.widgetVisible === undefined) {
    isEnabled = true;
    await chrome.storage.local.set({ widgetVisible: true });
    console.log('[Claude Usage] Set default widgetVisible to true');
  } else {
    isEnabled = result.widgetVisible;
  }
  
  // バッジを更新
  updateBadge(isEnabled);
  console.log('[Claude Usage] Initialized with widgetVisible:', isEnabled);
}

// 既存のClaude.aiタブにコンテンツスクリプトを注入
async function injectContentScripts() {
  console.log('[Claude Usage] Checking for existing Claude.ai tabs...');
  
  try {
    // すべてのClaude.aiタブを取得
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    console.log('[Claude Usage] Found', tabs.length, 'Claude.ai tabs');
    
    for (const tab of tabs) {
      try {
        // まずcontent scriptが既に読み込まれているかチェック
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
          if (response && response.pong) {
            console.log('[Claude Usage] Content script already loaded in tab', tab.id);
            // 既にロードされている場合は、ウィジェットを表示するよう通知
            await chrome.tabs.sendMessage(tab.id, { action: 'showWidget' });
            continue;
          }
        } catch (pingError) {
          console.log('[Claude Usage] Content script not yet loaded in tab', tab.id);
        }
        
        // CSSを注入
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['floating-widget.css']
        });
        console.log('[Claude Usage] CSS injected into tab', tab.id);
        
        // JavaScriptを注入（content.jsとfloating-widget.jsの順序で）
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js', 'floating-widget.js']
        });
        console.log('[Claude Usage] Scripts injected into tab', tab.id);
        
        // スクリプト注入後、少し待ってからウィジェット表示を要求
        setTimeout(async () => {
          try {
            await chrome.tabs.sendMessage(tab.id, { action: 'showWidget' });
            console.log('[Claude Usage] Show widget message sent to tab', tab.id);
          } catch (msgError) {
            console.log('[Claude Usage] Could not send message to tab', tab.id, msgError);
          }
        }, 500);
        
      } catch (error) {
        console.log('[Claude Usage] Could not inject scripts into tab', tab.id, ':', error.message);
      }
    }
  } catch (error) {
    console.error('[Claude Usage] Error finding tabs:', error);
  }
}

// インストール時
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Claude Usage] Extension installed/updated:', details.reason);
  await initializeExtension();
  await scheduleDailyAlarms();
  await refreshHolidayListIfNeeded();

  // 初回インストールまたは更新時に既存のタブにスクリプトを注入
  if (details.reason === 'install' || details.reason === 'update') {
    console.log('[Claude Usage] Injecting content scripts into existing tabs...');
    // 少し待ってから注入（拡張機能の初期化を確実にするため）
    setTimeout(injectContentScripts, 1000);
  }
});

// ブラウザ起動時
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Claude Usage] Browser started');
  await initializeExtension();
  await scheduleDailyAlarms();
  await refreshHolidayListIfNeeded();
});

// メッセージリスナーを追加（統合版）
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Claude Usage] Received message:', request);
  
  if (request.action === 'fetchUsageData') {
    // 使用量ページからデータを取得
    fetchUsageDataFromPage(request.reason || 'message:fetchUsageData')
      .then(data => {
        sendResponse({ success: true, data: data.usageData, lastUpdate: data.lastUpdate });
      })
      .catch(error => {
        console.error('[Claude Usage] Error fetching data:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // 非同期レスポンスを有効にする
  }

  if (request.action === 'settingsUpdated') {
    // オプション画面で設定が保存されたら、朝夕アラームを組み直す
    scheduleDailyAlarms();
    return false;
  }

  if (request.action === 'testChatworkMessage') {
    // 固定の接続確認文言ではなく、実際のレポートと同じ書式・現在のデータで送る。
    // キャッシュが新しければそれを使い、無ければその場で取得する。
    (async () => {
      try {
        const cached = await chrome.storage.local.get(['usageData', 'lastUpdate']);
        const cacheAgeMin = cached.lastUpdate ? (Date.now() - cached.lastUpdate) / 60000 : Infinity;
        let usageData = cached.usageData;
        if (!usageData || cacheAgeMin > 30) {
          const fetched = await fetchUsageDataFromPage('test-send-button');
          usageData = fetched.usageData;
        }
        const body = formatReportMessage(usageData, 'テスト送信');
        await sendChatworkMessage(request.chatworkToken, request.chatworkRoomId, body);
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // 非同期レスポンスを有効にする
  }

  // 拡張機能アイコンからのトグル要求は別途処理
  return false;
});

// タブ作成中のフラグ
let isFetchingData = false;
let fetchPromise = null;

// ページ読み込み完了後、モーダルの描画を待つ時間。
// かつては3秒固定で待って1回だけ取得していたが、描画が間に合わないと
// そのまま失敗していた（2026/8/3朝の欠測）。いまは短く待ってからポーリングする。
const PAGE_SETTLE_MS = 1000;
// 使用量データが取れるまで粘る上限と、その間隔。
const USAGE_POLL_TIMEOUT_MS = 20000;
const USAGE_POLL_INTERVAL_MS = 1000;

// 使用量データを、取れるまで（最大 USAGE_POLL_TIMEOUT_MS）繰り返し要求する。
// claude.aiの使用量モーダルは描画完了のタイミングが読めないため、
// 「何秒待てば確実」と決め打ちせず、取れた時点で抜ける方式にしている。
async function requestUsageDataWithPolling(tabId, timeoutMs = USAGE_POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastIssue = null;

  while (Date.now() < deadline) {
    attempt++;
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'getUsageData' });
      if (response && response.success && response.data) {
        console.log('[Claude Usage] Usage data obtained on attempt', attempt);
        return response;
      }
      lastIssue = (response && response.error) || 'データが空でした';
    } catch (e) {
      // タブがまだ応答しない（描画中・content script初期化中）ケース
      lastIssue = e && e.message ? e.message : String(e);
    }
    await new Promise(resolve => setTimeout(resolve, USAGE_POLL_INTERVAL_MS));
  }

  console.log('[Claude Usage] Usage data polling timed out after', attempt, 'attempts. lastIssue=', lastIssue);
  return null;
}

// タブの読み込み完了を待つ。完了後、モーダルの描画の頭出しぶんだけ追加で待つ。
function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise(resolve => {
    let timer = null;
    const listener = (id, changeInfo) => {
      if (id !== tabId || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      setTimeout(resolve, PAGE_SETTLE_MS);
    };
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
  });
}

// 使用量ページ単体(/settings/usage)のタブかどうか。
// 会話ページ+ハッシュ(/chat/xxx#settings/usage)は、読み込み直すと書きかけの入力が消えるため、
// 「そのまま読み直してよいタブ」からは外す。
function isStandaloneUsageUrl(url) {
  try {
    return new URL(url).pathname.startsWith('/settings/usage');
  } catch (e) {
    return false;
  }
}

// 使用量ページからデータを取得する関数
// reason: どこから呼ばれたか（ログ用。例: 'daily-report-morning', 'widget-message:fetchUsageData', 'test-send-button'）
async function fetchUsageDataFromPage(reason = 'unknown') {
  console.log('[Claude Usage] Fetching usage data from page... reason=', reason);

  // 既にデータ取得中の場合は、そのPromiseを返す
  if (isFetchingData && fetchPromise) {
    console.log('[Claude Usage] Already fetching data, waiting for existing request...');
    return fetchPromise;
  }

  // フラグを設定
  isFetchingData = true;

  // Promiseを作成して保存
  fetchPromise = (async () => {
    let prevActiveTab = null;
    let navigatedTabId = null;
    let navigatedOriginalUrl = null;
    let outcome = 'unknown';
    try {
      // 既に使用量ページ(モーダル)が開いているタブを探す。
      // claude.aiは「/new#settings/usage」「/cowork/project/xxx#settings/usage」など
      // ベースのページ+ハッシュでモーダルを開く作りなので、パス前方一致ではなく
      // URL全体に"settings/usage"を含むかで判定する（無関係なタブを誤って掴まないように）。
      const allClaudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
      // Chrome起動直後は、セッション復元されたタブが discarded（未読込）のまま残っている。
      // discarded なタブには chrome.scripting で注入できず「注入失敗」になるため、
      // 「そのまま使う」候補からは外す（2026/8/3朝、これで定時レポートが欠測した）。
      let usageTab = allClaudeTabs.find(t => t.url && isStandaloneUsageUrl(t.url) && !t.discarded) || null;
      let wasCreated = false;

      console.log('[Claude Usage] Found existing usage tab:', !!usageTab);

      const [currentActive] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      prevActiveTab = currentActive || null;

      if (usageTab) {
        // 使用量ページのタブが開いていても、モーダルの「残り◯時間◯分」は開いた時点の表示のまま
        // 止まっている。読み直さずに拾うと、何時間も前の値をそのままChatworkへ流してしまう
        // （2026/8/19：9:23のアラートと9:30の定時レポートが揃って「12時間39分後」を出した）。
        // 再利用するときは必ず読み込み直す。対象は /settings/usage 単体ページに限っているので、
        // 会話の書きかけを巻き込む心配はない。
        outcome = 'reused-usage-tab-reloaded';
        console.log('[Claude Usage] Reloading existing usage tab for fresh values:', usageTab.id);

        await chrome.tabs.reload(usageTab.id);
        await waitForTabComplete(usageTab.id);
      } else if (allClaudeTabs.length > 0) {
        // 使用量ページそのもののタブは無いが、claude.aiの別タブは開いている。
        // 新しいタブを増やさず、既存タブを一時的にナビゲートして使い回す
        // （2026/7/30：タブが頻繁に一瞬開く問題への対応。新規タブ作成は最終手段にする）。
        // ナビゲートする場合は discarded でも問題ない（URLを更新すれば読み込まれる）が、
        // 読み込み済みのタブがあればそちらを優先する。
        const target = allClaudeTabs.find(t => t.active && !t.discarded)
          || allClaudeTabs.find(t => !t.discarded)
          || allClaudeTabs[0];
        navigatedTabId = target.id;
        navigatedOriginalUrl = target.url;
        outcome = 'reused-claude-tab-navigated';

        console.log('[Claude Usage] Reusing existing claude.ai tab (temporarily navigating):', target.id);
        usageTab = await chrome.tabs.update(target.id, {
          url: 'https://claude.ai/settings/usage',
          active: true
        });

        await new Promise(resolve => {
          const listener = (tabId, changeInfo) => {
            if (tabId === usageTab.id && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              // ここは軽く待つだけでよい。描画待ちは後段のポーリングが引き受ける。
              setTimeout(resolve, PAGE_SETTLE_MS);
            }
          };
          chrome.tabs.onUpdated.addListener(listener);

          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 15000);
        });
      } else {
        // claude.aiのタブが1つも開いていない場合のみ、新規タブを作成する（最終手段）。
        // 非表示(active:false)のまま開くとclaude.ai側のモーダルが実際には描画されない
        // ことが分かっているため、一時的に前面化してから元のタブへ戻す。
        outcome = 'created-new-tab';

        console.log('[Claude Usage] No claude.ai tab open, creating a new one (temporarily focused)...');
        usageTab = await chrome.tabs.create({
          url: 'https://claude.ai/settings/usage',
          active: true
        });
        wasCreated = true;

        // タブIDを記録
        console.log('[Claude Usage] Created new tab with ID:', usageTab.id);

        // ページが完全に読み込まれるまで待機
        await new Promise(resolve => {
          const listener = (tabId, changeInfo) => {
            if (tabId === usageTab.id && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              // ここは軽く待つだけでよい。描画待ちは後段のポーリングが引き受ける。
              setTimeout(resolve, PAGE_SETTLE_MS);
            }
          };
          chrome.tabs.onUpdated.addListener(listener);

          // タイムアウト設定（15秒）
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 15000); // 10秒から15秒に延長
        });
      }

      // content scriptが読み込まれているか確認し、必要に応じて注入
      let scriptReady = false;
      try {
        const pingResponse = await chrome.tabs.sendMessage(usageTab.id, { action: 'ping' });
        scriptReady = pingResponse && pingResponse.pong;
        console.log('[Claude Usage] Content script ready:', scriptReady);
      } catch (e) {
        console.log('[Claude Usage] Content script not loaded, will inject');
      }
      
      if (!scriptReady) {
        // content scriptを注入
        try {
          await chrome.scripting.insertCSS({
            target: { tabId: usageTab.id },
            files: ['floating-widget.css']
          });
          
          await chrome.scripting.executeScript({
            target: { tabId: usageTab.id },
            files: ['content.js', 'floating-widget.js']
          });
          
          console.log('[Claude Usage] Content scripts injected successfully');
          
          // スクリプトの初期化を待つ
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (injectError) {
          console.error('[Claude Usage] Failed to inject scripts:', injectError);

          await cleanupTemporaryTab(usageTab.id, wasCreated, prevActiveTab, navigatedTabId, navigatedOriginalUrl);
          await logTabEvent(reason, `${outcome}-inject-failed`);

          throw new Error('スクリプトの注入に失敗しました');
        }
      }

      // データを取得。モーダルの描画完了は待ち時間を決め打ちできないため、
      // 取れるまでポーリングする（2026/8/3：3秒固定・1回きりで間に合わず欠測した）。
      console.log('[Claude Usage] Requesting data from content script (polling)...');
      const response = await requestUsageDataWithPolling(usageTab.id);

      if (response && response.success) {
        const usageData = response.data;
        const lastUpdate = Date.now();
        // いつ時点の数値かを一緒に持ち回る。Chatworkへ出す残り時間は、
        // この時刻を基準に送信の瞬間へ計算し直す（chatwork-notify.js の resolveResetAt）。
        usageData.capturedAt = lastUpdate;

        // データを保存
        await chrome.storage.local.set({
          usageData: usageData,
          lastUpdate: lastUpdate
        });

        console.log('[Claude Usage] Data fetched and saved successfully');

        // しきい値チェック（Chatwork通知）。失敗しても本体の取得結果には影響させない
        checkThresholdAndNotify(usageData).catch(err =>
          console.error('[Claude Usage] checkThresholdAndNotify failed:', err)
        );

        // 一時的に前面化・ナビゲートしたタブなら、元の状態へ戻す
        if (wasCreated || navigatedTabId) {
          console.log('[Claude Usage] Restoring tab/focus after fetch...');
          setTimeout(async () => {
            await cleanupTemporaryTab(usageTab.id, wasCreated, prevActiveTab, navigatedTabId, navigatedOriginalUrl);
          }, 500); // 少し遅延させて確実にデータ取得完了後に閉じる
        }

        await logTabEvent(reason, `${outcome}-success`);

        return { usageData, lastUpdate };
      } else {
        // データ取得失敗
        await cleanupTemporaryTab(usageTab.id, wasCreated, prevActiveTab, navigatedTabId, navigatedOriginalUrl);
        await logTabEvent(reason, `${outcome}-failed`);
        throw new Error('使用量データの取得に失敗しました');
      }
    } catch (error) {
      console.error('[Claude Usage] Error in fetchUsageDataFromPage:', error);
      throw error;
    } finally {
      // フラグをリセット
      isFetchingData = false;
      fetchPromise = null;
      console.log('[Claude Usage] Fetch completed, flags reset');
    }
  })();

  return fetchPromise;
}

// 一時的に前面化・流用したタブの後始末。
// wasCreated=true なら新規作成したタブを閉じる。navigatedTabId があれば
// （既存の別タブを一時的にナビゲートしただけなので）閉じずに元のURLへ戻す。
// どちらの場合も、フォーカスを奪った元アクティブタブがあれば戻す。
async function cleanupTemporaryTab(tabId, wasCreated, prevActiveTab, navigatedTabId, navigatedOriginalUrl) {
  if (navigatedTabId && navigatedOriginalUrl) {
    try {
      await chrome.tabs.update(navigatedTabId, { url: navigatedOriginalUrl });
    } catch (e) {
      console.log('[Claude Usage] Could not restore navigated tab URL (maybe closed)');
    }
  }
  if (prevActiveTab && prevActiveTab.id !== tabId) {
    try {
      await chrome.tabs.update(prevActiveTab.id, { active: true });
    } catch (e) {
      console.log('[Claude Usage] Could not restore previous active tab (maybe closed)');
    }
  }
  if (wasCreated) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      console.log('[Claude Usage] Tab already closed or removed');
    }
  }
}

// タブ作成・流用の記録を残す（診断用）。直近200件までstorage.localに保持する。
const TAB_ACTIVITY_LOG_MAX = 200;
async function logTabEvent(reason, outcome) {
  try {
    const { tabActivityLog } = await chrome.storage.local.get(['tabActivityLog']);
    const log = Array.isArray(tabActivityLog) ? tabActivityLog : [];
    log.push({ time: Date.now(), reason, outcome });
    while (log.length > TAB_ACTIVITY_LOG_MAX) log.shift();
    await chrome.storage.local.set({ tabActivityLog: log });
  } catch (e) {
    console.error('[Claude Usage] Failed to write tab activity log:', e);
  }
}

// 拡張機能アイコンのクリックを処理
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[Claude Usage] Extension icon clicked');
  
  // Claude.aiのページかチェック
  if (tab.url && tab.url.includes('claude.ai')) {
    // 現在の状態を取得
    const result = await chrome.storage.local.get(['widgetVisible']);
    
    // widgetVisibleが未設定の場合はtrueとして扱う
    const currentState = result.widgetVisible === undefined ? true : result.widgetVisible;
    const newState = !currentState; // 状態を反転
    
    // 新しい状態を保存
    await chrome.storage.local.set({ widgetVisible: newState });
    console.log('[Claude Usage] Widget state changed to:', newState);
    
    // バッジとアイコンの表示を更新
    updateBadge(newState);
    
    // content scriptが読み込まれているかチェック
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
      if (response && response.pong) {
        // content scriptが応答した場合、ウィジェットの表示/非表示を切り替え
        if (newState) {
          await chrome.tabs.sendMessage(tab.id, { action: 'showWidget' });
          console.log('[Claude Usage] Widget show message sent');
        } else {
          await chrome.tabs.sendMessage(tab.id, { action: 'hideWidget' });
          console.log('[Claude Usage] Widget hide message sent');
        }
      }
    } catch (error) {
      // content scriptが読み込まれていない場合は、注入を試みる
      console.log('[Claude Usage] Content script not ready, attempting injection');
      
      try {
        // CSSを注入
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['floating-widget.css']
        });
        
        // JavaScriptを注入
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js', 'floating-widget.js']
        });
        
        console.log('[Claude Usage] Scripts injected successfully');
        
        // 注入後、少し待ってから状態を適用
        setTimeout(async () => {
          try {
            if (newState) {
              await chrome.tabs.sendMessage(tab.id, { action: 'showWidget' });
            }
          } catch (msgError) {
            console.log('[Claude Usage] Could not send message after injection');
          }
        }, 500);
        
      } catch (injectError) {
        console.log('[Claude Usage] Could not inject scripts:', injectError);
      }
    }
  } else {
    // Claude.ai以外のページの場合は、Claude.aiを開く
    chrome.tabs.create({ url: 'https://claude.ai/settings/usage' });
  }
});

// バッジとアイコンの表示を更新
async function updateBadge(isEnabled) {
  if (isEnabled) {
    // ON状態: 緑色のバッジ
    await chrome.action.setBadgeText({ text: 'ON' });
    await chrome.action.setBadgeBackgroundColor({ color: '#4ade80' });
  } else {
    // OFF状態: グレーのバッジ
    await chrome.action.setBadgeText({ text: 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: '#9ca3af' });
  }
}

// 定期的にデータを更新する（5分ごと）
chrome.alarms.create('updateUsage', { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'updateUsage') {
    // Claude.aiのタブが開いている場合のみ更新
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    if (tabs.length > 0) {
      try {
        const response = await chrome.tabs.sendMessage(tabs[0].id, { action: 'getUsageData' });
        if (response && response.success) {
          await chrome.storage.local.set({
            usageData: response.data,
            lastUpdate: Date.now()
          });
          checkThresholdAndNotify(response.data).catch(err =>
            console.error('[Claude Usage] checkThresholdAndNotify failed:', err)
          );
        }
      } catch (error) {
        console.error('自動更新エラー:', error);
      }
    }
    return;
  }

  if (alarm.name === 'dailyMorningReport' || alarm.name === 'dailyEveningReport') {
    handleDailyAlarm(alarm.name, alarm.scheduledTime).catch(err =>
      console.error('[Claude Usage] handleDailyAlarm failed:', err)
    );
    return;
  }

  // 定時レポートの再試行（取得失敗から60秒後。chatwork-notify.js側で予約している）
  if (alarm.name.startsWith(DAILY_REPORT_RETRY_PREFIX)) {
    handleDailyReportRetryAlarm(alarm.name, alarm.scheduledTime).catch(err =>
      console.error('[Claude Usage] handleDailyReportRetryAlarm failed:', err)
    );
  }
});

// ウィジェットからのメッセージ処理は上記の統合リスナーで処理

/*
// この関数は現在使用されていません（参考用に保持）
// バックグラウンドで使用量データを取得
async function fetchUsageDataInBackground() {
  console.log('[Claude Usage] Starting background data fetch...');
  
  try {
    // まず、既に開いている使用量ページのタブを探す
    const existingTabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage' });
    
    let tab;
    let shouldCloseTab = false;
    
    if (existingTabs.length > 0) {
      // 既存のタブがあればそれを使用
      tab = existingTabs[0];
      console.log('[Claude Usage] Using existing usage page tab', tab.id);
      
      // ページをリロードして最新のデータを取得
      await chrome.tabs.reload(tab.id);
    } else {
      // なければ新しいタブを開く（バックグラウンドで）
      tab = await chrome.tabs.create({
        url: 'https://claude.ai/settings/usage',
        active: false // バックグラウンドで開く
      });
      shouldCloseTab = true; // 後で閉じる
      console.log('[Claude Usage] Usage page opened in new background tab', tab.id);
    }
    
    // タブの読み込みを待つ
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 20; // 最大20回試行（10秒）
      
      const checkInterval = setInterval(async () => {
        attempts++;
        console.log('[Claude Usage] Checking for data, attempt', attempts);
        
        try {
          // content scriptにデータ取得を依頼
          const response = await chrome.tabs.sendMessage(tab.id, { action: 'getUsageData' });
          
          if (response && response.success) {
            console.log('[Claude Usage] Data retrieved successfully');
            clearInterval(checkInterval);
            
            // データを保存
            await chrome.storage.local.set({
              usageData: response.data,
              lastUpdate: Date.now()
            });
            
            // 新しく開いたタブの場合のみ閉じる
            if (shouldCloseTab) {
              await chrome.tabs.remove(tab.id);
              console.log('[Claude Usage] Background tab closed');
            }
            
            resolve({
              usageData: response.data,
              lastUpdate: Date.now()
            });
          } else if (attempts >= maxAttempts) {
            console.log('[Claude Usage] Max attempts reached, giving up');
            clearInterval(checkInterval);
            if (shouldCloseTab) {
              await chrome.tabs.remove(tab.id);
            }
            resolve(null);
          }
        } catch (error) {
          if (attempts >= maxAttempts) {
            console.log('[Claude Usage] Max attempts reached with error:', error.message);
            clearInterval(checkInterval);
            if (shouldCloseTab) {
              try {
                await chrome.tabs.remove(tab.id);
              } catch (closeError) {
                console.log('[Claude Usage] Could not close tab:', closeError);
              }
            }
            resolve(null);
          }
        }
      }, 500); // 0.5秒ごとにチェック
    });
  } catch (error) {
    console.error('[Claude Usage] Error in background fetch:', error);
    return null;
  }
}
*/

