// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { join } from 'node:path'

/** Read the same generic credential and UTF-16LE password as the desktop's keyring store. */
export function windowsKeychainCommand(service: string): [string, string[]] {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SlicerxCredential {
  [StructLayout(LayoutKind.Sequential)]
  private struct Credential {
    public uint Flags, Type;
    public IntPtr TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint BlobSize;
    public IntPtr Blob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes, TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", ExactSpelling = true)]
  private static extern void CredFree(IntPtr credential);
  public static string Password(string target) {
    IntPtr pointer;
    if (!Read(target, 1, 0, out pointer)) throw new InvalidOperationException("Credential unavailable");
    byte[] bytes = null;
    try {
      var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (credential.BlobSize > 2560 || credential.BlobSize % 2 != 0) throw new InvalidOperationException("Invalid credential encoding");
      bytes = new byte[credential.BlobSize];
      if (bytes.Length > 0) Marshal.Copy(credential.Blob, bytes, 0, bytes.Length);
      return new UnicodeEncoding(false, false, true).GetString(bytes);
    } finally {
      if (bytes != null) Array.Clear(bytes, 0, bytes.Length);
      CredFree(pointer);
    }
  }
}
'@
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Write([SlicerxCredential]::Password('slicerx.${service}'))`
  return [join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]]
}
