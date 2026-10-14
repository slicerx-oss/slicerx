# mimir cloud for apps

mimir cloud is SlicerX's hosted model proxy. It gives each install of an edition a small amount of free daily use of mimir, the SlicerX assistant, with no model key on the user's side. This page is for an app that calls the proxy itself (Path B), such as an add-on that runs its own mimir chat. An edition built from the SlicerX repository (Path A) already has it built in and needs nothing here.

Base URL: `https://rsirfakkcogdwyfvehhk.supabase.co/functions/v1/mimir`

You need an edition id and that edition's registration key, both from the SlicerX team. No other credential is used: no Supabase key, no `Authorization` header.

## Ground rules

- Call the proxy from your app's own process (the main process, a local server), never from a web page or webview. The registration key and the install token must not reach page code.
- The registration key goes in exactly one place: the body of `POST /register`. Ship it inside the build (a release secret at build time), never in git, and never log it or put it in an error message.
- Keep the install token in the operating system's secure storage (the macOS Keychain, the Windows Credential Manager, the Secret Service on Linux, or your host's secure store), like a password.
- Never retry a refused call by yourself. Every refusal message is written for people: show it as it is.
- Don't register or chat against the real proxy in automated tests. Use a fake server (see Testing).

## Register

```
POST /register
Content-Type: application/json

{"edition": "<edition id>", "key": "<registration key>"}
```

A 200 returns `{"install": "<uuid>", "token": "<64 lowercase hex characters>"}`. Store the token. The proxy keeps only its hash, so it can't be recovered.

- Register once, on the first mimir message, not at startup.
- The edition id is lowercase letters, digits and hyphens. The key is 16 to 128 letters, digits, `-` or `_`. The body may be at most 4 KB.
- A network may register only 3 new installs a day (per IPv4 address, or per IPv6 /64), and 20 per IPv6 /48. Days run to midnight in Melbourne, Australia.
- An install that never makes a call is removed after 7 days. One that goes 30 days without a call is removed too, unless it has saved chats. Its token then gets `401 unknown_install`, and the app registers again (see Refusals).

## Send a message

```
POST /v1/messages
Content-Type: application/json
x-sx-install: <token>
```

The body is the Anthropic Messages API request. The proxy never forwards it as is. It rebuilds the request from an allowlist and drops everything else without an error (for example `temperature`, `metadata` or `stop_sequences`):

- `model` is always `claude-haiku-5-5`, whatever you send.
- `max_tokens` is kept up to 8192. It is 8192 when missing.
- `stream` is always on. The reply is server-sent events (`text/event-stream`), the provider's own events passed through.
- Thinking is set by the proxy (adaptive, medium effort). A `thinking` field you send is ignored.
- `system` is a string or a list of text blocks.
- `messages` holds 1 to 400 messages, each from `user` or `assistant`, with content that is a string or a non-empty list of blocks.
- `tools` holds at most 128 tools. Your own tools need a `name` (1 to 64 letters, digits, `_` or `-`) and an `input_schema` object. `description` and `strict: true` are kept. Web search (any `web_search_*` type) is the only server tool allowed, at most 3 searches a call across all of them. Any other server tool (code execution, web fetch, computer use) is refused with a 400. `mcp_servers` and `anthropic-beta` headers are dropped.
- `tool_choice` (`auto`, `none`, `any`, or `tool` with a `name`) is kept when there are tools.
- Cache points (`cache_control`) are kept in their plain 5-minute form, at most 4. Without any on the tools or system prompt, the proxy puts one on the last tool and one on the last system block.
- The whole body may be at most 2,000,000 bytes.

Blocks in messages:

| Block | Where | Rules |
| --- | --- | --- |
| `text` | user and assistant | needs `text` |
| `image` | user only | base64 only (`source.type: "base64"`), `image/png`, `image/jpeg`, `image/gif` or `image/webp`. No URL images: the provider would fetch them |
| `tool_result` | user | needs `tool_use_id`; `content` is a string or a list of text and image blocks; `is_error: true` is kept |
| `tool_use` | assistant | needs `id`, `name` and an `input` object |
| `thinking`, `redacted_thinking`, `server_tool_use`, `web_search_tool_result` | assistant | passed back unchanged |

Replies can hold `thinking` and `redacted_thinking` blocks, and `server_tool_use` and `web_search_tool_result` blocks when the model searches. Put every assistant block back in the history exactly as you received it, signatures included, or the next call fails. Any other block type is refused with a 400.

### Saved chats

During alpha, mimir cloud saves free chats for 30 days to improve mimir. Each edition has a default for a call that says nothing: on for SlicerX, and for a partner edition once its app tells users. With the default on, a call is saved unless the client sends `x-sx-share: 0`, so a kit that sends none of these headers is saved too. These headers go on `/v1/messages` and are optional:

