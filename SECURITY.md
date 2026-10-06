# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Contact Lightning LLC through the contact form at <https://ltng.jp/#contact>.
Include what you found, how to reproduce it, and whether it affects this
repository (the local stdio server) or the hosted relay at
`https://ltng.jp/api/mustdo/mcp`.

We aim to acknowledge reports within 5 business days.

## Scope

- This repository: the local MCP server (`src/`) and the shared core used by the relay.
- The hosted relay (`https://ltng.jp/api/mustdo/mcp`, OAuth 2.1 endpoints under
  `https://ltng.jp/api/mustdo/oauth/*`, and the disconnect page
  `https://ltng.jp/api/mustdo/disconnect`).

## What this software handles

- **Your To-Dos** live only in your own iCloud (CloudKit private database).
  The local server talks to Apple directly; the relay never stores or logs
  To-Do content.
- **`ckWebAuthToken`** (the CloudKit sign-in session issued by Apple) is the
  only credential that grants access to your data. Locally it is stored in
  `~/.mustdo/auth.json` with mode `0600`. On the relay it is stored encrypted
  with AWS KMS and deleted when you disconnect or when Apple invalidates it.
- **CloudKit API Token** (`ckAPIToken`) identifies the MustDo container to
  Apple's CloudKit Web Services. It is a client-side token by design and does
  not by itself grant access to any private database.

## Supported versions

Only the latest release on the default branch receives fixes.
