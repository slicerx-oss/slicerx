// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client opens a textured OBJ in the desktop app with its MTL and image beside it, as a person double-clicks it,
// and then paints it from the texture through the app link: open_in_app says which of the files the OBJ names are in
// its folder (the app reads them from there), and app_paint_from_texture previews the paint and app_paint_apply
// applies it.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { appPaintTools } from '../src/app-paint'
import type { AppLinkCaller } from '../src/app-route'
import { objTexture, openInApp } from '../src/open-in-app'

describe('a textured OBJ opened in the app and painted from its texture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-open-tex-'))
  const obj = join(dir, 'cube.obj')
  writeFileSync(obj, 'mtllib cube.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl skin\nf 1/1 2/2 3/3\n')
  writeFileSync(join(dir, 'cube.mtl'), 'newmtl skin\nKd 1 1 1\nmap_Kd -clamp on tex/skin.png\nnewmtl band\nmap_Kd band.jpg\n')
  mkdirSync(join(dir, 'tex'))
  writeFileSync(join(dir, 'tex', 'skin.png'), 'png')

  it('opens the OBJ, says which texture files are beside it, then previews and applies the paint', async () => {
    const calls: string[][] = []
    const opened = await openInApp(obj, async (cmd, args) => void calls.push([cmd, ...args]), 'darwin')
    expect(calls).toEqual([['open', obj]])
    expect(opened.texture).toEqual({ found: ['cube.mtl', 'tex/skin.png'], missing: ['band.jpg'] })

    const link = vi.fn(async (method: string, args: Record<string, unknown>) => (method === 'paint.from_texture' ? { output: { preview: 'p1', changed: true, args } } : { output: { changed: true, args } }))
    const tools = appPaintTools({ call: link } as unknown as AppLinkCaller, 'SlicerX')
    const run = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(args as never, {} as never)
    await run('app.paint_from_texture', { object: 'cube', mode: 'nearest' })
    await run('app.paint_apply', { preview: 'p1' })
    expect(link.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['paint.from_texture', { object: 'cube', mode: 'nearest' }],
      ['paint.apply', { preview: 'p1' }],
    ])
  })

  it('reads no name outside the OBJ folder, and nothing for an OBJ without an MTL', () => {
    const odd = join(dir, 'odd.obj')
    writeFileSync(odd, 'mtllib ../secret.mtl\nmtllib C:/x.mtl\nv 0 0 0\n')
    expect(objTexture(odd)).toEqual({ found: [], missing: ['../secret.mtl', 'C:/x.mtl'] })
    const bare = join(dir, 'bare.obj')
    writeFileSync(bare, 'v 0 0 0\n')
    expect(objTexture(bare)).toBeUndefined()
  })

  it('counts no file reached through a symbolic link or a junction, or a name of dots and spaces', () => {
    const top = mkdtempSync(join(tmpdir(), 'sx-open-tex-link-'))
    const models = join(top, 'models')
    mkdirSync(join(top, 'outside'))
    mkdirSync(models)
    writeFileSync(join(top, 'secret.png'), 'secret')
    writeFileSync(join(top, 'outside', 'a.png'), 'secret')
    writeFileSync(join(top, 'outside', 'b.mtl'), 'newmtl b\nmap_Kd a.png\n')
    const o = join(models, 'link.obj')
    writeFileSync(o, 'mtllib cube.mtl\nmtllib maps/b.mtl\nv 0 0 0\n')
    writeFileSync(join(models, 'cube.mtl'), 'newmtl a\nmap_Kd tex.png\nnewmtl b\nmap_Kd maps/a.png\nnewmtl c\nmap_Kd .. /secret.png\nnewmtl d\nmap_Kd ... /secret.png\n')
    symlinkSync(join(top, 'secret.png'), join(models, 'tex.png'), 'file')
    symlinkSync(join(top, 'outside'), join(models, 'maps'), 'junction')
    expect(objTexture(o)).toEqual({ found: ['cube.mtl'], missing: ['tex.png', 'maps/a.png', '.. /secret.png', '... /secret.png', 'maps/b.mtl'] })
  })

  it('refuses a mode it does not know and an empty object', async () => {
    const tools = appPaintTools({ call: vi.fn() } as unknown as AppLinkCaller, 'SlicerX')
    const input = tools.find((t) => t.name === 'app.paint_from_texture')!.input
    expect(input.safeParse({ object: 'cube' }).data).toEqual({ object: 'cube', mode: 'nearest' })
    expect(input.safeParse({ object: '', mode: 'nearest' }).success).toBe(false)
    expect(input.safeParse({ object: 'cube', mode: 'dither' }).success).toBe(false)
  })
})
