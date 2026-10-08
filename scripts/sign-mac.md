# sign-mac

`scripts/sign-mac` signs, notarizes, staples and verifies a macOS app, disk image, installer package or zip. It uses only Apple's tools (codesign, productsign, notarytool, stapler, spctl, ditto) and never touches a secret: the Developer ID key and the notary credentials stay in the login keychain.

Install it once on the Mac that builds: `cp scripts/sign-mac ~/bin/sign-mac`.

## Usage

    sign-mac <file.app|file.dmg|file.pkg|file.zip|binary> [--entitlements FILE] [--inherit FILE]
             [--identity NAME] [--installer NAME] [--profile NAME] [--no-notarize]
    sign-mac --check     test that signing and notarizing work from this session
    sign-mac --setup     one time, typed by the owner: unlock the keychain, allow codesign to use the key

Defaults: the SlicerX Developer ID Application certificate (team X2928JZ7GJ) and the notarytool profile `slicerx-notary`. Override with `--identity` and `--profile`, or the environment variables `SX_SIGN_IDENTITY`, `SX_INSTALLER_IDENTITY` and `SX_NOTARY_PROFILE`.

Before anything is signed, every Mach-O file of an app, and a bare binary, is checked for the SlicerX agent bridge,
which only test builds carry (`docs/agent-bridge.md`): with `apps/desktop/release/check-agent-bridge.mjs` from the
SlicerX checkout the script or the file sits in, or, outside a checkout, for the same names. A file that has it is not
signed.

An app is signed inside-out: every nested framework, helper, XPC service and Mach-O file first, then the app, all with the hardened runtime and a secure timestamp. It is then notarized (the script waits), stapled and checked with `codesign --verify --deep --strict` and `spctl`. The last line is `PASS: <name>` or `FAIL: <reason>`. Exit status is 0 pass, 1 fail, 2 usage, 3 a certificate is missing, 4 the keychain is locked.

## The locked keychain

Over ssh the login keychain is locked, so codesign and notarytool cannot reach the key. Two ways out, either one is enough:

- Run `sign-mac` from Terminal on the Mac's own desktop. The keychain is already unlocked there. If macOS asks whether codesign may use a key, choose Always Allow.
- Run `sign-mac --setup` once at a terminal you type into, including an ssh session. It asks for the login password at Apple's own prompt, stops the keychain from locking while the Mac is awake, and puts the signing tools on the key's access list. After that, ssh runs work until the next restart.

## Examples

Tauri (SlicerX). Build unsigned, then sign. `apps/desktop/release/macos-sign.sh` does all of this:

    pnpm tauri build --target universal-apple-darwin --bundles app
    sign-mac target/universal-apple-darwin/release/bundle/macos/SlicerX.app
    hdiutil create -volname SlicerX -srcfolder stage -format UDZO SlicerX.dmg
    sign-mac SlicerX.dmg

Electron. The helper apps run the JavaScript engine and need the JIT entitlements; the main app does not:

    sign-mac dist/mac-universal/MyApp.app --entitlements build/entitlements.mac.plist --inherit build/entitlements.inherit.plist

Disable electron-builder's own signing (`mac.identity: null`) so the two do not fight.

Swift or Xcode. Archive without signing, or export the app, then:

    xcodebuild -scheme MyApp -configuration Release -derivedDataPath build CODE_SIGNING_ALLOWED=NO
    sign-mac build/Build/Products/Release/MyApp.app

An installer package needs a Developer ID Installer certificate, which is separate from the application certificate. Without it `sign-mac thing.pkg` stops with exit status 3 and says what to create. Apps and dmg files do not need it.

A zip can be notarized but not stapled. Ship a dmg when you can.

A bare command line tool, such as the `sx` engine in the integrator kit, is signed with the hardened runtime and
notarized inside a zip. It cannot be stapled, so macOS checks the ticket online the first time a downloaded copy
runs; never ship one ad-hoc signed, since a quarantined ad-hoc binary is blocked:

    sign-mac kit/bin/macos/sx
