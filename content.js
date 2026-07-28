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

// 行単位でパース：「ラベル行」→「◯◯にリセット行」→「N% 使用済み行」の3行1組を1指標として拾う。
// 日本語UI・英語UIどちらにも対応し、3つ目（モデル別週次制限）はラベル名を固定せず動的に検出する
// （現在は「Fable」だが、提供モデルが変われば名前も変わるため）。
function extractUsageData() {
  const pageText = document.body.innerText;

  console.log('Page text sample:', pageText.substring(0, 1000));

  if (pageText.length < 100) {
    console.warn('Page text is too short, page may not be fully loaded');
    throw new Error('ページが完全に読み込まれていません。しばらく待ってから再試行してください。');
  }

  const data = parseUsageBlocks(pageText);

  if (!data.currentSession && !data.allModels && !data.modelSpecific) {
    console.error('No usage data found in page text');
    console.error('Page text length:', pageText.length);
    console.error('Page URL:', window.location.href);
    throw new Error('使用量データが見つかりませんでした。使用量ページ(https://claude.ai/settings/usage)が完全に読み込まれていることを確認してください。');
  }

  console.log('Extracted data:', data);
  return data;
}

function parseUsageBlocks(pageText) {
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
      // 週間制限のうち「すべてのモデル」とは別枠で個別表示されているモデル（例：Fable、Opus等）
      data.modelSpecific = { ...entry, name: label };
    }
    i += 2; // このブロック分は読み飛ばす
  }

  return data;
}
