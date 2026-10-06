// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The one step a found Bambu Lab printer needs: its access code. One flat card with the printer's name,
// one line on where the code is, one field and one Connect button. The steps tick off as it connects;
// what went wrong shows only after Connect, in one sentence. "Where is it?" opens the drawing of the
// printer's screen on request.
import { Button, Icon } from '@slicerx/ui'
import { useCallback, useEffect, useState } from 'react'
import { AccessCodeScreen } from './access-code-screen'
import { bambuFamily, bambuGuide, DEVELOPER_EFFECT, LAN_ONLY_EFFECT } from './bambu-lan'
import type { PrinterController } from './printer-step'
import { checkConnection, currentModel, normalizeSecret, parseAddress } from './printer-form'
import { TEST_STEPS, type FoundPrinter } from './setup-registry'
import { failureCopy } from './test-failure'

/** "Tawain #1 (H2D) found". */
export function foundTitle(p: FoundPrinter, model?: string): string {
  const m = model ?? p.model
  const named = p.name && p.name !== m && p.name !== p.address
  return named && m ? `${p.name} (${m}) found` : `${m ?? p.name} found`
}

export function CodeCard({ ctl, picked, onReport }: { ctl: PrinterController; picked: FoundPrinter; onReport: () => void }) {
  const { form, method, test } = ctl
  const model = currentModel(form)
  const family = bambuFamily(model?.name ?? picked.model)
  const [where, setWhere] = useState(picked.lanOnly === false)
  const [more, setMore] = useState(false)
  // Pressing Connect with a code that is not complete says so in one sentence; nothing is said before.
  const [tried, setTried] = useState(false)
  const len = form.secretLengths.accessCode ?? 0
  const ready = method ? checkConnection(form, method).ready : false
  const outcome = test.status === 'done' ? test.outcome : null
  const steps = test.status === 'testing' ? test.steps : outcome?.steps ?? null
  const { setSecret } = ctl
  const sync = useCallback((v: string) => setSecret('accessCode', v), [setSecret])
  useEffect(() => {
    const el = document.getElementById('fr-f-accessCode') as HTMLInputElement | null
    if (el?.value) sync(el.value)
  }, [sync])

  const connect = () => {
    const el = document.getElementById('fr-f-accessCode') as HTMLInputElement | null
    if (el) sync(el.value)
    setTried(true)
    if (ctl.method && checkConnection(ctl.current(), ctl.method).ready) void ctl.runTest()
  }
  const short = tried && !ready ? (len ? `The access code has 8 characters; ${len} ${len === 1 ? 'is' : 'are'} entered.` : 'Enter the 8-character access code first.') : null
  const failed = outcome && !outcome.ok ? failureCopy(outcome, { address: parseAddress(form.fields.host)?.host ?? form.fields.host, family: form.connection, model: model?.name }) : null
  const testing = test.status === 'testing'

  return (
    <section className="fr-codecard" aria-labelledby="fr-codecard-h">
      <h2 id="fr-codecard-h" className="fr-codecard-h">
        <Icon name="check" size={18} /> {foundTitle(picked, model?.name)}
      </h2>
      {picked.lanOnly === false ? (
        <p className="fr-codecard-warn" role="status">
          <Icon name="warning" size={16} /> LAN Only Mode is off on this printer. Turn it on, then enter the code it shows.
        </p>
      ) : null}
      <label htmlFor="fr-f-accessCode" className="fr-codecard-lede">
        Enter the access code from the printer's LAN Only screen.
      </label>
      <form
        className="fr-codecard-row"
        onSubmit={(e) => {
          e.preventDefault()
          connect()
        }}
      >
        <input
          id="fr-f-accessCode"
          className="fr-codecard-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={16}
          placeholder="xxxx xxxx"
          aria-describedby={short || failed ? 'fr-codecard-msg' : undefined}
          aria-invalid={short ? true : undefined}
          onChange={(e) => sync(e.target.value)}
          onInput={(e) => sync(e.currentTarget.value)}
          onBlur={(e) => sync(e.currentTarget.value)}
          onPaste={(e) => {
            // A pasted code arrives without its spaces; its case stays as the printer shows it.
            const text = e.clipboardData.getData('text')
            if (!text) return
            e.preventDefault()
            e.currentTarget.value = normalizeSecret('accessCode', text)
            sync(e.currentTarget.value)
          }}
          data-help="accessCode"
          data-secret="true"
        />
        <Button type="submit" variant="primary" size="lg" className="fr-codecard-go" disabled={testing}>
          {testing ? 'Connecting' : outcome?.ok ? 'Connected' : failed ? 'Try again' : 'Connect'}
        </Button>
      </form>
      {steps ? (
        <ol className="fr-codecard-steps" aria-live="polite">
          {TEST_STEPS.map((s) => {
            const st = steps.find((x) => x.id === s.id)
            const state = st?.running ? 'run' : st?.ok === true ? 'ok' : st?.ok === false ? 'bad' : 'wait'
            if (state === 'wait' && !testing) return null
            return (
              <li key={s.id} data-state={state}>
                <Icon name={state === 'ok' ? 'check' : state === 'bad' ? 'close' : state === 'run' ? 'refresh' : 'minus'} size={14} />
                {s.label}
              </li>
            )
          })}
        </ol>
      ) : null}
      {short ? (
        <p id="fr-codecard-msg" className="fr-codecard-msg" role="alert">
          {short}
        </p>
      ) : failed ? (
        <div id="fr-codecard-msg" className="fr-codecard-msg" role="alert" data-kind={failed.kind}>
          <p>
            {failed.title} {failed.body}
          </p>
          {failed.actions.includes('report') ? (
            <Button size="sm" variant="ghost" icon="bug" onClick={onReport}>
              Send a report
            </Button>
          ) : null}
        </div>
      ) : null}
      <button type="button" className="fr-codecard-where" aria-expanded={where} aria-controls="fr-codecard-pic" onClick={() => setWhere(!where)}>
        {where ? 'Hide where it is' : 'Where is it?'}
      </button>
      {where ? (
        <div id="fr-codecard-pic" className="fr-codecard-pic">
          {family ? <AccessCodeScreen family={family} /> : <p>Check your printer's network settings for the LAN Only page. The access code is shown there.</p>}
          {family ? (
            <ol>
              <li>
                {bambuGuide(family).developerWhere} {bambuGuide(family).accessCode}
              </li>
              <li>If the printer can't be reached: {bambuGuide(family).lanOnly}</li>
              <li>Optional, for printing directly: {bambuGuide(family).developer}</li>
            </ol>
          ) : null}
          <p className="fr-codecard-note">
            LAN Only Mode takes the printer off Bambu Cloud, so Bambu Handy stops working. Printing from this computer keeps working.{' '}
            <button type="button" className="fr-codecard-more" aria-expanded={more} onClick={() => setMore(!more)}>
              {more ? 'Less' : 'More'}
            </button>
          </p>
          {more ? (
            <p className="fr-codecard-note">
              {LAN_ONLY_EFFECT} {DEVELOPER_EFFECT}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
