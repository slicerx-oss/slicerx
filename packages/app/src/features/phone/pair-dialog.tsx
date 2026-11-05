// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings, Phone access, "Pair a phone": the offer's code, then the digits both screens must show.
// Settings, Printer bridge, Devices, "Pair a partner phone": the same, for another company's phone app. The person
// names the partner app first; the code works only for that app, and it may approve nothing until they say so.
import { Button, Dialog, Input, Switch } from '@slicerx/ui'
import { useEffect, useMemo, useState } from 'react'
import { qrMatrix, qrPath } from '../../lib/qr'
import type { PhoneAccess, PhoneAttempt, PhoneOffer } from '../../lib/phone'
import { appName } from '../../edition'

type Stage = { at: 'name' } | { at: 'offer'; offer: PhoneOffer } | { at: 'compare'; attempt: PhoneAttempt; digits: string } | { at: 'done'; name: string } | { at: 'failed'; message: string }

/** The partner name as the pair package takes it (partnerName): 1 to 64 characters with a letter or digit. */
const PARTNER_MAX = 64
const partnerOk = (n: string) => {
  const t = n.trim()
  return t.length > 0 && t.length <= PARTNER_MAX && /[\p{L}\p{N}]/u.test(t)
}

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

/**
 * `partner`: pair a partner phone. The dialog asks for the partner app's name first (`known` suggests the partner
 * apps that already hold a key), and the person decides on the digits screen whether it may approve.
 */
export function PairDialog({ phone, onClose, partner, known = [] }: { phone: PhoneAccess; onClose: () => void; partner?: boolean; known?: string[] }) {
  const [stage, setStage] = useState<Stage | null>(partner ? { at: 'name' } : null)
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState<string | null>(partner ? null : '')
  const [approve, setApprove] = useState(false)
  const [send, setSend] = useState(false)
  useEffect(() => {
    if (chosen === null) return
    let off: (() => void) | null = null
    let made: PhoneOffer | null = null
    let gone = false
    phone.offer(partner ? { partner: chosen } : undefined).then(
      (offer) => {
        if (gone) return offer.cancel()
        made = offer
        setStage({ at: 'offer', offer })
        off = offer.onAttempt((attempt) => {
          void attempt.sas.then((digits) => !gone && setStage({ at: 'compare', attempt, digits }))
          void attempt.result.then((r) => !gone && setStage(r.ok ? { at: 'done', name: r.device?.name ?? attempt.deviceName } : { at: 'failed', message: r.reason ?? 'The phone was not paired.' }))
        })
      },
      (e: unknown) => !gone && setStage({ at: 'failed', message: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      gone = true
      off?.()
      made?.cancel()
    }
  }, [phone, partner, chosen])
  const app = chosen ?? ''
  return (
    <Dialog open onClose={onClose} title={partner ? 'Pair a partner phone' : 'Pair a phone'} className="pair-dialog" footer={<Button onClick={onClose}>{stage?.at === 'done' ? 'Done' : 'Close'}</Button>}>
      {stage?.at === 'name' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (partnerOk(name)) setChosen(name.trim())
          }}
        >
          <p>A partner phone is another company&apos;s phone app that works with {appName()}, like a printer monitor. Type its name as the app shows it.</p>
          <p className="preset-save">
            <label className="sr-only" htmlFor="partner-phone-name">
              Partner app name
            </label>
            <Input id="partner-phone-name" data-testid="partner-phone-name" list="partner-phone-known" placeholder="App name, like Example Phone" value={name} maxLength={PARTNER_MAX} autoComplete="off" onChange={(e) => setName(e.target.value)} />
            {known.length ? (
              <datalist id="partner-phone-known">
                {known.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            ) : null}
            <Button type="submit" variant="primary" data-testid="partner-phone-make" disabled={!partnerOk(name)}>
              Make a code
            </Button>
          </p>
          <p className="sx-small sx-muted">It will see your printers and their cameras, and can ask to pause or stop a print. It can&apos;t approve anything, send prints or see your library unless you allow that when the digits match. The name is what the app calls itself; {appName()} can&apos;t check who made it.</p>
        </form>
      ) : null}
      {stage?.at === 'offer' ? (
        <>
          <p>{partner ? `Open ${app} on the phone, choose to pair with ${appName()}, and scan this code. Or type the code below.` : `Open the ${appName()} phone app, choose Pair a computer, and scan this code. Or type the code below.`}</p>
          <PairQr link={stage.offer.link} />
          <p className="sx-mono pair-code" aria-label="Pairing code">{stage.offer.code}</p>
          <p className="sx-small sx-muted">The code works once and expires in a few minutes.</p>
        </>
      ) : null}
      {stage?.at === 'compare' ? (
        <>
          <p>{partner ? `${app} on a phone wants to pair as a partner phone. Do both screens show these digits?` : `${stage.attempt.deviceName} wants to pair. Do both screens show these digits?`}</p>
          <p className="sx-mono pair-code" aria-label="Digits to compare">{stage.digits}</p>
          {partner ? (
            <>
              <p className="sx-small sx-muted">It will see your printers and their cameras, and can ask to pause or stop a print. Allow more only if you trust {app}. You can change both later in Devices.</p>
              <div className="sx-switchrow">
                <label htmlFor="partner-phone-approve">
                  Let it approve pausing and stopping a print
                  <small>It can then also answer mimir&apos;s questions. Starting a print always needs you here.</small>
                </label>
                <Switch id="partner-phone-approve" testId="partner-phone-approve" checked={approve} onChange={setApprove} />
              </div>
              <div className="sx-switchrow">
                <label htmlFor="partner-phone-send">
                  Let it send prints and see your library
                  <small>Each print still waits for you to approve it on this computer.</small>
                </label>
                <Switch id="partner-phone-send" testId="partner-phone-send" checked={send} onChange={setSend} />
              </div>
            </>
          ) : null}
          <p>
            <Button variant="primary" data-testid="pair-match" onClick={() => (partner ? stage.attempt.confirm({ request: true, approve, introduce: false, send }) : stage.attempt.confirm())}>
              They match
            </Button>{' '}
            <Button onClick={() => stage.attempt.reject()}>They differ</Button>
          </p>
        </>
      ) : null}
      {stage?.at === 'done' ? <p role="status">{partner ? `${app} on ${stage.name} is paired.` : `${stage.name} is paired.`}</p> : null}
      {stage?.at === 'failed' ? <p className="app-err" role="alert">{stage.message}</p> : null}
      {!stage ? <p className="sx-small sx-muted">Making a code.</p> : null}
    </Dialog>
  )
}
