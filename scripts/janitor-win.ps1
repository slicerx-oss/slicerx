# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
#
# Removes the temp dirs SlicerX's tests, e2e host and signing scripts leave behind on a Windows machine. The Windows
# side of scripts/janitor-mac.sh, with the same names and age rule. It looks only at depth 1 of $env:TEMP,
# %LOCALAPPDATA%\Temp and, when it can read them (elevated, or run as that user), the GPU runners'
# C:\Users\sx-gpu-runner*\AppData\Local\Temp, and only at dirs nothing has written to for -MinAgeHours (default 2). A dry run is the default: it prints each candidate with
# its age and size and a total. scripts/ci/README.md, "Disk", says what each name is.
#
#   powershell -NoProfile -File scripts\janitor-win.ps1 [-Execute] [-BelowGB N] [-MinAgeHours N] [-MeasureMax N]
#
# Sizes come from robocopy (/L lists without copying; /XJ skips junctions), one call per dir, about 70 ms each. A name
# with more than -MeasureMax (default 200) candidates, such as tens of thousands of MCP test dirs, is measured on a
# sample of that many and its total is an estimate; the free space before and after is exact.
# Never: git worktrees or anything holding a .git, source trees, C:\builds, release outputs, node_modules or target.
param(
  [switch]$Execute,
  [int]$BelowGB = 0,
  [int]$MinAgeHours = 2,
  [int]$MeasureMax = 200
)
$ErrorActionPreference = 'Stop'
if ($MinAgeHours -lt 2) { $MinAgeHours = 2 }
$cutoff = (Get-Date).ToUniversalTime().AddHours(-$MinAgeHours)

