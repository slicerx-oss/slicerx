// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Native open and save dialogs. Rust owns the paths; the webview only gets ids
// and bytes. Drag and drop onto the window uses the same code as the browser.
import type { FileHost, FileRef } from '@slicerx/contracts'
import { createWebFiles } from '@slicerx/web/host/files'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export function createTauriFiles(): FileHost {
  const web = createWebFiles()
  const recent: FileRef[] = []
  return {
    async open({ accept, multiple }) {
      const refs = await invoke<FileRef[]>('open_files', { accept, multiple: multiple ?? false })
      recent.unshift(...refs)
      recent.length = Math.min(recent.length, 12)
      return refs
    },
    read: (ref) => (ref.path ? invoke<ArrayBuffer>('read_file', { id: Number(ref.id) }) : web.read(ref)),
    async save(suggestedName, data) {
      const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data)
      return invoke<FileRef | null>('save_file', bytes, { headers: { 'x-sx-name': suggestedName } })
    },
    // Only a file the shell already knows by id (opened or saved through it) is written over.
    async saveTo(ref, data) {
      const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data)
      return invoke<FileRef | null>('save_file_to', bytes, { headers: { 'x-sx-id': ref.id } })
    },
    recent: async () => [...recent, ...(await web.recent())],
    onOpenRequest(cb) {
      // Files the system hands over (a double-clicked project, an "Open in SlicerX" link) wait in the shell until asked for.
      const takeOpened = () => void invoke<FileRef[]>('opened_take').then((refs) => refs.length && cb(refs), () => undefined)
      const unlisten = listen('sx-open-files', takeOpened)
      takeOpened()
      const off = web.onOpenRequest(cb)
      return () => {
        off()
        void unlisten.then((f) => f())
      }
    },
  }
}
