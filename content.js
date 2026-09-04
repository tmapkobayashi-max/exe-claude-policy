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



// ---- どのアカウントの数字か（2026/9/4・実物のDOMを見て作り直し）----
// 🔴 なぜ最初「アカウント不明」だったか：
//    メールアドレスは、アカウントメニューを**開いたときだけ**DOMに現れる
//    （[data-testid="user-menu-header"]）。閉じている間はページのどこにも無い。
//    → 本文をいくら探しても見つからないのは当たり前だった。
// ⭐ 代わりに、いつでも出ているものがある＝メニューの**ボタン**。
//    アバターに aria-label="うつぼや"、その隣に「うつぼや · Max」。
//    「誰の数字か」を知るには、メールアドレスより、こちらのほうが素直で確実。
// ⚠️ data-testid は予告なく変わりうる。変わったら下の順番で自然に次へ落ち、
//    最後は設定画面の手入力（accountManual）が受け止める。黙って壊れない。
// ⚠️ トップレベルに const を置かない。拡張を再読み込みすると既存タブへ再注入されることがあり、
//    そのとき「already been declared」で注入ごと失敗して、コンテンツスクリプトが動かなくなる。
function pickEmail(text) {
  if (!text) return null;
  const ACCOUNT_IGNORE = /^(support|noreply|no-reply|help|info|privacy|security|legal|press|sales|example|test)@/i;
  const ACCOUNT_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const found = String(text).match(ACCOUNT_RE);
  if (!found) return null;
  for (const m of found) {
    if (ACCOUNT_IGNORE.test(m)) continue;
    if (/@(anthropic|sentry|google|gstatic|w3\.org)\./i.test(m)) continue;
    if (/\.(png|jpg|svg|css|js)$/i.test(m)) continue;
    return m;
  }
  return null;
}

// アイコンフォントの字を落とす。
// Unicodeの私用領域（U+E000〜U+F8FF）にアイコンが割り当てられており、
// 見た目は空でも文字としては1文字あるため、素通りさせると空カッコになる。
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
    // 「文字か数字を1つでも含む」ものだけ残す。
    // アイコンフォントの字は私用領域なので \p{L} にも \p{N} にも当たらない。
    // ⚠️ length で弾くだけでは足りない（U+FFFF より上のアイコンは length 2 になる）。
    .filter(t => t !== '·' && /[\p{L}\p{N}]/u.test(t) && t.length >= 2);

  const avatar = btn.querySelector('[data-cds="Avatar"]');
  let name = avatar ? cleanLabel(avatar.getAttribute('aria-label')) : '';
  if (!name) {
    name = parts.slice().sort((a, b) => b.length - a.length)[0] || '';
  }
  if (!name) return null;

  // プラン名（Max など）があれば添える。無ければ名前だけ返す＝空カッコを作らない。
  const plan = parts.find(t => t !== name && t.length <= 12);
  return plan ? name + '（' + plan + '）' : name;
}

// 戻り値は { email, source }。source は診断用（設定画面に出す）。
function extractAccount() {
  // ❶ メニューが開いていれば、メールアドレスがそのまま取れる
  const header = document.querySelector('[data-testid="user-menu-header"]');
  if (header) {
    const hit = pickEmail(header.textContent);
    if (hit) return { email: hit, source: 'menu' };
  }

  // ❷ メニューのボタン（閉じていても常にある）
  const name = accountFromMenuButton();
  if (name) return { email: name, source: 'name' };

  // ❸ 見えている本文
  let hit = pickEmail(document.body.innerText);
  if (hit) return { email: hit, source: 'text' };

  // ❹ 属性（title / aria-label など）
  for (const el of document.querySelectorAll('[title],[aria-label],[alt],[data-email]')) {
    hit = pickEmail(
      (el.getAttribute('title') || '') + ' ' +
      (el.getAttribute('aria-label') || '') + ' ' +
      (el.getAttribute('alt') || '') + ' ' +
      (el.getAttribute('data-email') || '')
    );
    if (hit) return { email: hit, source: 'attr' };
  }

  // ❺ ページに埋め込まれたHTML／JSON
  try {
    const html = document.documentElement.innerHTML;
    hit = pickEmail(html.length > 3000000 ? html.slice(0, 3000000) : html);
    if (hit) return { email: hit, source: 'html' };
  } catch (e) { /* 読めなければ諦める */ }

  return { email: null, source: null };
}
