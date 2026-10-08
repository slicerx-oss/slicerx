# The release gate

The release gate is one command that runs before every desktop release. It starts a test build of the desktop app
that has the [agent bridge](agent-bridge.md), drives it through the running-app MCP server (`packages/app-bridge`)
against production, and writes one HTML report with screenshots. It works the same on Windows, macOS and Linux. A
release needs a pass on every platform it ships to.

It never prints, never sends anything to a printer and never deletes anything. It never reads mail and never opens a
sign-in link. When a link has to be opened, it says which one and waits for an operator (see [The operator](#the-operator)).

## Build the test build

Build the bridge test build from the release candidate's commit, with the same backend settings as the release: the
production `SLICERX_SUPABASE_URL` and its public publishable key in `SLICERX_SUPABASE_ANON_KEY`.

```sh
SLICERX_SUPABASE_URL=... SLICERX_SUPABASE_ANON_KEY=... pnpm --filter @slicerx/desktop build:bridge
```

The app ends up at `target/agent-bridge/release/slicerx` (`slicerx.exe` on Windows). See
[agent-bridge.md](agent-bridge.md#build-a-bridge-build) for the macOS target and the other options. A bridge build has
its own identifier and data folder, so it runs next to an installed SlicerX without touching it.

## Run it

```sh
node scripts/gate/run.mjs --app target/agent-bridge/release/slicerx.exe --platform windows \
  --account qa-win@qa.slicerx.app --out <report folder>
```

| Option | Meaning |
| --- | --- |
| `--app <path>` | The bridge test build. A macOS `.app` bundle works too. |
| `--platform <name>` | `windows`, `macos` or `linux`. Defaults to the machine the gate runs on. |
| `--account <address>` | The test account for c and d and the signed-in half of b. Only `@qa.slicerx.app` addresses are accepted. |
| `--out <dir>` | Where `report.html`, `results.json` and `shots/` go. |
| `--only a,b,e`, `--skip c,d` | Run some of the scenarios. |
| `--starters <slugs>` | Slice only these starters in e. |
| `--wait-signin <min>` | How long to wait for the operator at each sign-in link. The default is 10. |
| `--wait-scan <min>` | How long to wait for the malware scan. The default is 15. |
| `--wait-review <min>` | How long to wait for review approval. The default is 60. |
| `--profile <dir>` | Reuse a web profile folder instead of a fresh one (Windows, Linux). |
| `--commit <hash>` | The commit the build was made from. The default is this checkout's HEAD. |

The exit code is 0 when every scenario that ran passed, 1 when any of them failed (a wait that ran out counts as a
failure), and 2 when the gate could not start.

Run it under the machine's heavy lock, with a time limit. Slicing every starter takes a while. A full run with an
operator takes about 20 minutes plus the review wait.

The gate starts the app with `SX_AGENT_BRIDGE_PORT=0`, keeps the connection file (with the per-run token) in a
temporary folder, and stops the app by its process id when it's done. It never stops a process by name. The app is
single-instance, so the gate refuses to start while the same build is already running.

### Each platform

- **Windows**: each run gets a fresh WebView2 profile (`WEBVIEW2_USER_DATA_FOLDER` in a temporary folder), so first run
  shows. The printer list and other app data stay in the bridge build's own data folder.
- **Linux**: each run gets fresh `XDG_DATA_HOME`, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME`, so the app's data and the
  WebKitGTK profile are new. Run it in a desktop session with working graphics.
- **macOS**: there is no switch for a fresh web profile, so the run uses the bridge build's own data folder as it is.
  The gate copes with a profile that has been used before: it skips first run, adds the printer from Printers if it's
  missing, and signs out before the signed-out checks. Run it from a Terminal in the desktop session, not over ssh.

## Scenarios

Every run starts the same way. It waits for the app to come up, accepts the pre-alpha agreement on the test profile,
answers Later to an optional update sheet, and adds the gate's printer by hand: a Bambu Lab A1 with a 0.4 mm nozzle,
**No connection (export files)**, set up through first-run setup or Printers > Add printer by test id. No network scan
runs, and no printer is ever contacted.

| | Scenario | Passes when |
| --- | --- | --- |
| a | Vault | Design cards show. Every cover and creator logo on screen has loaded, no picture failed anywhere (a broken logo that falls back to initials still counts), the backend answered every call, the whole run has no content security refusals, and Feed and Saved switch. |
| b1 | Open signed out | Temperature tower opens on the starting plate, then Cable clip on a cleared plate. Each time the download shows its progress (a download too fast to sample counts as shown) and the design is alone on the plate, with no example brought back. After a change, the next design asks Save project, Don't save or Cancel. Cancel keeps the plate as it was, and Don't save opens the new design alone. Save project is never pressed. |
| c | Accounts | A sign-in link is asked for in the app (sign-up and sign-in are the same step), and the app signs in once the operator opens it. Sign out from the account menu signs out, and the form starts over at the email field. Two links are asked for in a row: Send again counts down while it's disabled, then turns on, sends, and starts over. The older link shows "expired, or a newer one was sent", and the newer one signs in again. |
| b2 | Open signed in | The same open on a cleared plate, on the account's session. This runs after c. |
| e | Starters | Every starter design opens from the Vault alone on the plate and slices on the A1 (0.4 mm, PLA) with zero warnings. The report lists each one's time and grams. The temperature tower's exported G-code changes the nozzle temperature once per floor, through the tower's temperatures in order, at rising heights. |
| d | Creator page and upload | The creator page saves: it's made on first use, otherwise its bio gets this run's date. Then a fresh two-color coaster is made for the run, opened, and uploaded as This project. Its swatches are derived from the model's colors, and its cover is drawn from the model. The malware scan passes, a reviewer approves it, and it shows in the Feed and opens. The Export menu offers no mesh export, and no STL or OBJ export command is on (sealed). |

When an account is given, e runs signed in, so the gate's downloads stay out of the public counts (test accounts are
flagged). b1's downloads are anonymous.

Each scenario's section in the report has its PASS and FAIL lines with their evidence (state, toasts, dialog answers),
its screenshots, and excerpts of the console (errors, warnings, content security refusals) and of the backend calls
(address and status only). Codes, tokens, keys and sign-in callbacks are masked everywhere.

### What a run leaves in production

Sign-in emails to the test account. The creator page's bio. One new listing per run with d, named
`QA gate coaster <platform> <time>`, plus its cover and file. Downloads, which are left out of the counts for a test
account. Anonymous downloads from b1. The gate deletes nothing, so cleaning up old gate listings is a separate task for
someone who holds production.

## The operator

The gate never reads mail, never fetches a verify link and never handles a sign-in code. At each sign-in step it
prints a block like this one, then waits (bounded by `--wait-signin`) until `app_user` reports the account signed in:

```
OPERATOR: Sign up or sign in: open the newest sign-in link sent to qa-win@qa.slicerx.app (asked at 2026-10-08T01:02:03.000Z).
  Address: qa-win@qa.slicerx.app
  Asked at: 2026-10-08T01:02:03.000Z
  ...
  The app's connection file (for app_auth_callback): /tmp/sx-gate-XXXX/agent-bridge.json
  Waiting until 2026-10-08T01:12:03.000Z (10 min).
```

For as long as it waits, `operator.json` in the report folder holds the same facts (the address, what to open, when the
wait ends and the connection file's path, never the token itself), so an operator's script can pick them up. The
old-link step asks for the **older** link first, then the **newer** one.

The operator takes the link from the test inbox and opens it **on the machine the gate runs on**. A bridge build has its
own identifier, and its `slicerx://` handler isn't registered with the system, so a browser can't pass the link's
redirect to it. The callback has to reach the app through the bridge's `app_auth_callback` instead:

1. Follow the verify link **one hop** without a browser. The answer redirects to `slicerx://auth/callback?...`.
2. Hand that callback to the running bridge build:
   - with the operator helper, which reads it from standard input and never prints it:
     `... | node scripts/gate/hand-callback.mjs --token-file <the connection file the gate printed>`
   - or with any MCP client connected to `packages/app-bridge` with `--token-file <that file>`: the `app_auth_callback`
     tool.

This is the same on Windows, macOS and Linux. The step that fetches the link and holds the code belongs to the
operator. It must be a script that the account owner has approved for test-account links only, it must never print or
store the code, and it isn't part of the gate. For the signed release (below), the installed app's handler is
registered, so there the link can go to the system as it would for a person.

The review wait works the same way. The gate prints `NEEDS REVIEW APPROVAL` with the listing id, title and account, then
polls the listing's stage in Your uploads, as the uploader sees it, until it's live (or sent back, which fails).

## The report

`report.html` is a single page: a table of every scenario on every platform, then each run's commit, build file,
version and sha256, every PASS and FAIL line, every screenshot, and the excerpts. `results.json` holds the same data.
To put several platforms on one page, for example runs from different machines:

```sh
node scripts/gate/report.mjs --out <dir> <windows run folder> <linux run folder> <macos run folder>
```

## The signed installer

The release itself has no bridge, so its short check is separate and optional.

- **Windows**: `node scripts/gate/installer.mjs [--installer <setup.exe>] [--exe <installed slicerx.exe>] --out <dir> [--account <qa address>]`.
  With `--installer` it installs per user without asking (`/S`). It checks the Authenticode signature of the installer
  and the program, then starts the program with the WebView2 debugging port and a fresh profile. It gets through first
  run, checks that the Vault's pictures load with no content security refusal, and with `--account` asks for a sign-in
  link. The operator then opens it the way a person would (the installed handler takes it), and the check waits for the
  account menu. It stops the app by its process id and writes the same report format. It refuses to run while that
  program is already running.
- **macOS**: by hand in the desktop session. Install the signed DMG, launch it, check that Gatekeeper accepts it, open
  the Vault and check the covers and logos, ask for a link for the macOS test account, open it from the inbox, and check
  that the app signs in. Take screenshots of each step for the report.
- **Linux**: by hand, the same steps with the AppImage or the deb.

## Adding to the gate

Large features list the gate scenarios they add, and new screens add their test ids to [test-ids.md](test-ids.md).
Scenarios live in `scripts/gate/scenarios/`. Each one gets helpers for the bridge's tools and records its steps with
their evidence. The pure parts (the masking, the waits, the tower check, the upload model, the options, the report)
are tested in `scripts/gate/gate.test.mjs`, which runs with `pnpm test:scripts`.
