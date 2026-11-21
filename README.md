# Antigravity Chat UI

Google の公式 CLI（[`agy`](https://antigravity.google)）を **無改変のまま** ACP (`@agentclientprotocol/sdk`) でラップし、PC・iPhone ブラウザ / PWA から快適かつ安全に利用できる ChatGPT ライクなセルフホスト型 AI チャットワークスペースです。

## 主な特徴

- **公式バイナリ＆プロトコル完全準拠**
  - 無改変の `agy acp` を stdio (`@agentclientprotocol/sdk` v1/stable) で実行。
  - トークンファイルの直接読取・復号・外部内部 API の直叩きは一切行いません。
- **Webログイン ⇔ サーバー上 `agy` アカウントの 1:1 紐付け ＆ 作業フォルダ専用サンドボックス**
  - Web 側はサーバー管理の軽量認証（`scrypt` + `HttpOnly` セッション Cookie + CSRF 検証）。
  - ログインした Web ユーザーごとに完全に分離された専用プロファイル（`DATA_ROOT/profiles/<userId>/agy-home`）を持ち、初回チャット前に **認証コード貼り付け**（`agy acp --login` の PTY 出力から Google OAuth URL を発行し、ブラウザ認証後にコードを貼り付ける方式）または任意の `GEMINI_API_KEY` で公式認証を完了します。
  - Linux (`Ubuntu`) ではデフォルト `SANDBOX_MODE=auto` で `bubblewrap` (`bwrap`) のホワイトリスト rootfs コンテナが自動有効化され、内部 `agy` およびシェルコマンドからは対象チャットの作業フォルダ (`/workspace`) と最小システムライブラリ以外（`/home`・`/root`・`/etc/antigravity-chat`・SQLite DB・他ユーザー領域・ホスト PID）をカーネル名前空間レベルで隠蔽します（設定モーダルで状態確認可能）。
- **ChatGPT ライクな集中 UI ＆ モバイル/PWA 対応**
  - 標準ニュートラル配色ベースの Vanilla CSS（ライト / ダーク / システム追従テーマ）、レスポンシブ設計（iPhone Safari「ホーム画面に追加」PWA 対応・ノッチ領域対応）。
  - 入力欄ツールバーにカプセル型 **モデル選択ポップオーバー（モバイルではボトムシート）** と、ACP `configOptions` に連動し選択値・ドラッグに追従して針が回転する **Effort（推論レベル）スライダーバー** を配置（新規チャット送信前から切替可能）。
  - 「新しいチャット」を押しただけでは空チャットを履歴に増やさず、最初のメッセージ送信／応答が確定してからサイドバーへ永続表示します。
  - コンパクト化された利用枠（Quota）モニター（公式 `agy -p /usage` の 4列 TSV / JSON 出力をモデル系統別のグループ見出し＋見やすい残量バーとして可視化し、5分クールダウン付きの低頻度自動更新＋手動更新に対応）。
  - **応答完了通知（Web Push + ブラウザ通知）**: 設定モーダルのスライド式トグルスイッチからオン/オフでき、PC ブラウザのバックグラウンドタブや iPhone ホーム画面追加 PWA のロック画面でも応答完了通知を受け取れます（純粋 Node 24 暗号化実装・VAPID 鍵は SQLite 永続化・テスト通知ボタン付き）。
- **アップデート検知 ＆ 高速デプロイ（GitHub Actions 事前ビルド ＆ SemVer 自動リリース）**
  - **GitHub Actions**（[`.github/workflows/ci-deploy.yml`](.github/workflows/ci-deploy.yml) / [`scripts/version.mjs`](scripts/version.mjs) / [`scripts/fetch-anthropic-skills.mjs`](scripts/fetch-anthropic-skills.mjs)）が Conventional Commits（`feat:` で minor、`BREAKING CHANGE` / `!:` で major、それ以外で patch）に基づき SemVer タグ（`vX.Y.Z`）を自動採番し、`typecheck`・`npm test`・`npm run build` を実行。あわせて Anthropic 公式リポジトリ（[`anthropics/skills`](https://github.com/anthropics/skills)）から最新のドキュメント系スキル（`docx` / `pptx` / `xlsx` / `pdf`）をビルド時に動的取得してバンドルへ同梱し、全ユーザープロファイルへ自動適用（無効化・編集・削除済みプロファイル状態は保持）します。純粋 JS サーバー実行依存のみ（ネイティブバイナリ無し・ARM64/x64 共通）のバンドル `antigravity-chat-bundle.tar.gz` を作成し、リリースノート付きのバージョン別 GitHub Release（例: `v1.1.0`）として公開します。
  - **隔離されたドキュメント実行環境（`/opt/agy-doc-runtime`）**: サーバー上のホスト Python/Node やユーザー領域を汚さずに、[`deploy/setup-doc-runtime.sh`](deploy/setup-doc-runtime.sh) が専用の Python venv（`openpyxl`, `pandas`, `markitdown`, `python-pptx`, `python-docx`, `pypdf`, `pdfplumber`, `reportlab`, `pypdfium2`, `Pillow`, `lxml`, `defusedxml`, `matplotlib` 等）・Node.js ライブラリ（`docx`, `pptxgenjs`, `pdf-lib`, `react`, `react-dom`, `react-icons`, `sharp`）・LibreOffice・Poppler・Pandoc・QPDF・Tesseract・日本語/互換フォントを構築し、`bwrap` サンドボックス内の全プロファイルへ読み取り専用（`/opt/agy-doc-runtime` + `PATH` / `NODE_PATH` / `PYTHONPATH` / `/etc/fonts`）で公開します。
  - **デプロイ方式（どちらも可）**:
    1. **Tailscale 経由の即時プッシュデプロイ（最速）**: GitHub Secrets / Variables に Tailscale OAuth と SSH 情報を設定すると、`main` への push 完了直後に GitHub Actions から Tailscale 越しに自動デプロイ・再起動します。
    2. **サーバー側自動更新タイマー（ポーリング）**: `deploy/antigravity-chat-updater.timer` が 3 分ごとに最新の SemVer バージョンタグ（`vX.Y.Z`）の GitHub Release を確認し、ビルド済みバンドルを数秒で展開して再起動します（公開リポジトリはトークン不要。`/etc/antigravity-chat/env` に `RELEASE_TAG=vX.Y.Z` を指定すれば特定バージョン固定・ロールバックも可能。非公開リポジトリの場合のみ `GITHUB_READ_TOKEN` を設定、未設定時は `git pull --ff-only` + ローカルビルドにフォールバック）。あわせて、システム上の公式 `agy` CLI も単一パス `/usr/local/bin/agy` に統一（システム / root 配下の重複バイナリがある場合は統合・シンボリックリンク化）したうえで 15 分間隔（`AGY_UPDATE_INTERVAL_SEC=900`）で `agy update` により自動更新し、更新時はサービスを再起動して新しい `agy` を反映します（無効化は `AGY_AUTO_UPDATE=false`）。
  - **クライアント / PWA**: `buildId`・バージョン不一致（`/api/health`・`/api/auth/bootstrap`・WebSocket `hello`・`BUILD_INFO.json` ハッシュ連動）および Service Worker キャッシュ更新（ビルドごとに `sw.js` へバージョンを刻印）を検知すると、入力中・応答生成中・認証入力中でないタイミングで自動リロードします（作業中は通知バナー表示、設定モーダルで現在のバージョン・SHA を確認可能）。
- **プロジェクト（共有カスタム指示 ＆ 資料）**
  - プロジェクト配下のチャット作成時に資料を `.project-context/` へ Copy-on-Write で複製するため、チャット内の編集で原紙や別チャットが汚染されません。
  - プロジェクト更新時は既存チャットに「最新化」バナーを表示し、ユーザー操作で明示的に同期できます。
- **リッチな Markdown ＆ 多形式アーティファクトビューア**
  - コピー・折返し・保存付きコードブロック（Highlight.js）、KaTeX 数式、Mermaid 図（失敗時ソースフォールバック）、CSV/Markdown コピー可能なテーブル、引用ブロックコピー、ワークスペース内ファイルリンク解決。
  - Text / Code / Unified Diff / PDF (`pdfjs-dist` Canvas 描画で iPhone 対応) / Excel (`.xlsx`)・CSV・TSV テーブル / Word (`.docx` 注意バナー付き) / PowerPoint (`.pptx` LibreOffice 変換 + DL) / DOMPurify 済み SVG / 厳格 CSP `sandbox="allow-scripts"` HTML プレビュー / HTTP Range 対応音声・動画再生。
- **クロスデバイス・リアルタイム同期**
  - バックエンド主導のタスク実行・公平スケジューラ + SQLite (`node:sqlite` WAL) + 単調増分 `sinceSeq` 付き WebSocket リプレイにより、PC で送信した応答の途中から iPhone で参加したり、ツール承認カードをどちらの端末からでも競合安全（二重承認時 HTTP `409`）に操作できます。

## Oracle Cloud Always Free (Ubuntu) 推奨構成

- **最推奨**: **`VM.Standard.A1.Flex` (Ampere ARM64, 最大 2 OCPU / 12 GB RAM — 月 1,500 OCPU時間・9,000 GB時間)** — 1台の **2 OCPU / 12 GB VM** に集約する構成が最適です。12 GB RAM は Node 24 サーバー・複数 `agy acp` ワーカー・`pdftoppm` に対して十分余裕がありますが、ローカルツール実行時は **2 コアの CPU がボトルネック** になりやすいため、ビルド作業を GitHub Actions 側に逃がしつつデフォルトを **`MAX_CONCURRENT_ACP=2`、`MAX_ACP_PER_USER=2`、`IDLE_WORKER_MS=600000`（10分）** に最適化し、2GB 以上のホストでは `INSTALL_DOC_RUNTIME=auto` / `INSTALL_LIBREOFFICE=auto` により隔離ドキュメントランタイム（`/opt/agy-doc-runtime`）と LibreOffice 変換環境も自動整備します（無効化する場合は `/etc/antigravity-chat/env` に `INSTALL_DOC_RUNTIME=0` または `INSTALL_LIBREOFFICE=0` を指定）。
- **軽量単体向け**: **`VM.Standard.E2.1.Micro` (1/8 OCPU, 1 GB RAM)** — Actions 事前ビルドバンドル運用なら VM 上で `npm ci` / `vite build` を行わないため 1GB RAM でも更新負荷を抑えられます（2GB 未満のホストでは `INSTALL_DOC_RUNTIME=auto` は自動スキップされます。実行時は `MAX_CONCURRENT_ACP=1`、`MAX_ACP_PER_USER=1`、`IDLE_WORKER_MS=180000` 推奨）。
- 詳しい運用ノート（Tailscale Serve による HTTPS 公開と Ubuntu `iptables` 回避、7日間アイドル回収ルール、コンシューマ版 `oauth-personal` 利用規約上の注意）は [docs/architecture.md](docs/architecture.md) を参照してください。

## セットアップ ＆ ビルド

必要環境: **Node.js >= 24.0.0**, **Python 3**（PTY ログインブリッジ用・追加 pip パッケージ不要）, 公式 **`agy` CLI**（ローカル動作テスト時は `AGY_MODE=mock` 利用可）

```bash
# 1. 依存インストール（ネイティブ C++ ビルド不要）
npm install

# 2. 型チェック・自動テスト・本番ビルド
npm run typecheck
npm test
npm run build
```

### Ubuntu サーバー（Oracle Always Free）への導入手順

```bash
# 1. OS パッケージ・Node 24・サービスユーザー・/etc/antigravity-chat/env (SESSION_SECRET) を作成
sudo bash deploy/ubuntu-setup.sh

# 2. systemd ユニット配置・起動
sudo cp deploy/antigravity-chat.service /etc/systemd/system/
sudo cp deploy/antigravity-chat-updater.service /etc/systemd/system/
sudo cp deploy/antigravity-chat-updater.timer /etc/systemd/system/
sudo chmod +x /opt/antigravity-chat/deploy/*.sh
sudo systemctl daemon-reload
sudo systemctl enable --now antigravity-chat

# 3. Tailscale で安全に HTTPS 公開（Oracle iptables やセキュリティリストのポート開放不要）
sudo tailscale serve --bg http://127.0.0.1:3000
```

ChatUI が起動するすべての `agy acp` プロセスに `--disable-telemetry` を渡します。既存サーバーにも通常のアプリ更新で反映され、systemd ユニットや環境ファイルの変更は不要です。[Antigravity ACP のフラグ](https://antigravity.google/docs/ide/extensions/acp#flags)

#### GitHub Actions 高速デプロイの設定方法（2パターン）

- **パターン1: Actions から Tailscale 経由で即時プッシュデプロイ（最速・VM側ポーリング不要）**
  - GitHub リポジトリ Settings → **Secrets and variables → Actions**:
    - Variable: `ENABLE_TAILSCALE_DEPLOY` = `true`
    - Variable: `DEPLOY_USER` = `ubuntu`（VMの sudo 可能ユーザー名）
    - Variable (任意): `TS_CI_TAGS` = `tag:ci`（Tailscale ACL で許可したタグ）
    - Secrets: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`（Tailscale OAuth Client）, `DEPLOY_HOST`（VMの Tailscale IP 例 `100.x.y.z`）, `DEPLOY_SSH_KEY`（秘密鍵・Tailscale SSH 使用時は空でも可）
- **パターン2: サーバー側タイマーで Actions ビルド済み Release を自動取得（Tailscale ACL 設定不要）**
  - タイマーを有効化します（公開リポジトリならこれだけで事前ビルド済み Release を自動適用します）:
    ```bash
    sudo systemctl enable --now antigravity-chat-updater.timer
    ```
  - 非公開（Private）リポジトリの場合は、GitHub の Fine-grained PAT（対象リポジトリ `Contents: Read` のみ）も `/etc/antigravity-chat/env` に追記してください:
    ```bash
    echo 'GITHUB_READ_TOKEN=github_pat_xxxx' | sudo tee -a /etc/antigravity-chat/env >/dev/null
    ```

## 開発サーバー（モックモード / 実機モード）

```bash
# オフライン・UI動作確認用モックモード（実 agy CLI 不要）
AGY_MODE=mock npm run dev
# 別ターミナルで Vite フロントエンド起動（http://127.0.0.1:5173）
npm run dev:web
```

本番ビルド後は `NODE_ENV=production node server/dist/index.js`（または `npm start`）1プロセスのみで API・WebSocket・ビルド済み SPA フロントエンドを配信できます。

## Antigravity の Auto モードとツール承認

ツールの承認は Antigravity のネイティブ設定に従います。Antigravity が ACP で承認を求めたときは、ChatUI の承認カードで許可または拒否を選べます。

新規プロファイルには `"agentMode": "auto"` を設定した `settings.json` を作成します。既存プロファイルにファイルがなければ、サーバー起動時に同じ初期設定を作成します。「設定」の「Antigravity エージェントモード」で選んだ値は、そのプロファイルの `settings.json` の `agentMode` に保存されます。新しい ACP セッションの作成時に、Antigravity がそのモードを選択肢として返した場合、ChatUI は保存値を公式 ACP API に渡します。標準構成での保存先は `$DATA_ROOT/profiles/<user-id>/agy-home/.gemini/antigravity-cli/settings.json` です。

`agentMode` がファイルにない場合は「CLI の既定モード」と表示します。この場合、Antigravity が実行モードを決めます。利用枠の取得に使う `agy -p /usage` は設定ファイルの一時コピーを使用します。[CLI の設定仕様](https://antigravity.google/docs/cli-settings)

ChatUI の `SANDBOX_MODE` はサーバー側の bubblewrap 分離を制御します。Antigravity の Auto はネイティブのターミナルサンドボックスと承認判断を制御します。[Antigravity CLI の実行モード](https://antigravity.google/docs/cli/modes/) · [ACP 連携ガイド](https://antigravity.google/docs/cli/acp/)

## ディレクトリ構成

- `.github/workflows/`: CI テスト・ビルド・Release バンドル生成・Tailscale プッシュデプロイ定義
- `server/`: Fastify + WebSocket + `node:sqlite` バックエンド、ACP マネージャ、公平スケジューラ、ワークスペース分離、認証・PTY ログインブリッジ
- `web/`: React + TypeScript + Vanilla CSS フロントエンド（Vite + PWA）
- `deploy/`: Oracle Always Free Ubuntu 向けセットアップスクリプト・バンドル展開スクリプト・自動更新スクリプト ＆ systemd ユニット
- `docs/`: アーキテクチャ設計 ＆ 運用・コンプライアンス詳細 ([docs/architecture.md](docs/architecture.md))