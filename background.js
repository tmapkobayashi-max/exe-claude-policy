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
    fetchUsageDataFromPage()
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
    sendChatworkMessage(
      request.chatworkToken,
      request.chatworkRoomId,
      '[info][title]Claude使用量チェッカー[/title]テスト通知です。この文言が届いていれば設定は正常です。[/info]'
    )
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 非同期レスポンスを有効にする
  }

  // 拡張機能アイコンからのトグル要求は別途処理
  return false;
});

// タブ作成中のフラグ
let isFetchingData = false;
let fetchPromise = null;

// 使用量ページからデータを取得する関数
async function fetchUsageDataFromPage() {
  console.log('[Claude Usage] Fetching usage data from page...');
  
  // 既にデータ取得中の場合は、そのPromiseを返す
  if (isFetchingData && fetchPromise) {
    console.log('[Claude Usage] Already fetching data, waiting for existing request...');
    return fetchPromise;
  }
  
  // フラグを設定
  isFetchingData = true;
  
  // Promiseを作成して保存
  fetchPromise = (async () => {
    try {
      // 既に使用量ページが開いているかチェック（より広範囲に検索）
      let tabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' });
      
      // 完全一致でも検索
      if (tabs.length === 0) {
        tabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage' });
      }
      
      let usageTab = tabs.length > 0 ? tabs[0] : null;
      let wasCreated = false;
      
      console.log('[Claude Usage] Found', tabs.length, 'existing usage page tab(s)');
      
      if (!usageTab) {
        // 使用量ページが開いていない場合のみ、バックグラウンドで開く
        console.log('[Claude Usage] Opening usage page in background...');
        usageTab = await chrome.tabs.create({
          url: 'https://claude.ai/settings/usage',
          active: false // バックグラウンドで開く
        });
        wasCreated = true;
        
        // タブIDを記録
        console.log('[Claude Usage] Created new tab with ID:', usageTab.id);
        
        // ページが完全に読み込まれるまで待機
        await new Promise(resolve => {
          const listener = (tabId, changeInfo) => {
            if (tabId === usageTab.id && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              // ページのJavaScriptが実行されるまでさらに待つ
              setTimeout(resolve, 3000); // 2秒から3秒に延長
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          
          // タイムアウト設定（15秒）
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 15000); // 10秒から15秒に延長
        });
      } else {
        console.log('[Claude Usage] Using existing usage page tab:', usageTab.id);
        
        // 既存のタブがある場合は、念のため少し待つ
        await new Promise(resolve => setTimeout(resolve, 500));
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
          
          // 自分で作ったタブの場合は閉じる
          if (wasCreated) {
            try {
              await chrome.tabs.remove(usageTab.id);
            } catch (e) {
              console.log('[Claude Usage] Could not remove tab');
            }
          }
          
          throw new Error('スクリプトの注入に失敗しました');
        }
      }
      
      // データを取得
      console.log('[Claude Usage] Requesting data from content script...');
      const response = await chrome.tabs.sendMessage(usageTab.id, { action: 'getUsageData' });
      
      if (response && response.success) {
        const usageData = response.data;
        const lastUpdate = Date.now();
        
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
        
        // バックグラウンドで開いたタブの場合は閉じる
        if (wasCreated) {
          console.log('[Claude Usage] Closing background tab...');
          setTimeout(async () => {
            try {
              await chrome.tabs.remove(usageTab.id);
            } catch (e) {
              console.log('[Claude Usage] Tab already closed or removed');
            }
          }, 500); // 少し遅延させて確実にデータ取得完了後に閉じる
        }
        
        return { usageData, lastUpdate };
      } else {
        // データ取得失敗
        if (wasCreated) {
          try {
            await chrome.tabs.remove(usageTab.id);
          } catch (e) {
            console.log('[Claude Usage] Could not remove tab');
          }
        }
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
    handleDailyAlarm(alarm.name).catch(err =>
      console.error('[Claude Usage] handleDailyAlarm failed:', err)
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

