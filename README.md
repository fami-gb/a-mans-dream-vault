# VideoVault (video-app v2)

動画を **フォルダ** で整理し、**どの端末からでも** アップロード・再生できる自宅用動画ライブラリ。

- 大きなサムネイル＋ホバー / スワイプでのシーンプレビューで「どの動画か」がひと目で分かる
- 複数選択（Ctrl/⌘・Shift・ドラッグ範囲選択・スマホは長押し）→ ドラッグ＆ドロップ / 「移動」で一括振り分け
- 移動・ゴミ箱は **楽観的更新**（即座に反映、失敗時は自動で元に戻る）＋トーストの「元に戻す」
- アップロードは tus（再開可能）。電波が切れても続きから。PWA として Android の共有メニューからも送れる
- HEVC(.mov) / VP9 / mkv などは自動で H.264 MP4 に変換し、iPhone・Android・PC のどのブラウザでも再生できる
- 外出先からは Tailscale 経由で HTTPS アクセス

構成: Go 単一バイナリ（API・配信・変換キュー・フロント同梱）+ SQLite + ffmpeg。コンテナ 1 つ。

## 起動

```sh
cp .env.example .env      # DATA_DIR / LIBRARY_DIR を確認
docker compose up -d --build
docker compose exec videovault vv import   # LIBRARY_DIR の動画を「未分類」に登録（初回のみ・何度実行しても安全）
```

→ http://localhost:8080

取り込み後はバックグラウンドでサムネイル・プレビュー生成（必要なら変換）が進みます。
1000 本規模だと数十分かかります（サイドバー下部に「処理中 N件」表示）。CPU に余裕があれば `.env` の `WORKERS=2`。

`videos/` に後からファイルを直接置いた場合は、画面左下の「ライブラリを再スキャン」または `vv import`。

## 操作

| 操作 | PC | スマホ |
|---|---|---|
| 再生 | クリック | タップ |
| 選択 | Ctrl/⌘+クリック、チェック、空白からドラッグで範囲選択、Shift で範囲 | 長押し → 以降はタップで追加 |
| 全選択 / 解除 | Ctrl/⌘+A / Esc | 下部バーの「全選択」/ × |
| フォルダへ移動 | サイドバーやフォルダカードへドラッグ、または「移動」 | 「移動」→ フォルダを選ぶ（その場で新規作成も可） |
| ゴミ箱へ | Delete キー / サイドバーの「ゴミ箱」へドラッグ | 「ゴミ箱へ」 |
| シーンプレビュー | サムネイル上でマウスを左右に | サムネイルを横になぞる |
| アップロード | ボタン or 画面にファイルをドロップ（開いているフォルダに入る） | 右下のアップロードボタン |
| プレーヤー | ←/→ 前後の動画、Space、J/L ±10秒、F 全画面、M ミュート | 左右スワイプで前後の動画 |

ゴミ箱の動画は 30 日後（`TRASH_DAYS`）に自動で完全削除されます。完全削除すると **元ファイルもディスクから消えます**。
フォルダを削除しても動画は消えず、1 つ上の階層へ移動します。

## 外出先から使う（Tailscale）

1. ホスト PC と各端末（iPhone / Android / 外出用 PC）に [Tailscale](https://tailscale.com/download) を入れ、同じアカウントでログイン
2. 管理画面で MagicDNS と HTTPS Certificates を有効化
3. ホストで:
   ```sh
   tailscale serve --bg 8080
   ```
4. 各端末から `https://<ホスト名>.<tailnet名>.ts.net` を開く
   - iPhone: 共有 → ホーム画面に追加 / Android: メニュー → アプリをインストール（共有メニューから動画を直接送れるようになる）

tailnet に参加した自分の端末しか入れないので、通常はパスワード不要です。念のため掛けたい場合は `.env` に `APP_PASSWORD=...`。

## 別マシン（Linux）への移行

状態はすべて `DATA_DIR`（DB・アップロード分・サムネ）と `LIBRARY_DIR`（既存動画）の 2 か所だけにあり、
DB にはホストの絶対パスを持たせていません。

```sh
# 旧ホスト
docker compose down
rsync -a data/app.db data/uploads  newhost:/srv/videovault/data/
rsync -a ../videos/                newhost:/srv/videovault/library/

# 新ホスト（v2 ディレクトリをコピーして）
#   .env: DATA_DIR=/srv/videovault/data  LIBRARY_DIR=/srv/videovault/library
#         PUID/PGID = `id -u` / `id -g`（ファイル所有者に合わせる）
docker compose up -d --build
docker compose exec videovault vv import   # 移動・改名されたファイルを内容で照合して再リンク（フォルダ分けは維持）
docker compose exec videovault vv verify   # 足りないサムネ・変換ファイルを作り直す
```

- `thumbs/` `sprites/` `playable/` はコピー不要（`verify` で再生成）。コピーすれば再生成の時間を省けます
- `import` / `verify` は何度実行しても同じ結果になります（重複登録しない・行を消さない）
- ライブラリ側でファイルを移動・改名しても、`import` がサイズ＋先頭/末尾のハッシュで同じ動画と判断して付け替えます
- 新ホストでも `tailscale serve --bg 8080` を実行（マシン名を同じにすれば URL も同じ）

## 開発

```sh
# サーバー（Go 1.26、ffmpeg が PATH に必要）
cd server && DATA_DIR=../data LIBRARY_DIR=../../videos go run .
# フロント（Vite が /api と /media を :8080 へプロキシ）
cd web && npm install && npm run dev
# テスト
cd server && go test ./...
```

| パス | 役割 |
|---|---|
| `server/internal/store` | SQLite スキーマとクエリ（フォルダ・動画・処理キュー） |
| `server/internal/library` | 冪等な import / verify、完全削除 |
| `server/internal/media` | ffprobe / 変換 / サムネ / プレビュースプライト |
| `server/internal/jobs` | 永続処理キュー、ゴミ箱の自動削除 |
| `server/internal/api` | REST API、tus アップロード、SSE、Range 配信、SPA |
| `web/src/lib/queries.ts` | TanStack Query と楽観的更新（移動・ゴミ箱・フォルダ操作） |
| `web/src/pages/LibraryPage.tsx` | 一覧・選択・D&D・範囲選択 |
| `web/src/pages/WatchPage.tsx` | プレーヤー |
