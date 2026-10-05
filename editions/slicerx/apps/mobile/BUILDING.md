<!-- SPDX-License-Identifier: Apache-2.0 -->
# Building the SlicerX phone app

The app is an Expo (React Native) project. The generated `ios/` and `android/` folders are not committed. `expo prebuild` creates them from `app.config.ts` and the edition config.

Application id (Android) and bundle id (iOS): `app.slicerx.mobile`.

## Requirements

| | Android | iOS |
| --- | --- | --- |
| OS | macOS, Linux or Windows | macOS |
| Toolchain | JDK 17, Android SDK (platform 36, build-tools 36.0.0) | Xcode with Swift 6.3 (Xcode 26.4 or newer for Expo SDK 57), CocoaPods |
| Both | Node 24 or newer, pnpm 10 | |

Install dependencies from the repository root:

```sh
pnpm install --filter "@slicerx/mobile..."
```

Copy `.env.example` to `.env.local` and fill it in. Without Supabase values the app runs on the offline example catalog and the demo printer fleet. See `SETUP.md` for accounts and keys.

## Generate the native projects

```sh
cd editions/slicerx/apps/mobile
pnpm exec expo prebuild --clean            # both platforms
pnpm exec expo prebuild --clean --platform android
```

Run it again after changing `app.config.ts`, the edition config or a native dependency.

## Android

Debug build (development client, loads JavaScript from Metro):

```sh
cd android
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a
# then, from the app folder: pnpm start
```

Release build (JavaScript bundled into the APK, no Metro needed):

```sh
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

APKs land in `android/app/build/outputs/apk/<variant>/`. Drop `-PreactNativeArchitectures` to build all four ABIs (slower, larger). Both variants are signed with the debug keystore that prebuild generates. Store builds need a real keystore (see EAS below).

Run on a device or emulator:

```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
adb shell am start -n app.slicerx.mobile/.MainActivity
```

## iOS

```sh
cd ios
xcodebuild -workspace SlicerX.xcworkspace -scheme SlicerX -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/SlicerX.app
xcrun simctl launch booted app.slicerx.mobile
```

`expo run:ios --device <simulator id>` treats the id as a physical device. Use xcodebuild and simctl as above.

Expo SDK 57 needs Swift 6.3. `expo-modules-jsi` 57.1.1 fails to compile under Xcode 26.1 (Swift 6.2.1) with data race errors in `JavaScriptRuntime.swift`. Use Xcode 26.4 or newer, or an Expo SDK that supports the Xcode you have.

Device builds and App Store builds need an Apple Developer team, the capabilities listed in `SETUP.md` and signing.

## End-to-end tests

Flows live in `e2e/flows` and use Maestro against the release APK or an iOS simulator build. They select elements by `testID`.

```sh
maestro test e2e/flows/smoke.yaml                 # all flows
maestro test --format junit e2e/flows/launch.yaml
```

Screenshots go where Maestro runs (`takeScreenshot` writes into the working directory). Keep them out of git.

## Building on a separate machine

`scripts/` runs the steps above on a remote Mac over ssh (set `BUILD_HOST` to its ssh host; the scripts stop with a message when it is unset). Paths and tool locations are in `scripts/remote-env.sh`.

| Script | Does |
| --- | --- |
| `sync-to-remote.sh [--no-install]` | rsync the repository over and install dependencies. Leaves the remote `ios/` and `android/` alone. |
| `prebuild.sh [ios\|android]` | `expo prebuild --clean` on the remote machine |
| `android-build.sh [debug\|release]` | Gradle build, prints the APK path |
| `android-emulator.sh [start\|stop]` | boot or stop the headless emulator |

## EAS (later)

EAS Build produces signed store binaries without a local toolchain. Not set up yet. When the Expo account exists:

1. `npx eas login`, then `npx eas init` in this folder. Export the printed project id as `EXPO_PROJECT_ID` (push tokens need it).
2. Add an `eas.json` with `development`, `preview` (internal distribution) and `production` profiles. Keep `channel` names equal to the profile names if you use EAS Update.
3. `npx eas credentials` to create or upload the Android keystore, the iOS distribution certificate and provisioning profile, and the APNs key.
4. `npx eas build --platform all --profile production`, then `npx eas submit` for Google Play and App Store Connect.

Because the repository is a pnpm workspace, run EAS commands from the repository root with the app folder as the project directory, or set `EAS_NO_VCS=1` and the monorepo root in `eas.json`. Check the current EAS monorepo guide before the first cloud build.
