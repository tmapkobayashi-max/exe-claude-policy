# Claude使用量チェッカー（Chatwork通知版）セットアップ

[ueponx/claude-usage-extension](https://github.com/ueponx/claude-usage-extension)（MIT License）をベースに、
Chatwork通知機能を追加した個人用Chrome拡張機能です。

## できること
- claude.aiの使用量（Current session / All models / Opus only）がしきい値を超えたら、Chatworkへ通知
- 平日の朝・夕方に、その時点の使用量をChatworkへレポート（土日・日本の祝日はスキップ）

## インストール手順
1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をONにする
3. 「パッケージ化されていない拡張機能を読み込む」を押す
4. このフォルダ（`claude-usage-chatwork`）を選択する

## 初期設定
1. 拡張機能一覧の「Claude使用量チェッカー（Chatwork通知版）」の「詳細」→「拡張機能のオプション」を開く
   （または `chrome://extensions` の拡張機能アイコン上で右クリック→オプション）
2. **Chatwork接続設定**
   - APIトークン：Chatworkの「サービス連携」→「API Token」で発行したトークンを入力
   - ルームID：通知したいルームのURL末尾の数字（例：`https://www.chatwork.com/#!rid401617013` なら `401617013`）
   - 「テスト送信」を押して、実際にChatworkへメッセージが届くか確認する
3. **しきい値通知**：有効化し、しきい値（%）と監視項目を選ぶ
4. **定時レポート**：有効化し、朝・夕方の時刻を設定する（祝日除外は内閣府の公表データを自動取得・週1回更新）
5. 「保存する」を押す

## 動作の仕組み・注意点
- claude.aiの使用量ページ（`https://claude.ai/settings/usage`）のDOMを読み取って数値化しています。
  claude.ai側の表示が変わると、正しく取れなくなる可能性があります（非公式・壊れることがある前提の仕組みです）。
- 定時レポート・しきい値チェックは、**PCがログオンしていてChromeが起動している時間帯のみ**動作します
  （このPCの勤務時間＝平日9時前〜17時に合わせて使う想定）。
- 5分ごとの自動更新は、claude.aiのタブが開いているときだけ動きます。定時レポートはタブが無くても
  バックグラウンドで一時的にタブを開いて取得します。
- Chatwork APIトークンは、この拡張機能の`chrome.storage.local`（このPC・このChromeプロファイル内）にのみ
  保存されます。外部には送信されません（Chatwork API以外への通信はありません）。

## 元のリポジトリとの差分
- `manifest.json`：`host_permissions`に`api.chatwork.com`・`www8.cao.go.jp`を追加、`options_page`を追加
- `chatwork-notify.js`（新規）：Chatwork通知・祝日判定・定時レポートのロジック
- `options.html` / `options.js` / `options.css`（新規）：設定画面
- `background.js`：`chatwork-notify.js`の読み込みと、既存の処理へのフック（しきい値チェック呼び出し・
  定時アラームの登録/処理）を追加。既存のロジック（DOM取得・ウィジェット制御）は変更していません。
- `content.js` / `floating-widget.js` / `floating-widget.css`：無変更（元のまま）
