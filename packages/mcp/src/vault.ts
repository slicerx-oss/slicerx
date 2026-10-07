// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Designs from the Vault leave SlicerX only as .sx3mf. A 3MF, .sx3mf or .gcode.3mf that names a library listing
// (sx:Listing, on the root model or on an object) is refused by the tools that write a mesh; slicing and inspecting it
// still work. The marks are read as XML (packages/contracts/src/sx3mf-marks.ts), so quoting, attribute order and
// position in the file do not matter.
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { basename } from 'node:path'
import { hasListing, MarkReadError, readVaultMarks } from '@slicerx/contracts/sx3mf-marks'
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

type Verdict = { vault: false } | { vault: true; unreadable?: string }

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
      if (/\.model$/i.test(name) && hasListing(readVaultMarks(zip.read(name)?.toString('utf8') ?? ''))) return { vault: true }
    }
    for (const name of MARKED_SETTINGS) {
      const text = zip.read(name)?.toString('utf8')
      if (text && hasListing(readVaultMarks(text, true))) return { vault: true }
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

/** Throws when a mesh tool is given a Vault design. */
export function refuseVaultFile(path: string): void {
  const v = inspect(path)
  if (!v.vault) return
  if (v.unreadable) throw new ToolInputError(`${basename(path)} could not be checked for a Vault listing: ${v.unreadable}`, 'invalid_model')
  throw new ToolInputError(`${basename(path)} is a design from the Vault, which leaves SlicerX only as .sx3mf. Slicing and printing it still work.`, 'unsupported_format')
}
