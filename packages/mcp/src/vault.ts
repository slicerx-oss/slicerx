// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Designs from the Vault leave SlicerX only as .sx3mf. A 3MF or .sx3mf that names a library listing (sx:Listing, on
// the root model or on an object) is refused by the tools that write a mesh; slicing and inspecting it still work.
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { ToolInputError } from './models'
import { readZip } from './zip'

/** True when the file is a 3MF or .sx3mf that carries an sx:Listing. */
export function isVaultFile(path: string): boolean {
  if (!['.3mf', '.sx3mf'].includes(extname(path).toLowerCase())) return false
  let zip
  try {
    zip = readZip(readFileSync(path), basename(path))
  } catch {
    return false
  }
  const root = zip.read('3D/3dmodel.model', 64 * 1024 * 1024)?.subarray(0, 1 << 20).toString('utf8') ?? ''
  if (/<metadata\s+name="sx:Listing"\s*>\s*[^<\s]/.test(root)) return true
  const settings = zip.text('Metadata/model_settings.config') ?? ''
  return /<metadata\s+key="sx:Listing"\s+value="[^"]+"/.test(settings)
}

/** Throws when a mesh tool is given a Vault design. */
export function refuseVaultFile(path: string): void {
  if (isVaultFile(path)) {
    throw new ToolInputError(`${basename(path)} is a design from the Vault, which leaves SlicerX only as .sx3mf. Slicing and printing it still work.`, 'unsupported_format')
  }
}
