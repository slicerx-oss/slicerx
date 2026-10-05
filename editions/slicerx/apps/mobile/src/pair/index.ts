// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Phone to computer pairing inside the app. Turns @slicerx/pair into the props app/pair.tsx
// passes to PairingScreen, and into the paired computer's PrinterHost for src/host.
import type { PrinterHost } from '@slicerx/contracts'
import { PairError, type DeviceJoinRequest, type PairingFlow, type RemoteQuota } from '@slicerx/pair'
import { useCameraPermissions } from 'expo-camera'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { usePocketHost } from '../data/provider'
import type { PocketHost, PrinterSource } from '../host'
import type { PairedCamera } from '../camera/feed'
import type { PushRegistrar } from '../notify/push'
import type { JoinRequestView, PairedHostView, PairingScreenProps, PairingStage } from '../screens/pairing-screen'
import { lazyCamera, lazyPush } from './lazy'
import { pairService, type ComputerApproval, type HostState, type PairService } from './service'

export type { ComputerApproval } from './service'
export { sendSlice, sliceOnComputer, type ComputerSliceOutcome } from './computer'
export type PairingController = Omit<PairingScreenProps, 'onBack' | 'now'>

const LIST: PairingStage = { step: 'list' }

const NONE: HostState[] = []

/** The service once it has loaded; null before that. */
function useService(): PairService | null {
  const host = usePocketHost()
  const [svc, setSvc] = useState<PairService | null>(null)
  useEffect(() => {
    let live = true
    pairService(host).then(
      (s) => live && setSvc(s),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [host])
  return svc
}

function useHosts(svc: PairService | null): HostState[] {
  const subscribe = useCallback((cb: () => void) => (svc ? svc.onChange(cb) : () => undefined), [svc])
  return useSyncExternalStore(subscribe, () => (svc ? svc.hosts() : NONE))
}

const toView = (s: HostState): PairedHostView => ({ host: s.host, online: s.online, slicing: s.slicing })

/** Paired computers, for the Account tab's count and anywhere else that lists them. */
export function usePairedHosts(): PairedHostView[] {
  return useHosts(useService()).map(toView)
}

export function usePairing(): PairingController {
  const svc = useService()
  const states = useHosts(svc)
  const [stage, setStage] = useState<PairingStage>(LIST)
  const [refreshing, setRefreshing] = useState(false)
  const [joins, setJoins] = useState<DeviceJoinRequest[]>([])
  const [quota, setQuota] = useState<RemoteQuota | null>(null)
  const [permission, requestPermission] = useCameraPermissions()
  const flow = useRef<PairingFlow | null>(null)
  const canceled = useRef(false)

  // Join requests from new devices of the same account, while this screen is open.
  useEffect(() => {
    if (!svc) return
    let off: (() => void) | null = null
    let live = true
    void svc.accountRelay().then((relay) => {
      if (!relay || !live) return
      off = svc.client.watchJoinRequests(relay, (r) => setJoins((list) => [r, ...list.filter((x) => x.requestId !== r.requestId)].slice(0, 8)))
    })
    return () => {
      live = false
      off?.()
    }
  }, [svc])

  // The hub's relay quota, while the phone reaches it away from home.
  const onlineKey = states.map((s) => `${s.host.pairingId}:${s.online}`).join(',')
  useEffect(() => (svc ? svc.watchQuota(setQuota) : undefined), [svc, onlineKey])

  const run = useCallback(
    async (start: () => Promise<PairingFlow | null>, waiting: PairingStage, names?: string[]) => {
      canceled.current = false
      setStage(waiting)
      let f: PairingFlow | null
      try {
        f = await start()
      } catch (e) {
        setStage({ step: 'error', reason: e instanceof PairError ? e.message : 'Pairing could not start' })
        return
      }
      if (!f) {
        setStage({ step: 'error', reason: 'This phone has no computers it can add that device to' })
        return
      }
      flow.current = f
      const hostName = f.hostName
      f.sas.then(
        (sas) => {
          if (flow.current === f) setStage({ step: 'confirm', sas, hostName })
        },
        () => undefined,
      )
      const r = await f.result
      if (flow.current !== f) return
      flow.current = null
      if (canceled.current) setStage(LIST)
      else if (r.ok) setStage({ step: 'done', hostNames: names ?? r.hosts.map((h) => h.name) })
      else setStage({ step: 'error', reason: r.reason })
      if (r.ok && svc) void svc.refresh()
    },
    [svc],
  )

  const cameraState: PairingController['camera'] = permission?.granted ? 'granted' : permission && !permission.canAskAgain ? 'denied' : 'undetermined'
  const introducible = states.some((s) => s.host.rights.introduce && s.host.accountLinked && !s.host.pendingIntroduction)
  const joinRequests: JoinRequestView[] = joins.map((r) => ({ requestId: r.requestId, name: r.name, platform: r.platform, canReview: introducible }))

  return {
    hosts: states.map(toView),
    loading: svc === null,
    joinRequests,
    stage,
    camera: cameraState,
    onRequestCamera: () => void requestPermission(),
    onStartScan: () => setStage({ step: 'scan' }),
    onTypeCode: () => setStage({ step: 'type' }),
    onCode: (input) => {
      if (!svc) return
      void run(() => svc.client.pair(input), { step: 'connecting' })
    },
    onJoinAccount: () => {
      if (!svc) return
      void run(() => svc.client.joinAccount(), { step: 'join-waiting' })
    },
    onReviewJoin: (requestId) => {
      const r = joins.find((x) => x.requestId === requestId)
      if (!r) return
      setJoins((list) => list.filter((x) => x.requestId !== requestId))
      void run(() => r.review(), { step: 'connecting', hostName: r.name }, [r.name])
    },
    onConfirm: () => {
      if (!flow.current) return
      flow.current.confirm()
      setStage({ step: 'finishing' })
    },
    onReject: () => {
      canceled.current = true
      if (flow.current) flow.current.reject()
      else setStage(LIST)
    },
    onReset: () => setStage(LIST),
    onRetryRemovals: async () => (svc ? svc.retryRemovals() : 0),
    quota,
    onUnpair: async (pairingId) => {
      if (svc) await svc.client.unpair(pairingId)
    },
    refreshing,
    onRefresh: () => {
      if (!svc) return
      setRefreshing(true)
      void svc.refresh().finally(() => setRefreshing(false))
    },
  }
}

// ---------------------------------------------------------------------------
// Printers and approvals from the paired computer, for src/host and the approval UI.

export interface ActivePairing {
  source: Extract<PrinterSource, { kind: 'paired' }>
  printers: PrinterHost
  /** Where "slice on the computer" would run, for SendPrintScreen. */
  sliceLocation: { kind: 'desktop' | 'browser'; name: string; detail: string } | null
  /** Push registration on the hub (`push.register` on the paired channel), once @slicerx/pair carries it. */
  push: PushRegistrar | null
  /** The computer's live camera (`camera.*` on the paired channel). Asks the connection on first use. */
  camera: PairedCamera | null
}

/**
 * Calls `cb` with the computer to use for printers (pass it to `host.printers.use`): the most recently seen paired computer that
 * is online, or null for the demo fleet. Returns a stop function.
 */
export function watchActivePairing(pocket: PocketHost, cb: (active: ActivePairing | null) => void): () => void {
  let stop = () => undefined as void
  let live = true
  let last: string | null = null
  void pairService(pocket).then((svc) => {
    if (!live) return
    const pick = () => {
      const s = svc.hosts().find((h) => h.online && h.host.rights.request)
      const key = s ? s.host.pairingId : null
      if (key === last) return
      last = key
      if (!s) return cb(null)
      const kind = s.host.platform === 'web' ? 'browser' : 'desktop'
      const printers = svc.printers(s.host.pairingId)
      cb({
        source: { kind: 'paired', hostId: s.host.hostId, hostName: s.host.name },
        printers,
        push: lazyPush(printers),
        camera: lazyCamera(printers, async () => (await svc.connection(s.host.pairingId)).via, async () => (await svc.connection(s.host.pairingId)).info.stun ?? null),
        sliceLocation: s.slicing.includes('host') ? { kind, name: s.host.name, detail: kind === 'browser' ? 'Slices in SlicerX in your browser' : 'Slices on your computer' } : null,
      })
    }
    stop = svc.onChange(pick)
    pick()
  })
  return () => {
    live = false
    stop()
  }
}

/** Approvals the paired computer asks this phone to decide. `decide` signs; call it after device auth. */
export function watchComputerApprovals(pocket: PocketHost, cb: (a: ComputerApproval) => void): () => void {
  let stop = () => undefined as void
  let live = true
  void pairService(pocket).then((svc) => {
    if (live) stop = svc.onApproval(cb)
  })
  return () => {
    live = false
    stop()
  }
}
