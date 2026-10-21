// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The window over the app link: ui.get reads the workspace, the tab, the selection, the plate shown, the printer chosen
// and the panels open; ui.set changes what the window shows, checks everything before anything changes, and never
// carries a printer's id out.
import type { PrinterHost } from '@slicerx/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { bindRunPrinters } from '../src/app-link/mimir-run'
import { toolStore } from '../src/plate/tools'
import { setMimirOn } from '../src/state/model-mode'
import { setOffered } from '../src/state/offered'
import { get, set } from '../src/state/store'

// A Bambu Lab printer goes by its serial as its id; only the name the person gave it may leave the app.
const SERIAL = '01P00A451200789'
const PRINTERS = { list: async () => [{ id: SERIAL, name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', nozzleCount: 1, host: '192.168.1.42' }] } as unknown as PrinterHost

const box = { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 5]), indices: new Uint32Array([0, 1, 2, 0, 1, 3]), name: 'Box', slot: 1 }
const at = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 50, 0, 1]
const entry = (id: string, name: string) => ({ id, name, parts: [box], transform: at }) as never

/** Workspace and tab go to ui.set (read class); the selection and the panels to ui.select (edit class). */
const methodFor = (args: Record<string, unknown>) => (Object.keys(args).some((k) => k !== 'workspace' && k !== 'tab') ? 'ui.select' : 'ui.set')
const call = (args: Record<string, unknown>) => runCall(methodFor(args), args)

const refused = async (args: Record<string, unknown>) => {
  const e = await call(args).catch((x: unknown) => x)
  expect(e, JSON.stringify(args)).toBeInstanceOf(LinkError)
  return e as LinkError
}

const CLOSED = { settingsOpen: false, settingsSection: null, commandOpen: false, aboutOpen: false, shortcutsOpen: false, expertOpen: false, printerChooserOpen: false, printerSettingsOpen: false, bugReportOpen: false, agreementOpen: false, setup: null }

beforeEach(() => {
  setOffered({ workspaces: [{ id: 'prepare', label: 'Slice' }, { id: 'library', label: 'My models' }], settings: [] })
  setMimirOn(true)
  toolStore.setState({ tool: 'move' })
  set({
    ...CLOSED,
    workspace: 'prepare',
    modelMode: 'slice',
    plate: [entry('obj_1', 'Box'), entry('obj_2', 'Clip'), entry('obj_3', 'Twin'), entry('obj_4', 'Twin')],
    plates: [
      { id: 'plate-1', name: 'Plate 1', objects: [], settings: {} },
      { id: 'plate-2', name: 'Brackets', objects: [], settings: {} },
    ],
    activePlate: 'plate-2',
    selection: 'obj_2',
    selectedIds: ['obj_1', 'obj_2'],
    printerId: null,
    printerModel: null,
    projectPrinter: null,
    profile: null,
    objectTool: null,
    historyEdit: null,
  })
})

afterEach(() => {
  bindRunPrinters(undefined)
  setMimirOn(true)
})

