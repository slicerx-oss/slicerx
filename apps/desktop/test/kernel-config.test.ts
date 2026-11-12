// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The release step that turns the exact kernel on (release/kernel-config.mjs): the Cargo feature through the Tauri
// config, the kernel's license files as resources, the kernel's NOTICE when its source has one, and a refusal for a
// directory that is not the fetched kernel. Also the About button's shell command.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error a plain .mjs release script, no types
import { FEATURE, NOTICE_FILE, kernelResources, withKernel } from '../release/kernel-config.mjs'

const calls: string[] = []
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    calls.push(cmd)
  },
}))

const script = resolve(import.meta.dirname, '../release/kernel-config.mjs')
const slash = (p: string) => p.replaceAll('\\', '/')

/** A directory shaped like the one fetch-smlib.sh prints. */
function kernel({ notice = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sx-kernel-config-'))
  mkdirSync(join(dir, 'source', 'SMLib', 'inc'), { recursive: true })
  writeFileSync(join(dir, 'LICENSE'), 'Copyright (c) NVIDIA\nApache License\n')
  if (notice) writeFileSync(join(dir, 'NOTICE'), 'NOTICE\n')
  return dir
}

describe('kernel release config', () => {
  it('turns native-geom on and keeps the config the edition wrote', () => {
    const dir = kernel()
    const conf = withKernel({ productName: 'SlicerX', build: { features: ['x'] }, bundle: { externalBin: ['binaries/sx-watch'], resources: { 'resources/sx-watch-siglip2.onnx': 'sx-watch-siglip2.onnx' } } }, dir)
    expect(FEATURE).toBe('native-geom')
    expect(conf.productName).toBe('SlicerX')
    expect(conf.build.features).toEqual(['x', 'native-geom'])
    expect(conf.bundle.externalBin).toEqual(['binaries/sx-watch'])
    expect(conf.bundle.resources).toEqual({
      'resources/sx-watch-siglip2.onnx': 'sx-watch-siglip2.onnx',
      [slash(join(dir, 'LICENSE'))]: 'licenses/SMLib-LICENSE.txt',
      [slash(NOTICE_FILE)]: 'licenses/SMLib.txt',
    })
    // twice is the same as once
    expect(withKernel(conf, dir).build.features).toEqual(['x', 'native-geom'])
  })

  it("ships the kernel's NOTICE when its source has one", () => {
    const dir = kernel({ notice: true })
    expect(kernelResources(dir)[slash(join(dir, 'NOTICE'))]).toBe('licenses/SMLib-NOTICE.txt')
  })

  it('refuses a directory without the kernel or its license, and a config with the agent bridge', () => {
    const empty = mkdtempSync(join(tmpdir(), 'sx-kernel-config-'))
    expect(() => kernelResources(empty)).toThrow(/fetch-smlib\.sh/)
    const dir = kernel()
    rmSync(join(dir, 'LICENSE'))
    expect(() => kernelResources(dir)).toThrow(/license must ship/)
    expect(() => withKernel({ build: { features: ['agent-bridge'] } }, kernel())).toThrow(/agent-bridge/)
  })

  it('writes the config in place from the command line', () => {
    const dir = kernel()
    const conf = join(mkdtempSync(join(tmpdir(), 'sx-kernel-config-')), 'edition.conf.json')
    writeFileSync(conf, JSON.stringify({ identifier: 'app.slicerx.desktop' }))
    const out = execFileSync(process.execPath, [script, '--config', conf, '--kernel', dir], { encoding: 'utf8' })
    expect(out).toContain('kernel: on (native-geom)')
    const written = JSON.parse(readFileSync(conf, 'utf8'))
    expect(written.identifier).toBe('app.slicerx.desktop')
    expect(written.build.features).toEqual(['native-geom'])
    expect(Object.values(written.bundle.resources)).toEqual(['licenses/SMLib-LICENSE.txt', 'licenses/SMLib.txt'])
  })

  it('ships a notice that names NVIDIA and every change the swap makes', () => {
    expect(existsSync(NOTICE_FILE)).toBe(true)
    const text = readFileSync(NOTICE_FILE, 'utf8')
    expect(text).toContain('NVIDIA CORPORATION & AFFILIATES')
    expect(text).toContain('c9c5979f04cea8c38213004d4f04df0dcfb40d05')
    // the routines packages/brep/scripts/swap-routines.sh swaps, the macro and the removed file
    const swap = readFileSync(resolve(import.meta.dirname, '../../../packages/brep/scripts/swap-routines.sh'), 'utf8')
    const routines = [...swap.matchAll(/^(?:routines=')?[A-Za-z_]+\.cpp\|([A-Za-z_:]+)\|/gm)].map((m) => m[1])
    expect(routines.length).toBe(11)
    for (const r of routines) expect(text, r).toContain(r)
    for (const s of ['smos_Pythag', 'SmIntegrator.cpp', 'sx_routines.h']) expect(text).toContain(s)
  })
})

describe('the license files from About', () => {
  it('asks the shell to open its licenses folder', async () => {
    const { createTauriLicenses } = await import('../src/host/themes')
    await createTauriLicenses().openFolder()
    expect(calls).toEqual(['licenses_open_folder'])
  })
})
