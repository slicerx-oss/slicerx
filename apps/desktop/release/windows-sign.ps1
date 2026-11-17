# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Signs SlicerX for Windows with Azure Artifact Signing through SignTool, so the app, its uninstaller and the
# installers carry the publisher and SmartScreen can build reputation for them. See windows-sign.md.
#
#   windows-sign.ps1 -File <path>                     check one file has no agent bridge, sign it and verify it
#                                                     (Tauri's signCommand calls this)
#   windows-sign.ps1 -Release -Out <dir> [-Kit <exe>] build signed installers into <dir>, with .sha256 files,
#                                                     and sign the dev kit's sx.exe in place
#   windows-sign.ps1 -VerifyInstalled                 install the signed setup for this user and check the
#                                                     installed app and uninstaller (needs -Out from a release)
#   windows-sign.ps1 -ExactModule                     only build the engine with exact solids into
#                                                     packages/geom/wasm/pkg, the -Release step of that name
#
# Everything about the signing account comes from the environment; nothing secret is in this file or written to
# disk. Signing uses the Azure sign-in already saved by Connect-AzAccount (Az.Accounts), through the Artifact
# Signing DLL. When that sign-in has expired, the script stops and says so; it never opens a sign-in itself.
#
# -Release builds the exact kernel in (the desktop crate's native-geom feature) unless SX_RELEASE_KERNEL=0 drops it
# from that build. The kernel's source is fetched with Git's sh (packages/brep/scripts/fetch-smlib.sh).
#
# -Release also builds the engine with exact solids (pkg/sx_geom_exact.mjs and .wasm), which the app's geometry worker
# loads by URL: a page build without them passes and only the app fails, so the release fails instead. Windows has no
# Emscripten, so it is built in WSL by packages/geom/wasm/scripts/release-exact.sh from this commit, then copied in:
#   SX_WSL_DISTRO      the WSL distribution (default: WSL's default one), entered as root
#   SX_WSL_EMSDK       Emscripten 6.0.10 in it, passed as EMSDK (default: release-exact.sh looks for it); never installed
#   SX_WSL_EXACT_WORK  its work folder, kept between releases (default: ~/.cache/slicerx/exact-release there)
# A cold first build fetches the pinned, hash-checked SMLib source and the crates of the build-std build, and takes
# about 5 minutes; later ones reuse the work folder.
# SX_RELEASE_KERNEL=0 drops it with the kernel.
param(
  [string]$File,
  [switch]$Release,
  [string]$Out,
  [string]$Kit,
  [switch]$VerifyInstalled,
  [switch]$ExactModule
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$timestamp = 'http://timestamp.acs.microsoft.com'

function Need([string]$name) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if (-not $v) { throw "Set $name (see apps/desktop/release/windows-sign.md)." }
  return $v
}

# The newest x64 SignTool of the Windows SDK, unless SLICERX_SIGNTOOL names one.
function SignTool {
  if ($env:SLICERX_SIGNTOOL) { return $env:SLICERX_SIGNTOOL }
  $found = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object { [version]($_.FullName -replace '.*\\bin\\([\d.]+)\\.*', '$1') } | Select-Object -Last 1
  if (-not $found) { throw 'No x64 SignTool found; install the Windows SDK or set SLICERX_SIGNTOOL.' }
  return $found.FullName
}

# The Artifact Signing client's DLL, unless SLICERX_SIGN_DLIB names one: the newest under %LOCALAPPDATA%\TrustedSigning.
function Dlib {
  if ($env:SLICERX_SIGN_DLIB) { return $env:SLICERX_SIGN_DLIB }
  $found = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'TrustedSigning') -Filter Azure.CodeSigning.Dlib.dll -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\bin\\x64\\' } | Sort-Object LastWriteTime | Select-Object -Last 1
  if (-not $found) { throw 'No Azure.CodeSigning.Dlib.dll found; install the Artifact Signing client or set SLICERX_SIGN_DLIB.' }
  return $found.FullName
}

# The DLL signs with the saved Az sign-in through AzurePowerShellCredential, which runs PowerShell 7 (pwsh). Windows
# PowerShell 5.1 lacks the SecureString conversion it needs, so pwsh must be on PATH; only this process's PATH changes.
function Use-Tools {
  if ($env:SLICERX_SIGN_PWSH_DIR) { $env:PATH = $env:SLICERX_SIGN_PWSH_DIR + ';' + $env:PATH }
  if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) { throw 'PowerShell 7 (pwsh) is needed on PATH; set SLICERX_SIGN_PWSH_DIR to its folder.' }
  if ($env:SLICERX_SIGN_DOTNET_ROOT) {
    $env:DOTNET_ROOT = $env:SLICERX_SIGN_DOTNET_ROOT
    $env:DOTNET_ROOT_X64 = $env:SLICERX_SIGN_DOTNET_ROOT
  }
}