describe('ui over the app link', () => {
  it('reads the window and switches its workspace and tab as a read, and sets the selection and panels as an edit', async () => {
    expect(APP_LINK_METHODS['ui.get']).toBe('read')
    expect(APP_LINK_METHODS['ui.set']).toBe('read')
    expect(APP_LINK_METHODS['ui.select']).toBe('edit')
    // each takes only its own arguments, so a read grant never reaches the selection or a panel
    for (const args of [{ selection: ['Box'] }, { open: 'about' }, { close: 'all' }, { tab: 'design', selection: [] }]) {
      await expect(runCall('ui.set', args), JSON.stringify(args)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    for (const args of [{ tab: 'design' }, { workspace: 'library' }, { open: 'about', tab: 'slice' }]) {
      await expect(runCall('ui.select', args), JSON.stringify(args)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(get()).toMatchObject({ modelMode: 'slice', workspace: 'prepare', selection: 'obj_2', aboutOpen: false })
  })

  it('reads the workspace, the tab, the selection with its primary first, the plate shown and the panels', async () => {
    set({ settingsOpen: true, settingsSection: 'look' })
    expect(await runCall('ui.get', {})).toEqual({
      workspace: 'prepare',
      workspaces: [{ id: 'prepare', label: 'Slice' }, { id: 'library', label: 'My models' }],
      tab: 'slice',
      tabs: ['slice', 'design', 'mimir'],
      selection: { primary: { id: 'obj_2', name: 'Clip' }, objects: [{ id: 'obj_2', name: 'Clip' }, { id: 'obj_1', name: 'Box' }] },
      plate: { number: 2, id: 'plate-2', name: 'Brackets', count: 2 },
      printer: null,
      panels: { open: ['settings'], settingsSection: 'look', settable: ['settings', 'command', 'about', 'shortcuts', 'expert', 'printerChooser', 'printerSettings'] },
    })
    setMimirOn(false)
    expect(await runCall('ui.get', {})).toMatchObject({ tabs: ['slice', 'design'] })
  })

  it('reads the printer by the name the person gave it, never its id, serial or address', async () => {
    bindRunPrinters({ printers: PRINTERS })
    set({ printerId: SERIAL, printerModel: { id: SERIAL, vendor: 'Bambu Lab', model: 'P1S' }, profile: { nozzle: 0.4 } as never })
    const read = await runCall('ui.get', {})
    expect((read as { printer: unknown }).printer).toEqual({ name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', nozzleMm: 0.4, fromProject: false })
    expect(JSON.stringify(read)).not.toContain(SERIAL)
    expect(JSON.stringify(read)).not.toContain('192.168')
    // a name that only repeats the serial stays in the app too
    bindRunPrinters({ printers: { list: async () => [{ id: SERIAL, name: `P1S ${SERIAL}`, vendor: 'Bambu Lab', model: 'P1S' }] } as unknown as PrinterHost })
    expect(JSON.stringify(await runCall('ui.get', {}))).not.toContain(SERIAL)
    // an opened project's own printer
    set({ printerId: 'project-printer', projectPrinter: { id: 'project-printer', name: 'X1C 0.4', vendor: 'Bambu Lab', model: 'X1C', nozzle: 0.4, source: 'the project' } as never })
    expect(await runCall('ui.get', {})).toMatchObject({ printer: { name: 'X1C 0.4 from the project', vendor: 'Bambu Lab', model: 'X1C', nozzleMm: 0.4, fromProject: true } })
  })

  it('switches the tab and the workspace, reading them back', async () => {
    expect(await call({ tab: 'design' })).toMatchObject({ workspace: 'prepare', tab: 'design' })
    expect(get().modelMode).toBe('design')
    expect(await call({ workspace: 'library' })).toMatchObject({ workspace: 'library' })
    expect(await call({ tab: 'mimir' })).toMatchObject({ workspace: 'prepare', tab: 'mimir' })
  })

  it('selects objects by id or name, the primary first, and selects nothing with []', async () => {
    const read = await call({ selection: ['Box', 'obj_3'] })
    expect(read).toMatchObject({ selection: { primary: { id: 'obj_1', name: 'Box' }, objects: [{ id: 'obj_1' }, { id: 'obj_3' }] } })
    expect(get().selection).toBe('obj_1')
    expect(get().selectedIds).toEqual(['obj_1', 'obj_3'])
    expect(await call({ selection: [] })).toMatchObject({ selection: { primary: null, objects: [] } })
    expect(get().selection).toBeNull()
  })

  it('opens Settings on a section and closes it, and leaves a panel the call does not name alone', async () => {
    expect(await call({ open: 'settings', section: 'controls' })).toMatchObject({ panels: { open: ['settings'], settingsSection: 'controls' } })
    expect(await call({ open: 'settings', section: 'look' })).toMatchObject({ panels: { open: ['settings'], settingsSection: 'look' } })
    expect(await call({ close: 'settings' })).toMatchObject({ panels: { open: [], settingsSection: null } })
    // a panel in Slice's pane stays open under a dialog opened after it
    expect(await call({ open: 'expert' })).toMatchObject({ panels: { open: ['expert'] } })
    expect(await call({ open: 'about' })).toMatchObject({ panels: { open: ['about', 'expert'] } })
    // closing a panel that is not open changes nothing
    expect(await call({ close: 'shortcuts' })).toMatchObject({ panels: { open: ['about', 'expert'] } })
    expect(await call({ close: 'all', open: 'command' })).toMatchObject({ panels: { open: ['command'] } })
    expect(await call({ close: 'command' })).toMatchObject({ panels: { open: [] } })
  })

  it('never opens a dialog over another one or a pane panel under one, and never closes one to make room', async () => {
    set({ settingsOpen: true })
    for (const open of ['about', 'command', 'printerSettings', 'expert', 'printerChooser']) {
      const e = await refused({ open })
      expect(e.code, open).toBe('busy')
      expect(e.message, open).toBe('Settings is open; close it first')
    }
    expect(get()).toMatchObject({ settingsOpen: true, aboutOpen: false, commandOpen: false, expertOpen: false, printerChooserOpen: false, printerSettingsOpen: false })
    // closing it in the same call makes the room
    expect(await call({ close: 'settings', open: 'about' })).toMatchObject({ panels: { open: ['about'] } })
  })

  it("opens a Slice panel in Slice, with Slice's left pane open", async () => {
    set({ modelMode: 'design', rails: {} })
    expect(await call({ open: 'printerSettings' })).toMatchObject({ tab: 'slice', panels: { open: ['printerSettings'] } })
    expect(get().rails['prepare']?.left).toBe(true)
    await expect(call({ open: 'expert', tab: 'design' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('refuses bad input and changes nothing', async () => {
    const before = get()
    for (const [args, code] of [
      [{}, 'invalid_input'],
      [{ printer: 'Bay 2' }, 'invalid_input'],
      [{ workspace: 'vault' }, 'invalid_input'],
      [{ tab: 'paint' }, 'invalid_input'],
      [{ tab: 'design', workspace: 'library' }, 'invalid_input'],
      [{ selection: 'Box' }, 'invalid_input'],
      [{ selection: ['Box', 'Nothing'] }, 'not_found'],
      [{ selection: ['Twin'] }, 'invalid_input'],
      [{ selection: [7] }, 'invalid_input'],
      [{ open: 'agreement' }, 'invalid_input'],
      [{ open: 'settings', section: 'secrets' }, 'invalid_input'],
      [{ section: 'look' }, 'invalid_input'],
      [{ close: 'setup' }, 'invalid_input'],
      [{ open: 'about', close: 'about' }, 'invalid_input'],
      // a valid part never goes through when another part is refused
      [{ tab: 'design', open: 'nope' }, 'invalid_input'],
    ] as const) {
      expect((await refused(args)).code, JSON.stringify(args)).toBe(code)
    }
    const after = get()
    for (const k of ['workspace', 'modelMode', 'selection', 'selectedIds', 'settingsOpen', 'aboutOpen', 'commandOpen'] as const) expect(after[k], k).toEqual(before[k])
    // two objects share a name: the refusal names them by id, so the client can pick one
    expect((await refused({ selection: ['Twin'] })).message).toContain('obj_3, obj_4')
  })

  it('refuses a tab the window does not show', async () => {
    setMimirOn(false)
    const e = await refused({ tab: 'mimir' })
    expect(e.code).toBe('not_found')
    expect(e.message).toBe('this window has no mimir tab')
  })

  it('waits while the person uses a tool or first-run setup is up', async () => {
    set({ objectTool: 'cut' })
    expect((await refused({ selection: ['Box'] })).code).toBe('busy')
    expect((await refused({ tab: 'design' })).code).toBe('busy')
    // a dialog over the tool is fine
    expect(await call({ open: 'shortcuts' })).toMatchObject({ panels: { open: ['shortcuts'] } })
    set({ objectTool: null, shortcutsOpen: false })
    toolStore.setState({ tool: 'paint' })
    expect((await refused({ workspace: 'library' })).code).toBe('busy')
    toolStore.setState({ tool: 'move' })
    set({ setup: { step: 'printer' } as never })
    expect((await refused({ open: 'about' })).code).toBe('busy')
    expect(get().aboutOpen).toBe(false)
  })

  describe('answers busy and changes nothing while the window is busy', () => {
    const before = () => {
      const s = get()
      return { workspace: s.workspace, modelMode: s.modelMode, selection: s.selection, selectedIds: s.selectedIds, settingsOpen: s.settingsOpen, aboutOpen: s.aboutOpen, commandOpen: s.commandOpen }
    }
    const each = async (why: RegExp) => {
      const was = before()
      for (const args of [{ open: 'about' }, { close: 'all' }, { tab: 'design' }, { selection: ['Box'] }, { workspace: 'library' }]) {
        const e = await refused(args)
        expect(e.code, JSON.stringify(args)).toBe('busy')
        expect(e.message, JSON.stringify(args)).toMatch(why)
      }
      expect(before()).toEqual(was)
    }

    it('a file opening', async () => {
      set({ plateLoading: true })
      await each(/a file is opening/)
      set({ plateLoading: false })
    })

    it('the print sheet', async () => {
      set({ printSheet: {} as never })
      await each(/the print sheet is open/)
      set({ printSheet: null })
    })

    it('the question about an opened project, and the G-code review', async () => {
      set({ projectOpenAsk: { source: 'Deck box.3mf' } })
      await each(/asking the person about the project/)
      set({ projectOpenAsk: null, projectGcode: { source: 'Deck box.3mf', changes: [], asking: true } })
      await each(/asking the person about the project/)
      // the review answered: no longer busy
      set({ projectGcode: { source: 'Deck box.3mf', changes: [], asking: false } })
      expect(await call({ open: 'about' })).toMatchObject({ panels: { open: ['about'] } })
      set({ projectGcode: null })
    })

    it('a phone being paired in Settings', async () => {
      set({ settingsOpen: true, settingsSection: 'phone' })
      const pairing = Object.assign(document.createElement('dialog'), { className: 'sx-dialog pair-dialog' })
      document.body.append(pairing)
      try {
        await each(/pairing a phone/)
        expect((await refused({ close: 'settings' })).code).toBe('busy')
        expect((await refused({ open: 'settings', section: 'look' })).code).toBe('busy')
        expect(get()).toMatchObject({ settingsOpen: true, settingsSection: 'phone' })
      } finally {
        pairing.remove()
      }
    })
  })

  describe("never closes a panel with the person's work under way", () => {
    const field = (html: string) => {
      const box = document.createElement('div')
      box.innerHTML = html
      document.body.append(box)
      return box
    }

    it('the command bar with a query typed, and empty it closes', async () => {
      set({ commandOpen: true })
      const box = field('<div class="sx-palette"><input class="sx-palette-input" value="slice"></div>')
      try {
        for (const close of ['command', 'all']) {
          const e = await refused({ close })
          expect(e.code, close).toBe('busy')
          expect(e.message).toBe("The command bar has the person's work under way; it stays open until they are done")
        }
        expect(get().commandOpen).toBe(true)
        box.querySelector('input')!.value = ''
        expect(await call({ close: 'command' })).toMatchObject({ panels: { open: [] } })
      } finally {
        box.remove()
      }
    })

    it('Settings with a key typed and not saved, or a preset rename open', async () => {
      set({ settingsOpen: true, settingsSection: 'apps' })
      const box = field('<div class="settings-dialog"><input data-testid="connected-app-spoolman-key" value="k3y"></div>')
      try {
        expect((await refused({ close: 'settings' })).code).toBe('busy')
        expect((await refused({ open: 'settings', section: 'look' })).code).toBe('busy')
        box.querySelector('input')!.value = ''
        box.querySelector('.settings-dialog')!.insertAdjacentHTML('beforeend', '<input id="pn-user-1" value="">')
        expect((await refused({ close: 'all' })).code).toBe('busy')
        expect(get()).toMatchObject({ settingsOpen: true, settingsSection: 'apps' })
        box.querySelector('#pn-user-1')!.remove()
        expect(await call({ open: 'settings', section: 'look' })).toMatchObject({ panels: { open: ['settings'], settingsSection: 'look' } })
      } finally {
        box.remove()
      }
    })

    it('Expert and Printer settings with a search typed, also when a tab change would take them off screen', async () => {
      set({ expertOpen: true })
      const box = field('<input id="expert-search" value="stringing">')
      try {
        expect((await refused({ close: 'expert' })).code).toBe('busy')
        const e = await refused({ tab: 'design' })
        expect(e.code).toBe('busy')
        expect(e.message).toBe('Expert settings has a search typed in it; leaving Slice would lose it')
        expect(get()).toMatchObject({ expertOpen: true, modelMode: 'slice' })
        set({ expertOpen: false, printerSettingsOpen: true })
        box.innerHTML = '<input id="ps-search" value="retraction">'
        expect((await refused({ close: 'printerSettings' })).code).toBe('busy')
        expect((await refused({ workspace: 'library' })).code).toBe('busy')
        // the printer list and About hold nothing to lose
        set({ printerSettingsOpen: false, printerChooserOpen: true })
        expect(await call({ close: 'printerChooser' })).toMatchObject({ panels: { open: [] } })
      } finally {
        box.remove()
      }
    })
  })
})
