// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Feature `connect`: the Printers workspace, and send, pause and resume commands
// that follow the live fleet. Entry point @slicerx/app/features/fleet.
import type { AppFeature, CommandSpec, Host, PrinterHost, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { registerCommands } from '../../commands/registry'
import { printerAction, sendToPrinter } from '../../state/actions'
import { appStore, get, set, setWorkspace } from '../../state/store'
import { isExportOnly } from '../../lib/hand-printers'
import { statusOrOffline } from '../../lib/queries'

function printerCommands(host: Host, p: PrinterInfo, s: PrinterStatus): CommandSpec[] {
  if (isExportOnly(p)) return []
  const out: CommandSpec[] = [
    {
      id: `send-${p.id}`,
      title: `Print the plate on ${p.name} (${p.model})`,
      section: 'printers',
      keywords: ['send', 'start', 'queue', p.vendor, p.model],
      workspace: 'preview',
      tool: { permission: 'start' },
      enabled: () => get().slice.status === 'done' && (s.state === 'idle' || s.state === 'finished'),
      run: () => sendToPrinter(host, p),
    },
  ]
  if (s.cameraAvailable) out.push({ id: `camera-${p.id}`, title: `Open the camera of ${p.name}`, section: 'printers', keywords: ['live', 'video', 'watch', p.model], workspace: 'printers', run: () => set({ cameraPlayer: { id: p.id, name: p.name } }) })
  if (s.state === 'printing') out.push({ id: `pause-${p.id}`, title: `Pause ${p.name}`, section: 'printers', keywords: ['stop', p.model], workspace: 'printers', tool: { permission: 'start' }, run: () => printerAction(host, p, 'pause') })
  if (s.state === 'paused') out.push({ id: `resume-${p.id}`, title: `Resume ${p.name}`, section: 'printers', keywords: ['continue', p.model], workspace: 'printers', tool: { permission: 'start' }, run: () => printerAction(host, p, 'resume') })
  return out
}

/**
 * Per-printer commands change with printer state, so they are kept in sync from
 * printer events rather than listed once. Runs for the life of the app.
 */
const synced = new WeakSet<Host>()

function syncPrinterCommands(host: Host): void {
  // The app may ask for the feature's commands more than once (effects run twice in development).
  if (synced.has(host)) return
  synced.add(host)
  let status = new Map<string, { info: PrinterInfo; status: PrinterStatus }>()
  let off: () => void = () => undefined
  let unsubscribe: (() => void)[] = []
  let sig = ''
  let round = 0
  const publish = () => {
    const next = [...status.values()].map((v) => `${v.info.id}:${v.status.state}:${v.status.cameraAvailable}`).join('|')
    if (next === sig) return
    sig = next
    off()
    off = registerCommands([...status.values()].flatMap((v) => printerCommands(host, v.info, v.status)))
  }
  // Reads the host's printers again whenever they change: the bridge connecting or leaving swaps them.
  const load = () => {
    const mine = ++round
    for (const u of unsubscribe) u()
    unsubscribe = []
    status = new Map()
    sig = ''
    off()
    off = () => undefined
    const printers = host.printers
    if (!printers) return
    void printers.list().then(async (list) => {
      for (const p of list) {
        // One printer that cannot be read must not leave the others without their commands.
        const st = await statusOrOffline(printers, p.id)
        if (mine !== round) return
        status.set(p.id, { info: p, status: st })
        unsubscribe.push(
          printers.subscribe(p.id, (e) => {
            if (e.type !== 'status' || mine !== round) return
            status.set(p.id, { info: p, status: e.status })
            publish()
          }),
        )
      }
      if (mine === round) publish()
    }).catch(() => undefined)
  }
  load()
  let epoch = get().linkEpoch
  appStore.subscribe((s) => {
    if (s.linkEpoch === epoch) return
    epoch = s.linkEpoch
    load()
  })
}

export const fleetFeature: AppFeature = {
  id: 'connect',
  requires: ['printers', 'approvals'],
  workspaces: [{ id: 'printers', label: 'Printers', icon: 'printer', load: () => import('./fleet').then((m) => ({ default: m.Fleet })) }],
  commands: (host) => {
    syncPrinterCommands(host)
    return [
      {
        id: 'fleet-refresh',
        title: 'Refresh printer status',
        section: 'printers',
        keywords: ['reload', 'fleet', 'status'],
        workspace: 'printers',
        tool: { permission: 'read' },
        run: () => {
          setWorkspace('printers')
          set({ fleetRefresh: Date.now() })
        },
      },
    ]
  },
}
