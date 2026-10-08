# mustdo-mcp

[日本語版はこちら (README.ja.md)](./README.ja.md)

**MCP server for [MustDo](https://ltng.jp/mustdo/) — the iOS To-Do alarm that keeps ringing until you do it.**

It lets Claude (Claude Code, Claude Desktop, claude.ai, the Claude iPhone app) and any other
[Model Context Protocol](https://modelcontextprotocol.io/) client read and write your MustDo To-Dos.

- **Your data stays in your iCloud.** MustDo has no database of its own for To-Dos. They live in the
  CloudKit *private* database of your Apple ID (container `iCloud.jp.lightning.mustdo`, zone `MustDo`).
  This server talks to Apple's [CloudKit Web Services](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/)
  and reads/writes the same records as the iPhone app.
- **The developer never stores your To-Dos.** Neither the local server in this repository nor the
  hosted relay (see below) keeps To-Do content on Lightning LLC servers.
- After a write, CloudKit pushes a silent notification to your iPhone, so the app updates right away.

## Two ways to use it

| | A. Hosted relay (recommended) | B. Run this repository locally (developers) |
|---|---|---|
| Works from | claude.ai, Claude iPhone app, any client that supports remote MCP + OAuth | Claude Code / Claude Desktop on a Mac (stdio) |
| Setup | Add a custom connector, sign in with your Apple ID | Node 24, build, configure, sign in. Needs a CloudKit API Token that is **not publicly distributed** (see below) |
| What Lightning LLC stores | Your **CloudKit sign-in token only**, encrypted with AWS KMS (see below) | Nothing |

### A. Hosted relay — `https://ltng.jp/api/mustdo/mcp`

1. claude.ai → **Settings → Connectors → Add custom connector** → URL `https://ltng.jp/api/mustdo/mcp` (name it "MustDo").
2. Click **Connect**. You will see a consent page on ltng.jp explaining what is stored, then Apple's sign-in page.
   Sign in with **the same Apple ID you use in the MustDo app**.
3. Done. The same connector is available in the Claude iPhone app.

**What the relay keeps, honestly:**

- When you sign in, Apple issues a CloudKit sign-in token (`ckWebAuthToken`). The relay stores this token
  **encrypted with AWS KMS** (AWS Tokyo region) so it can call CloudKit on your behalf on each request.
- It also stores hashed OAuth access/refresh tokens for the connector itself.
- It does **not** store or log your To-Do content, your Apple ID email, your password, or your raw iCloud user ID.
- **Disconnect:** remove the connector in claude.ai **and** visit <https://ltng.jp/api/mustdo/disconnect>.
  After confirming with your Apple ID, the stored token is deleted immediately. It is also deleted automatically
  when Apple invalidates the sign-in (the tools then return `RECONNECT_REQUIRED`; just reconnect).

Full write-up: <https://ltng.jp/mustdo/mcp>.

### B. Run locally (stdio)

Requirements:

- macOS with **Node.js 24 or newer**
- The MustDo app installed and synced to iCloud at least once (the app creates the zone and the `Account` record)
- A **CloudKit API Token** for the MustDo container. It is **not currently distributed to the public** — see "About the CloudKit API Token" below. Without it, use the hosted relay (A)

```bash
git clone https://github.com/lightning-llc-jpn/mustdo-mcp mustdo-mcp
cd mustdo-mcp
npm install
npm run build        # -> dist/index.js
npm test             # vitest; CloudKit is mocked
```

Register with Claude Code:

```bash
claude mcp add mustdo \
  -e MUSTDO_CK_API_TOKEN=<MUSTDO_CK_API_TOKEN> \
  -e MUSTDO_CK_ENV=production \
  -- node /path/to/mustdo-mcp/dist/index.js
```

Or put the settings in `~/.mustdo/config.json` and register without `-e`:

```json
{
  "apiToken": "<MUSTDO_CK_API_TOKEN>",
  "environment": "production"
}
```

Then ask Claude to run the `sign_in` tool once. The server opens Apple's sign-in page in your browser,
listens on `http://localhost:51234/callback`, and saves the returned token to `~/.mustdo/auth.json` (mode `0600`).

#### About the CloudKit API Token

CloudKit Web Services needs two tokens on every request:

| Token | What it is | Who has it |
|---|---|---|
| `ckAPIToken` | Identifies the **container** (`iCloud.jp.lightning.mustdo`). Created in CloudKit Dashboard by the container owner. Apple designs it for use "from a website or an embedded web view", i.e. it is a client-side token with a fixed Sign-in Callback URL. | Lightning LLC (the container belongs to the MustDo developer team). **You cannot create one yourself** — CloudKit Dashboard only lets a team create tokens for its own containers. |
| `ckWebAuthToken` | Your personal CloudKit session, issued by Apple when you sign in with your Apple ID. **This is the credential that actually grants access to your private database.** | Only you. Stored in `~/.mustdo/auth.json`. With the production token, Apple returns it through a redirect on `ltng.jp` during sign-in (see below; nothing is stored or logged there). After that it is sent only to Apple. |

The API Token is container-wide and cannot be created by end users. **Lightning LLC does not currently
distribute it publicly, so running this server locally is not offered to general users — use the hosted relay (A).**
The code is published so that you can read exactly what the MCP server does with your data.

For reference, the token for the *production* environment has its Sign-in Callback set to
`https://ltng.jp/api/mustdo/oauth/local-callback`, which simply redirects back to `http://localhost:51234/callback`
without storing or logging anything.

#### Configuration

Environment variables win over `~/.mustdo/config.json`.

| env | config.json key | default | meaning |
|---|---|---|---|
| `MUSTDO_CK_API_TOKEN` | `apiToken` | (required) | CloudKit API Token for the MustDo container |
| `MUSTDO_CK_ENV` | `environment` | `development` | `production` for App Store data. `development` is only useful for the MustDo developers |
| `MUSTDO_CK_CONTAINER` | `container` | `iCloud.jp.lightning.mustdo` | leave as is |
| `MUSTDO_CK_ZONE` | `zoneName` | `MustDo` | leave as is |
| `MUSTDO_CALLBACK_PORT` | `callbackPort` | `51234` | port the sign-in callback listens on |
| `MUSTDO_HOME` | — | `~/.mustdo` | where `config.json` and `auth.json` live |
| `MUSTDO_LOG_LEVEL` | — | `INFO` | `DEBUG` / `INFO` / `WARN` / `ERROR` (JSON lines on stderr) |

`auth.json` is per environment; switching `MUSTDO_CK_ENV` requires another `sign_in`.
Apple expires the session after a while (CloudKit returns HTTP 421); tools then return `NOT_SIGNED_IN` and you run `sign_in` again.

## Tools

All tools return JSON. Dates in output are ISO 8601 (UTC). Dates in input may be:

- `YYYY-MM-DD` — that day at the account's **default time** (see below)
- `YYYY-MM-DDTHH:mm` — wall-clock time in the account's time zone
- Full ISO 8601 with offset

| Tool | Arguments | What it does |
|---|---|---|
| `sign_in` | `waitSeconds?` (5–300, default 90) | **Local only.** Opens Apple's sign-in page and stores `ckWebAuthToken`. Not present on the relay. |
| `get_me` | — | Account info: `timeZone`, `today`, `weekday`, `defaultTime`, `defaultDueNext`, trial/subscription dates, `canAddTodo`. Call this before doing date math. |
| `list_todos` | `date?`, `from?`, `to?` (`YYYY-MM-DD`, inclusive), `status?` (`pending` default / `done` / `skipped` / `all`), `includeRepeating?` (default true) | Lists To-Dos. Deleted ones are excluded. Repeating To-Dos are returned as **templates** under `repeating` (not expanded) with any per-day `occurrences` in range. |
| `add_todo` | `title` (1–200), `due?`, `repeat?`, `notes?` (≤2000), `sound?` | Creates a To-Do with `source = "mcp"`. **If `due` is omitted, it is tomorrow at the default time.** |
| `update_todo` | `id`, `title?`, `due?`, `repeat?` (object or `null`), `notes?` (string or `null`), `sound?`, `status?` | Changes only the fields you pass. `repeat` replaces the whole rule; `null` or `{ "kind": "none" }` removes it. |
| `complete_todo` | `id`, `occurrenceDate?` | One-off: `status = done`. Repeating: marks that day's occurrence done (default: today). |
| `snooze_todo` | `id`, `until`, `occurrenceDate?` | Snoozes until `until`. Repeating: only that day's occurrence. |
| `delete_todo` | `id` | Soft delete (`deletedAt`). The app purges it after 14 days. |

### Default time and omitted `due`

Each account has a default alarm time (`Account.defaultTime`, `HH:mm`, set in the app's settings; `09:00` if unset).

- `add_todo` with no `due` → **tomorrow** (in the account's time zone) at the default time.
  Month/year boundaries and DST transitions follow the wall clock.
- `due: "2026-10-10"` → that day at the default time.
- `get_me` returns `defaultTime` and `defaultDueNext` so a client can tell the user when the alarm will ring.

Examples:

```jsonc
// "Remind me to buy milk" → tomorrow at the default time
{ "title": "Buy milk" }

// "Call the dentist on the 10th" → that day at the default time
{ "title": "Call the dentist", "due": "2026-10-10" }

// "Today at 3pm"
{ "title": "Submit report", "due": "2026-10-06T15:00" }
```

### Repeat rules

Same vocabulary as the iOS Calendar app. Used as input to `add_todo` / `update_todo` and returned by `list_todos`.

```jsonc
{
  "kind": "none | daily | weekly | monthly | yearly",
  "interval": 1,                                   // 1 = every, 2 = every other … (1–99)
  "weekdays": [2, 4],                              // weekly only. 1 = Sun … 7 = Sat. Empty → weekday of `due`
  "monthly": { "mode": "dayOfMonth | weekdayOrdinal", "ordinal": 1, "weekday": 2 },
  "end": { "kind": "never | until | count", "until": "2026-12-31", "count": 10 }
}
```

| You want | `repeat` |
|---|---|
| Every day | `{ "kind": "daily" }` |
| Every Mon & Wed | `{ "kind": "weekly", "weekdays": [2, 4] }` |
| Every other week | `{ "kind": "weekly", "interval": 2 }` |
| Every 3 days | `{ "kind": "daily", "interval": 3 }` |
| 5th of every month | `{ "kind": "monthly" }` with `due` on the 5th (29–31 fall back to month end) |
| First Monday of every month | `{ "kind": "monthly", "monthly": { "mode": "weekdayOrdinal", "ordinal": 1, "weekday": 2 } }` |
| Last Friday of every month | `{ "kind": "monthly", "monthly": { "mode": "weekdayOrdinal", "ordinal": -1, "weekday": 6 } }` |
| Every year | `{ "kind": "yearly" }` (month/day of `due`; Feb 29 → Feb 28 in non-leap years) |
| 10 times, then stop | `{ "kind": "daily", "end": { "kind": "count", "count": 10 } }` |
| Until Dec 31 | `{ "kind": "weekly", "weekdays": [2], "end": { "kind": "until", "until": "2026-12-31" } }` |

Omitted fields take defaults (`interval` 1, `weekdays` [], `monthly.mode` `dayOfMonth`, `end.kind` `never`).
Ranges: `interval` 1–99, `ordinal` 1–5 or -1, `weekday` 1–7, `count` 1–999. Anything else → `INVALID_ARGUMENT`.
The legacy shape `{ "kind", "weekdays", "until" }` is still accepted.

**Expansion happens in the app, not here.** `list_todos` returns the template plus `occurrences`
(per-day `done` / `skipped` / snooze). Range filtering only drops templates that definitely cannot
fire in range (first occurrence after the range, `until` before the range, weekly with no matching weekday).

### Errors

Failures come back with `isError: true` and a body of `{ "code": "...", "message": "...", "details"?: {...} }`.

| `code` | Meaning |
|---|---|
| `NOT_SIGNED_IN` | No valid `ckWebAuthToken` (local). Run `sign_in`. |
| `RECONNECT_REQUIRED` | Same, on the hosted relay. Reconnect the connector in claude.ai. |
| `NOT_CONFIGURED` | API Token missing or rejected by CloudKit (HTTP 401/403). |
| `PAYMENT_REQUIRED` | The account's trial has ended and there is no active subscription. Only `add_todo` is affected. |
| `NOT_FOUND` | No such To-Do, or it was deleted. |
| `INVALID_ARGUMENT` | Bad date, out-of-range repeat rule, empty title, etc. |
| `CONFLICT` | Another device changed the record twice in a row. Retry. |
| `CLOUDKIT_ERROR` | Any other CloudKit error (e.g. zone missing because the app has never synced). |
| `SIGN_IN_TIMEOUT` | The 10-minute sign-in listener expired. |
| `INTERNAL` | Unexpected error. |

## Security model

- **Access to your To-Dos is gated by your own Apple ID session** (`ckWebAuthToken`), issued by Apple's sign-in page.
  No one — including the developer — can read your private database without it.
- The **API Token** only identifies the container and fixes where Apple may redirect after sign-in.
  Apple positions it as a client-side token (it is normally embedded in CloudKit JS web pages). By itself it grants
  no access to any user's private data.
- **Locally**, the session is stored in `~/.mustdo/auth.json` (`0600`), logs go to stderr as JSON and never include tokens,
  and the sign-in listener binds to `127.0.0.1` / `::1` only.
- **On the relay**, the session is encrypted with AWS KMS per user (envelope encryption with encryption context),
  OAuth tokens are stored only as peppered SHA-256 hashes, PKCE S256 is mandatory, refresh tokens rotate with
  reuse detection, and To-Do content is never written to storage or logs.
- Writes use CloudKit `recordChangeTag` (optimistic locking) and retry once on conflict; deletes are soft.
- Anything you find: see [SECURITY.md](./SECURITY.md).

## Development

```bash
npm install
npm run build       # tsc → dist/
npm test            # vitest (CloudKit mocked in test/fakeCloudKit.ts)
npm run typecheck   # tsc --noEmit
MUSTDO_LOG_LEVEL=DEBUG node dist/index.js   # run the stdio server by hand
```

Layout:

```
src/
  index.ts      entry point (stdio)
  server.ts     wiring for stdio: sign_in + the 7 To-Do tools
  tools.ts      tool definitions (zod schemas) shared by stdio and the relay
  core.ts       public entry for the shared core (no auth/config/stdio)
  service.ts    tool logic: filtering, upserts, conflict retry
  cloudkit.ts   thin CloudKit Web Services client (query / lookup / modify, 421 handling)
  records.ts    CloudKit record <-> model conversion
  dates.ts      time-zone-aware date math using Intl only
  auth.ts       auth.json and the sign-in callback listener
  config.ts     env / ~/.mustdo/config.json
  model.ts      enums, allowlists, RepeatRule types (mirrors the Swift app)
  errors.ts     ToolError / NotSignedInError
  log.ts        JSON logs to stderr (setLogSink to redirect)
test/           vitest
```

`dist/core.js` (package `exports`) is the **shared core** consumed by the hosted relay: everything
except `auth.ts`, `config.ts`, `index.ts` and `server.ts`. Keep it free of anything that touches the
local file system or a browser.

## License

MIT — Copyright (c) 2026 Lightning LLC. See [LICENSE](./LICENSE).

MustDo is a product of Lightning LLC. Apple, iCloud and CloudKit are trademarks of Apple Inc.
