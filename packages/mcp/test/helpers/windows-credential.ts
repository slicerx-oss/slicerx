// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

// Only creates a fresh test item. Refuses collisions and removes that item in finally.
export async function withWindowsCredential<T>(secret: string | Uint8Array, use: (ref: string, identifier: string) => T | Promise<T>): Promise<T> {
  const ref = 'slicerx-agent-test'
  const identifier = `app.slicerx.test.${randomUUID()}`
  const target = `slicerx.${ref}.${identifier}`
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TestCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint BlobSize;
    public IntPtr Blob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  public static extern bool Read(string target, uint type, uint flags, out IntPtr value);
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  public static extern bool Write(ref Credential value, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  public static extern bool Delete(string target, uint type, uint flags);
  [DllImport("advapi32.dll", ExactSpelling = true)]
  public static extern void CredFree(IntPtr value);
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.action -eq 'delete') {
  if (-not [TestCredential]::Delete($request.target, 1, 0)) { throw 'Test credential cleanup failed' }
} else {
  $existing = [IntPtr]::Zero
  if ([TestCredential]::Read($request.target, 1, 0, [ref]$existing)) {
    [TestCredential]::CredFree($existing)
    throw 'Test credential already exists'
  }
  if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Cannot check test credential' }
  $bytes = [Convert]::FromBase64String($request.bytes)
  $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
    $value = New-Object TestCredential+Credential
    $value.Type = 1
    $value.TargetName = $request.target
    $value.UserName = 'slicerx'
    $value.Persist = 1
    $value.BlobSize = $bytes.Length
    $value.Blob = $pointer
    if (-not [TestCredential]::Write([ref]$value, 0)) { throw 'Cannot create test credential' }
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
  }
}`
  const run = (action: string, bytes?: string) => execFileSync(join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { input: JSON.stringify({ action, target, bytes }), windowsHide: true, timeout: 30_000, stdio: ['pipe', 'ignore', 'pipe'] })
  run('create', (typeof secret === 'string' ? Buffer.from(secret, 'utf16le') : Buffer.from(secret)).toString('base64'))
  try { return await use(ref, identifier) } finally { run('delete') }
}
