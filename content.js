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
  const acct = extractAccount();
  data.account = acct.email;
  data.accountSource = acct.source;

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




// ---- どのアカウントの数字か（2026/9/4・メールを読むのをやめた版）----
// 数字だけだと、誰の数字かが見えない。アカウントを切り替えると黙って別人の数字が出る。
//
// 🔴 メールアドレスは読まない（2026/9/4 方針）。
//    ・そもそもメニューを開いている間しかDOMに無く、ほぼ取れない
//    ・取れなくても、メニューのボタンにある表示名（例：うつぼや（Max））で用は足りる
//    ・個人を特定できる情報を持たないほうが、扱いも申告も簡単
//    → 読むのは「表示名」だけ。取れなければ、設定画面の手入力を使う。
//
// 🚫 非公開API（/api/bootstrap 等）も呼ばない。ページにあるものを読むだけ。
// ⚠️ data-testid は予告なく変わりうる。変わったら null を返し、手入力が受け止める。

// アイコンフォントの字を落とす。
// Unicodeの私用領域にアイコンが割り当てられており、見た目が空でも文字数を持つ。
function cleanLabel(t) {
  return String(t || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
}

// メニューのボタンから「うつぼや（Max）」のような名前を組む
function accountFromMenuButton() {
  const btn = document.querySelector('[data-testid="user-menu-button"]');
  if (!btn) return null;

  // ⚠️ 「いちばん奥の span」だけを見る。入れ子の親を拾うと
  //    名前とプランがつながった1つの文字列として混ざる。
  const parts = Array.from(btn.querySelectorAll('span'))
    .filter(e => e.children.length === 0)
    .map(e => cleanLabel(e.textContent))
    // 文字か数字を1つでも含むものだけ残す。アイコンの字は私用領域なので
    // \p{L} にも \p{N} にも当たらない（U+FFFF より上でも効く）。
    .filter(t => t !== '\u00b7' && /[\p{L}\p{N}]/u.test(t) && t.length >= 2);

  const avatar = btn.querySelector('[data-cds="Avatar"]');
  let name = avatar ? cleanLabel(avatar.getAttribute('aria-label')) : '';
  if (!name) {
    name = parts.slice().sort((a, b) => b.length - a.length)[0] || '';
  }
  if (!name) return null;

  // プラン名（Max など）があれば添える。無ければ名前だけ＝空カッコを作らない。
  const plan = parts.find(t => t !== name && t.length <= 12);
  return plan ? name + '\uff08' + plan + '\uff09' : name;
}

// 戻り値は { email, source }。email には表示名が入る（メールアドレスは入れない）。
function extractAccount() {
  const name = accountFromMenuButton();
  if (name) return { email: name, source: 'name' };
  return { email: null, source: null };
}