$roots = @()
if ($env:TEMP) { $roots += [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') }
# the user's own temp folder too, for a CI job that points TEMP at a folder of its own
if ($env:LOCALAPPDATA) { $roots += [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Temp')).TrimEnd('\') }
foreach ($u in [IO.Directory]::GetDirectories('C:\Users', 'sx-gpu-runner*')) {
  $t = Join-Path $u 'AppData\Local\Temp'
  try { $null = [IO.Directory]::GetDirectories($t, 'x-no-such-dir-x'); $roots += $t }
  catch { Write-Output "skipped $t (no access: run elevated or as that user)" }
}
$unique = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$roots = @($roots | Where-Object { $unique.Add($_) })

function Free-Report {
  $drives = $roots | ForEach-Object { [IO.Path]::GetPathRoot($_) } | Select-Object -Unique
  foreach ($d in $drives) {
    $info = New-Object IO.DriveInfo $d
    '  {0} {1:N1} GB free' -f $d, ($info.AvailableFreeSpace / 1GB)
  }
}

if ($BelowGB -gt 0) {
  $low = $false
  foreach ($d in ($roots | ForEach-Object { [IO.Path]::GetPathRoot($_) } | Select-Object -Unique)) {
    if ((New-Object IO.DriveInfo $d).AvailableFreeSpace -lt ([int64]$BelowGB * 1GB)) { $low = $true }
  }
  if (-not $low) { "janitor: at least $BelowGB GB free, nothing to do"; Free-Report; exit 0 }
}

if ($Execute) { "janitor: deleting, min age $MinAgeHours h" } else { "janitor: dry run, nothing is deleted; min age $MinAgeHours h" }
'free before:'
Free-Report

# The newest write time of the dir and its direct children: Vite and the e2e host write into subdirs.
function Newest([string]$dir) {
  $info = New-Object IO.DirectoryInfo $dir
  $newest = $info.LastWriteTimeUtc
  foreach ($e in $info.GetFileSystemInfos()) { if ($e.LastWriteTimeUtc -gt $newest) { $newest = $e.LastWriteTimeUtc } }
  $newest
}

# Vitest's core temp dir: a 21-character nanoid holding only ssr\ and client\ (patches/vitest@5.0.2.patch stops new ones)
function Is-Vitest([string]$dir) {
  $entries = [IO.Directory]::GetFileSystemEntries($dir)
  if ($entries.Count -eq 0) { return $false }
  foreach ($e in $entries) {
    $n = [IO.Path]::GetFileName($e)
    if (($n -ne 'ssr' -and $n -ne 'client') -or -not [IO.Directory]::Exists($e)) { return $false }
  }
  $true
}

# The name pattern a dir matches, or nothing: the patterns are the groups the sizes are estimated in.
function Kind([string]$dir) {
  $n = [IO.Path]::GetFileName($dir)
  foreach ($p in 'sx-e2e-native-*', 'slicerx-mcp-test-*', 'slicerx-mcp-fn-*', 'sx-hub-test-*', 'sx-cli-*', 'sx-starters-*', 'sx-updater-e2e-*', 'sx-sign*', 'playwright-artifacts-*') {
    if ($n -like $p) { return $p }
  }
  if ($n.Length -eq 21 -and $n -cmatch '^[A-Za-z0-9_-]+$' -and (Is-Vitest $dir)) { return 'Vitest' }
  $null
}

function Size([string]$dir) {
  $out = & robocopy $dir NUL /L /S /NJH /BYTES /NFL /NDL /XJ /R:0 /W:0
  foreach ($line in $out) { if ($line -match '^\s*Bytes\s*:\s*(\d+)') { return [int64]$matches[1] } }
  [int64]0
}

$found = New-Object 'System.Collections.Generic.List[object]'
foreach ($root in $roots) {
  foreach ($d in [IO.Directory]::GetDirectories($root)) {
    try {
      if (([IO.File]::GetAttributes($d) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
      $kind = Kind $d
      if (-not $kind) { continue }
      if ([IO.Directory]::Exists((Join-Path $d '.git')) -or [IO.File]::Exists((Join-Path $d '.git'))) { continue }
      $newest = Newest $d
      if ($newest -gt $cutoff) { continue }
      if ($kind -eq 'sx-e2e-native-*') {
        $pidFile = Join-Path $d 'owner.pid'
        if ([IO.File]::Exists($pidFile)) {
          $owner = 0
          if ([int]::TryParse(([IO.File]::ReadAllText($pidFile)).Trim(), [ref]$owner) -and (Get-Process -Id $owner -ErrorAction SilentlyContinue)) { continue }
        }
      }
      $found.Add((New-Object PSObject -Property @{ Path = $d; Kind = $kind; Age = ((Get-Date).ToUniversalTime() - $newest).TotalHours; Bytes = $null }))
    } catch {
      Write-Output "skipped ${d}: $($_.Exception.Message)"
    }
  }
}

$total = [int64]0
$estimated = $false
foreach ($group in ($found | Group-Object Kind)) {
  $items = @($group.Group)
  $sample = $items
  if ($items.Count -gt $MeasureMax) { $sample = $items | Get-Random -Count $MeasureMax; $estimated = $true }
  $measured = [int64]0
  foreach ($c in $sample) { $c.Bytes = Size $c.Path; $measured += $c.Bytes }
  $kindTotal = [int64]($measured * $items.Count / [Math]::Max(1, @($sample).Count))
  $total += $kindTotal
  foreach ($c in $items) {
    $mb = '-'
    if ($null -ne $c.Bytes) { $mb = '{0:N0}' -f ($c.Bytes / 1MB) }
    '{0,8} MB {1,7:N1} h  {2}  ({3})' -f $mb, $c.Age, $c.Path, $c.Kind
  }
  $note = ''
  if ($items.Count -gt @($sample).Count) { $note = ", estimated from $(@($sample).Count) measured" }
  '  {0}: {1} dirs, {2:N1} GB{3}' -f $group.Name, $items.Count, ($kindTotal / 1GB), $note
}

if ($Execute) {
  # rmdir through cmd, many paths per call: one process per dir would take most of an hour for 25,000 dirs
  $batch = @()
  $len = 0
  foreach ($c in $found) {
    $part = 'rmdir /s /q "' + $c.Path + '"'
    if ($batch.Count -gt 0 -and $len + $part.Length -gt 7000) { & cmd /c ($batch -join ' & ') 2>&1 | Out-Null; $batch = @(); $len = 0 }
    $batch += $part
    $len += $part.Length + 3
  }
  if ($batch.Count -gt 0) { & cmd /c ($batch -join ' & ') 2>&1 | Out-Null }
  $left = @($found | Where-Object { [IO.Directory]::Exists($_.Path) }).Count
  if ($left -gt 0) { "janitor: $left dirs could not be removed (files still open?)" }
}

$approx = ''
if ($estimated) { $approx = 'about ' }
if ($Execute) { 'total: {0} dirs, {1}{2:N1} GB removed' -f $found.Count, $approx, ($total / 1GB) }
else { 'total: {0} dirs, {1}{2:N1} GB would be removed (run with -Execute)' -f $found.Count, $approx, ($total / 1GB) }
'free after:'
Free-Report
