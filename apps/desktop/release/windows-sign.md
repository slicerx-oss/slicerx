# Signing SlicerX for Windows

`windows-sign.ps1` signs the Windows app, its NSIS uninstaller, the NSIS setup and the MSI with
[Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) through Microsoft SignTool, and signs
the dev kit's `sx.exe` the same way. Every file is checked afterwards: Authenticode `Valid`, the expected publisher,
an RFC 3161 timestamp, and `signtool verify /pa /all /v`. A signature does not guarantee SmartScreen reputation
by itself; it lets the reputation build on the publisher.

## What it needs

- The Windows SDK's SignTool (x64). The newest one under `Program Files (x86)\Windows Kits\10\bin` is used, or set
  `SLICERX_SIGNTOOL`.
- The Artifact Signing client's `Azure.CodeSigning.Dlib.dll` (the TrustedSigning PowerShell module puts it under
  `%LOCALAPPDATA%\TrustedSigning`). The newest one there is used, or set `SLICERX_SIGN_DLIB`.
- PowerShell 7 (`pwsh`) on PATH, or its folder in `SLICERX_SIGN_PWSH_DIR`. The DLL signs through
  `AzurePowerShellCredential`, which needs PowerShell 7; Windows PowerShell 5.1 cannot convert the token it gets.
  If the DLL also needs a private .NET runtime, put its folder in `SLICERX_SIGN_DOTNET_ROOT`.
- The `Az.Accounts` module and a saved sign-in with access to the signing account (the Certificate Profile Signer
  role). Sign in once, in a terminal of the account owner:

  ```powershell
  Connect-AzAccount -UseDeviceAuthentication -Tenant <tenant id> -Subscription <subscription id>
  ```

  The script never opens a sign-in. When the saved one is missing or expired it stops and says so.
- For `-Release`, the toolchain of a release build: Rust, pnpm, binaryen's `wasm-opt` (`scripts/install-binaryen.sh`)
  and the `rust-src` component of the pinned toolchain.
- For the engine with exact solids, which `-Release` builds in WSL (Windows has no Emscripten): a WSL distribution
  (`SX_WSL_DISTRO`, else WSL's default one) with the pinned Rust toolchain and its `rust-src`, and Emscripten 6.0.10
  installed there (`SX_WSL_EMSDK`, else `~/builds/emsdk-6.0.10` of its root user). Nothing is installed for it. The
  work folder is `SX_WSL_EXACT_WORK`, else `~/.cache/slicerx/exact-release` of that user. A cold first build fetches
  the pinned, hash-checked SMLib source and the crates of the build-std build, and takes about 5 minutes; later
  builds reuse the work folder.

## Settings

All from the environment. None of them is secret; they name the account, not a credential.

| Variable | What |
| --- | --- |
| `SLICERX_SIGN_ENDPOINT` | The signing account's regional endpoint, such as `https://eus.codesigning.azure.net/` |
| `SLICERX_SIGN_ACCOUNT` | The Artifact Signing account name |
| `SLICERX_SIGN_PROFILE` | The certificate profile name (a Public Trust profile for releases) |
| `SLICERX_SIGN_PUBLISHER` | The publisher the certificate names, checked on every signed file |
| `SLICERX_SIGN_AZURE_ACCOUNT` | Optional: the Azure account the saved sign-in must be |
| `SLICERX_SIGN_PWSH_DIR`, `SLICERX_SIGN_DOTNET_ROOT`, `SLICERX_SIGNTOOL`, `SLICERX_SIGN_DLIB` | Optional tool locations |

## Use

```powershell
# One file, for example the dev kit's engine
apps\desktop\release\windows-sign.ps1 -File C:\path\to\sx.exe

# Signed installers from the checked-out commit into a new folder, with .sha256 files, and the kit's sx.exe in place
apps\desktop\release\windows-sign.ps1 -Release -Out C:\builds\outgoing\rc8-signed -Kit C:\builds\outgoing\kit\bin\windows\sx.exe

# Install that setup for this user (silent, no elevation) and check the installed app and uninstaller
apps\desktop\release\windows-sign.ps1 -VerifyInstalled -Out C:\builds\outgoing\rc8-signed

# Only build the engine with exact solids into packages\geom\wasm\pkg (in WSL), as -Release does
apps\desktop\release\windows-sign.ps1 -ExactModule
```

`-Release` builds the engine and geometry modules, the engine with exact solids (in WSL, from a `git archive` of HEAD,
through `packages/geom/wasm/scripts/release-exact.sh`, then copied into `packages/geom/wasm/pkg` and checked), the
edition config and the sidecars, signs any sidecar before it is packed, then runs `tauri build` with a copy of the
edition config that sets `bundle.windows.signCommand` to this script. Tauri calls it for the app, the NSIS uninstaller
before it goes into the setup, the setup and the MSI. The output folder must not exist yet, so a signed release is
never overwritten. `-ExactModule` runs only the exact solids step, with no signing.

## Why it is done this way

- SignTool with the Artifact Signing DLL needs no exported certificate, no client secret and no .NET SDK. The
  signing key stays in Azure; only the file's digest leaves the machine.
- The metadata file for the DLL is written per run, UTF-8 without a byte order mark (the DLL cannot read the BOM
  Windows PowerShell writes), and deleted after signing.
- `ExcludeCredentials` leaves only the saved Az sign-in, so a stray environment credential can never sign.
