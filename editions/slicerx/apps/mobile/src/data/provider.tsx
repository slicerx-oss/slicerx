// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's data root: one host, one query client, and the background work that runs
// while Pocket is open (status stream, alerts and notifications, sign-in callbacks).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { router } from 'expo-router'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPocketHost, type PocketHost } from '../host'
import { notify, onNotificationOpen } from '../notify/notifier'
import { onPushReceived, syncPush, type PushRegistrar } from '../notify/push'
import { watchPrinters } from '../notify/watch'
import { watchActivePairing } from '../pair'
import { get, PREF_FOR, pushAlert, set, setSliceLocation, usePocket } from '../state/store'
import { keys, useStatusSync } from './queries'

const HostContext = createContext<PocketHost | null>(null)

export function usePocketHost(): PocketHost {
  const host = useContext(HostContext)
  if (!host) throw new Error('usePocketHost() needs <PocketProvider> above it')
  return host
}

function Background({ host, client }: { host: PocketHost; client: QueryClient }) {
  useStatusSync()

  // Printers come from the most recently seen paired computer that is online, else the demo fleet.
  const [hub, setHub] = useState<{ registrar: PushRegistrar; hostName: string } | null>(null)
  useEffect(
    () =>
      watchActivePairing(host, (active) => {
        if (active) host.printers.use(active.source, active.printers, active.camera)
        else host.printers.use({ kind: 'demo' }, host.demoPrinters)
        setSliceLocation(active?.sliceLocation ?? null)
        setHub(active?.push ? { registrar: active.push, hostName: active.source.hostName } : null)
      }),
    [host],
  )

  // The hub holds this phone's push token while alerts are wanted; the Account screen shows the outcome.
  const prefs = usePocket((s) => s.notify)
  const lastReg = useRef<{ token: string; registrar: PushRegistrar } | null>(null)
  useEffect(() => {
    let live = true
    syncPush(hub?.registrar ?? null, hub?.hostName ?? null, prefs, lastReg.current).then(
      (r) => {
        if (!live) return
        lastReg.current = r.last
        set({ push: r.state })
      },
      (e: unknown) => live && set({ push: { kind: 'unsupported', reason: e instanceof Error ? e.message : 'Could not register for push' } }),
    )
    return () => {
      live = false
    }
  }, [hub, prefs])

  // A push while the app is open means something changed: reload every printer's status.
  useEffect(() => onPushReceived(() => void client.invalidateQueries({ queryKey: ['status'] })), [client])

  // A new printer source (a computer was paired or unpaired) replaces every printer query.
  useEffect(
    () =>
      host.printers.onSwitch(() => {
        client.removeQueries({ queryKey: ['status'] })
        client.removeQueries({ queryKey: ['snapshot'] })
        void client.invalidateQueries({ queryKey: keys.printers })
        void client.invalidateQueries({ queryKey: keys.fleets })
      }),
    [host, client],
  )

  // Printer events become alerts, and system notifications when the person allows them.
  const [source, setSource] = useState(() => host.printers.source())
  useEffect(() => host.printers.onSwitch(setSource), [host])
  useEffect(() => {
    let stop: (() => void) | null = null
    let live = true
    let primed = false
    void watchPrinters(host.printers, {
      onAlert: (a) => {
        pushAlert(a)
        // What is already true at launch goes to the list quietly; changes after that notify.
        if (!primed || !get().notify[PREF_FOR[a.kind]]) return
        notify({ title: a.title, body: a.detail, href: `/printer/${a.printerId}` }).catch(() => undefined)
      },
    }).then(
      (off) => {
        primed = true
        if (live) stop = off
        else off()
      },
      () => undefined,
    )
    return () => {
      live = false
      stop?.()
    }
  }, [host, source])

  // Magic links and OAuth callbacks finish the PKCE sign-in.
  useEffect(
    () =>
      host.auth.onDeepLink((url) => {
        void host.account.completeSignIn(url).then((r) => {
          if (r.ok) client.setQueryData(keys.session, r.value)
        })
      }),
    [host, client],
  )

  useEffect(() => onNotificationOpen((href) => router.push(href as never)), [])
  return null
}

export function PocketProvider({ children, host: given }: { children: ReactNode; host?: PocketHost }) {
  const host = useMemo(() => given ?? createPocketHost(), [given])
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }), [])
  return (
    <HostContext.Provider value={host}>
      <QueryClientProvider client={client}>
        <Background host={host} client={client} />
        {children}
      </QueryClientProvider>
    </HostContext.Provider>
  )
}
