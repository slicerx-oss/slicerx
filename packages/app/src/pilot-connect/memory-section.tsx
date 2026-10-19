// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Memory: the notes mimir keeps about the person, by kind, each one edited or deleted in place; whether a
// note is saved without asking; Export (every note as one JSON file) and Clear all, which asks first. Every change goes
// through the app's one handle on the edition's notes (memory-store.ts), the same one mimir saves through.
import { redactSecrets, type MemoryFact, type MemoryKind } from '@slicerx/pilot'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, MenuAnchor, Popover, SwitchRow, useToast } from '@slicerx/ui'
import { useEffect, useState, type KeyboardEvent } from 'react'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { Loading } from '../shell/loading'
import { set, useApp } from '../state/store'
import { useMemoryStore, type AppMemory } from './memory-store'
import './connect.css'

/** The kinds in the order Settings lists them, in plain words. */
export const KIND_LABELS: readonly { kind: MemoryKind; label: string }[] = [
  { kind: 'printer', label: 'Printers' },
  { kind: 'filament', label: 'Filaments' },
  { kind: 'preference', label: 'Preferences' },
  { kind: 'outcome', label: 'What worked' },
  { kind: 'size', label: 'Sizes' },
]

/** The notes through `store`, read again after every change made through it. Null until the first read. */
function useNotes(store: AppMemory): MemoryFact[] | null {
  const [facts, setFacts] = useState<MemoryFact[] | null>(null)
  useEffect(() => {
    let live = true
    const load = (): void =>
      void store.list().then(
        (f) => live && setFacts(f),
        () => live && setFacts([]),
      )
    load()
    const off = store.subscribe(load)
    return () => {
      live = false
      off()
    }
  }, [store])
  return facts
}

/** What is wrong with an edited note, as mimir's own save would refuse it, or null. */
function problem(text: string): string | null {
  if (text.length < 3) return 'A note needs a few words.'
  if (text.length > 240) return 'Keep a note under 240 characters.'
  if (redactSecrets(text).refused) return 'That looks like a key, token, access code or serial. Notes never keep those.'
  return null
}

/**
 * One note. Editing swaps the words for a field of the same size in the same place (the field's height follows its
 * text), and Edit and Delete for Save and Cancel at the same widths, so nothing around the row moves.
 */
function NoteRow({ fact, store }: { fact: MemoryFact; store: AppMemory }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const editing = draft !== null
  const stop = (): void => {
    setDraft(null)
    setErr(null)
  }
  const save = async (): Promise<void> => {
    const text = (draft ?? '').trim()
    if (text === fact.text) return stop()
    const bad = problem(text)
    if (bad) return setErr(bad)
    setBusy(true)
    try {
      await store.put({ ...fact, text, updatedAt: Date.now() })
      stop()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      // the field's own Escape, so the dialog around it stays open
      e.preventDefault()
      e.stopPropagation()
      stop()
    }
  }
  return (
    <li className="mem-row" data-editing={editing || undefined}>
      <div className="mem-text" data-value={`${draft ?? fact.text} `}>
        {editing ? (
          <textarea className="mem-field" aria-label="Note" rows={1} value={draft} autoFocus aria-invalid={err ? true : undefined} onChange={(e) => (setDraft(e.target.value), setErr(null))} onKeyDown={keys} />
        ) : (
          <span className="mem-field">{fact.text}</span>
        )}
      </div>
      <div className="mem-row-a">
        {editing ? (
          <>
            <Button size="sm" busy={busy} onClick={() => void save()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={stop}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" aria-label={`Edit "${fact.text}"`} onClick={() => setDraft(fact.text)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Delete "${fact.text}"`} onClick={() => void store.remove(fact.id)}>
              Delete
            </Button>
          </>
        )}
      </div>
      {err ? (
        <p className="mem-err sx-small" role="alert">
          {err}
        </p>
      ) : null}
    </li>
  )
}

export function MemorySection() {
  const store = useMemoryStore()
  const facts = useNotes(store)
  const host = useHost()
  const edition = useEdition()
  const toast = useToast()
  const withoutAsking = useApp((s) => s.mimirRememberWithoutAsking)
  const [clearing, setClearing] = useState(false)
  const count = facts?.length ?? 0
  const exportAll = async (): Promise<void> => {
    const all = await store.list()
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), facts: all }, null, 2)], { type: 'application/json' })
    try {
      const saved = await host.files.save(`${edition.id}-notes.json`, blob, { accept: ['.json'] })
      if (saved) toast(`Saved ${saved.name}`, { tone: 'ok' })
    } catch (e) {
      toast(`Could not export the notes: ${e instanceof Error ? e.message : String(e)}`, { tone: 'error' })
    }
  }
  const clearAll = async (): Promise<void> => {
    await store.clear()
    setClearing(false)
  }
  return (
    <section className="set-sec mem-sec" aria-labelledby="mem-h">
      <h3 id="mem-h">Memory</h3>
      <p className="sx-small sx-muted">Notes {ASSISTANT_NAME} keeps about your printers, filaments and what worked, so you don't have to repeat yourself. They stay on this computer.</p>
      <SwitchRow
        id="memory-without-asking"
        testId="memory-without-asking"
        label="Save notes without asking"
        detail={`${ASSISTANT_NAME} keeps a note without showing Remember and Not now first.`}
        checked={withoutAsking}
        onChange={(v) => set({ mimirRememberWithoutAsking: v })}
      />
      {/* Sync with my account goes here, under Save notes without asking, once notes can be copied to the account
          (the edition's ai.brain.memory.sync). */}
      {/* Clear all at the row's right end, so its confirm opens leftward inside the dialog and never needs lifting out */}
      <div className="set-actions mem-actions">
        <Button icon="export" data-testid="memory-export" disabled={count === 0} onClick={() => void exportAll()}>
          Export
        </Button>
        <MenuAnchor>
          <Button variant="ghost" data-testid="danger-memory-clear" aria-haspopup="dialog" aria-expanded={clearing} disabled={count === 0} onClick={() => setClearing(!clearing)}>
            Clear all
          </Button>
          <Popover open={clearing} onClose={() => setClearing(false)} label="Clear all notes" align="end" className="mem-clear">
            <p>
              Clear all {count} {count === 1 ? 'note' : 'notes'}? This can't be undone.
            </p>
            <div className="mem-clear-a">
              <Button size="sm" variant="ghost" onClick={() => setClearing(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" data-testid="danger-memory-clear-confirm" onClick={() => void clearAll()}>
                Clear all
              </Button>
            </div>
          </Popover>
        </MenuAnchor>
      </div>
      {facts === null ? (
        <Loading />
      ) : count === 0 ? (
        <p className="sx-small sx-muted">No notes yet. When you tell {ASSISTANT_NAME} about your printers or filaments, it asks before it keeps one.</p>
      ) : (
        KIND_LABELS.map(({ kind, label }) => {
          const rows = facts.filter((f) => f.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt)
          if (!rows.length) return null
          return (
            <div key={kind} className="mem-group">
              <h4 id={`mem-${kind}`} className="set-sub">
                {label}
              </h4>
              <ul className="mem-list" aria-labelledby={`mem-${kind}`}>
                {rows.map((f) => (
                  <NoteRow key={f.id} fact={f} store={store} />
                ))}
              </ul>
            </div>
          )
        })
      )}
    </section>
  )
}
