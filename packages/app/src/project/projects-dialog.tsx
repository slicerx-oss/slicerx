// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Unsaved work offered back after a crash, and the recent projects list.
import { Button, Dialog } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { useHost } from '../host'
import { set, useApp } from '../state/store'
import { discardRecovery, findRecovery, listRecent, openSnapshot, type Snapshot } from './autosave'
import { appName } from '../edition'

const when = (t: number): string => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const count = (n: number): string => `${n} ${n === 1 ? 'object' : 'objects'}`

export function ProjectsDialog() {
  const host = useHost()
  const mode = useApp((s) => s.projectsDialog)
  const [recovery, setRecovery] = useState<Snapshot | null>(null)
  const [recent, setRecent] = useState<Snapshot[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!mode) return
    void findRecovery().then(setRecovery)
    void listRecent().then(setRecent)
  }, [mode])
  const close = () => set({ projectsDialog: null })
  const open = async (snap: Snapshot) => {
    setBusy(true)
    try {
      await openSnapshot(host, snap)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={mode !== null}
      onClose={close}
      title={mode === 'recover' ? 'Restore unsaved work?' : 'Recent projects'}
      testId="projects-dialog"
      footer={
        <Button variant="primary" data-testid="projects-close" onClick={close}>
          Close
        </Button>
      }
    >
      {recovery ? (
        <section aria-label="Unsaved work" data-testid="recover-work">
          <p className="sx-small">
            {appName()} kept <b>{recovery.name}</b> ({count(recovery.objects)}, {when(recovery.savedAt)}) because it was never saved.
            {recovery.locked ? ` It is locked to your ${appName()} account, so restoring it needs you signed in and online.` : ''}
          </p>
          <div className="calib-act">
            <Button variant="primary" disabled={busy} data-testid="recover-restore" onClick={() => void open(recovery)}>
              Restore
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              data-testid="danger-recover-discard"
              onClick={() => {
                void discardRecovery()
                setRecovery(null)
                if (mode === 'recover') close()
              }}
            >
              Discard
            </Button>
          </div>
        </section>
      ) : mode === 'recover' ? (
        <p className="sx-small sx-muted" data-testid="recover-nothing">
          There is nothing to restore.
        </p>
      ) : null}
      {mode === 'recent' ? (
        recent.length ? (
          <ul className="recent-projects">
            {recent.map((r) => (
              <li key={r.id}>
                <button type="button" disabled={busy} data-testid="recent-project" onClick={() => void open(r)}>
                  <b>{r.name}</b>
                  <small>
                    {count(r.objects)}, {when(r.savedAt)}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sx-small sx-muted">Projects you save or open appear here.</p>
        )
      ) : null}
    </Dialog>
  )
}
