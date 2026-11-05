// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opens a model or project in the SlicerX desktop app on this computer, the way a person double-clicks it: through the
// system's opener, which hands the file to the app registered for its type. The browser's "Open in SlicerX" button
// does the same for a project through the app's link.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, sep } from 'node:path'
import { ToolInputError, typesText } from './models'

/**
 * The files this tool hands to the app: every type the desktop app takes from the system (its accept list for opened
 * files and its file associations, which the tests hold this list to). Projects, locked projects, models (a STEP file
 * is meshed by the app's own reader as it opens) and G-code, which opens in the preview.
 */
export const APP_OPENS: readonly string[] = ['.sx3mf', '.3mf', '.sxlock', '.stl', '.obj', '.amf', '.step', '.stp', '.igs', '.iges', '.gcode']

/** ".sx3mf, .3mf, .sxlock, .stl, .obj, .amf, .step, .stp, .igs, .iges or .gcode" */
export const APP_OPENS_TEXT = typesText(APP_OPENS)

/** The system's opener for a file: open on macOS, start on Windows, xdg-open elsewhere. */
export function openerFor(platform: NodeJS.Platform, file: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [file] }
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', file] }
  return { cmd: 'xdg-open', args: [file] }
}

export interface Opened {
  file: string
  /** The command that handed it over. */
  command: string
  /** For an OBJ that names an MTL: the material and image files the app reads from its folder, and the ones missing. */
  texture?: ObjTexture
}

/** The files an OBJ's texture needs, by the names the OBJ and its MTL give them. */
export interface ObjTexture {
  found: string[]
  missing: string[]
}

/**
 * A name the app reads beside an OBJ: relative, no parent steps, no drive, a material or an image, and no part only
 * dots and spaces or ending in a dot or a space (Windows drops those from the end of a name).
 */
function plainName(n: string): string | null {
  const name = n.trim().replace(/\\/g, '/')
  const plain = name !== '' && !name.startsWith('/') && !/[:\0]/.test(name) && name.split('/').every((s) => s !== '' && !/^[. ]+$/.test(s) && !/[. ]$/.test(s))
  return plain && /\.(mtl|png|jpe?g)$/i.test(name) ? name : null
}

/** The most bytes of an MTL read to find its images; the app reads no more than its texture cap either. */
const MAX_MTL_BYTES = 16 * 1024 * 1024

/** The first `max` bytes of a file, read through one handle. */
function head(path: string, max: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(Math.min(statSync(path).size, max))
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

/**
 * The path of a file an OBJ names in its folder, as the app reads it: every step from the folder down checked without
 * following links (a symbolic link or a junction anywhere counts as outside), a plain file at the end, and its real
 * path inside the folder's. Null otherwise.
 */
function besideFile(dir: string, n: string): string | null {
  const name = plainName(n)
  if (!name) return null
  try {
    let at = dir
    for (const part of name.split('/')) {
      at = join(at, part)
      if (lstatSync(at).isSymbolicLink()) return null
    }
    if (!lstatSync(at).isFile()) return null
    const base = realpathSync.native(dir)
    const real = realpathSync.native(at)
    return real.startsWith(base.endsWith(sep) ? base : base + sep) ? at : null
  } catch {
    return null
  }
}

/** The image a `map_Kd` line names, past its options. */
function mapName(rest: string): string {
  const toks = rest.trim().split(/\s+/)
  let i = 0
  while (i < toks.length && toks[i]!.startsWith('-')) {
    const o = toks[i]!
    i += 1
    if (o === '-o' || o === '-s' || o === '-t') for (let n = 0; n < 3 && i < toks.length && !Number.isNaN(Number(toks[i])); n++) i += 1
    else i += o === '-mm' ? 2 : 1
  }
  return toks.slice(i).join(' ')
}

/**
 * The MTL and image files an OBJ names and whether each is in its folder, as the desktop app looks for them when the
 * OBJ opens; undefined for an OBJ that names no MTL. Reads the first 4 MB of the OBJ, where it names its MTL.
 */
export function objTexture(file: string): ObjTexture | undefined {
  const text = head(file, 4 * 1024 * 1024).toString('utf8')
  const mtl = [...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((m) => m[1]!)
  if (!mtl.length) return undefined
  const dir = dirname(file)
  const at = (n: string) => besideFile(dir, n)
  const found: string[] = []
  const missing: string[] = []
  for (const m of mtl) {
    const p = at(m)
    if (!p) {
      missing.push(m)
      continue
    }
    found.push(m)
    for (const line of head(p, MAX_MTL_BYTES).toString('utf8').split(/\r?\n/)) {
      const hit = /^\s*map_Kd\s+(.+)$/i.exec(line)
      const img = hit ? mapName(hit[1]!) : ''
      if (!img || found.includes(img) || missing.includes(img)) continue
      ;(at(img) ? found : missing).push(img)
    }
  }
  return { found, missing }
}

/** Hands `file` to the desktop app. Throws a tool input error for a missing or unsupported file. */
export async function openInApp(file: string, run: (cmd: string, args: string[]) => Promise<void> = launch, platform: NodeJS.Platform = process.platform): Promise<Opened> {
  if (!APP_OPENS.includes(extname(file).toLowerCase())) throw new ToolInputError(`${basename(file)} is not a file the app opens (${APP_OPENS_TEXT})`, 'unsupported_format')
  if (!existsSync(file)) throw new ToolInputError(`${file} does not exist`, 'invalid_model')
  const texture = extname(file).toLowerCase() === '.obj' ? objTexture(file) : undefined
  const { cmd, args } = openerFor(platform, file)
  await run(cmd, args)
  return { file, command: [cmd, ...args].join(' '), ...(texture ? { texture } : {}) }
}

function launch(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
