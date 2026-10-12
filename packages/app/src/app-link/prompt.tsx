// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The question the hub asks the first time an agent calls on the open project: allow it, allow it to read only, or
// deny it. The answer is kept on the hub until the person revokes it in Settings, Agents. Only a person answers it: the
// agent bridge refuses these buttons.
import { Button, Dialog } from '@slicerx/ui'
import { appName } from '../edition'
import { answerAsk, useLinkAsks } from './host'

export function AppLinkPrompt() {
  const ask = useLinkAsks()[0]
  if (!ask) return null
  const decide = (d: 'allow' | 'read' | 'deny') => void answerAsk(ask, d).catch(() => undefined)
  return (
    <Dialog
      open
      onClose={() => decide('deny')}
      title={`${ask.name} wants to use the open project`}
      testId="app-link-prompt"
      splitFooter
      footer={
        <>
          <Button variant="ghost" onClick={() => decide('deny')} data-testid="app-link-deny" data-agent-refuse>
            Deny
          </Button>
          <span className="sx-row">
            <Button variant="ghost" onClick={() => decide('read')} data-testid="app-link-read" data-agent-refuse>
              Allow read only
            </Button>
            <Button onClick={() => decide('allow')} data-testid="app-link-allow" data-agent-refuse>
              Allow
            </Button>
          </span>
        </>
      }
    >
      <p>
        With Allow, {ask.name} can read the plate and change its designs and objects the way you do in {appName()}. Each change is one step you can undo. With Allow read only, it can look but not
        change anything.
      </p>
      <p className="sx-muted">It can never print, queue, approve a print or change your settings. You can take this back in Settings, Agents.</p>
    </Dialog>
  )
}
