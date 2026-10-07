# In-app updates

The desktop app checks for a newer version at launch and once a day, downloads it in the background, and then asks:
"SlicerX 0.x.y is ready" with Restart to update and Later. It never restarts by itself, and Restart to update waits
while a print is being sent. Help, Check for updates (and the button in About) asks at once. The macOS app, both
Windows installers and the AppImage update themselves. A .deb or .rpm install shows the new version with a Download
button, because those belong to the package manager.

Installs from before the first release with the updater (0.1.x) have no updater, so their users download once more.

## How it fits together

- The feed is `latest.json` on the fixed `desktop-updates` release:
  `https://github.com/slicerx-oss/slicerx/releases/download/desktop-updates/latest.json`. It is set in
  `editions/slicerx/edition.config.ts` (`release.updates`), and the desktop build's Tauri config takes it from there.
  That release is never marked latest, so an engine or watch model release cannot replace the feed. A copy served
  from slicerx.app can be added in front of it later; the app tries the endpoints in order.
- Each desktop release has these update bundles next to its installers: `SlicerX_<v>_universal.app.tar.gz` (the
  stapled app, made by `macos-sign.sh`), `SlicerX_<v>_x64-setup.exe`, `SlicerX_<v>_x64_en-US.msi` and
  `SlicerX_<v>_amd64.AppImage`. The Windows and Linux installers are used as they are; only macOS needs a tarball.
- `sign-updates.sh` signs each bundle on the release Mac and writes `<bundle>.sig`. The signature names the file and
  the version, and the app refuses a download whose signature names another version (`requireSignedVersion`), so a
  doctored feed cannot pass an old signed build off as a new one.
- `publish.sh` checks every signature against the public key in the edition config, writes `latest.json` (the
  version, the release date, the top five lines of What changed, the release page, the .deb link and one entry per
  updater target), attaches it to the release, and then replaces `latest.json` on `desktop-updates`.
- A fork never gets SlicerX's feed: the edition config refuses it, and an edition without `release.updates` builds an
  app that never looks for updates.

Tauri's own `createUpdaterArtifacts` is off on purpose. It signs during `tauri build`, which would put the private key
on every build machine; here the key stays on the release Mac.

## Update signing

The update signing key is made once, on the release Mac, and never leaves it. Losing it means installed copies can no
longer update, so back it up the same way as the Developer ID key (an encrypted backup the owner keeps), never into
the repository or another machine.

One time, in a Terminal on the release Mac (or `ssh -t` to it):

```sh
cd ~/builds/slicerx-public-desktop/apps/desktop
mkdir -p ~/.config/slicerx && chmod 700 ~/.config/slicerx
# asks for a password twice; the private key goes to the file, the public key to updater.key.pub
pnpm exec tauri signer generate -w ~/.config/slicerx/updater.key
chmod 600 ~/.config/slicerx/updater.key
# keeps the password in the login keychain, readable by the security tool without a prompt; it asks for the password
security add-generic-password -s slicerx-updater-key -a "$USER" -T /usr/bin/security -w
# the public key, for the edition config
cat ~/.config/slicerx/updater.key.pub; echo
```

Put the printed public key in `editions/slicerx/edition.config.ts` as `UPDATE_PUBKEY` and commit it. It is public.
The first release built after that commit is the first one that can update itself.

`sign-updates.sh` reads the key from `~/.config/slicerx/updater.key` (or `SX_UPDATER_KEY`), refuses it unless only its
owner can read it, and takes the password from the keychain item `slicerx-updater-key`. The login keychain is open in
the desktop session and to its LaunchAgents; over plain ssh unlock it first with `security unlock-keychain`.

## Releasing

1. Build and sign the installers as before: `macos-sign.sh` on the Mac (it now also writes the `.app.tar.gz`) and
   `windows-sign.ps1 -Release` on the PC. The Linux AppImage and .deb come from their own build.
2. Put every file of the release in one folder on the release Mac and sign the update bundles there:

   ```sh
   apps/desktop/release/sign-updates.sh 0.2.0 ~/builds/outgoing/desktop-v0.2.0
   ```

3. Publish from that folder as before (`publish.sh <version> <folder> <notes.md> <commit>`). With `.sig` files in the
   folder it writes and uploads `latest.json` and moves the feed. Once the edition has an update key, a release must
   carry a signed update for macOS, both Windows installers and the AppImage: `sign-updates.sh` and `publish.sh` stop
   when any of them is missing, so no platform is left on the old version.

To test the whole path on a computer with Rust: `node apps/desktop/release/test/updater-e2e.mjs`. It makes a
throwaway key in a temporary folder, signs fake bundles with `sign-updates.sh`, writes the feeds with
`latest-json.mjs`, serves them locally, and has a 0.1.0 build find, download and verify 0.2.0 with the real updater;
it also checks that a changed download and a feed that pairs a newer version with an older signature are refused.
The key is deleted afterwards.