| Header | Value |
| --- | --- |
| `x-sx-share` | `0` when the user turned saving off: nothing from that call is stored. `1` saves it. Without the header, the edition's default applies. |
| `x-sx-session` | one id per conversation, 1 to 64 letters, digits, `_` or `-` (16 random bytes as base64url works). Without it, the turn is filed under one session per install and Melbourne day. |
| `x-sx-version` | your app's version, 1 to 40 letters, digits, `.`, `+` or `-` |

Only a call that answered in full is saved. The reply keeps every tool call with its whole input, so a design can be replayed. Images are stored as a placeholder, without their data. The system prompt and tool list are stored once per distinct text, not in every turn, and a turn over 1 MB isn't saved. In a public release, give the user a switch that sends `x-sx-share: 0` and a way to delete what was saved (`/forget`). A closed test, where people join your app as testers, can make saving a condition of testing and leave the switch out, as long as your app tells testers before their first chat that their mimir chats are saved for 30 days to improve mimir. With `@slicerx/pilot`, pass `share: () => ({ on, version })` to `createTransportClient`; `on: false` sends the `0`.

## Today's use

```
GET /quota
x-sx-install: <token>
```

Returns:

| Field | Meaning |
| --- | --- |
| `edition` | the install's edition |
| `day` | the current day (Melbourne), `YYYY-MM-DD` |
| `install_used`, `install_cap` | what this install has used today, and its cap |
| `ip_used`, `ip_cap` | what this network has used today, and its cap |
| `edition_open` | false when mimir cloud is paused or the edition's budget for today is used up |

Amounts are in millionths of a US dollar. The install cap can shrink late in a busy day, so read it from here rather than keeping a copy. A simple line for the chat: the share left is `1 - install_used / install_cap`, rounded down. When `edition_open` is false, show "mimir's daily limit is used up. It resets at midnight Melbourne time." instead.

## Delete saved chats

```
POST /forget
x-sx-install: <token>
```

Deletes every chat saved from this install and returns `{"deleted": <count>}`.

## Refusals

Every refusal is JSON:

```json
{"type": "error", "error": {"type": "mimir_limit", "message": "...", "reason": "install_daily"}}
```

Show `message` to the user as it is. `reason` is there for your code; not every refusal has one.

| Status | `reason` | When | What the app does |
| --- | --- | --- | --- |
| 429 | `install_daily` | this install's free use for today is gone | show it, stop |
| 429 | `ip_daily`, `net_daily`, `net_full` | this network's free use for today is gone | show it, stop |
| 429 | `edition_daily` | the edition's budget for today is gone | show it, stop |
| 429 | `install_rate`, `ip_rate` | too many calls in the last minute | show it, stop |
| 429 | `install_busy`, `ip_busy`, `net_busy` | a call is still answering for this install or network | show it, stop |
| 429 | `register_limit` | too many new installs from this network today | show it, stop |
| 429 | `edition_register_limit` | the edition takes no more new installs today | show it, stop |
| 503 | `edition_busy` | too many calls in flight for the edition | show it with a Try again button |
| 503 | `paused` | mimir cloud is paused | show it with a Try again button |
| 503 | none (`overloaded_error`) | the model provider is busy | show it with a Try again button |
| 401 | `unknown_install` | missing, malformed, removed or unknown token | clear the stored token, register once, resend that one request once; if it fails again, show the message |
| 403 | `register_key` | missing or wrong registration key, on `/register` | tell the user this build can't use mimir cloud; the fix is a new build |
| 400 | `no_ip` | the proxy couldn't tell which network the call came from | show it |
| 400 | none (`invalid_request_error`) | the body broke a rule above (the message names it), or an unknown edition | a bug in the app: log it, show it |
| 413 | none (`request_too_large`) | the body is over the size limit | trim the conversation |
| 404 | none (`not_found_error`) | no such route | a bug in the app |
| 502, 500 | none (`api_error`) | the proxy couldn't reach a service, or hit an error | show it with a Try again button |

Never retry a 429 by yourself. The day's caps don't reset until midnight Melbourne time, and calls refused for a cap or a busy slot count toward the per-minute limits, so a retry loop only keeps the user locked out longer. A Try again button the user presses is fine.

A stream can also end early, or with an `error` event, after the 200. Treat that like a 503: show what arrived and offer Try again.

## Testing

Point the app at a local fake server through an environment variable (for example `MYAPP_MIMIR_URL`), and never at the real proxy in tests: the register limit is 3 installs a day per network, and test runs would use it up for everyone on that network.

The fake needs four routes:

- `POST /register` returns `{"install": "...", "token": "<64 hex>"}`, or 403 `register_key` for a wrong key.
- `POST /v1/messages` checks `x-sx-install` and streams a short reply as server-sent events (`message_start`, a text `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`).
- `GET /quota` returns the fields above.
- `POST /forget` returns `{"deleted": 0}`.

Cover at least: registering once and reusing the token, a 401 `unknown_install` that registers again and resends once, a 429 that shows its message and makes no second call, thinking blocks passed back unchanged on the next turn, and a missing registration key that leaves the rest of the app working.
