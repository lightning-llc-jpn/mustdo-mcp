# mustdo-mcp

[English (README.md)](./README.md)

**[MustDo](https://ltng.jp/mustdo/)（やるまで鳴る TODO アラーム、iOS）の MCP サーバー。**

Claude（Claude Code・Claude Desktop・claude.ai・iPhone の Claude アプリ）など
[Model Context Protocol](https://modelcontextprotocol.io/) 対応クライアントから、MustDo の TODO を読み書きできます。

- **データは利用者自身の iCloud にあります。** MustDo は TODO 用のデータベースを自前で持ちません。TODO は Apple ID の CloudKit
  *private* database（container `iCloud.jp.lightning.mustdo`、zone `MustDo`）にあり、このサーバーは Apple の
  [CloudKit Web Services](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/)
  で iPhone アプリと同じレコードを読み書きします。
- **開発元のサーバーに TODO は置きません。** このリポジトリのローカルサーバーも、下記の中継も、TODO の内容を
  Lightning LLC のサーバーに保存しません。
- 書き込むと CloudKit がアプリにサイレントプッシュを送るので、iPhone 側はすぐ更新されます。

## 使い方は 2 通り

| | A. 中継を使う（おすすめ） | B. このリポジトリをローカルで動かす（開発者向け） |
|---|---|---|
| 使える場所 | claude.ai、iPhone の Claude アプリ、リモート MCP＋OAuth 対応クライアント | Mac の Claude Code / Claude Desktop（stdio） |
| 準備 | カスタムコネクタを追加して Apple ID でサインイン | Node 24、ビルド、設定、サインイン。**一般には配布していない** CloudKit API Token が必要（下記） |
| Lightning LLC が預かるもの | **CloudKit のサインイン用トークンだけ**（AWS KMS で暗号化。下記） | 何も預かりません |

### A. 中継 — `https://ltng.jp/api/mustdo/mcp`

1. claude.ai → **設定 → コネクタ → カスタムコネクタを追加** → URL `https://ltng.jp/api/mustdo/mcp`（名前は「MustDo」）
2. **接続** → ltng.jp の同意画面（何を預かるかの説明）→ Apple のサインイン画面で **MustDo アプリと同じ Apple ID** でサインイン
3. 完了。iPhone の Claude アプリでも同じコネクタが使えます

**中継が預かるもの（正直に）:**

- サインイン時に Apple が発行する CloudKit のサインイン用トークン（`ckWebAuthToken`）を、**AWS KMS で暗号化**して
  （AWS 東京リージョン）保管します。リクエストごとに復号して、利用者に代わって CloudKit を呼ぶために必要です。
- コネクタ自体の OAuth アクセス／リフレッシュトークンのハッシュも保管します。
- TODO の内容・Apple ID のメールアドレス・パスワード・iCloud のユーザー ID 生値は、保存もログもしません。
- **接続解除:** claude.ai でコネクタを削除し、**さらに** <https://ltng.jp/api/mustdo/disconnect> を開いてください。
  Apple ID で本人確認すると保管トークンは即時削除されます。Apple 側でサインインが失効したときも自動で削除されます
  （ツールは `RECONNECT_REQUIRED` を返すので、接続し直してください）。

詳しい説明: <https://ltng.jp/mustdo/mcp>

### B. ローカルで動かす（stdio）

必要なもの:

- macOS と **Node.js 24 以上**
- MustDo アプリを一度起動して iCloud に同期していること（zone と `Account` レコードはアプリが作ります）
- MustDo の container 用の **CloudKit API Token**。**現在、一般には配布していません** — 下の「CloudKit API Token について」を参照。無い場合は中継（A）をお使いください

```bash
git clone https://github.com/lightning-llc-jpn/mustdo-mcp mustdo-mcp
cd mustdo-mcp
npm install
npm run build        # -> dist/index.js
npm test             # vitest（CloudKit はモック）
```

Claude Code に登録:

```bash
claude mcp add mustdo \
  -e MUSTDO_CK_API_TOKEN=<MUSTDO_CK_API_TOKEN> \
  -e MUSTDO_CK_ENV=production \
  -- node /path/to/mustdo-mcp/dist/index.js
```

または `~/.mustdo/config.json` に書いて `-e` なしで登録:

```json
{
  "apiToken": "<MUSTDO_CK_API_TOKEN>",
  "environment": "production"
}
```

あとは Claude に `sign_in` ツールを一度実行してもらいます。サーバーが Apple のサインイン画面をブラウザで開き、
`http://localhost:51234/callback` で待ち受け、戻ってきたトークンを `~/.mustdo/auth.json`（権限 `0600`）に保存します。

#### CloudKit API Token について

CloudKit Web Services はリクエストごとに 2 つのトークンを使います。

| トークン | 何か | 誰が持つか |
|---|---|---|
| `ckAPIToken` | **container**（`iCloud.jp.lightning.mustdo`）を識別するトークン。CloudKit Dashboard で container の所有チームが発行します。Apple は「Web サイトや埋め込み Web ビューから使う」ものと位置づけており、Sign-in Callback の URL が固定されたクライアント側トークンです。 | Lightning LLC（container は MustDo 開発元のもの）。**利用者が自分で作ることはできません** — CloudKit Dashboard は自チームの container に対してしかトークンを発行できません。 |
| `ckWebAuthToken` | Apple ID でサインインしたときに Apple が発行する、利用者個人の CloudKit セッション。**private database に入れるのはこれがあるときだけ**です。 | 利用者本人だけ。`~/.mustdo/auth.json` に保存されます。production 用のトークンでは、サインインの戻りのときだけ `ltng.jp` の転送を通ります（下記。保存もログもしません）。それ以降は Apple にだけ送られます。 |

API Token は container 単位で、利用者が自分で作ることはできません。**Lightning LLC は現在このトークンを一般には
配布していないため、ローカルでの利用は一般向けには提供していません — 中継（A）をお使いください。**
コードを公開しているのは、MCP サーバーがデータをどう扱うかを読んで確かめられるようにするためです。

参考: *production* 環境用のトークンの Sign-in Callback は `https://ltng.jp/api/mustdo/oauth/local-callback` で、
これは何も保存せずログにも残さず `http://localhost:51234/callback` に戻すだけの転送です。

#### 設定

環境変数が `~/.mustdo/config.json` より優先されます。

| env | config.json のキー | 既定 | 意味 |
|---|---|---|---|
| `MUSTDO_CK_API_TOKEN` | `apiToken` | （必須） | MustDo container の CloudKit API Token |
| `MUSTDO_CK_ENV` | `environment` | `development` | App Store 版のデータは `production`。`development` は MustDo の開発者向け |
| `MUSTDO_CK_CONTAINER` | `container` | `iCloud.jp.lightning.mustdo` | 変えない |
| `MUSTDO_CK_ZONE` | `zoneName` | `MustDo` | 変えない |
| `MUSTDO_CALLBACK_PORT` | `callbackPort` | `51234` | サインインの戻り先ポート |
| `MUSTDO_HOME` | — | `~/.mustdo` | `config.json` と `auth.json` の置き場所 |
| `MUSTDO_LOG_LEVEL` | — | `INFO` | `DEBUG` / `INFO` / `WARN` / `ERROR`（stderr に JSON 行） |

`auth.json` は環境ごとに別です。`MUSTDO_CK_ENV` を変えたら `sign_in` をやり直してください。
Apple のセッションはしばらくすると失効します（CloudKit が HTTP 421）。ツールが `NOT_SIGNED_IN` を返したら `sign_in` をもう一度。

## ツール

戻り値は JSON。出力の日時は ISO 8601（UTC）。入力の日時は次の 3 形式:

- `YYYY-MM-DD` — その日の **既定時刻**（下記）
- `YYYY-MM-DDTHH:mm` — アカウントの時間帯の壁時計
- オフセット付き ISO 8601

| ツール | 引数 | 何をする |
|---|---|---|
| `sign_in` | `waitSeconds?`（5〜300、既定 90） | **ローカル専用。** Apple のサインイン画面を開いて `ckWebAuthToken` を保存。中継には無い |
| `get_me` | — | アカウント情報: `timeZone`・`today`・`weekday`・`defaultTime`・`defaultDueNext`・試用／購読の日付・`canAddTodo`。日付を扱う前に呼ぶ |
| `list_todos` | `date?`・`from?`・`to?`（`YYYY-MM-DD`、両端含む）・`status?`（既定 `pending` / `done` / `skipped` / `all`）・`includeRepeating?`（既定 true） | 一覧。削除済みは除く。繰り返しは **テンプレート** のまま `repeating` に返し（展開しない）、範囲内の `occurrences` を添える |
| `add_todo` | `title`（1〜200）・`due?`・`repeat?`・`notes?`（≤2000）・`sound?` | 追加（`source = "mcp"`）。**`due` を省略すると明日の既定時刻** |
| `update_todo` | `id`・`title?`・`due?`・`repeat?`（オブジェクトか `null`）・`notes?`（文字列か `null`）・`sound?`・`status?` | 渡した項目だけ変更。`repeat` は丸ごと置き換え。`null` か `{ "kind": "none" }` で繰り返しを外す |
| `complete_todo` | `id`・`occurrenceDate?` | 単発は `status = done`。繰り返しはその日の回を done に（省略で今日） |
| `snooze_todo` | `id`・`until`・`occurrenceDate?` | `until` までスヌーズ。繰り返しはその日の回だけ |
| `delete_todo` | `id` | soft delete（`deletedAt`）。アプリが 14 日後に物理削除 |

### 既定時刻と `due` の省略

アカウントごとに鳴らす時刻の既定（`Account.defaultTime`、`HH:mm`、アプリの設定で変更。無ければ `09:00`）があります。

- `due` なしの `add_todo` → **明日**（アカウントの時間帯）の既定時刻。月末・年末・夏時間の切り替え日でも壁時計どおり
- `due: "2026-10-10"` → その日の既定時刻
- `get_me` が `defaultTime` と `defaultDueNext` を返すので、何時に鳴るかを事前に利用者へ伝えられます

例:

```jsonc
// 「牛乳買うのリマインドして」→ 明日の既定時刻
{ "title": "牛乳を買う" }

// 「10 日に歯医者に電話」→ その日の既定時刻
{ "title": "歯医者に電話", "due": "2026-10-10" }

// 「今日 15 時」
{ "title": "報告書を出す", "due": "2026-10-06T15:00" }
```

### 繰り返し（`repeat`）

iOS カレンダーと同じ語彙。`add_todo` / `update_todo` の入力と `list_todos` の出力で同じ形です。

```jsonc
{
  "kind": "none | daily | weekly | monthly | yearly",
  "interval": 1,                                   // 1 = 毎、2 = 隔 …（1〜99）
  "weekdays": [2, 4],                              // weekly のみ。1 = 日 … 7 = 土。空なら due の曜日
  "monthly": { "mode": "dayOfMonth | weekdayOrdinal", "ordinal": 1, "weekday": 2 },
  "end": { "kind": "never | until | count", "until": "2026-12-31", "count": 10 }
}
```

| 言い方 | `repeat` |
|---|---|
| 毎日 | `{ "kind": "daily" }` |
| 毎週 月水 | `{ "kind": "weekly", "weekdays": [2, 4] }` |
| 隔週 | `{ "kind": "weekly", "interval": 2 }` |
| 3 日ごと | `{ "kind": "daily", "interval": 3 }` |
| 毎月 5 日 | `{ "kind": "monthly" }`（`due` を 5 日に。29〜31 日は無い月は月末） |
| 毎月 第 1 月曜 | `{ "kind": "monthly", "monthly": { "mode": "weekdayOrdinal", "ordinal": 1, "weekday": 2 } }` |
| 毎月 最終金曜 | `{ "kind": "monthly", "monthly": { "mode": "weekdayOrdinal", "ordinal": -1, "weekday": 6 } }` |
| 毎年 | `{ "kind": "yearly" }`（`due` の月日。2/29 は閏年以外 2/28） |
| 10 回で終了 | `{ "kind": "daily", "end": { "kind": "count", "count": 10 } }` |
| 12/31 まで | `{ "kind": "weekly", "weekdays": [2], "end": { "kind": "until", "until": "2026-12-31" } }` |

省略した項目は既定値（`interval` 1・`weekdays` []・`monthly.mode` `dayOfMonth`・`end.kind` `never`）。
範囲は `interval` 1〜99、`ordinal` 1〜5 / -1、`weekday` 1〜7、`count` 1〜999。範囲外は `INVALID_ARGUMENT`。
旧形 `{ "kind", "weekdays", "until" }` も受け付けます。

**展開はアプリ側で行い、MCP はしません。** `list_todos` はテンプレートと `occurrences`（回ごとの done / skipped / スヌーズ）を返します。
範囲の絞り込みは、確実に範囲内で鳴らないもの（初回が範囲より後・`until` が範囲より前・毎週で曜日が合わない）だけを落とします。

### エラー

失敗は `isError: true`、本文は `{ "code": "...", "message": "...", "details"?: {...} }`。

| `code` | 意味 |
|---|---|
| `NOT_SIGNED_IN` | 有効な `ckWebAuthToken` が無い（ローカル）。`sign_in` を実行 |
| `RECONNECT_REQUIRED` | 同じ状態（中継）。claude.ai でコネクタを接続し直す |
| `NOT_CONFIGURED` | API Token が未設定か CloudKit に拒否された（HTTP 401/403） |
| `PAYMENT_REQUIRED` | 試用期間が終わり購読も無い。`add_todo` だけが対象 |
| `NOT_FOUND` | その TODO が無い、または削除済み |
| `INVALID_ARGUMENT` | 日付の形式・繰り返しの範囲・空のタイトルなど |
| `CONFLICT` | 別の端末が 2 回続けて同じレコードを変更した。やり直す |
| `CLOUDKIT_ERROR` | その他の CloudKit エラー（アプリが未同期で zone が無い等） |
| `SIGN_IN_TIMEOUT` | サインインの待ち受け（10 分）が切れた |
| `INTERNAL` | 想定外のエラー |

## セキュリティの考え方

- **TODO へのアクセスは利用者自身の Apple ID セッション**（`ckWebAuthToken`）で守られます。Apple のサインイン画面が発行するもので、
  これが無ければ開発元を含め誰も private database を読めません。
- **API Token** は container を識別し、サインイン後の戻り先を固定するだけです。Apple はクライアント側トークンとして位置づけており
  （通常は CloudKit JS の Web ページに埋め込まれる）、それ単体では誰の private データにもアクセスできません。
- **ローカル**では、セッションは `~/.mustdo/auth.json`（`0600`）に保存、ログは stderr に JSON で出しトークンは含めず、
  サインインの待ち受けは `127.0.0.1` / `::1` だけに bind します。
- **中継**では、セッションを利用者ごとに AWS KMS でエンベロープ暗号化（encryption context 付き）、OAuth トークンはペッパー付き
  SHA-256 ハッシュだけを保存、PKCE S256 必須、リフレッシュトークンはローテーション＋再利用検知、TODO の内容は保存もログもしません。
- 書き込みは CloudKit の `recordChangeTag`（楽観ロック）付きで衝突時に 1 回再試行、削除は soft delete です。
- 脆弱性の報告は [SECURITY.md](./SECURITY.md) へ。

## 開発

```bash
npm install
npm run build       # tsc → dist/
npm test            # vitest（CloudKit は test/fakeCloudKit.ts でモック）
npm run typecheck   # tsc --noEmit
MUSTDO_LOG_LEVEL=DEBUG node dist/index.js   # stdio サーバーを手で起動
```

構成:

```
src/
  index.ts      エントリ（stdio）
  server.ts     stdio の配線: sign_in ＋ TODO の 7 ツール
  tools.ts      ツール定義（zod）。stdio と中継の共通ソース
  core.ts       共有コアの入口（auth / config / stdio は含まない）
  service.ts    ツールの中身: 絞り込み・upsert・衝突再試行
  cloudkit.ts   CloudKit Web Services の薄いクライアント（query / lookup / modify、421）
  records.ts    レコード ⇄ モデル変換
  dates.ts      Intl だけの時間帯つき日付計算
  auth.ts       auth.json とサインインの待ち受け
  config.ts     env / ~/.mustdo/config.json
  model.ts      enum・allowlist・RepeatRule 型（Swift アプリと同じ値）
  errors.ts     ToolError / NotSignedInError
  log.ts        stderr への JSON ログ（setLogSink で差し替え）
test/           vitest
```

`dist/core.js`（package の `exports`）が中継の使う **共有コア** です。`auth.ts`・`config.ts`・`index.ts`・`server.ts` 以外の全部。
ここにローカルのファイルやブラウザに触るものを入れないでください。

### 進め方: Issue から始める

変更は、先に GitHub の Issue を立ててから始めます。コミットメッセージに `Issue #番号` を入れ
（例 `Fix the due-date default for repeating To-Dos (Issue #12)`。マージのコミットも同じ）、
`main` に入ったら Issue を閉じます。`#12` だけでは通りません。

```bash
bash tools/git-hooks/install.sh   # クローンごとに 1 回。この決まりを確かめる commit-msg フックを入れる
```

push されたコミットは `.github/workflows/issue-number.yml` でも確かめます。

## ライセンス

MIT — Copyright (c) 2026 Lightning LLC。[LICENSE](./LICENSE) を参照。

MustDo は Lightning LLC の製品です。Apple・iCloud・CloudKit は Apple Inc. の商標です。
