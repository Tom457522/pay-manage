# ふたり精算

夫婦間の立替を記録して精算する Web アプリ。レシートを撮影すると品目ごとの「仕分けカード」が作られ、夫／共有／妻を選ぶだけで負担額を計算します。

## ファイル

| ファイル | 内容 |
|---|---|
| `index.html` / `style.css` | 画面 |
| `app.js` | 記録・計算・レシート読み取り・画面処理 |
| `sync.js` | Firebase (Firestore) による2台間の自動同期 |
| `firebase-config.js` | Firebase の接続設定（自分で貼り付ける） |
| `firestore.rules` | Firestore のセキュリティルール |

## Firebase 同期のセットアップ（無料の Spark プランで足ります）

1. [Firebase コンソール](https://console.firebase.google.com/) で「プロジェクトを作成」（Google アナリティクスはオフで可）。
2. **Authentication** →「始める」→「ログイン方法」で **匿名** を有効にする。
3. **Firestore Database** →「データベースを作成」→ 本番環境モード、ロケーションは `asia-northeast1`（東京）など。
4. Firestore の **ルール** タブに `firestore.rules` の内容を貼り付けて「公開」。
5. **プロジェクトの設定** →「マイアプリ」→ ウェブ（`</>`）アイコンでアプリを登録し、表示された `firebaseConfig` を `firebase-config.js` に貼り付ける。
6. アプリを https で公開する（GitHub Pages、Netlify、Firebase Hosting など。フォルダの中身をそのまま置くだけ）。

## 2人で使い始める

1. 1人目：設定 →「共有を始める」→「招待リンクをコピー」して LINE などで送る。
2. 2人目：リンクを開き「参加しますか？」で OK（またはコードを設定画面で入力）。
3. 以降は記録・削除・清算・名前と割合の変更が自動で両方の端末に反映されます。圏外で記録しても、つながった時に送信されます。

参加前にそれぞれの端末にあった記録も、最初の同期で統合されます。

## セキュリティについて

- 共有コード（24文字のランダム文字列）を知っている端末だけが読み書きできます。コードは他人に教えないでください。招待リンクの `#` 以降はサーバーに送信されません。
- Anthropic の API キーは同期されず、各端末のブラウザ内にだけ保存されます。

## GitHub Pages で公開する

ビルド不要の静的サイトなので、リポジトリのルートをそのまま公開できます。

1. GitHub で新しいリポジトリを作成（例: `pay-manage`）。無料プランの Pages は **Public** リポジトリが必要です。
2. このフォルダから push：
   ```bash
   git remote add origin https://github.com/<ユーザー名>/pay-manage.git
   git push -u origin main
   ```
3. リポジトリの **Settings → Pages** で「Source: Deploy from a branch」「Branch: `main` / `(root)`」を選んで Save。
4. 1〜2分後に `https://<ユーザー名>.github.io/pay-manage/` で開けます。スマホではブラウザの「ホーム画面に追加」でアプリのように使えます。

以降は変更を `git push` するだけで自動的に更新されます。

- `firebase-config.js` の値は公開されても問題ありません（アクセス制御は Firestore ルールで行います）。
- Anthropic の API キーはリポジトリに含めず、アプリの設定画面で各端末に入力してください。

## ローカルで試す

```bash
python -m http.server 5173
```

`http://localhost:5173` を開く。
