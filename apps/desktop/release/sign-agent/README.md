# sign-mac agent

A small LaunchAgent that signs release builds without anyone at the keyboard. It runs in the logged-in desktop session, where the login keychain is unlocked, so the Developer ID key and the notary profile never leave the keychain and no password is needed. It has no network listener and touches nothing outside the user's home.

## How it works

A build, run over ssh or anywhere else, drops a request file in `~/Library/Application Support/sign-mac/requests`. launchd notices the folder change and starts `sign-mac-agent`. The agent reads each request as plain data, checks it, runs `~/bin/sign-mac` on the file, writes the log and a result to `results/`, and deletes the request. One job runs at a time, behind a lock, with a one hour limit.

Rules the agent enforces:

- The path must resolve (symlinks followed) to a place under `~/builds` and end in `.app`, `.dmg`, `.pkg` or `.zip`. Entitlement files must also be under `~/builds`.
- A request is `key=value` lines, never executed. Keys: `path`, `entitlements`, `inherit`, `notarize=0`.

## Install and remove

    zsh apps/desktop/release/sign-agent/install.sh            # copies the tools to ~/bin, loads the agent
    zsh apps/desktop/release/sign-agent/install.sh --remove   # same as launchctl bootout, plus removes the files

Disable without removing: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.suby.sign-mac.plist`.

The first signing run can raise a keychain dialog on the Mac's screen asking whether `codesign` or `notarytool` may use a key. Choose Always Allow once.

## Request a signature

    sign-mac-request ~/builds/slicerx-rc4/target/universal-apple-darwin/release/bundle/macos/SlicerX.app
    sign-mac-request ~/builds/slicerx-rc4/target/signed/SlicerX_0.1.0_universal.dmg
    sign-mac-request ~/builds/electron-app/dist/MyApp.app --entitlements ~/builds/electron-app/build/mac.plist --inherit ~/builds/electron-app/build/inherit.plist

`sign-mac-request` writes the request, waits for the result, prints it (PASS or FAIL, then the end of the log with the Gatekeeper output) and exits 0 on PASS. The full log is in `~/Library/Application Support/sign-mac/results/`. The agent's own log is `agent.log` in the same folder.

`macos-sign.sh` uses `sign-mac-request` when `sign-mac --check` cannot use the keychain from the current session.
