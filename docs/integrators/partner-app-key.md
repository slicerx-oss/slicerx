# Partner app key

An app that runs next to SlicerX on the same computer, such as LayerMate, reaches the user's printers through SlicerX's printer bridge (`sx-link`) with a partner app key. The user makes the key in SlicerX and pastes it into your app. You don't need the bridge's pairing codes, and you shouldn't read files from its state folder other than the public `hub-key.pub`.

## What the key can do

A partner app key has the agent role with tighter limits:

- It reads printers, their status and camera stills, and prepares a file for a printer.
- It can ask to print a sliced plate, pause a print or cancel one. Each request shows up as a card in SlicerX and on the user's paired phones, with "Asked by <your app's name>, a partner app" on top. Nothing runs until the user approves it there.
- Over remote access it can only ask to pause or cancel.

It can never approve a card, its own included, and it can't start, resume, pause or cancel anything without the user's tap. It can't send G-code, change a running print (temperatures, fans, speed, AMS slots), switch Home Assistant devices, or touch the user's settings, keys, printers, connected apps or other devices. The bridge refuses those calls with `forbidden`.

## Getting a key

The user makes the key in SlicerX:

1. In SlicerX, open Settings, mimir, Connect your AI agent.
2. Choose Partner app, type your app's name and press Create key.
3. Copy the key (`sxp_` followed by 64 hex digits) and paste it into your app. SlicerX shows it once and keeps only a hash of it.

Each key is listed under Settings, Printer bridge, Devices, with when it was last used. The user can make more than one key for the same app. Revoke ends a key right away and closes any connection open with it.

## Keeping it

Treat the key like a password. Keep it in the operating system's secure storage (the macOS Keychain, the Windows Credential Manager or the Secret Service on Linux; Electron's `safeStorage` works). Never put it in a settings file, a log, a crash report, a URL or a command line. If you lose it or suspect a leak, ask the user to revoke it and make a new one.

## Using it with the MCP server

Start the bundled MCP server with `--printers link` and pass the key in its environment:

```sh
SLICERX_MCP_LINK_KEY=<the key> node node_modules/@slicerx/mcp/dist/cli.js --printers link --link-state-dir <the bridge's state folder>
```

The server reads `SLICERX_MCP_LINK_KEY` once at start and removes it from its own environment, so nothing it launches inherits the key. It checks the bridge's signed hello against `hub-key.pub` from `--link-state-dir` (or `SLICERX_MCP_LINK_HUB_KEY`) before the key leaves your process. A key in any other format is refused, and the error never repeats it.

Printer tools that change something answer with `status: "needs_person"` and a `request_id`. `slicerx_pending_approvals` reports `waiting_for_person`, then `done` or `failed` once the user has answered in SlicerX and the bridge has run the request.

## Using it with @slicerx/link-client

```ts
import { connectLink } from '@slicerx/link-client'

const link = await connectLink({ clientKey: key, hubKey })
link.partner // true
```

`hubKey` is the contents of `hub-key.pub`. Ask for a print with `link.approvals.registerWork(card, { kind: 'print', printerId, file })`, or `{ kind: 'pause' | 'cancel', printerId }`, and listen with `link.onApprovalDone`. The card's actions have to match the work exactly, the same as for an AI agent.

## When the key stops working

A revoked key fails pairing with `unauthorized`, and an open connection closes. Tell the user the key was revoked and point them to Settings, mimir, Connect your AI agent, Partner app for a new one. Don't retry in a loop.
