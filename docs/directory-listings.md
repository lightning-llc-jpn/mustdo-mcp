# Directory listings — copy-paste text and per-site requirements

Internal note for the maintainers. Nothing here has been submitted yet. Replace `https://github.com/lightning-llc-jpn/mustdo-mcp`,
`lightning-llc-jpn` and `{{NPM_SCOPE}}` before use. Checked on 2026-10-06; re-verify each site's
rules before submitting, they change often.

## Shared copy

| Field | Value |
|---|---|
| Name | **MustDo MCP** (package: `mustdo-mcp`) |
| One-liner (≤ 100 chars) | `Read and write your MustDo (iOS alarm To-Do) tasks in your own iCloud via CloudKit.` |
| Short description | `MCP server for MustDo, the iOS To-Do alarm that keeps ringing until you do it. Lists, adds, updates, completes, snoozes and deletes To-Dos stored in the user's own iCloud (CloudKit private database). Offered as a hosted remote server (OAuth 2.1, works from claude.ai and the Claude iPhone app) and as a local stdio server. No To-Do content is stored on the developer's servers.` |
| Category | Productivity / Task management (fallbacks: Workplace & Productivity, Personal, Calendar & Reminders) |
| Tags | `mcp`, `model-context-protocol`, `to-do`, `reminder`, `alarm`, `ios`, `icloud`, `cloudkit`, `productivity`, `claude` |
| Language / runtime | TypeScript, Node.js 24+ |
| Transports | Remote: Streamable HTTP at `https://ltng.jp/api/mustdo/mcp` (OAuth 2.1, PKCE). Local: stdio (`node dist/index.js`) |
| Auth | Remote: OAuth 2.1 → Apple ID sign-in. Local: env `MUSTDO_CK_API_TOKEN` + browser sign-in via `sign_in` tool |
| Tools (8) | `sign_in` (local only), `get_me`, `list_todos`, `add_todo`, `update_todo`, `complete_todo`, `snooze_todo`, `delete_todo` |
| Homepage | https://ltng.jp/mustdo/mcp |
| Repository | `https://github.com/lightning-llc-jpn/mustdo-mcp` |
| License | MIT |
| Author / vendor | Lightning LLC (https://ltng.jp) |
| Icon | MustDo app icon (yellow). Export 512×512 PNG from the app assets before submitting |
| Platform notes | Local server: macOS (uses `open` for the sign-in browser). Remote: any client supporting remote MCP + OAuth |

Do not include pricing. If asked about cost, say: "Requires the MustDo iOS app; the app has a free trial and a subscription."

---

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

Source: https://github.com/modelcontextprotocol/registry → `docs/` (quickstart + server.json reference).
PulseMCP explicitly points submitters here, so do this first.

Prerequisites (owner decides):

- **Namespace.** Two options:
  - `io.github.lightning-llc-jpn/mustdo-mcp` — verified by `mcp-publisher login github` (device flow). Easiest.
  - `jp.ltng/mustdo-mcp` — reverse-DNS of `ltng.jp`, verified by `mcp-publisher login dns` (TXT record) or `login http` (file under `/.well-known/`). Looks more official; requires touching DNS or the site.
- **npm package must be published first** (`npm publish --access public`) and `package.json` must contain the ownership marker
  `"mcpName": "<the namespace/name above>"`. The registry checks the package for it. Add it to `package.json` right before publishing.
- `description` in server.json is short (the schema enforces a limit; keep the one-liner above ≤ 100 chars).

Steps:

```bash
npm publish --access public            # after adding "mcpName" to package.json
brew install mcp-publisher             # or download from the registry releases
mcp-publisher init                     # writes server.json template
# edit server.json (below)
mcp-publisher login github             # or: login dns / login http for jp.ltng
mcp-publisher publish
```

Draft `server.json` (both a remote and a local package can be listed in one entry):

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json",
  "name": "io.github.lightning-llc-jpn/mustdo-mcp",
  "title": "MustDo",
  "description": "Read and write your MustDo (iOS alarm To-Do) tasks in your own iCloud via CloudKit.",
  "version": "0.1.0",
  "websiteUrl": "https://ltng.jp/mustdo/mcp",
  "repository": { "url": "https://github.com/lightning-llc-jpn/mustdo-mcp", "source": "github" },
  "remotes": [
    { "type": "streamable-http", "url": "https://ltng.jp/api/mustdo/mcp" }
  ],
  "packages": [
    {
      "registryType": "npm",
      "identifier": "mustdo-mcp",
      "version": "0.1.0",
      "runtimeHint": "npx",
      "transport": { "type": "stdio" },
      "environmentVariables": [
        { "name": "MUSTDO_CK_API_TOKEN", "description": "CloudKit API Token for the MustDo container (provided by Lightning LLC, see README)", "isRequired": true, "isSecret": false },
        { "name": "MUSTDO_CK_ENV", "description": "production (App Store data) or development", "isRequired": false, "default": "production" }
      ]
    }
  ]
}
```

Note: if the owner decides the API Token must not be public, remove the `packages` block and list only `remotes`.
Check the `$schema` date against the current one in the registry repo before publishing.

---

## 2. awesome-mcp-servers (github.com/punkpeye/awesome-mcp-servers)

Format: one bullet per server, **alphabetical by repo name within the category**, with legend emojis after the link.
Legend: 📇 TypeScript · ☁️ cloud service · 🏠 local service · 🍎 macOS · 🎖️ official (vendor-maintained).

Category: **🏢 Workplace & Productivity** (there is no "Personal / To-Do" section; this is where Todoist/Notion-style servers sit).

Entry (remote + local, so both ☁️ and 🏠; 🍎 because the local sign-in uses macOS `open`):

```markdown
- [lightning-llc-jpn/mustdo-mcp](https://github.com/lightning-llc-jpn/mustdo-mcp) 📇 ☁️ 🏠 🍎 🎖️ - Read and write To-Dos of MustDo, the iOS alarm To-Do app, stored in the user's own iCloud (CloudKit). Hosted OAuth remote server or local stdio.
```

Submission: fork → edit `README.md` → PR titled `Add mustdo-mcp (Workplace & Productivity)`. Keep the description to one sentence; no marketing adjectives.
There are several forks/clones (e.g. `wong2/awesome-mcp-servers`, `appcypher/awesome-mcp-servers`) with the same bullet format — the same line works.

---

## 3. Smithery (smithery.ai)

Source: https://smithery.ai/docs/build/publish. Two publishing routes:

- **URL-based (remote):** go to `https://smithery.ai/new`, enter `https://ltng.jp/api/mustdo/mcp`. Smithery proxies to it and scans the tool list.
  Requirements: Streamable HTTP (we have it) and OAuth if auth is required (we have OAuth 2.1).
  - Smithery's scanner needs to reach `tools/list`. Our relay returns 401 before auth, so scanning may fail.
    Fallback they document: serve `/.well-known/mcp/server-card.json` with `serverInfo`, `authentication`, `tools`.
    That file would have to be added to the ltng.jp site (**owner decision; involves a site change**).
  - Smithery's OAuth client must be able to register with our relay. Our `/api/mustdo/oauth/register` only allows
    `https://claude.ai/...` and `https://claude.com/...` redirect URIs → **Smithery's redirect URI would need to be allow-listed** (owner decision).
- **Local (MCPB bundle):** package the stdio server as a `.mcpb` bundle and upload. Only worth it if the API Token is public.

Listing metadata: name `MustDo`, description (short one above), icon, homepage, repository. Smithery pulls the rest from the scan.

---

## 4. PulseMCP (pulsemcp.com)

Checked 2026-10-06: **submissions are paused** ("not accepting new MCP server or client submissions right now", last updated 2026-09-03).
They say publishing to the Official MCP Registry is the best first step — they ingest from it. Nothing to do here beyond #1; re-check later.

---

## 5. mcp.so (chatmcp)

Two routes:

- `https://mcp.so/submit` — form with a paid auto-submit option. Fields visible: **Repository URL** (required), **Name**; types: MCP Server / Remote Server / MCP Client / AI Agent.
- Free route: open an issue at **https://github.com/chatmcp/mcpso/issues** (the FAQ points here).
  Convention seen in existing issues: title `Submit Remote MCP Server: MustDo (iOS alarm To-Do in your own iCloud; io.github.lightning-llc-jpn/mustdo-mcp)` or `Submit: MustDo MCP`.
  Body: name, repo URL, homepage, one-line description, features (tool list), connection info (remote URL + OAuth; local `npx mustdo-mcp` with env), category `Productivity`, tags.

Draft issue body:

```markdown
**Name:** MustDo MCP
**Type:** Remote MCP Server (also runnable locally via stdio)
**Repository:** https://github.com/lightning-llc-jpn/mustdo-mcp
**Homepage:** https://ltng.jp/mustdo/mcp
**Description:** Read and write your MustDo (iOS alarm To-Do) tasks in your own iCloud via CloudKit.
**Features:** get_me, list_todos, add_todo (due defaults to tomorrow at the user's default time), update_todo, complete_todo, snooze_todo, delete_todo; repeat rules like iOS Calendar; To-Dos never stored on the developer's servers.
**Connection:** Remote: `https://ltng.jp/api/mustdo/mcp` (Streamable HTTP, OAuth 2.1 → Apple ID). Local: `npx mustdo-mcp` with `MUSTDO_CK_API_TOKEN`.
**Category:** Productivity
**Tags:** to-do, reminder, alarm, ios, icloud, cloudkit
**License:** MIT
```

---

## 6. Others worth a line (same copy)

- **Glama (glama.ai/mcp/servers)** — auto-indexes public GitHub repos with MCP servers; "Claim" the listing once the repo is public. Add a `glama.json` only if they ask.
- **mcpservers.org / mcp-get / Cline & Cursor marketplaces** — each has its own form; the shared copy table covers all their fields.
- **Anthropic connector directory (claude.ai)** — separate vendor process, not a public form. Owner contact.

## Owner decisions needed before any submission

1. Public repo URL and GitHub owner (fills `https://github.com/lightning-llc-jpn/mustdo-mcp` / `lightning-llc-jpn`).
2. Registry namespace: `io.github.<owner>/mustdo-mcp` vs `jp.ltng/mustdo-mcp` (DNS/HTTP verification).
3. Whether the CloudKit API Token for local use is published (README + `packages` in server.json) or local use is dropped from listings (remote only).
4. Whether to allow-list Smithery's OAuth redirect URI and add `/.well-known/mcp/server-card.json` to ltng.jp.
5. Publish `mustdo-mcp` to npm (required for the Official Registry's `packages` entry; not required for a remote-only entry).
