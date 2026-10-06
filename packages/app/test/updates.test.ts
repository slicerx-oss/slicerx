// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// In-app updates: checks at launch and daily, a background download, then Restart to update or Later. It never
// restarts by itself and holds the restart while a print is being sent. The dialog shows each step in the gods style.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateDialogView, type UpdateDialogViewProps } from '../src/updates/dialog'
import {
  checkForUpdates,
  DAY_MS,
  FIRST_CHECK_MS,
  getUpdateState,
  holdUpdates,
  laterUpdate,
  notifyBusy,
  noteLines,
  registerUpdater,
  resetUpdates,
  restartToUpdate,
  retryUpdate,
  shorten,
  startUpdates,
  updatesHeld,
  watchBusy,
  type FoundUpdate,
  type UpdatePhase,
  type UpdaterHost,
} from '../src/updates/updates'

beforeAll(() => {
  // jsdom has no modal dialogs.
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

const NOTES = [
  '- Fillet the round edge where a face meets a cylinder',
  '- Pick and round a hole rim in the fillet tool',
  '- Bambu Lab A1 prints through Bambu Connect when Developer Mode is off',
  '- Faster slicing on big plates',
  '- The camera loader shows huginn and muninn',
  '- A sixth line that never shows',
].join('\n')
const found: FoundUpdate = { version: '0.2.0', notes: NOTES, releaseUrl: 'https://github.com/slicerx-oss/slicerx/releases/tag/desktop-v0.2.0' }

function fakeHost(over: Partial<UpdaterHost> = {}) {
  const calls = { check: 0, download: 0, restart: 0 }
  const host: UpdaterHost = {
    mode: 'install',
    check: async () => (calls.check++, found),
    download: async (onProgress) => {
      calls.download++
      onProgress(5_000_000, 20_000_000)
      onProgress(20_000_000, 20_000_000)
    },
    restart: async () => void calls.restart++,
    ...over,
  }
  registerUpdater(host)
  return calls
}

beforeEach(() => resetUpdates())
afterEach(() => {
  vi.useRealTimers()
  resetUpdates()
})

describe('release highlights', () => {
  it('keeps the first five lines without list marks or headings', () => {
    expect(noteLines(NOTES)).toEqual([
      'Fillet the round edge where a face meets a cylinder',
      'Pick and round a hole rim in the fillet tool',
      'Bambu Lab A1 prints through Bambu Connect when Developer Mode is off',
      'Faster slicing on big plates',
      'The camera loader shows huginn and muninn',
    ])
    expect(noteLines('## What changed\n\n* One\n2. Two\n\n')).toEqual(['One', 'Two'])
    expect(noteLines('')).toEqual([])
  })

  it('cuts a long line at a word boundary with an ellipsis', () => {
    const long = 'Prints that start from the queue now wait for the bed to cool below the temperature the material asks for before the next part'
    const out = shorten(long, 100)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out.endsWith('…')).toBe(true)
    expect(long.startsWith(out.slice(0, -1))).toBe(true)
    expect(shorten('short', 100)).toBe('short')
    expect(noteLines(long)[0]).toBe(out)
  })
})

describe('the update flow', () => {
  it('checks a little after launch, downloads in the background and asks once the update is ready', async () => {
    vi.useFakeTimers()
    const calls = fakeHost()
    startUpdates()
    expect(calls.check).toBe(0)
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
    expect(calls).toEqual({ check: 1, download: 1, restart: 0 })
    expect(getUpdateState()).toEqual({ phase: { kind: 'ready', update: found }, open: true })
    // nothing restarts until the person clicks
    expect(calls.restart).toBe(0)
  })

  it('checks again after a day, not before', async () => {
    vi.useFakeTimers()
    const calls = fakeHost({ check: async () => (calls.check++, null) })
    startUpdates()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
    expect(calls.check).toBe(1)
    await vi.advanceTimersByTimeAsync(DAY_MS - 2 * 60 * 60 * 1000)
    expect(calls.check).toBe(1)
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000)
    expect(calls.check).toBe(2)
    // a scheduled check that finds nothing never opens the dialog
    expect(getUpdateState().open).toBe(false)
  })

  it('stays quiet when a scheduled check fails, and says why when the person asked', async () => {
    fakeHost({ check: async () => Promise.reject(new Error('The feed did not answer')) })
    await checkForUpdates()
    expect(getUpdateState()).toEqual({ phase: { kind: 'idle' }, open: false })
    await checkForUpdates({ manual: true })
    expect(getUpdateState()).toEqual({ phase: { kind: 'error', message: 'The feed did not answer' }, open: true })
  })

  it('says the newest version is installed when the person asked', async () => {
    fakeHost({ check: async () => null })
    await checkForUpdates({ manual: true })
    expect(getUpdateState()).toEqual({ phase: { kind: 'current' }, open: true })
    laterUpdate()
    expect(getUpdateState()).toEqual({ phase: { kind: 'idle' }, open: false })
  })

  it('waits for a print send to finish before it asks, and holds the restart while one runs', async () => {
    const calls = fakeHost()
    const release = holdUpdates()
    await checkForUpdates()
    expect(getUpdateState()).toEqual({ phase: { kind: 'ready', update: found }, open: false })
    await restartToUpdate()
    expect(calls.restart).toBe(0)
    release()
    expect(getUpdateState().open).toBe(true)
    // releasing twice does not count twice
    release()
    expect(updatesHeld()).toBe(false)
    await restartToUpdate()
    expect(calls.restart).toBe(1)
    expect(getUpdateState().phase.kind).toBe('installing')
  })

  it("counts the app's own Print sheet and approval card, and keeps closed during first run", async () => {
    let sheet = true
    let firstRun = true
    watchBusy(() => sheet, () => firstRun)
    fakeHost()
    await checkForUpdates()
    expect(updatesHeld()).toBe(true)
    expect(getUpdateState().open).toBe(false)
    sheet = false
    notifyBusy()
    expect(getUpdateState().open).toBe(false)
    firstRun = false
    notifyBusy()
    expect(getUpdateState().open).toBe(true)
  })

  it('restarts only after unsaved changes are settled, and not when the person cancels', async () => {
    const calls = fakeHost()
    await checkForUpdates()
    await restartToUpdate(async () => false)
    expect(calls.restart).toBe(0)
    expect(getUpdateState().phase.kind).toBe('ready')
    // a send that starts while the question is open still wins
    await restartToUpdate(async () => (holdUpdates(), true))
    expect(calls.restart).toBe(0)
  })

  it('asks again a day after Later, and at once when the person checks', async () => {
    vi.useFakeTimers()
    const calls = fakeHost()
    startUpdates()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS)
    laterUpdate()
    expect(getUpdateState()).toEqual({ phase: { kind: 'ready', update: found }, open: false })
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(getUpdateState().open).toBe(false)
    await checkForUpdates({ manual: true })
    expect(getUpdateState().open).toBe(true)
    // the ready download is the answer: no second check or download
    expect(calls).toMatchObject({ check: 1, download: 1 })
    laterUpdate()
    // the hourly tick after a day has passed
    await vi.advanceTimersByTimeAsync(DAY_MS - 2 * 60 * 60 * 1000)
    expect(getUpdateState().open).toBe(false)
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000)
    expect(getUpdateState().open).toBe(true)
  })

  it('shows a failed download and tries it again', async () => {
    let fail = true
    const calls = fakeHost({
      download: async () => {
        calls.download++
        if (fail) throw new Error('Signature does not match')
      },
    })
    await checkForUpdates({ manual: true })
    expect(getUpdateState().phase).toEqual({ kind: 'error', message: 'Signature does not match', update: found })
    fail = false
    retryUpdate()
    await vi.waitFor(() => expect(getUpdateState().phase.kind).toBe('ready'))
    expect(calls).toMatchObject({ check: 1, download: 2 })
  })

  it('offers the download for a Linux package install and never downloads itself', async () => {
    const calls = fakeHost({ mode: 'download' })
    await checkForUpdates()
    expect(calls.download).toBe(0)
    expect(getUpdateState()).toEqual({ phase: { kind: 'available', update: found }, open: true })
  })

  it('does nothing without an updater', async () => {
    await checkForUpdates({ manual: true })
    expect(getUpdateState()).toEqual({ phase: { kind: 'idle' }, open: false })
    expect(startUpdates()).toBeTypeOf('function')
  })
})

