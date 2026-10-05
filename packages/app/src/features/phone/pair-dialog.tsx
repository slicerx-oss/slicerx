// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings, Phone access, "Pair a phone": the offer's code, then the digits both screens must show.
import { Button, Dialog } from '@slicerx/ui'
import { useEffect, useMemo, useState } from 'react'
import { qrMatrix, qrPath } from '../../lib/qr'
import type { PhoneAccess, PhoneAttempt, PhoneOffer } from '../../lib/phone'
import { appName } from '../../edition'

type Stage = { at: 'offer'; offer: PhoneOffer } | { at: 'compare'; attempt: PhoneAttempt; digits: string } | { at: 'done'; name: string } | { at: 'failed'; message: string }

/** The pairing link as a QR code, drawn here. Dark on white at any theme, so cameras read it. */
export function PairQr({ link }: { link: string }) {
  const qr = useMemo(() => {
    try {
      return qrPath(qrMatrix(link))
    } catch {
      return null
    }
  }, [link])
  if (!qr) return null
  return (
    <svg className="pair-qr" role="img" aria-label="Pairing QR code" viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" width={200} height={200}>
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.d} fill="#000" />
    </svg>
  )
}

export function PairDialog({ phone, onClose }: { phone: PhoneAccess; onClose: () => void }) {
  const [stage, setStage] = useState<Stage | null>(null)
  useEffect(() => {
    let off: (() => void) | null = null
    let made: PhoneOffer | null = null
    let gone = false
    phone.offer().then(
      (offer) => {
        if (gone) return offer.cancel()
        made = offer
        setStage({ at: 'offer', offer })
        off = offer.onAttempt((attempt) => {
          void attempt.sas.then((digits) => !gone && setStage({ at: 'compare', attempt, digits }))
          void attempt.result.then((r) => !gone && setStage(r.ok ? { at: 'done', name: attempt.deviceName } : { at: 'failed', message: r.reason ?? 'The phone was not paired.' }))
        })
      },
      (e: unknown) => !gone && setStage({ at: 'failed', message: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      gone = true
      off?.()
      made?.cancel()
    }
  }, [phone])
  return (
    <Dialog open onClose={onClose} title="Pair a phone" footer={<Button onClick={onClose}>{stage?.at === 'done' ? 'Done' : 'Close'}</Button>}>
      {stage?.at === 'offer' ? (
        <>
          <p>Open the {appName()} phone app, choose Pair a computer, and scan this code. Or type the code below.</p>
          <PairQr link={stage.offer.link} />
          <p className="sx-mono pair-code" aria-label="Pairing code">{stage.offer.code}</p>
          <p className="sx-small sx-muted">The code works once and expires in a few minutes.</p>
        </>
      ) : null}
      {stage?.at === 'compare' ? (
        <>
          <p>{stage.attempt.deviceName} wants to pair. Do both screens show these digits?</p>
          <p className="sx-mono pair-code" aria-label="Digits to compare">{stage.digits}</p>
          <p>
            <Button variant="primary" onClick={() => stage.attempt.confirm()}>They match</Button>{' '}
            <Button onClick={() => stage.attempt.reject()}>They differ</Button>
          </p>
        </>
      ) : null}
      {stage?.at === 'done' ? <p role="status">{stage.name} is paired.</p> : null}
      {stage?.at === 'failed' ? <p className="app-err" role="alert">{stage.message}</p> : null}
      {!stage ? <p className="sx-small sx-muted">Making a code.</p> : null}
    </Dialog>
  )
}
