// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The question the hub asks the first time an agent calls on the open project: allow it, allow it to read only, or
// deny it. The answer is kept on the hub until the person revokes it in Settings, Agents. Only a person answers it: the
// agent bridge refuses these buttons. The agent named itself when it was connected, so the name is shown as its claim,
// with the day it was connected, never as the title.
import { Button, Dialog } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { appName } from '../edition'
import { answerAsk, useLinkAsks, type LinkAsk } from './host'

/** The buttons wait this long after a question appears, so a click meant for something else never answers it. */
export const ARM_MS = 800

export function AppLinkPrompt() {
  const ask = useLinkAsks()[0]
  // A new question is a new dialog: its buttons arm again.
  return ask ? <Question key={ask.askId} ask={ask} /> : null
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