describe('the update dialog', () => {
  const roots: (() => void)[] = []
  afterEach(() => {
    for (const u of roots.splice(0)) u()
  })

  function show(phase: UpdatePhase, over: Partial<UpdateDialogViewProps> = {}) {
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    const on = { restart: vi.fn(), later: vi.fn(), retry: vi.fn(), download: vi.fn() }
    const props: UpdateDialogViewProps = { phase, open: true, app: 'SlicerX', tag: 'SlicerX | A slicer for the gods', version: '0.1.3', mode: 'install', held: false, onRestart: on.restart, onLater: on.later, onRetry: on.retry, onDownload: on.download, ...over }
    flushSync(() => root.render(createElement(UpdateDialogView, props)))
    roots.push(() => {
      root.unmount()
      el.remove()
    })
    const dialog = el.querySelector('dialog')!
    const button = (name: string) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === name)
    return { dialog, on, button, title: dialog.querySelector('.upd-title')?.textContent, name: dialog.querySelector('h2')!.textContent!.replace(dialog.querySelector('.upd-tag')!.textContent!, '') }
  }

  it('shows the ready update with the ravens, the tag, a green title, five highlights and the full notes', () => {
    const { dialog, on, button, title, name } = show({ kind: 'ready', update: found })
    expect(title).toBe('SlicerX 0.2.0 is ready')
    // the accessible name is the title alone: the ravens and the tag are hidden from screen readers
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(name).toBe('SlicerX 0.2.0 is ready')
    expect(dialog.querySelector('.upd-tag')?.getAttribute('aria-hidden')).toBe('true')
    expect(dialog.querySelector('.upd-tag')?.textContent).toBe('SlicerX | A slicer for the gods')
    const ravens = dialog.querySelector('svg.upd-ravens')!
    expect(ravens.getAttribute('aria-hidden')).toBe('true')
    expect(ravens.querySelectorAll('.upd-rbody')).toHaveLength(2)
    // transparent: nothing is drawn behind the ravens
    expect(ravens.querySelector('rect, radialGradient')).toBeNull()
    expect([...dialog.querySelectorAll('.upd-notes li')].map((l) => l.textContent)).toHaveLength(5)
    expect(dialog.querySelector<HTMLAnchorElement>('a.upd-more')?.href).toBe(found.releaseUrl)
    expect(dialog.querySelector('a.upd-more')?.textContent).toBe('Full release notes')
    button('Restart to update')!.click()
    button('Later')!.click()
    expect(on.restart).toHaveBeenCalledOnce()
    expect(on.later).toHaveBeenCalledOnce()
  })

  it('holds Restart to update while a print is being sent and says why', () => {
    const { dialog, on, button } = show({ kind: 'ready', update: found }, { held: true })
    const restart = button('Restart to update')!
    expect(restart.getAttribute('aria-disabled')).toBe('true')
    restart.click()
    expect(on.restart).not.toHaveBeenCalled()
    expect(dialog.querySelector('.upd-held')?.textContent).toMatch(/print is being sent/)
  })

  it('shows the download progress and lets it run hidden', () => {
    const { dialog, on, button, title } = show({ kind: 'downloading', update: found, got: 5_000_000, total: 20_000_000 })
    expect(title).toBe('Downloading SlicerX 0.2.0')
    const bar = dialog.querySelector('[role=progressbar]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('25')
    expect(dialog.textContent).toContain('5.0 MB of 20 MB')
    expect(button('Restart to update')).toBeUndefined()
    button('Hide')!.click()
    expect(on.later).toHaveBeenCalledOnce()
    // an unknown size shows a moving bar with no value
    const unknown = show({ kind: 'downloading', update: found, got: 0, total: null })
    expect(unknown.dialog.querySelector('[role=progressbar]')?.hasAttribute('aria-valuenow')).toBe(false)
  })

  it('offers the download for a package install', () => {
    const pkg = { ...found, downloadUrl: 'https://github.com/slicerx-oss/slicerx/releases/download/desktop-v0.2.0/SlicerX_0.2.0_amd64.deb' }
    const { dialog, on, button, title } = show({ kind: 'available', update: pkg }, { mode: 'download' })
    expect(title).toBe('SlicerX 0.2.0 is out')
    expect(dialog.textContent).toContain('installed as a package')
    button('Download')!.click()
    expect(on.download).toHaveBeenCalledWith(pkg.downloadUrl)
  })

  it('says what went wrong and tries again', () => {
    const { dialog, on, button, title } = show({ kind: 'error', message: 'Signature does not match', update: found })
    expect(title).toBe('Could not update')
    expect(dialog.querySelector('[role=alert]')?.textContent).toBe('Signature does not match')
    button('Try again')!.click()
    expect(on.retry).toHaveBeenCalledOnce()
  })

  it('says when this is the newest version, and stays put while installing', () => {
    expect(show({ kind: 'current' }).title).toBe('SlicerX is up to date')
    expect(show({ kind: 'current' }).dialog.textContent).toContain('0.1.3')
    const installing = show({ kind: 'installing', update: found })
    expect(installing.title).toBe('Installing SlicerX 0.2.0')
    expect(installing.dialog.querySelector('.sx-dialog-close')).toBeNull()
    expect(installing.button('Restarting…')?.disabled).toBe(true)
  })
})
