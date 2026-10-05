// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs everything the main process of Spoolhouse does once: read the project, slice its plate with the
// user's presets and a filament per slot, show the error codes, and lock and open a project when an
// account token is configured. Writes out/report.json and public/preview.sxpv for the window.
//   SLICERX_SX_BIN=/path/to/sx npm run slice
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountFromEnv, lockAndOpen, notLocked } from './locked.ts'
import { SlicerXError, startSlicerX } from './slicerx.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const library = join(root, 'fixtures')
const out = resolve(process.env['SPOOLHOUSE_OUT'] ?? join(root, 'out'))
const work = join(out, 'private')
const sxBin = process.env['SLICERX_SX_BIN']
if (!sxBin) {
  console.error('Set SLICERX_SX_BIN to the sx engine (cargo build -p sx-cli --release builds target/release/sx).')
  process.exit(2)
}
rmSync(out, { recursive: true, force: true })
mkdirSync(work, { recursive: true, mode: 0o700 })

const project = join(library, 'x-mark-2color.3mf')
const slicerx = await startSlicerX({ sxBin, libraryDirs: [library, work], outDir: out })
const report: Record<string, unknown> = {}
try {
  report['project'] = await slicerx.inspect(project)

  const stages: { progress: number; message: string }[] = []
  const slice = await slicerx.slice(
    {
      model: project,
      plate: 1,
      profiles: ['machine:bambu-a1', 'process:standard'],
      filaments: [
        { slot: 1, profile: 'stock-filament:BBL/Bambu PLA Basic @BBL A1', color: '#F4EE2A' },
        { slot: 2, file: join(library, 'My PETG.json'), color: '#00AE42' },
      ],
      overrides: { sparse_infill_density: 20 },
      output: 'gcode.3mf',
      preview: true,
    },
    (progress, message) => stages.push({ progress, message }),
  )
  report['slice'] = slice
  report['progress'] = stages

  // Each refusal has a stable code to branch on.
  const codes: Record<string, string> = {}
  const expectCode = async (name: string, args: Record<string, unknown>) => {
    try {
      await slicerx.slice(args)
      codes[name] = 'no error'
    } catch (e) {
      if (!(e instanceof SlicerXError)) throw e
      codes[name] = e.code
    }
  }
  await expectCode('missing plate', { model: project, plate: 9 })
  await expectCode('outside the library', { model: join(root, 'package.json') })
  await expectCode('unknown profile', { model: project, profiles: ['machine:no-such-printer'] })
  await expectCode('bad setting', { model: project, overrides: { layer_height: 'thick' } })
  report['errors'] = codes

  const bytes = new Uint8Array(readFileSync(project))
  report['not_locked'] = notLocked(bytes)
  const account = accountFromEnv()
  if (!account) {
    report['sxlock'] = { skipped: 'no account token: set SLICERX_MCP_SXLOCK_TOKEN, SLICERX_MCP_SUPABASE_URL and SLICERX_MCP_SUPABASE_ANON_KEY' }
  } else {
    const { owner, same, locked, opened: openedBytes } = await lockAndOpen(bytes, account)
    writeFileSync(join(out, 'x-mark.sxlock'), locked)
    // The opened project goes where only this app reads it, is sliced, then deleted.
    const opened = join(work, 'x-mark.sx3mf')
    writeFileSync(opened, openedBytes, { mode: 0o600 })
    const s = await slicerx.slice({ model: opened, plate: 1, profiles: ['machine:bambu-a1', 'stock-filament:BBL/Bambu PLA Basic @BBL A1'] })
    rmSync(opened)
    report['sxlock'] = { owner, same, sliced_g: s.filament_g }
  }

  if (slice.preview_path) {
    mkdirSync(join(root, 'public'), { recursive: true })
    copyFileSync(slice.preview_path, join(root, 'public', 'preview.sxpv'))
    writeFileSync(join(root, 'public', 'slice.json'), JSON.stringify({ time_text: slice.time_text, filament_g: slice.filament_g, filaments: slice.filaments }))
  }
} finally {
  await slicerx.close()
}
writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
