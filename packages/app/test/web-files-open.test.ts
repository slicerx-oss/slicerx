// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The browser's Open keeps its file input in the document while the dialog is open, so the input cannot be garbage
// collected before the person picks (the pick would then be lost), and takes it out once the dialog answers.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebFiles } from '../../../apps/web/src/host/files'

const inputs = () => [...document.querySelectorAll<HTMLInputElement>('input[type=file]')]

describe('web Open', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('holds the input in the document, hidden, from the click until a pick, then removes it', async () => {
    const clicked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      // The click opens the dialog only for an input that is in the document by then.
      expect(this.isConnected).toBe(true)
    })
    const files = createWebFiles()
    const opened = files.open({ accept: ['.stl', '.3mf'], multiple: true })
    expect(clicked).toHaveBeenCalledTimes(1)
    const [input] = inputs()
    expect(inputs()).toHaveLength(1)
    expect(input!.hidden).toBe(true)
    expect(input!.accept).toBe('.stl,.3mf')
    const file = new File([new Uint8Array([1, 2, 3])], 'part.stl')
    Object.defineProperty(input, 'files', { value: [file] })
    input!.dispatchEvent(new Event('change'))
    const refs = await opened
    expect(refs.map((r) => [r.name, r.size])).toEqual([['part.stl', 3]])
    expect(inputs()).toHaveLength(0)
    expect(await files.read(refs[0]!)).toBeInstanceOf(ArrayBuffer)
  })

  it('removes the input when the dialog is canceled', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const opened = createWebFiles().open({ accept: ['.stl'] })
    expect(inputs()).toHaveLength(1)
    inputs()[0]!.dispatchEvent(new Event('cancel'))
    expect(await opened).toEqual([])
    expect(inputs()).toHaveLength(0)
  })
})
