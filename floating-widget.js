// フローティングウィジェット
(function() {
  'use strict';

  console.log('[Claude Usage Widget] Script loaded');

  // 既に存在する場合は何もしない
  if (document.getElementById('claude-usage-widget')) {
    console.log('[Claude Usage Widget] Widget already exists, exiting');
    return;
  }

  let widget = null;
  let isDragging = false;
  let currentX = 0;
  let currentY = 0;
  let initialX = 0;
  let initialY = 0;
  let updateInterval = null;
  let useRightPosition = true; // 右端からの位置を使用するフラグ

  // バックグラウンドスクリプトからのメッセージを受信
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('[Claude Usage Widget] Received message:', request);
    
    if (request.action === 'ping') {
      // Content scriptが読み込まれているか確認するためのpingに応答
      sendResponse({ pong: true });
    } else if (request.action === 'showWidget') {
      showWidget();
      sendResponse({ success: true });
    } else if (request.action === 'hideWidget') {
      hideWidget();
      sendResponse({ success: true });
    }
    
    return true;
  });

  // 使用量ページかどうかをチェック
  function isUsagePage() {
    const result = window.location.href.includes('claude.ai/settings/usage');
    console.log('[Claude Usage Widget] isUsagePage:', result);
    return result;
  }

  // ウィジェットを作成
  function createWidget() {
    console.log('[Claude Usage Widget] createWidget called');
    
    // 既にwidget変数に値がある場合は作成しない
    if (widget) {
      console.log('[Claude Usage Widget] Widget variable already set, skipping creation');
      return;
    }
    
    // DOM上に既に存在する場合も作成しない
    if (document.getElementById('claude-usage-widget')) {
      console.log('[Claude Usage Widget] Widget element already exists in DOM, skipping creation');
      return;
    }
    
    widget = document.createElement('div');
    widget.id = 'claude-usage-widget';
    widget.innerHTML = `
      <div class="widget-header">
        <h3 class="widget-title">Claude使用量</h3>
        <div class="widget-controls">
          <button class="widget-btn" id="widget-refresh" title="更新">🔄</button>
          <button class="widget-btn" id="widget-toggle" title="折りたたみ">−</button>
          <button class="widget-btn" id="widget-close" title="閉じる">×</button>
        </div>
      </div>
      <div class="widget-content">
        <div class="widget-loading">
          <div class="widget-spinner"></div>
          <div>読み込み中...</div>
        </div>
      </div>
    `;

    document.body.appendChild(widget);
    console.log('[Claude Usage Widget] Widget appended to body');

    // 保存された位置を復元
    restorePosition();

    // イベントリスナーを設定
    setupEventListeners();
    console.log('[Claude Usage Widget] Event listeners set up');

    // 使用量ページにいる場合はデータ取得、それ以外はキャッシュを表示
    if (isUsagePage()) {
      console.log('[Claude Usage Widget] On usage page, fetching data');
      fetchUsageData();
      // 5分ごとに自動更新
      updateInterval = setInterval(fetchUsageData, 5 * 60 * 1000);
    } else {
      console.log('[Claude Usage Widget] Not on usage page, loading cached data');
      // キャッシュをチェック
      chrome.storage.local.get(['usageData', 'lastUpdate', 'hasShownInitialFetch'], (result) => {
        const hasCache = result.usageData && result.lastUpdate;
        const hasShownInitial = result.hasShownInitialFetch;
        
        if (!hasCache && !hasShownInitial) {
          // 初回起動（キャッシュなし & 初回フラグなし）の場合のみ自動取得
          console.log('[Claude Usage Widget] First time launch, fetching data automatically');
          
          const content = widget.querySelector('.widget-content');
          content.innerHTML = `
            <div class="widget-loading">
              <div class="widget-spinner"></div>
              <div>初回データ取得中...</div>
            </div>
          `;
          
          // 初回フラグを設定
          chrome.storage.local.set({ hasShownInitialFetch: true });
          
          // データ取得
          chrome.runtime.sendMessage({ action: 'fetchUsageData' }, (response) => {
            if (response && response.success) {
              console.log('[Claude Usage Widget] Initial data fetched successfully');
              displayData(response.data, response.lastUpdate);
            } else {
              console.log('[Claude Usage Widget] Failed to fetch initial data');
              content.innerHTML = `
                <div class="widget-info">
                  データの取得に失敗しました<br>
                  <small>🔄ボタンをクリックして再試行してください</small>
                </div>
              `;
            }
          });
        } else {
          // 2回目以降、またはキャッシュがある場合は通常のキャッシュロード
          loadCachedData();
        }
        
        // すべてのページで5分ごとに自動更新
        updateInterval = setInterval(() => {
          console.log('[Claude Usage Widget] Auto-refresh triggered');
          chrome.runtime.sendMessage({ action: 'fetchUsageData' }, (response) => {
            if (response && response.success) {
              console.log('[Claude Usage Widget] Auto-refresh successful');
              displayData(response.data, response.lastUpdate);
            } else {
              console.log('[Claude Usage Widget] Auto-refresh failed');
            }
          });
        }, 5 * 60 * 1000);
      });
    }
  }

  // イベントリスナーを設定
  function setupEventListeners() {
    const header = widget.querySelector('.widget-header');
    const refreshBtn = widget.querySelector('#widget-refresh');
    const toggleBtn = widget.querySelector('#widget-toggle');
    const closeBtn = widget.querySelector('#widget-close');

    // ドラッグ機能
    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);

    // リフレッシュ中フラグ
    let isRefreshing = false;

    // ボタン
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      
      // 既にリフレッシュ中の場合は無視
      if (isRefreshing) {
        console.log('[Claude Usage Widget] Already refreshing, ignoring click');
        return;
      }
      
      isRefreshing = true;
      refreshBtn.disabled = true;
      refreshBtn.style.opacity = '0.5';
      
      if (isUsagePage()) {
        // 使用量ページにいる場合は直接データを取得
        fetchUsageData();
        
        // 完了後にフラグをリセット
        setTimeout(() => {
          isRefreshing = false;
          refreshBtn.disabled = false;
          refreshBtn.style.opacity = '1';
        }, 2000);
      } else {
        // 使用量ページにいない場合はバックグラウンドで取得
        const content = widget.querySelector('.widget-content');
        content.innerHTML = `
          <div class="widget-loading">
            <div class="widget-spinner"></div>
            <div>データを取得中...</div>
          </div>
        `;
        
        chrome.runtime.sendMessage({ action: 'fetchUsageData' }, (response) => {
          if (response && response.success) {
            console.log('[Claude Usage Widget] Data fetched successfully');
            displayData(response.data, response.lastUpdate);
          } else {
            console.log('[Claude Usage Widget] Failed to fetch data');
            content.innerHTML = `
              <div class="widget-error">
                データの取得に失敗しました<br>
                <small>もう一度お試しください</small>
              </div>
            `;
            setTimeout(() => {
              loadCachedData();
            }, 2000);
          }
          
          // 完了後にフラグをリセット
          isRefreshing = false;
          refreshBtn.disabled = false;
          refreshBtn.style.opacity = '1';
        });
      }
    });

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWidget();
    });

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideWidget();
    });
  }

  // ドラッグ開始
  function dragStart(e) {
    if (e.target.closest('.widget-btn')) {
      return;
    }

    if (useRightPosition) {
      // 右端からの距離を使用する場合
      const rightDistance = window.innerWidth - (widget.getBoundingClientRect().left + widget.offsetWidth);
      initialX = e.clientX + rightDistance;
      initialY = e.clientY - currentY;
    } else {
      initialX = e.clientX - currentX;
      initialY = e.clientY - currentY;
    }
    isDragging = true;
    widget.classList.add('dragging');
  }

  // ドラッグ中
  function drag(e) {
    if (!isDragging) return;

    e.preventDefault();

    if (useRightPosition) {
      // 右端からの距離を計算
      const rightDistance = initialX - e.clientX;
      currentX = rightDistance;
      currentY = e.clientY - initialY;

      widget.style.right = rightDistance + 'px';
      widget.style.top = currentY + 'px';
      widget.style.left = 'auto';
    } else {
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;

      widget.style.left = currentX + 'px';
      widget.style.top = currentY + 'px';
      widget.style.right = 'auto';
    }
  }

  // ドラッグ終了
  function dragEnd() {
    if (!isDragging) return;

    isDragging = false;
    widget.classList.remove('dragging');
    savePosition();
  }

  // 位置を保存
  function savePosition() {
    chrome.storage.local.set({
      widgetPosition: {
        x: currentX,
        y: currentY,
        useRight: useRightPosition
      }
    });
  }

  // 位置を復元
  function restorePosition() {
    chrome.storage.local.get(['widgetPosition'], (result) => {
      if (result.widgetPosition) {
        // 保存された位置設定を復元
        if (result.widgetPosition.useRight !== undefined) {
          useRightPosition = result.widgetPosition.useRight;
        }

        currentX = result.widgetPosition.x;
        currentY = result.widgetPosition.y;

        // 画面サイズを取得
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        const widgetWidth = widget.offsetWidth || 280;

        // 位置が画面外にある場合は調整
        let adjusted = false;

        if (useRightPosition) {
          // 右端からの距離を使用する場合
          // 右端チェック（負の値にならないように）
          if (currentX < 0) {
            currentX = 20;
            adjusted = true;
          }

          // 左端チェック（ウィジェットが画面外に出ないように）
          if (currentX + widgetWidth > screenWidth - 20) {
            currentX = 20;
            adjusted = true;
          }

          widget.style.right = currentX + 'px';
          widget.style.left = 'auto';
        } else {
          // 左端からの距離を使用する場合（後方互換性のため）
          // 右端チェック
          if (currentX + widgetWidth > screenWidth) {
            currentX = screenWidth - widgetWidth - 20;
            adjusted = true;
          }

          // 左端チェック
          if (currentX < 0) {
            currentX = 20;
            adjusted = true;
          }

          widget.style.left = currentX + 'px';
          widget.style.right = 'auto';
        }

        // 下端チェック
        if (currentY + 100 > screenHeight) {
          currentY = screenHeight - 200;
          adjusted = true;
        }

        // 上端チェック
        if (currentY < 0) {
          currentY = 80;
          adjusted = true;
        }

        widget.style.top = currentY + 'px';

        if (adjusted) {
          console.log('[Claude Usage Widget] Position adjusted from', result.widgetPosition, 'to:', currentX, currentY);
          // 調整後の位置を保存
          savePosition();
        } else {
          console.log('[Claude Usage Widget] Position restored:', currentX, currentY, 'useRight:', useRightPosition);
        }
      } else {
        // 初期位置を設定（右端から20px）
        useRightPosition = true;
        currentX = 20; // 右端からの距離
        currentY = 80;
        widget.style.right = currentX + 'px';
        widget.style.top = currentY + 'px';
        widget.style.left = 'auto';
        console.log('[Claude Usage Widget] Initial position set: right:', currentX, 'top:', currentY);
        // 初期位置を保存
        savePosition();
      }
    });
  }

  // ウィジェットを折りたたみ/展開
  function toggleWidget() {
    const toggleBtn = widget.querySelector('#widget-toggle');
    widget.classList.toggle('collapsed');
    
    if (widget.classList.contains('collapsed')) {
      toggleBtn.textContent = '+';
      toggleBtn.title = '展開';
    } else {
      toggleBtn.textContent = '−';
      toggleBtn.title = '折りたたみ';
    }

    // 状態を保存
    chrome.storage.local.set({
      widgetCollapsed: widget.classList.contains('collapsed')
    });
  }

  // ウィジェットを非表示
  function hideWidget() {
    console.log('[Claude Usage Widget] Hiding widget');
    if (updateInterval) {
      clearInterval(updateInterval);
    }
    if (widget && widget.parentNode) {
      widget.remove();
    }
    widget = null;
    
    // 非表示状態を保存
    chrome.storage.local.set({ widgetVisible: false });
  }

  // ウィジェットを再表示
  function showWidget() {
    console.log('[Claude Usage Widget] showWidget called, current widget:', widget);
    
    // 既にウィジェットが存在する場合は何もしない
    if (widget) {
      console.log('[Claude Usage Widget] Widget already exists, no action needed');
      return;
    }
    
    // ウィジェットが存在しない場合のみ作成
    chrome.storage.local.set({ widgetVisible: true }, () => {
      console.log('[Claude Usage Widget] Set widgetVisible to true, creating widget');
      createWidget();
    });
  }

  // メッセージを表示
  function showMessage(message) {
    const content = widget.querySelector('.widget-content');
    content.innerHTML = `
      <div class="widget-error">
        ${message}
      </div>
    `;
    setTimeout(() => {
      loadCachedData();
    }, 2000);
  }

  // キャッシュデータを読み込み
  function loadCachedData() {
    console.log('[Claude Usage Widget] Loading cached data');
    chrome.storage.local.get(['usageData', 'lastUpdate'], (result) => {
      console.log('[Claude Usage Widget] Cached data result:', result);
      
      const now = Date.now();
      const cacheAge = result.lastUpdate ? (now - result.lastUpdate) / 1000 / 60 : Infinity; // 分単位
      
      // キャッシュがあり、5分以内のものであればそれを使用
      if (result.usageData && cacheAge < 5) {
        console.log('[Claude Usage Widget] Using cached data (age:', Math.floor(cacheAge), 'minutes)');
        displayData(result.usageData, result.lastUpdate);
      } 
      // キャッシュがないか、古い場合は案内メッセージを表示（自動取得はしない）
      else {
        console.log('[Claude Usage Widget] No recent cached data found (age:', Math.floor(cacheAge), 'minutes)');
        const content = widget.querySelector('.widget-content');
        
        if (result.usageData) {
          // 古いキャッシュがある場合は表示して、更新を促す
          displayData(result.usageData, result.lastUpdate);
          // メッセージを追加
          const footer = content.querySelector('.widget-footer');
          if (footer) {
            footer.innerHTML += '<br><small style="color: #ee7800;">🔄ボタンで最新データに更新できます</small>';
          }
        } else {
          // キャッシュが全くない場合
          content.innerHTML = `
            <div class="widget-info">
              まだデータがありません<br>
              <small>🔄ボタンをクリックしてデータを取得してください</small>
            </div>
          `;
        }
      }
    });
  }

  // データを取得
  function fetchUsageData() {
    const content = widget.querySelector('.widget-content');
    
    // ローディング表示
    content.innerHTML = `
      <div class="widget-loading">
        <div class="widget-spinner"></div>
        <div>読み込み中...</div>
      </div>
    `;

    try {
      const usageData = extractUsageData();
      
      if (usageData === null) {
        // データが見つからない場合は案内メッセージを表示
        content.innerHTML = `
          <div class="widget-info">
            使用量データを読み込めませんでした<br>
            <small>ページを再読み込みするか、少し待ってから更新してください</small>
          </div>
        `;
        return;
      }
      
      displayData(usageData, Date.now());
      
      // データを保存
      chrome.storage.local.set({
        usageData: usageData,
        lastUpdate: Date.now()
      });
    } catch (error) {
      console.error('Error fetching usage data:', error);
      content.innerHTML = `
        <div class="widget-error">
          エラーが発生しました<br>
          <small>${error.message}</small>
        </div>
      `;
    }
  }

  // データを抽出（行単位パース。日本語UI・英語UI両対応、3つ目のモデル別枠は名前を固定せず動的検出）
  function extractUsageData() {
    const pageText = document.body.innerText;
    const lines = pageText.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const data = { currentSession: null, allModels: null, modelSpecific: null };

    const isSessionLabel = (l) => /現在のセッション/.test(l) || /^Current\s+session/i.test(l);
    const isAllModelsLabel = (l) => /すべてのモデル/.test(l) || /^All\s+models/i.test(l);

    for (let i = 0; i < lines.length - 2; i++) {
      const label = lines[i];
      const resetLine = lines[i + 1];
      const pctLine = lines[i + 2];

      const resetMatch = resetLine.match(/^(.+?)にリセット$/) || resetLine.match(/^Resets?\s+in\s+(.+)$/i);
      const pctMatch = pctLine.match(/^(\d+)\s*%\s*(使用済み|used)?/i);
      if (!resetMatch || !pctMatch) continue;

      const entry = { percentage: parseInt(pctMatch[1], 10), reset: resetMatch[1].trim() };

      if (isSessionLabel(label) && !data.currentSession) {
        data.currentSession = entry;
      } else if (isAllModelsLabel(label) && !data.allModels) {
        data.allModels = entry;
      } else if (!data.modelSpecific) {
        data.modelSpecific = { ...entry, name: label };
      }
      i += 2;
    }

    if (!data.currentSession && !data.allModels && !data.modelSpecific) {
      return null; // データが見つからない場合はnullを返す
    }

    return data;
  }

  // データを表示
  function displayData(data, lastUpdate) {
    const content = widget.querySelector('.widget-content');
    let html = '';

    if (data.currentSession) {
      html += `
        <div class="usage-item">
          <div class="usage-label">Current Session</div>
          <div class="usage-bar">
            <div class="usage-bar-fill" style="width: ${data.currentSession.percentage}%"></div>
          </div>
          <div class="usage-stats">
            <span class="usage-percentage">${data.currentSession.percentage}%</span>
            <span class="usage-reset">${data.currentSession.reset}</span>
          </div>
        </div>
      `;
    }

    if (data.allModels) {
      html += `
        <div class="usage-item">
          <div class="usage-label">All Models</div>
          <div class="usage-bar">
            <div class="usage-bar-fill" style="width: ${data.allModels.percentage}%"></div>
          </div>
          <div class="usage-stats">
            <span class="usage-percentage">${data.allModels.percentage}%</span>
            <span class="usage-reset">${data.allModels.reset}</span>
          </div>
        </div>
      `;
    }

    if (data.modelSpecific) {
      html += `
        <div class="usage-item opus">
          <div class="usage-label">${data.modelSpecific.name || 'モデル別'}</div>
          <div class="usage-bar">
            <div class="usage-bar-fill" style="width: ${data.modelSpecific.percentage}%"></div>
          </div>
          <div class="usage-stats">
            <span class="usage-percentage">${data.modelSpecific.percentage}%</span>
            <span class="usage-reset">${data.modelSpecific.reset}</span>
          </div>
        </div>
      `;
    }

    if (lastUpdate) {
      const updateTime = new Date(lastUpdate);
      
      // 時刻をHH:mm形式で表示
      const hours = updateTime.getHours().toString().padStart(2, '0');
      const minutes = updateTime.getMinutes().toString().padStart(2, '0');
      const timeString = `${hours}:${minutes}`;

      html += `
        <div class="widget-footer">
          最終更新: ${timeString}
        </div>
      `;
    }

    content.innerHTML = html;
  }

  // ウィジェットを初期化
  function initWidget() {
    console.log('[Claude Usage Widget] Initializing widget, readyState:', document.readyState);
    
    // bodyが存在しない場合は次のタイミングを待つ
    if (!document.body) {
      console.log('[Claude Usage Widget] Body not ready yet, will retry');
      return false;
    }
    
    chrome.storage.local.get(['widgetVisible', 'widgetCollapsed'], (result) => {
      console.log('[Claude Usage Widget] Storage result:', result);
      
      // widgetVisibleを明示的にチェック（undefined の場合は true として扱う）
      const shouldShow = result.widgetVisible === undefined ? true : result.widgetVisible;
      
      if (!shouldShow) {
        console.log('[Claude Usage Widget] Widget is set to hidden, not creating');
        return;
      }

      console.log('[Claude Usage Widget] Creating widget');
      createWidget();

      // 折りたたみ状態を復元
      if (result.widgetCollapsed && widget) {
        console.log('[Claude Usage Widget] Restoring collapsed state');
        widget.classList.add('collapsed');
        const toggleBtn = widget.querySelector('#widget-toggle');
        if (toggleBtn) {
          toggleBtn.textContent = '+';
          toggleBtn.title = '展開';
        }
      } else {
        console.log('[Claude Usage Widget] Widget is expanded (collapsed state:', result.widgetCollapsed, ')');
      }

      console.log('[Claude Usage Widget] Widget created successfully');
    });
    
    return true;
  }

  // 複数のタイミングで初期化を試みる
  function tryInitWidget() {
    console.log('[Claude Usage Widget] tryInitWidget called, readyState:', document.readyState);
    
    // 既にウィジェットが存在する場合はスキップ
    if (widget || document.getElementById('claude-usage-widget')) {
      console.log('[Claude Usage Widget] Widget already exists, skipping init');
      return;
    }
    
    // bodyが存在する場合のみ初期化を試みる
    if (document.body) {
      initWidget();
    } else {
      console.log('[Claude Usage Widget] Body not ready, waiting...');
    }
  }

  // 1. 即座に実行（DOMが既に準備されている場合）
  console.log('[Claude Usage Widget] Initial check, readyState:', document.readyState);
  if (document.readyState === 'complete') {
    console.log('[Claude Usage Widget] Document complete, initializing immediately');
    setTimeout(tryInitWidget, 100);
  } else if (document.readyState === 'interactive') {
    console.log('[Claude Usage Widget] Document interactive, initializing with delay');
    setTimeout(tryInitWidget, 200);
  }
  
  // 2. DOMContentLoaded
  if (document.readyState === 'loading') {
    console.log('[Claude Usage Widget] Waiting for DOMContentLoaded');
    document.addEventListener('DOMContentLoaded', () => {
      console.log('[Claude Usage Widget] DOMContentLoaded fired');
      setTimeout(tryInitWidget, 100);
    });
  }
  
  // 3. load イベント（完全ロード後）
  window.addEventListener('load', () => {
    console.log('[Claude Usage Widget] Window load event fired');
    setTimeout(tryInitWidget, 300);
  });
  
  // 4. 最後の保険として、1秒後に再試行
  setTimeout(() => {
    console.log('[Claude Usage Widget] Final retry after 1 second');
    tryInitWidget();
  }, 1000);
  
  // 5. さらに念のため、2秒後にも試行
  setTimeout(() => {
    console.log('[Claude Usage Widget] Extra retry after 2 seconds');
    tryInitWidget();
  }, 2000);

  // ページ変更を監視
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      console.log('[Claude Usage Widget] URL changed from', lastUrl, 'to', url);
      lastUrl = url;
      if (widget) {
        if (isUsagePage()) {
          console.log('[Claude Usage Widget] Moved to usage page, fetching data');
          fetchUsageData();
          // 自動更新を再開
          if (updateInterval) {
            clearInterval(updateInterval);
          }
          updateInterval = setInterval(fetchUsageData, 5 * 60 * 1000);
        } else {
          console.log('[Claude Usage Widget] Moved away from usage page, stopping auto-update');
          // 使用量ページ以外では自動更新を停止
          if (updateInterval) {
            clearInterval(updateInterval);
            updateInterval = null;
          }
          loadCachedData();
        }
      }
    }
  });
  
  observer.observe(document, { subtree: true, childList: true });
  console.log('[Claude Usage Widget] Page change observer set up');

  // ストレージ変更を監視（他のタブでデータが更新された時に反映）
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.usageData && widget) {
      console.log('[Claude Usage Widget] Usage data updated in storage');
      // ウィジェットが存在し、使用量ページにいない場合のみ更新
      // （使用量ページにいる場合は自動更新が動いているため）
      if (!isUsagePage()) {
        chrome.storage.local.get(['usageData', 'lastUpdate'], (result) => {
          if (result.usageData) {
            displayData(result.usageData, result.lastUpdate);
          }
        });
      }
    }
  });
  console.log('[Claude Usage Widget] Storage change listener set up');

})();
