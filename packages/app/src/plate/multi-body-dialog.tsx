// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "Load it as one object with parts?" for a model file that holds several separate bodies (state/multi-body.ts).
import { Button, Dialog } from '@slicerx/ui'
import { useState } from 'react'
import { answerMultiBody } from '../state/multi-body'
import { useApp } from '../state/store'

export function MultiBodyDialog() {
  const prompt = useApp((s) => s.multiBodyPrompt)
  const [remember, setRemember] = useState(false)
  const n = prompt?.bodies ?? 0
  return (
    <Dialog
      open={prompt !== null}
      onClose={() => answerMultiBody(null)}
      title="Load as one object with parts?"
      testId="multi-body-dialog"
      footer={
        <>
          <label className="multi-body-remember">
            <input type="checkbox" data-testid="multi-body-remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember my choice
          </label>
          <Button variant="ghost" data-testid="multi-body-objects" onClick={() => answerMultiBody('objects', remember)}>
            {n} separate objects
          </Button>
          <Button variant="primary" data-testid="multi-body-parts" onClick={() => answerMultiBody('parts', remember)}>
            One object, {n} parts
          </Button>
        </>
      }
    >
      <p className="sx-small">
        {prompt?.name ?? 'This file'} holds {n} separate bodies. As one object their parts move together; as separate objects each one moves and
        arranges on its own.
      </p>
      <p className="sx-small sx-dim">Remembered choices can be changed in Settings, Slicing and modeling.</p>
    </Dialog>
  )
}
