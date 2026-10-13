// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slice's defaults: the right pane opens on every finished slice until the person shuts it for that project, it starts
// shut in a new session, the gantry is off and the toolhead on by default, and a client reads all of that back and turns
// the two switches through the app link the way it would over the wire.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCall } from '../src/app-link/methods'
import { slicePanes } from '../src/lib/slice-panes'
import { loadPrefs } from '../src/state/prefs'
import { get, openRightOnSlice, railOpen, sessionRails, set, setRail } from '../src/state/store'
import { clampOffset } from '../src/workspaces/prepare/plate-tools-group'

const open = () => railOpen(get().rails, 'preview', 'right', true)

describe('the right pane on a finished slice', () => {
  beforeEach(() => {
    sessionStorage.removeItem('sx-e2e')
    sessionStorage.removeItem('sx-right-pane')
    set({ rails: {}, rightShut: null, jobSeq: 1 })
  })

  it('starts shut and opens when a slice finishes', () => {
    expect(open()).toBe(false)
    openRightOnSlice()
    expect(open()).toBe(true)
  })

  it('stays shut through this project\'s slices once the person shuts it, until they open it again', () => {
    openRightOnSlice()
    setRail('preview', 'right', false)
    expect(get().rightShut).toBe(1)
    openRightOnSlice()
    expect(open()).toBe(false)
    setRail('preview', 'right', true)
    expect(get().rightShut).toBeNull()
    setRail('preview', 'right', false)
    openRightOnSlice()
    expect(open()).toBe(false)
  })

  it('opens again for the next project', () => {
    setRail('preview', 'right', false)
    set({ jobSeq: 2 })
    openRightOnSlice()
    expect(open()).toBe(true)
  })

  it('is not kept between sessions: the saved rails leave it out, so a new session starts it shut', () => {
    expect(sessionRails({ prepare: { left: false }, preview: { right: true } })).toEqual({ prepare: { left: false } })
    const rails = { prepare: { left: true } }
    expect(sessionRails(rails)).toBe(rails)
  })
})

describe('Show toolhead and Show gantry', () => {
  beforeEach(() => localStorage.clear())

  it('default to the toolhead on and the gantry off, and keep a saved choice', () => {
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare' }))
    expect(loadPrefs()).toMatchObject({ showToolhead: true, showGantry: false })
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ showToolhead: false, showGantry: true }))
    expect(loadPrefs()).toMatchObject({ showToolhead: false, showGantry: true })
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ showGantry: 'yes' }))
    expect(loadPrefs().showGantry).toBe(false)
  })
})

describe('a client reads the panes back and turns the switches', () => {
  beforeEach(() => {
    set({ preview: null, workspace: 'prepare', modelMode: 'slice', showToolhead: true, showGantry: false, rightShut: null, jobSeq: 3 })
    document.body.innerHTML = `
      <button class="sx-edge-tab" data-panel="slice-summary" aria-expanded="false"></button>
      <div class="dock" data-testid="preview-drawer" data-mode="slim"></div>
      <div data-testid="plate-tools-group" data-moved=""><div class="plate-tools"></div></div>`
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('reads the right pane, the playback bar, the switches and the toolbar', () => {
    setRail('preview', 'right', false)
    expect(slicePanes()).toMatchObject({ rightPane: 'shut', rightPaneHeldShut: true, drawer: 'shut', showToolhead: true, showGantry: false, toolbar: { moved: true } })
    document.querySelector('.sx-edge-tab')!.setAttribute('aria-expanded', 'true')
    document.querySelector('.dock')!.setAttribute('data-mode', 'full')
    expect(slicePanes()).toMatchObject({ rightPane: 'open', drawer: 'open' })
    document.body.innerHTML = ''
    expect(slicePanes()).toMatchObject({ rightPane: null, drawer: null, toolbar: null })
  })

  it('turns Show toolhead and Show gantry through preview.set and reads them back', async () => {
    expect(await runCall('preview.get', {})).toMatchObject({ toolhead: true, gantry: false, rightPane: 'shut', drawer: 'shut' })
    expect(await runCall('preview.set', { gantry: true, toolhead: false })).toMatchObject({ toolhead: false, gantry: true })
    expect(get()).toMatchObject({ showToolhead: false, showGantry: true })
    const e = (await runCall('preview.set', { gantry: 'on', toolhead: true }).catch((x: unknown) => x)) as { code: string }
    expect(e.code).toBe('invalid_input')
    // A refused call changes nothing.
    expect(get()).toMatchObject({ showToolhead: false, showGantry: true })
  })
})

describe('dragging the plate toolbar', () => {
  const area = { left: 0, top: 0, right: 800, bottom: 600 }
  const box = { left: 300, top: 12, right: 500, bottom: 100 }

  it('moves it by the drag inside the view', () => {
    expect(clampOffset({ x: 0, y: 0 }, { x: -100, y: 200 }, box, area)).toEqual({ x: -100, y: 200 })
  })

  it('keeps it inside the view, 8 px from each edge', () => {
    expect(clampOffset({ x: 0, y: 0 }, { x: -1000, y: -1000 }, box, area)).toEqual({ x: -292, y: -4 })
    expect(clampOffset({ x: 10, y: 10 }, { x: 1000, y: 1000 }, box, area)).toEqual({ x: 10 + 292, y: 10 + 492 })
  })
})
