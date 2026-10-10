// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Browser files: the File System Access API where it exists, a hidden file
// input and a download link where it does not, and window drag and drop.
import type { FileHost, FileRef } from '@slicerx/contracts'

interface PickerWindow {
  showSaveFilePicker?: (opts: { suggestedName: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ name: string; createWritable(): Promise<{ write(d: Blob | ArrayBuffer): Promise<void>; close(): Promise<void> }> }>
}

export function createWebFiles(): FileHost {
  const files = new Map<string, File>()
  const recent: FileRef[] = []
  const listeners = new Set<(refs: FileRef[], how: 'drop' | 'open') => void>()
  let seq = 0

  const remember = (f: File): FileRef => {
    const ref: FileRef = { id: `file_${++seq}`, name: f.name, size: f.size }
    files.set(ref.id, f)
    recent.unshift(ref)
    recent.length = Math.min(recent.length, 12)
    return ref
  }

  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  })
  window.addEventListener('drop', (e) => {
    const list = e.dataTransfer?.files
    if (!list || list.length === 0) return
    e.preventDefault()
    const refs = [...list].filter((f) => /\.(stl|3mf|sx3mf|sxlock|obj|amf|step|stp|gcode|json)$/i.test(f.name)).map(remember)
    if (refs.length) for (const l of listeners) l(refs, 'drop')
  })

  return {
    open({ accept, multiple }) {
      return new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = accept.join(',')
        input.multiple = multiple ?? false
        // In the document, hidden, until the dialog answers: an input nothing holds can be garbage collected while the
        // dialog is open, and the pick is then lost (no change event comes).
        input.hidden = true
        const done = (refs: FileRef[]) => {
          input.remove()
          resolve(refs)
        }
        input.addEventListener('change', () => done([...(input.files ?? [])].map(remember)))
        input.addEventListener('cancel', () => done([]))
        document.body.append(input)
        input.click()
      })
    },
    async read(ref) {
      const f = files.get(ref.id)
      if (!f) throw new Error(`${ref.name} is no longer available; open it again`)
      return f.arrayBuffer()
    },
    async save(suggestedName, data, opts) {
      const blob = data instanceof Blob ? data : new Blob([data])
      const w = window as unknown as PickerWindow
      if (w.showSaveFilePicker) {
        try {
          const ext = opts?.accept?.[0] ?? `.${suggestedName.split('.').pop() ?? 'bin'}`
          const handle = await w.showSaveFilePicker({ suggestedName, types: [{ description: ext, accept: { 'application/octet-stream': [ext] } }] })
          const out = await handle.createWritable()
          await out.write(blob)
          await out.close()
          return { id: `saved_${++seq}`, name: handle.name, size: blob.size }
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return null
          throw e
        }
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = suggestedName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      return { id: `saved_${++seq}`, name: suggestedName, size: blob.size }
    },
    async recent() {
      return [...recent]
    },
    onOpenRequest(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
