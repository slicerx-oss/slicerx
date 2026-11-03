// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Designs from the Vault leave SlicerX only as .sx3mf. A 3MF, .sx3mf or .gcode.3mf that names a library listing
// (sx:Listing, on the root model or on an object) is refused by the tools that write a mesh; slicing and inspecting it
// still work, and its .gcode.3mf leaves without the model (gcode3mf.ts). The marks are read as XML
// (packages/contracts/src/sx3mf-marks.ts), so quoting, attribute order and position in the file do not matter.
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { basename } from 'node:path'
import { MarkReadError, readVaultMarks, type VaultMark, type VaultMarks } from '@slicerx/contracts/sx3mf-marks'
import { productName } from '@slicerx/contracts'
import { ToolInputError } from './models'
import { readZip } from './zip'

const MARKED_SETTINGS = ['Metadata/model_settings.config', 'Metadata/Slic3r_PE_model.config']

/** True when the file starts like a ZIP package: a 3MF, whatever its name. */
export function looksZipped(path: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(4)
    return readSync(fd, head, 0, 4, 0) === 4 && head.readUInt32LE(0) === 0x04034b50
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

type Verdict = { vault: false } | { vault: true; unreadable?: string; mark?: VaultMark }

/** The first mark that names a listing: the root's, else an object's. */
function listingMark(marks: VaultMarks): VaultMark | undefined {
  if (marks.root.listing) return marks.root
  for (const m of marks.objects.values()) if (m.listing) return m
  return undefined
}

function inspect(path: string): Verdict {
  if (!looksZipped(path)) return { vault: false }
  let zip
  try {
    zip = readZip(readFileSync(path), basename(path))
  } catch {
    return { vault: false }
  }
  try {
    for (const name of zip.names()) {
      const mark = /\.model$/i.test(name) ? listingMark(readVaultMarks(zip.read(name)?.toString('utf8') ?? '')) : undefined
      if (mark) return { vault: true, mark }
    }
    for (const name of MARKED_SETTINGS) {
      const text = zip.read(name)?.toString('utf8')
      const mark = text ? listingMark(readVaultMarks(text, true)) : undefined
      if (mark) return { vault: true, mark }
    }
  } catch (e) {
    // A part with a DTD could hide a mark behind an entity, and one that cannot be read could hold one anywhere.
    if (e instanceof MarkReadError || e instanceof ToolInputError) return { vault: true, unreadable: e.message }
    throw e
  }
  return { vault: false }
}

/** True when the file is a 3MF package (of any name) that carries an sx:Listing, or one whose marks cannot be read. */
export function isVaultFile(path: string): boolean {
  return inspect(path).vault
}

/**
 * The Vault listing and creator a file names, for the print file made from it (gcode3mf.ts), or null for a file that is
 * not a Vault design. A file whose marks cannot be read counts as one with an unknown listing.
 */
export function vaultMark(path: string): VaultMark | null {
  const v = inspect(path)
  return v.vault ? (v.mark ?? {}) : null
}

/** Throws when a mesh tool is given a Vault design. */
export function refuseVaultFile(path: string): void {
  const v = inspect(path)
  if (!v.vault) return
  if (v.unreadable) throw new ToolInputError(`${basename(path)} could not be checked for a Vault listing: ${v.unreadable}`, 'invalid_model')
  throw new ToolInputError(`${basename(path)} is a design from the Vault, which leaves ${productName()} only as .sx3mf. Slicing and printing it still work.`, 'unsupported_format')
}
