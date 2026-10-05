// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Locked projects (.sxlock): the .sx3mf encrypted so only the exporting SlicerX account can open it
// (packages/sx3mf/SPEC-sxlock.md). The account's store holds the keys; opening needs it online.
import type { EditionHost, FileRef, Host, SxlockKeys } from '@slicerx/contracts'
import { allPlates, projectBase } from '../plate/plates'
import { setLockedSession } from '../project/locked-session'
import { get, openSettings, toast } from '../state/store'
import { sx3mfBytes } from './actions'
import { appName } from '../edition'

export const LOCKED_EXT = '.sxlock'
export const isLockedName = (name: string): boolean => /\.sxlock$/i.test(name)

/** The host's keys (an embedding app's token), else the signed-in account's, or null for a build without accounts. */
function accountKeys(host: Host): SxlockKeys | null {
  const edition = host as EditionHost
  if (edition.sxlock) return edition.sxlock
  const store = edition.store
  if (!store) return null
  return { seal: (salt) => store.sxlockSeal(salt), open: (ref) => store.sxlockOpen(ref) }
}

const NO_ACCOUNTS = 'Locked projects need an account, and this build has none.'

/** Export the project as a locked .sxlock that only this account can open. */
export async function exportLockedProject(host: Host): Promise<boolean> {
  const plates = allPlates(get())
  if (plates.every((p) => p.objects.length === 0)) {
    toast('There is nothing on the plates to export.', 'info')
    return false
  }
  const keys = accountKeys(host)
  if (!keys) {
    toast(NO_ACCOUNTS, 'error')
    return false
  }
  const { lockSxlock } = await import('@slicerx/embed/sxlock')
  let locked: Awaited<ReturnType<typeof lockSxlock>>
  try {
    locked = await lockSxlock(await sx3mfBytes(plates), keys)
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not lock the project', 'error')
    return false
  }
  const ref = await host.files.save(`${projectBase()}${LOCKED_EXT}`, new Blob([locked.bytes as BlobPart], { type: 'application/vnd.slicerx.sxlock' }), { accept: [LOCKED_EXT] })
  if (!ref) return false
  toast(`Saved ${ref.name}. Only your ${appName()} account can open it.`, 'ok')
  // The open project is locked now too: its autosave is rewritten sealed, replacing any copy in the clear.
  setLockedSession(locked.fileKey)
  await (await import('../project/autosave')).autosaveNow().catch(() => false)
  return true
}

/**
 * Reads and unlocks every locked file in refs before anything on the plate changes, so a refusal (offline,
 * another account, a revoked key) leaves the open project as it was. Returns the .sx3mf bytes per locked ref
 * under an .sx3mf name, or null after telling the person why it could not open.
 */
export async function unlockRefs(host: Host, refs: readonly FileRef[]): Promise<Map<FileRef, { name: string; data: ArrayBuffer }> | null> {
  const out = new Map<FileRef, { name: string; data: ArrayBuffer }>()
  for (const ref of refs.filter((r) => isLockedName(r.name))) {
    const opened = await unlockBytes(host, ref.name, await host.files.read(ref))
    if (!opened) return null
    out.set(ref, opened)
  }
  return out
}

/**
 * Unlocks one locked project (a file or a sealed autosave) and keeps its key in memory, so autosave goes on
 * sealing it. Null after telling the person why not; signed out, the account settings open to sign in.
 */
export async function unlockBytes(host: Host, name: string, data: ArrayBuffer): Promise<{ name: string; data: ArrayBuffer } | null> {
  const keys = accountKeys(host)
  if (!keys) {
    toast(NO_ACCOUNTS, 'error')
    return null
  }
  const { SxlockError, unlockSxlock } = await import('@slicerx/embed/sxlock')
  try {
    const { sx3mf, fileKey } = await unlockSxlock(new Uint8Array(data), keys)
    setLockedSession(fileKey)
    return { name: name.replace(/\.sxlock$/i, '.sx3mf'), data: sx3mf.slice().buffer }
  } catch (e) {
    toast(`${name}: ${e instanceof Error ? e.message : 'could not be opened'}`, 'error')
    if (e instanceof SxlockError && e.code === 'signed_out') openSettings('account')
    return null
  }
}