# The saved Azure sign-in must be the expected account. A missing or expired one stops here with the command to fix it.
function Check-Azure {
  Import-Module Az.Accounts
  $c = Get-AzContext
  if (-not $c) { throw 'No saved Azure sign-in. Run Connect-AzAccount -UseDeviceAuthentication (see windows-sign.md), then sign again.' }
  if ($env:SLICERX_SIGN_AZURE_ACCOUNT -and $c.Account.Id -ne $env:SLICERX_SIGN_AZURE_ACCOUNT) {
    throw "The saved Azure sign-in is $($c.Account.Id), not $($env:SLICERX_SIGN_AZURE_ACCOUNT)."
  }
}

# The signing metadata for the DLL, written for this run only. It must be UTF-8 without a byte order mark: the DLL
# cannot read the BOM Windows PowerShell's UTF8 encoding writes.
function Metadata {
  $m = [ordered]@{
    Endpoint               = (Need 'SLICERX_SIGN_ENDPOINT')
    CodeSigningAccountName = (Need 'SLICERX_SIGN_ACCOUNT')
    CertificateProfileName = (Need 'SLICERX_SIGN_PROFILE')
    # Only the saved Az sign-in may sign; no other credential is tried.
    ExcludeCredentials     = @('EnvironmentCredential', 'WorkloadIdentityCredential', 'ManagedIdentityCredential', 'SharedTokenCacheCredential', 'VisualStudioCredential', 'VisualStudioCodeCredential', 'AzureCliCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential')
  }
  $path = Join-Path ([IO.Path]::GetTempPath()) ("slicerx-sign-{0}.json" -f [guid]::NewGuid())
  [IO.File]::WriteAllText($path, ($m | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  return $path
}

# Authenticode Valid, the expected publisher, a timestamp, and SignTool's own check of every signature.
function Verify([string]$path) {
  $publisher = Need 'SLICERX_SIGN_PUBLISHER'
  $sig = Get-AuthenticodeSignature -LiteralPath $path
  if ($sig.Status -ne 'Valid') { throw "Not validly signed: $path ($($sig.Status))" }
  if (-not $sig.TimeStamperCertificate) { throw "No timestamp: $path" }
  $name = $sig.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($name -cne $publisher) { throw "Signed by $name, not $publisher`: $path" }
  & (SignTool) verify /pa /all /v $path | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "SignTool could not verify $path" }
  [pscustomobject]@{ File = $path; Publisher = $name; Timestamped = $true; Status = 'Valid' }
}

# Nothing signed carries the agent bridge (docs/agent-bridge.md): every file is checked before it is signed, the app
# Tauri hands over with -File, the sidecars and the dev kit's sx.exe alike.
function Check-NoBridge([string]$path) {
  $check = Join-Path $repo 'apps/desktop/release/check-agent-bridge.mjs'
  & node $check --binary $path | Write-Host
  if ($LASTEXITCODE -ne 0) { throw "Not signed: $path carries the agent bridge, or the check could not run ($LASTEXITCODE)." }
}

function Sign-One([string]$path) {
  $path = (Resolve-Path -LiteralPath $path).Path
  Check-NoBridge $path
  Use-Tools
  Check-Azure
  $meta = Metadata
  try {
    & (SignTool) sign /v /fd SHA256 /tr $timestamp /td SHA256 /dlib (Dlib) /dmdf $meta $path
    if ($LASTEXITCODE -ne 0) { throw "Signing failed: $path" }
  } finally {
    Remove-Item -LiteralPath $meta -ErrorAction SilentlyContinue
  }
  Verify $path
}

# A build tool's progress on stderr is not a failure: in Windows PowerShell 5.1, with 'Stop', redirected stderr of a
# native command throws. Each step is judged by its exit code instead.
function Run([string]$what, [scriptblock]$step) {
  Write-Host "== $what"
  $was = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $step 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $was }
  if ($LASTEXITCODE) { throw "$what failed ($LASTEXITCODE)" }
}

