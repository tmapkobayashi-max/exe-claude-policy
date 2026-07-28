// Claude.aiのページからデータを抽出
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    // Content scriptが読み込まれているか確認するためのpingに応答
    sendResponse({ pong: true });
    return true;
  }
  
  if (request.action === 'getUsageData') {
    try {
      const usageData = extractUsageData();
      sendResponse({ success: true, data: usageData });
    } catch (error) {
      console.error('Error extracting usage data:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true; // 非同期レスポンスを有効にする
  }
});

function extractUsageData() {
  const data = {
    currentSession: null,
    allModels: null,
    opusOnly: null
  };

  // ページからテキストを抽出して解析
  const pageText = document.body.innerText;
  
  // デバッグ用にページテキストの一部をログ出力
  console.log('Page text sample:', pageText.substring(0, 1000));
  
  // ページが完全に読み込まれているかチェック
  if (pageText.length < 100) {
    console.warn('Page text is too short, page may not be fully loaded');
    throw new Error('ページが完全に読み込まれていません。しばらく待ってから再試行してください。');
  }
  
  // より柔軟なパターンマッチング - "使用済み"の前後にあるパーセンテージを探す
  
  // Current sessionのパーセンテージを抽出
  const currentMatch = pageText.match(/Current\s+session[^]*?(\d+)%[\s\S]*?使用済み/i) || 
                       pageText.match(/Current\s+session[^]*?(\d+)%/i);
  if (currentMatch) {
    data.currentSession = {
      percentage: parseInt(currentMatch[1]),
      reset: extractResetTime('Current session', pageText)
    };
    console.log('Current session found:', data.currentSession);
  } else {
    console.log('Current session not found');
  }

  // All modelsのパーセンテージを抽出
  const allModelsMatch = pageText.match(/All\s+models[^]*?(\d+)%[\s\S]*?使用済み/i) || 
                         pageText.match(/All\s+models[^]*?(\d+)%/i);
  if (allModelsMatch) {
    data.allModels = {
      percentage: parseInt(allModelsMatch[1]),
      reset: extractResetTime('All models', pageText)
    };
    console.log('All models found:', data.allModels);
  } else {
    console.log('All models not found');
  }

  // Opus onlyのパーセンテージを抽出
  const opusMatch = pageText.match(/Opus\s+only[^]*?(\d+)%[\s\S]*?使用済み/i) || 
                    pageText.match(/Opus\s+only[^]*?(\d+)%/i);
  if (opusMatch) {
    data.opusOnly = {
      percentage: parseInt(opusMatch[1]),
      reset: extractResetTime('Opus only', pageText)
    };
    console.log('Opus only found:', data.opusOnly);
  } else {
    console.log('Opus only not found');
  }

  // データが取得できたかチェック
  if (!data.currentSession && !data.allModels && !data.opusOnly) {
    console.error('No usage data found in page text');
    console.error('Page text length:', pageText.length);
    console.error('Page URL:', window.location.href);
    throw new Error('使用量データが見つかりませんでした。使用量ページ(https://claude.ai/settings/usage)が完全に読み込まれていることを確認してください。');
  }

  console.log('Extracted data:', data);
  return data;
}

function extractResetTime(section, text) {
  // セクションごとのリセット時間を抽出
  const sectionIndex = text.toLowerCase().indexOf(section.toLowerCase());
  if (sectionIndex === -1) return '--';
  
  const afterSection = text.substring(sectionIndex, sectionIndex + 400);
  
  // "3時間53分後にリセット" のようなパターン
  const resetMatch1 = afterSection.match(/(\d+時間\d+分後)にリセット/);
  if (resetMatch1) return resetMatch1[1];
  
  // "時間後にリセット" のパターン
  const resetMatch2 = afterSection.match(/(\d+時間後)にリセット/);
  if (resetMatch2) return resetMatch2[1];
  
  // "分後にリセット" のパターン
  const resetMatch3 = afterSection.match(/(\d+分後)にリセット/);
  if (resetMatch3) return resetMatch3[1];
  
  // "12:59 (木)にリセット" のようなパターン
  const resetMatch4 = afterSection.match(/(\d+:\d+\s*\([^)]+\))にリセット/);
  if (resetMatch4) return resetMatch4[1];
  
  // "12:59 (木) にリセット" のようなパターン（スペースあり）
  const resetMatch5 = afterSection.match(/(\d+:\d+\s*\([^)]+\))\s*にリセット/);
  if (resetMatch5) return resetMatch5[1];
  
  // 英語版のパターン（念のため）
  const resetMatch6 = afterSection.match(/Resets?\s+in\s+([\d\s\w]+)/i);
  if (resetMatch6) return resetMatch6[1];
  
  return '--';
}
