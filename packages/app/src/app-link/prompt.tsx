// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The question the hub asks the first time an agent calls on the open project: allow it, allow it to read only, or
// deny it. The answer is kept on the hub until the person revokes it in Settings, Agents. Only a person answers it: the
// agent bridge refuses these buttons. The agent named itself when it was connected, so the name is shown as its claim,
// with the day it was connected, never as the title.
import { SheetRecord } from '@slicerx/pilot/ui'
import '@slicerx/pilot/ui/pilot.css'
import { Button, Dialog } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { appName } from '../edition'
import { answerAsk, useLinkAsks, type LinkAsk } from './host'
import { answerClientSheet, useWaitingSheets, type ClientSheet } from './sheets'
import './prompt.css'

/** The buttons wait this long after a question appears, so a click meant for something else never answers it. */
export const ARM_MS = 800

export function AppLinkPrompt() {
  const ask = useLinkAsks()[0]
  const sheet = useWaitingSheets()[0]
  // A new question is a new dialog: its buttons arm again. A client's sheet waits behind a question.
  if (ask) return <Question key={ask.askId} ask={ask} />
  return sheet ? <SheetQuestion key={sheet.sheet.id} item={sheet} /> : null
}

/** A client's sheet: the sizes it will build from, for the person to confirm or set aside. */
function SheetQuestion({ item }: { item: ClientSheet }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(t)
  }, [])
  const answer = (values: Record<string, number> | null) => void answerClientSheet(item.sheet.id, values).catch(() => undefined)
  return (
    <Dialog
      open
      onClose={() => answer(null)}
      title="An agent asks you to check these sizes"
      testId="app-link-sheet"
      splitFooter
      footer={
        <>
          <Button variant="ghost" disabled={!armed} onClick={() => answer(null)} data-testid="app-link-sheet-decline" data-agent-refuse>
            Not now
          </Button>
          <Button disabled={!armed} onClick={() => answer(Object.fromEntries(item.sheet.dims.map((d) => [d.key, d.value])))} data-testid="app-link-sheet-confirm" data-agent-refuse>
            Build with these sizes
          </Button>
        </>
      }
    >
      <p>
        An agent you connected, which calls itself <b>{item.client.name}</b>, will build from these sizes. Guesses are marked; check them before it builds.
      </p>
      <div className="app-link-sheet-rec sx-pilot">
        <SheetRecord sheet={item.sheet} answer={null} />
      </div>
    </Dialog>
  )
}

function Question({ ask }: { ask: LinkAsk }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(t)
  }, [])
  const decide = (d: 'allow' | 'read' | 'deny') => void answerAsk(ask, d).catch(() => undefined)
  const made = new Date(ask.createdAt)
  const day = Number.isNaN(made.getTime()) ? null : made.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  return (
    <Dialog
      open
      onClose={() => decide('deny')}
      title="An agent wants to use the open project"
      testId="app-link-prompt"
      splitFooter
      footer={
        <>
          <Button variant="ghost" disabled={!armed} onClick={() => decide('deny')} data-testid="app-link-deny" data-agent-refuse>
            Deny
          </Button>
          <span className="sx-row">
            <Button variant="ghost" disabled={!armed} onClick={() => decide('read')} data-testid="app-link-read" data-agent-refuse>
              Allow read only
            </Button>
            <Button disabled={!armed} onClick={() => decide('allow')} data-testid="app-link-allow" data-agent-refuse>
              Allow
            </Button>
          </span>
        </>
      }
    >
      <p data-testid="app-link-who">
        An agent you connected{day ? ` on ${day}` : ''}, which calls itself <b>{ask.name}</b>, is asking to work on the project open in {appName()}.
      </p>
      <p>
        With Allow, it can read the plate and change its designs and objects the way you do. Each change is one step you can undo. With Allow read only, it can look but not change anything.
      </p>
      <p className="sx-muted">It can never print, queue, approve a print or change your settings. You can take this back in Settings, Agents.</p>
    </Dialog>
  )
}