# The engine with exact solids in packages/geom/wasm/pkg: both files there, not empty, and the wasm a wasm module.
function Check-ExactModule {
  $pkg = Join-Path $repo 'packages\geom\wasm\pkg'
  foreach ($f in 'sx_geom_exact.mjs', 'sx_geom_exact.wasm') {
    $p = Join-Path $pkg $f
    if (-not (Test-Path -LiteralPath $p -PathType Leaf) -or (Get-Item -LiteralPath $p).Length -eq 0) {
      throw "No $f in $pkg. The app would build without exact solids and fail when they load; run the exact solids module step (windows-sign.ps1 -ExactModule)."
    }
    Write-Host "$f`: $((Get-Item -LiteralPath $p).Length) bytes"
  }
  $head = [IO.File]::ReadAllBytes((Join-Path $pkg 'sx_geom_exact.wasm'))[0..3]
  if (($head -join ',') -ne '0,97,115,109') { throw "$pkg\sx_geom_exact.wasm is not a wasm module." }
}

# Builds the engine with exact solids in WSL from a tar of HEAD (WSL's git cannot read a Windows checkout, and the tar
# holds exactly the commit, never local edits), and copies it into packages/geom/wasm/pkg. The files there are removed
# first, so an older build is never what ships.
function Build-ExactModule {
  # WSL's default distribution unless SX_WSL_DISTRO names one
  $distro = @()
  $named = 'the default distribution'
  if ($env:SX_WSL_DISTRO) { $distro = @('-d', $env:SX_WSL_DISTRO); $named = $env:SX_WSL_DISTRO }
  # unset, release-exact.sh looks in its usual place; an empty EMSDK counts as unset there
  $emsdk = if ($env:SX_WSL_EMSDK) { $env:SX_WSL_EMSDK } else { '' }
  # unset, release-exact.sh keeps its work folder under the WSL user's home (~/.cache/slicerx/exact-release)
  $work = @()
  if ($env:SX_WSL_EXACT_WORK) { $work = @('--work', $env:SX_WSL_EXACT_WORK) }
  $pkg = Join-Path $repo 'packages\geom\wasm\pkg'
  foreach ($f in 'sx_geom_exact.mjs', 'sx_geom_exact.wasm') { Remove-Item -LiteralPath (Join-Path $pkg $f) -ErrorAction SilentlyContinue }
  $null = New-Item -ItemType Directory -Force -Path $pkg
  $changed = @(git -C $repo status --porcelain --untracked-files=no)
  if ($changed.Count) { Write-Warning "tracked changes are not in the exact solids module, which is built from HEAD: $($changed -join '; ')" }
  $tar = Join-Path ([IO.Path]::GetTempPath()) ("slicerx-exact-{0}.tar" -f [guid]::NewGuid())
  try {
    Run 'exact solids source' { git -C $repo archive --format=tar -o $tar HEAD }
    # wsl.exe -e runs the command with no shell between, so paths and folders pass as they are
    $win = @{ tar = $tar; pkg = $pkg; script = (Join-Path $repo 'packages\geom\wasm\scripts\release-exact.sh') }
    $wsl = @{}
    foreach ($k in $win.Keys) {
      $was = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try { $wsl[$k] = ([string](wsl.exe @distro -e wslpath -a -u $win[$k] 2>&1)).Trim() } finally { $ErrorActionPreference = $was }
      if ($LASTEXITCODE -or -not $wsl[$k].StartsWith('/')) { throw "WSL ($named) could not name $($win[$k]): $($wsl[$k])" }
    }
    Run 'exact solids module (WSL)' { wsl.exe @distro -u root -e env "EMSDK=$emsdk" sh $wsl.script @work --archive $wsl.tar --into $wsl.pkg }
  } finally {
    Remove-Item -LiteralPath $tar -ErrorAction SilentlyContinue
  }
  Check-ExactModule
}

function Hash-Into([string]$path) {
  $h = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText("$path.sha256", "$h *$([IO.Path]::GetFileName($path))`n", (New-Object Text.UTF8Encoding($false)))
  return $h
}

