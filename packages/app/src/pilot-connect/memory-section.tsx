// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Memory: the notes mimir keeps about the person, by kind, each one edited or deleted in place; whether a
// note is saved without asking; Export (every note as one JSON file) and Clear all, which asks first. Every change goes
// through the app's one handle on the edition's notes (memory.ts), the same one mimir saves through.
import { NOTE_MAX, noteProblem, type MemoryFact, type MemoryKind } from '@slicerx/pilot'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, MenuAnchor, Popover, SwitchRow, ToastProvider, useToast } from '@slicerx/ui'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { Loading } from '../shell/loading'
import { set, useApp } from '../state/store'
import { useMemoryStore, type WatchedMemory } from './memory'
import './connect.css'

/** The kinds in the order Settings lists them, in plain words. */
export const KIND_LABELS: readonly { kind: MemoryKind; label: string }[] = [
  { kind: 'printer', label: 'Printers' },
  { kind: 'filament', label: 'Filaments' },
  { kind: 'preference', label: 'Preferences' },
  { kind: 'outcome', label: 'What worked' },
  { kind: 'size', label: 'Sizes' },
]

// focusNext's value for the section heading; note ids start mem_
const HEADING = ':heading'

/** The notes through `store`, read again after every change made through it. Null until the first read. */
function useNotes(store: WatchedMemory): MemoryFact[] | null {
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

const PROBLEMS: Record<NonNullable<ReturnType<typeof noteProblem>>, string> = {
  'one-line': 'Keep a note on one line.',
  short: 'A note needs a few words.',
  long: `Keep a note under ${NOTE_MAX} characters.`,
  secret: 'That looks like a key, token, access code or serial. Notes never keep those.',
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The notes in the order the section shows them: by kind, newest first within each. */
function shown(facts: readonly MemoryFact[]): MemoryFact[] {
  return KIND_LABELS.flatMap(({ kind }) => facts.filter((f) => f.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt))
}

/**
 * One note. Editing swaps the words for a field of the same size in the same place (the field's height follows its
 * text), and Edit and Delete for Save and Cancel at the same widths, so nothing around the row moves. Save and Cancel
 * hand focus back to Edit.
 */
function NoteRow({ fact, store, onDelete }: { fact: MemoryFact; store: WatchedMemory; onDelete: (f: MemoryFact) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const row = useRef<HTMLLIElement>(null)
  const was = useRef(false)
  const editing = draft !== null
  useEffect(() => {
    if (was.current && !editing) row.current?.querySelector<HTMLButtonElement>('[data-mem-edit]')?.focus()
    was.current = editing
  }, [editing])
  const stop = (): void => {
    setDraft(null)
    setErr(null)
  }
  const save = async (): Promise<void> => {
    // the same checks mimir's own save makes (noteProblem): one line, the length, no secret
    const text = (draft ?? '').trim()
    if (text === fact.text) return stop()
    const bad = noteProblem(text)
    if (bad) return setErr(PROBLEMS[bad])
    setBusy(true)
    try {
      await store.put({ ...fact, text, updatedAt: Date.now() })
      stop()
    } catch (e) {
      setErr(errText(e))
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
    <li ref={row} className="mem-row" data-editing={editing || undefined}>
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
            <Button size="sm" data-mem-edit={fact.id} aria-label={`Edit "${fact.text}"`} onClick={() => setDraft(fact.text)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Delete "${fact.text}"`} onClick={() => onDelete(fact)}>
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

/**
 * Settings > Memory. Its toasts (Deleted, with Undo; a failed delete or clear; Export) come from a toast card of its
 * own inside the section: the app's card sits under the modal Settings dialog, where nobody would see an Undo.
 */
export function MemorySection() {
  return (
    <div className="mem-toasts">
      <ToastProvider>
        <MemoryBody />
      </ToastProvider>
    </div>
  )
}

function MemoryBody() {
  const store = useMemoryStore()
  const facts = useNotes(store)
  const host = useHost()
  const edition = useEdition()
  const toast = useToast()
  const withoutAsking = useApp((s) => s.mimirRememberWithoutAsking)
  const [clearing, setClearing] = useState(false)
  const count = facts?.length ?? 0
  const sec = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  // where focus goes once the list next reads back after a change: a note's Edit, or the heading when none is left.
  // Set before the change, since the list can read back before the change's own promise settles.
  const focusNext = useRef<string | null>(null)
  useEffect(() => {
    const want = focusNext.current
    if (want === null || facts === null) return
    focusNext.current = null
    const edit = want === HEADING ? undefined : [...(sec.current?.querySelectorAll<HTMLButtonElement>('[data-mem-edit]') ?? [])].find((b) => b.dataset['memEdit'] === want)
    ;(edit ?? heading.current)?.focus()
  }, [facts])
  const exportAll = async (): Promise<void> => {
    try {
      const all = await store.list()
      const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), facts: all }, null, 2)], { type: 'application/json' })
      const saved = await host.files.save(`${edition.id}-notes.json`, blob, { accept: ['.json'] })
      if (saved) toast(`Saved ${saved.name}`, { tone: 'ok' })
    } catch (e) {
      toast(`Could not export the notes: ${errText(e)}`, { tone: 'error' })
    }
  }
  // Delete needs no confirm: the toast's Undo puts the note back. Focus moves to the next note, or the one before.
  const remove = async (f: MemoryFact): Promise<void> => {
    const order = shown(facts ?? [])
    const at = order.findIndex((x) => x.id === f.id)
    focusNext.current = order[at + 1]?.id ?? order[at - 1]?.id ?? HEADING
    try {
      await store.remove(f.id)
    } catch (e) {
      focusNext.current = null
      return toast(`Could not delete the note: ${errText(e)}`, { tone: 'error' })
    }
    const undo = (): void => {
      focusNext.current = f.id
      store.put(f).catch((e: unknown) => {
        focusNext.current = null
        toast(`Could not put the note back: ${errText(e)}`, { tone: 'error' })
      })
    }
    toast('Deleted.', { tone: 'plain', action: { label: 'Undo', run: undo } })
  }
  const clearAll = async (): Promise<void> => {
    focusNext.current = HEADING
    try {
      await store.clear()
    } catch (e) {
      focusNext.current = null
      toast(`Could not clear the notes: ${errText(e)}`, { tone: 'error' })
    } finally {
      // closed either way; a failed clear leaves focus on Clear all, where the popover hands it back
      setClearing(false)
    }
  }
  return (
    <section ref={sec} className="set-sec mem-sec" aria-labelledby="mem-h">
      <h3 id="mem-h" ref={heading} tabIndex={-1}>
        Memory
      </h3>
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
          const rows = shown(facts).filter((f) => f.kind === kind)
          if (!rows.length) return null
          return (
            <div key={kind} className="mem-group">
              <h4 id={`mem-${kind}`} className="set-sub">
                {label}
              </h4>
              <ul className="mem-list" aria-labelledby={`mem-${kind}`}>
                {rows.map((f) => (
                  <NoteRow key={f.id} fact={f} store={store} onDelete={(x) => void remove(x)} />
                ))}
              </ul>
            </div>
          )
        })
      )}
    </section>
  )
}
