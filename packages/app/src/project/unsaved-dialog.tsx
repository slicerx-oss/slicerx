// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Button, Dialog } from '@slicerx/ui'
import { useState } from 'react'
import { useHost } from '../host'
import { useApp } from '../state/store'
import { answerUnsaved } from './unsaved'

/** "Save changes before you ...?" Save, discard or cancel. */
export function UnsavedDialog() {
  const host = useHost()
  const prompt = useApp((s) => s.unsavedPrompt)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const { saveProject } = await import('../export/actions')
      answerUnsaved(await saveProject(host))
    } catch {
      answerUnsaved(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={prompt !== null}
      onClose={() => answerUnsaved(false)}
      title="Save changes first?"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => answerUnsaved(false)}>Cancel</Button>
          <Button variant="ghost" disabled={busy} onClick={() => answerUnsaved(true)}>Don't save</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>Save project</Button>
        </>
      }
    >
      <p className="sx-small">This project has changes that were not saved. Save them before you {prompt?.what ?? 'continue'}?</p>
    </Dialog>
  )
}
