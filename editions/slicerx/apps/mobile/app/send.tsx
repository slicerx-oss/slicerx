// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slice from the phone: pick a model and a printer or fleet, slice in the cloud, send.
import { View } from 'react-native'
import { t } from '../src/components/theme'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Material } from '../src/cloud/slice-job'
import { usePocketHost } from '../src/data/provider'
import { useListing } from '../src/data/catalog'
import { useFleets, usePrinterViews, useSession } from '../src/data/queries'
import { pickFromFleet, sliceAndSend, useEstimate, useSendModels } from '../src/data/send'
import { usePocket } from '../src/state/store'
import { Sheet } from '../src/components/sheet'
import { SignIn } from '../src/components/sign-in'
import { SendPrintScreen, type SendSelection, type SendTarget, type SliceLocation } from '../src/screens/send-print-screen'

// The send screen has no material picker yet; PLA is the default until it does.
const MATERIAL: Material = 'pla'

export default function SendRoute() {
  const params = useLocalSearchParams<{
    model?: string
    printer?: string
    pick?: string
    listing?: string
  }>()
  const host = usePocketHost()
  const { views } = usePrinterViews()
  const { data: fleets = [] } = useFleets()
  // A model opened from its page (by slug) is offered even when the feed does not list it.
  const opened = useListing(params.listing)
  const { models, pickFile } = useSendModels(opened.data ? { listing: opened.data.listing, creator: opened.data.creator } : null)
  const estimate = useEstimate()
  const { data: session } = useSession()
  const [selection, setSelection] = useState<SendSelection | null>(null)
  const [signingIn, setSigningIn] = useState(false)

  const choices = useMemo(
    () =>
      models.map((m) => ({
        id: m.id,
        name: m.name.replace(/\.(stl|3mf|obj)$/i, ''),
        source: m.origin === 'library' ? ('library' as const) : ('file' as const),
        ...(m.by
          ? { detail: m.by }
          : m.bytes !== undefined
            ? {
                detail: `${m.name.split('.').pop()?.toUpperCase() ?? ''}, ${(m.bytes / 1024).toFixed(0)} KB`,
              }
            : {}),
      })),
    [models],
  )

  const resolve = (sel: SendSelection) => {
    const model = models.find((m) => m.id === sel.modelId)
    const target = sel.target
    const printer =
      target.kind === 'printer'
        ? (views.find((v) => v.info.id === target.printerId)?.info ?? null)
        : (() => {
            const fleet = fleets.find((f) => f.id === target.fleetId)
            return fleet ? pickFromFleet(fleet, views) : null
          })()
    return model && printer ? { model, printer, easy: sel.settings, material: MATERIAL } : null
  }
  // Re-estimate when the choice changes, not on every printer status tick.
  const resolveRef = useRef(resolve)
  resolveRef.current = resolve
  const runEstimate = estimate.run
  useEffect(() => runEstimate(selection ? resolveRef.current(selection) : null), [selection, runEstimate])

  useEffect(() => {
    if (params.pick) void pickFile().catch(() => undefined)
  }, [params.pick, pickFile])

  const cloud = host.edition.backend.cloudApi
  const computer = usePocket((s) => s.sliceLocation)
  // The cloud needs a token; without a session and without a paired computer, ask the person to sign in.
  const needsSignIn = !computer && Boolean(cloud) && !session
  const location: SliceLocation | null =
    computer ??
    (cloud
      ? session
        ? {
            kind: 'cloud',
            name: `${host.edition.brand.name} cloud`,
            detail: 'Slices on the service, then sends to the printer',
          }
        : null
      : {
          kind: 'cloud',
          name: 'Offline estimate',
          detail: 'No cloud service is configured for this build',
        })
  useEffect(() => {
    if (session) setSigningIn(false)
  }, [session])
  const initialTarget: SendTarget | undefined = params.printer ? { kind: 'printer', printerId: params.printer } : undefined

  return (
    <>
      <SendPrintScreen
        library={choices}
        printers={views}
        fleets={fleets}
        sliceLocation={location}
        onSignInForCloud={needsSignIn ? () => setSigningIn(true) : undefined}
        {...(params.model ? { initialModelId: params.model } : opened.data ? { initialModelId: `listing-${opened.data.listing.id}` } : {})}
        {...(initialTarget ? { initialTarget } : {})}
        onSelectionChange={setSelection}
        estimate={estimate.estimate}
        estimating={estimate.estimating}
        onPickFile={async () => (await pickFile())?.id ?? null}
        onSend={async (sel) => {
          const input = resolve(sel)
          if (!input) throw new Error('No printer in that fleet is ready for a new job')
          await sliceAndSend(host, input, () => undefined)
          router.replace({
            pathname: '/printer/[id]',
            params: { id: input.printer.id },
          })
        }}
        onBack={() => router.back()}
      />
      <Sheet open={signingIn} onClose={() => setSigningIn(false)} title="Sign in to slice in the cloud" testID="cloud-sign-in-sheet">
        <View style={{ paddingHorizontal: t.gutter }}>
          <SignIn
            methods={host.account.signInMethods()}
            onEmail={(email) => host.account.signInWithEmail(email)}
            onProvider={(provider) => host.account.signInWithOAuth(provider)}
            reason="Cloud slicing needs an account. You can also pair a computer running SlicerX and slice there."
          />
        </View>
      </Sheet>
    </>
  )
}