if ($File) {
  # Tauri also hands over the WiX toolset's extension DLLs, which only run during the build and never ship;
  # they are Microsoft's, so they keep their own signatures. The NSIS plugin DLLs do ship inside the setup and are signed.
  if ((Resolve-Path -LiteralPath $File).Path -match '\\wix\\') {
    Write-Host "not signed (a WiX build tool, not shipped): $File"
    exit 0
  }
  # Microsoft's redistributables (DirectML.dll, which ships with the print watch) already carry Microsoft's signature;
  # signing over it would leave Microsoft's as the primary one, so they ship as they are.
  $own = Get-AuthenticodeSignature -LiteralPath $File
  if ($own.Status -eq 'Valid' -and $own.SignerCertificate.Subject -match '(^|,\s*)O=Microsoft Corporation(,|$)') {
    Write-Host "keeps its own signature (a Microsoft redistributable): $File"
    exit 0
  }
  Sign-One $File | Format-List
  exit 0
}

if ($Release) {
  if (-not $Out) { throw 'Give -Out <dir> for the signed installers.' }
  if (Test-Path -LiteralPath $Out) { throw "$Out already exists; signed output goes to a new folder." }
  Use-Tools
  Check-Azure
  $null = Need 'SLICERX_SIGN_ENDPOINT'; $null = Need 'SLICERX_SIGN_ACCOUNT'; $null = Need 'SLICERX_SIGN_PROFILE'; $null = Need 'SLICERX_SIGN_PUBLISHER'
  Push-Location $repo
  try {
    if (-not $env:SLICERX_COMMIT) { $env:SLICERX_COMMIT = (git rev-parse HEAD).Trim() }
    $triple = 'x86_64-pc-windows-msvc'
    # A release never carries the agent bridge (docs/agent-bridge.md): refuse a bridge environment before building.
    Run 'agent bridge off' { node apps/desktop/release/check-agent-bridge.mjs --env --manifest apps/desktop/src-tauri/Cargo.toml }
    # A release is never a demo build: refuse an environment without the backend variables before building.
    Run 'not a demo build' { node apps/desktop/release/check-demo-data.mjs --env }
    Run 'engine module' { pnpm --filter @slicerx/slicer build:wasm }
    Run 'geometry module' { sh packages/geom/wasm/scripts/build.sh }
    if ($env:SX_RELEASE_KERNEL -ne '0') { Build-ExactModule } else { Write-Host '== exact solids module: off (SX_RELEASE_KERNEL=0)' }
    Run 'edition config' { pnpm --filter @slicerx/desktop tauri:config }
    Run 'sidecars' { node apps/desktop/release/prepare-sidecars.mjs --target $triple --config apps/desktop/src-tauri/gen/edition.conf.json }
    # The exact kernel: its source at the pinned, hash-checked commit with the routine swap checked (fetch-smlib.sh
    # prints its folder last), and SX_BREP_REQUIRE=1, so a build without it fails instead of building the stand-in.
    # kernel-config.mjs turns native-geom on through the edition config and adds the kernel's license files.
    if ($env:SX_RELEASE_KERNEL -ne '0') {
      Write-Host '== kernel source'
      $was = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try { $kernel = (& sh packages/brep/scripts/fetch-smlib.sh | Select-Object -Last 1) } finally { $ErrorActionPreference = $was }
      if ($LASTEXITCODE -or -not $kernel) { throw "kernel source failed ($LASTEXITCODE)" }
      # Git's sh names C:\ as /c/; cargo's build script needs the Windows form
      $kernel = ([string]$kernel).Trim() -replace '^/([A-Za-z])/', '$1:/'
      if (-not (Test-Path -LiteralPath $kernel -PathType Container)) { throw "fetch-smlib.sh printed $kernel, which is not a folder" }
      $env:SX_SMLIB_DIR = $kernel
      $env:SX_BREP_REQUIRE = '1'
      Run 'kernel config' { node apps/desktop/release/kernel-config.mjs --config apps/desktop/src-tauri/gen/edition.conf.json --kernel $kernel }
    } else {
      Write-Host '== kernel: off (SX_RELEASE_KERNEL=0)'
    }
    # Sidecars are packed into the installers as they are, so they are signed before Tauri bundles them.
    $sidecars = @(Get-ChildItem apps/desktop/src-tauri/binaries -Filter '*.exe' -ErrorAction SilentlyContinue)
    foreach ($s in $sidecars) { Sign-One $s.FullName | Out-Null }
    # Tauri runs the sign command for the app, the NSIS uninstaller (before it is packed into the setup), the setup
    # and the MSI. The edition config gets the command in a copy, so the plain build stays unsigned.
    $gen = 'apps/desktop/src-tauri/gen'
    $conf = Get-Content "$gen/edition.conf.json" -Raw | ConvertFrom-Json
    if (-not $conf.bundle) { $conf | Add-Member bundle ([pscustomobject]@{}) }
    if (-not $conf.bundle.windows) { $conf.bundle | Add-Member windows ([pscustomobject]@{}) }
    $sign = [pscustomobject]@{ cmd = 'powershell.exe'; args = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'windows-sign.ps1'), '-File', '%1') }
    $conf.bundle.windows | Add-Member signCommand $sign -Force
    [IO.File]::WriteAllText((Join-Path $repo "$gen/edition.signed.conf.json"), ($conf | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding($false)))
    # The edition's mimir cloud registration key comes from the environment; without it the app has no mimir cloud.
    if (-not $env:SX_MIMIR_REGISTER_KEY) { Write-Warning 'no SX_MIMIR_REGISTER_KEY, so this build has no mimir cloud' }
    # Earlier releases' installers stay in the bundle folders and add up on the build machine; clear them so the
    # folders hold only what this build makes.
    $target = Join-Path $repo "target\$triple\release"
    foreach ($b in 'nsis', 'msi') { Remove-Item -LiteralPath "$target\bundle\$b" -Recurse -Force -ErrorAction SilentlyContinue }
    # the page build takes pkg as it is, so the exact solids files are checked once more right before it
    if ($env:SX_RELEASE_KERNEL -ne '0') { Check-ExactModule }
    Push-Location apps/desktop
    try { Run 'signed build' { pnpm tauri build --config src-tauri/gen/edition.signed.conf.json --target $triple --bundles 'nsis,msi' } } finally { Pop-Location }
    # The app the installers carry and the frontend inside it, checked for the agent bridge before anything is copied out.
    Run 'no agent bridge' { node apps/desktop/release/check-agent-bridge.mjs --binary "$target\slicerx.exe" --dist apps/desktop/dist }
    Run 'not a demo build' { node apps/desktop/release/check-demo-data.mjs --dist apps/desktop/dist }
    # Exactly one installer of each kind, of this version.
    $version = (Get-Content (Join-Path $repo 'apps/desktop/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
    function One([string]$dir, [string]$filter) {
      $found = @(Get-ChildItem $dir -Filter $filter -ErrorAction SilentlyContinue)
      if ($found.Count -ne 1) { throw "Expected one $filter in $dir, found $($found.Count)." }
      return $found[0]
    }
    $setup = One "$target\bundle\nsis" "*_${version}_*-setup.exe"
    $msi = One "$target\bundle\msi" "*_${version}_*.msi"
    # Tauri marks the app with each installer's type after signing it, so target\slicerx.exe is left as the last,
    # unsigned copy; the copies inside the installers are the signed ones, and -VerifyInstalled checks them.
    $checked = @(Verify $setup.FullName) + @(Verify $msi.FullName)
    New-Item -ItemType Directory -Path $Out | Out-Null
    foreach ($f in @($setup, $msi)) {
      Copy-Item -LiteralPath $f.FullName -Destination $Out
      $copy = Join-Path $Out $f.Name
      Verify $copy | Out-Null
      Hash-Into $copy | Out-Null
    }
  } finally { Pop-Location }
  if ($Kit) {
    $checked += Sign-One $Kit
    Hash-Into (Resolve-Path -LiteralPath $Kit).Path | Out-Null
  }
  $checked | Format-Table -AutoSize
  Get-ChildItem $Out | Select-Object Name, Length | Format-Table -AutoSize
  exit 0
}

if ($VerifyInstalled) {
  if (-not $Out) { throw 'Give -Out <dir> with the signed setup.' }
  $setup = Get-ChildItem $Out -Filter '*-setup.exe' | Select-Object -First 1
  Verify $setup.FullName | Out-Null
  # A per-user, silent install: no elevation prompt. The installed app and its uninstaller must carry the signature.
  $p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "The setup exited with $($p.ExitCode)." }
  $dir = Join-Path $env:LOCALAPPDATA 'SlicerX'
  $installed = @(Get-ChildItem $dir -Recurse -Include '*.exe' -ErrorAction SilentlyContinue)
  if (-not ($installed | Where-Object Name -eq 'slicerx.exe')) { throw "No slicerx.exe under $dir after the install." }
  $installed | ForEach-Object { Verify $_.FullName } | Format-Table -AutoSize
  exit 0
}

if ($ExactModule) {
  Build-ExactModule
  exit 0
}

throw 'Give -File <path>, -Release -Out <dir>, -VerifyInstalled -Out <dir> or -ExactModule.'
