// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening a textured model: an OBJ picked or dropped with its MTL and images, or a 3MF with textures. Before the
// model opens, its texture source is kept (the open may hand the file's bytes to a worker); once it is on the plate,
// texture-paint.ts paints it.
import type { FileRef, Host } from '@slicerx/contracts'
import { unzipEntries } from '../export/unzip'
import { get, toast } from '../state/store'
import { allPlates } from './plates'
import { modelHasTextures, objCompanions, paintOpenedFromTexture, threemfMayHaveTextures, type TextureSource } from './texture-paint'

/** Files read only as an OBJ's material and images. */
export const TEXTURE_FILE = /\.(mtl|png|jpe?g)$/i

const MTLLIB = new TextEncoder().encode('mtllib')

function names(refs: readonly FileRef[]): string {
  return refs.map((r) => r.name).join(', ')
}

/** Whether the first 4 MB of `bytes` hold `word` (a short ASCII word); an OBJ names its MTL near the top. */
function holds(bytes: Uint8Array, word: Uint8Array): boolean {
  const end = Math.min(bytes.length, 4 * 1024 * 1024)
  outer: for (let i = 0; i + word.length <= end; i++) {
    for (let k = 0; k < word.length; k++) if (bytes[i + k] !== word[k]) continue outer
    return true
  }
  return false
}

/** The most files read from an OBJ's folder for its texture. */
export const MAX_BESIDE_FILES = 64
/** The most bytes an OBJ's texture files may add up to, the OBJ's own folder and the files opened with it together. */
export const MAX_TEXTURE_BYTES = 256 * 1024 * 1024

/**
 * The MTL and image files an OBJ names that are not in `read`, from the OBJ's own folder when the host can read there
 * (desktop, for a file the system opened). The MTL files first, since they name the images. At most
 * `MAX_BESIDE_FILES` files, and each read is held to what is left of `MAX_TEXTURE_BYTES`.
 */
async function readBeside(host: Host, ref: FileRef | undefined, obj: Uint8Array, read: Record<string, Uint8Array>): Promise<void> {
  const fetch = host.files.readBeside
  if (!fetch || !ref?.path) return
  let left = MAX_TEXTURE_BYTES - Object.values(read).reduce((n, b) => n + b.byteLength, 0)
  let asked = 0
  for (const round of [0, 1]) {
    const { mtl, missing } = objCompanions(obj, read)
    for (const n of missing) {
      if (round === 0 && !mtl.includes(n)) continue
      if (asked >= MAX_BESIDE_FILES || left <= 0) return
      asked += 1
      const bytes = await fetch.call(host.files, ref, n, left).catch(() => null)
      if (!bytes || bytes.byteLength > left) continue
      read[n] = new Uint8Array(bytes)
      left -= bytes.byteLength
    }
  }
}

/**
 * The texture source of a model about to open, or null when it has none. `files` are the MTL and image files opened
 * with it; `ref` is the model's own file, whose folder a desktop host reads the others from. Reads what it needs
 * before the open, which may hand `data` to a worker.
 */
export async function textureBefore(host: Host, name: string, data: ArrayBuffer, files: readonly FileRef[], ref?: FileRef): Promise<TextureSource | null> {
  const bytes = new Uint8Array(data)
  if (/\.3mf$/i.test(name)) {
    // the names first, which costs no inflating; then the model files, only when an image could be a texture
    const entries: string[] = []
    try {
      await unzipEntries(bytes, undefined, (n) => {
        entries.push(n)
        return false
      })
      if (!threemfMayHaveTextures(entries)) return null
      const models = await unzipEntries(bytes, undefined, (n) => /\.model$/i.test(n))
      if (![...models.values()].some(modelHasTextures)) return null
    } catch {
      return null
    }
    return { kind: '3mf', name, data: bytes.slice() }
  }
  if (!/\.obj$/i.test(name) || !holds(bytes, MTLLIB)) return null
  const read: Record<string, Uint8Array> = {}
  for (const f of files) read[f.name] = new Uint8Array(await host.files.read(f))
  const obj = bytes.slice()
  await readBeside(host, ref, obj, read)
  const { images, missing } = objCompanions(obj, read)
  if (missing.length) {
    const what = images.length || missing.some((m) => !/\.mtl$/i.test(m)) ? 'texture' : 'material'
    toast(`${name} uses ${missing.join(', ')}. Open ${missing.length === 1 ? 'it' : 'them'} together with the OBJ to paint its ${what}.`, 'info')
    if (!images.some((i) => !missing.includes(i))) return null
  }
  return { kind: 'obj', name, obj, files: read }
}

/**
 * The OBJ as the import should get it once its texture is kept: each `mtllib` line commented out. The import never
 * gets the MTL (the texture paint reads it), so it would warn that the material file is missing; with no material
 * file it reads the same parts either way. Same length, so nothing else moves.
 */
export function withoutMtllib(data: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(data.slice(0))
  for (let i = 0; i + MTLLIB.length <= out.length; i++) {
    if (i > 0 && out[i - 1] !== 10 && out[i - 1] !== 13) continue
    // past the line's leading spaces and tabs
    let j = i
    while (out[j] === 32 || out[j] === 9) j++
    let k = 0
    while (k < MTLLIB.length && out[j + k] === MTLLIB[k]) k++
    if (k === MTLLIB.length) out[j] = 35 // '#'
  }
  return out.buffer
}

/** Every object id on every plate. */
export function plateIds(): Set<string> {
  return new Set(allPlates(get()).flatMap((p) => p.objects.map((o) => o.id)))
}

/** The objects added since `before`. */
export function addedSince(before: ReadonlySet<string>): string[] {
  return [...plateIds()].filter((id) => !before.has(id))
}

/** Paints each opened model from its texture, one undo step each. */
export async function paintOpened(pending: readonly { src: TextureSource; ids: string[] }[]): Promise<void> {
  for (const p of pending) if (p.ids.length) await paintOpenedFromTexture(p.ids, p.src)
}

/** Says what to do when only an OBJ's material or image files were opened. */
export function onlyTextureFiles(refs: readonly FileRef[]): void {
  toast(`${names(refs)} ${refs.length === 1 ? 'is' : 'are'} read with an OBJ. Open the OBJ together with its MTL and image files.`, 'info')
}
