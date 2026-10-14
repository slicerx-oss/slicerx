// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// Images on a message: added from the composer, removed before sending, kept to the type, size and count limits, and
// carried on the person's turn into the run.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_POLICY, type Pilot, type PilotAttachment, type PilotEvent } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachProblem, ATTACH_LIMITS, Bubble, Composer, emptyTranscript, readAttachments, Terminal, useAttachments, usePilotRun } from '../ui/index'

afterEach(cleanup)

const png = (name = 'thermostat.png', bytes = 2048) => new File([new Uint8Array(bytes)], name, { type: 'image/png' })

describe('the limits', () => {
  it('takes images up to 10 MB, four to a message', () => {
    expect(attachProblem({ name: 'a.png', type: 'image/png', size: 1000 }, 0)).toBeNull()
    expect(attachProblem({ name: 'a.pdf', type: 'application/pdf', size: 1000 }, 0)).toBeNull()
    expect(attachProblem({ name: 'a.txt', type: 'text/plain', size: 10 }, 0)).toMatch(/isn't an image or a PDF/)
    expect(attachProblem({ name: 'a.png', type: 'image/png', size: ATTACH_LIMITS.maxBytes + 1 }, 0)).toMatch(/over 10 MB/)
    expect(attachProblem({ name: 'a.png', type: 'image/png', size: 1000 }, ATTACH_LIMITS.maxCount)).toMatch(/up to 4/)
  })

  it('reads what fits and says what was left out', async () => {
    const files = [png('1.png'), png('2.png'), new File(['x'], 'notes.txt', { type: 'text/plain' }), png('3.png'), png('4.png')]
    const { added, problems } = await readAttachments(files, 1)
    expect(added.map((a) => a.name)).toEqual(['1.png', '2.png', '3.png'])
    expect(added[0]!.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(problems).toHaveLength(2)
  })
})

function Harness({ onSend, sendOff = false }: { onSend: (t: string, a: PilotAttachment[]) => void; sendOff?: boolean }) {
  const attachments = useAttachments()
  return <Composer attachments={attachments} onSend={onSend} sendOff={sendOff} />
}

describe('the composer', () => {
  it('adds an image from the attach button, removes it, and sends the rest with the text', async () => {
    const onSend = vi.fn()
    const { container } = render(<Harness onSend={onSend} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [png('a.png'), png('b.png')] } })
    })
    await waitFor(() => expect(screen.getAllByTestId('mimir-attachment')).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }))
    expect(screen.getAllByTestId('mimir-attachment')).toHaveLength(1)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A wall mount for this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledTimes(1)
    const [text, sent] = onSend.mock.calls[0] as [string, PilotAttachment[]]
    expect(text).toBe('A wall mount for this')
    expect(sent.map((a) => a.name)).toEqual(['b.png'])
    // the box is empty again
    expect(screen.queryAllByTestId('mimir-attachment')).toHaveLength(0)
  })

  it('takes a PDF drawing, shown with a file icon instead of a thumbnail', async () => {
    const { container } = render(<Harness onSend={vi.fn()} />)
    await act(async () => {
      fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['%PDF-1.4'], 'bracket.pdf', { type: 'application/pdf' })] } })
    })
    await waitFor(() => expect(screen.getAllByTestId('mimir-attachment')).toHaveLength(1))
    const chip = screen.getByTestId('mimir-attachment')
    expect(chip.textContent).toContain('bracket.pdf')
    expect(chip.querySelector('img')).toBeNull()
    expect(chip.querySelector('.att-doc')).not.toBeNull()
  })

  it('says why a file was left out', async () => {
    const { container } = render(<Harness onSend={vi.fn()} />)
    await act(async () => {
      fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'part.stl', { type: 'model/stl' })] } })
    })
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/part.stl isn't an image/))
  })

  it('keeps send off while nothing can answer', () => {
    render(<Harness onSend={vi.fn()} sendOff />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello' } })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('on the turn', () => {
  const att: PilotAttachment = { id: 'x', name: 'thermostat.png', type: 'image/png', bytes: 2048, url: 'data:image/png;base64,AA==' }

  it('rides above the bubble', () => {
    render(<Bubble text="Can we print it?" attachments={[att]} />)
    expect(screen.getByTestId('mimir-attachment').textContent).toContain('thermostat.png')
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
  })

  it('goes to the run and onto the person\'s turn', async () => {
    const seen: unknown[] = []
    const pilot: Pilot = {
      tools: () => [],
      policy: () => DEFAULT_POLICY,
      setPolicy: () => undefined,
      resolveApproval: async () => undefined,
      async *run(_s, _m, opts): AsyncIterable<PilotEvent> {
        seen.push(opts?.attachments)
        yield { type: 'done', stopReason: 'end', ms: 1 }
      },
      async *switchMachine(): AsyncIterable<PilotEvent> {
        yield { type: 'done', stopReason: 'end', ms: 1 }
      },
    }
    let run: ReturnType<typeof usePilotRun> | null = null
    function Probe() {
      run = usePilotRun(pilot, 's')
      return null
    }
    render(<Probe />)
    act(() => run!.run('Can we print it?', { attachments: [att] }))
    await waitFor(() => expect(seen).toEqual([[att]]))
    expect(run!.transcript.turns[0]!.attachments).toEqual([att])
  })
})

function TerminalHarness({ onRun }: { onRun: (m: string, files?: PilotAttachment[]) => void }) {
  const attachments = useAttachments()
  return (
    <Terminal
      sessionTitle="new" transcript={emptyTranscript()} running={false} replaying={false} paused={false} showSpeed={false} speed="1"
      onSpeed={() => undefined} showThinking={false} onShowThinking={() => undefined} canReplay={false} onReplay={() => undefined}
      onPause={() => undefined} onRun={onRun} onStop={() => undefined} suggestions={[]} approvals={{ onApprove: async () => undefined, onCancel: async () => undefined }}
      emptyNote="Ask" announcement="" attachments={attachments}
    />
  )
}

describe('the docked prompt', () => {
  it('attaches a picture and a PDF, sends them with the text, and empties the row', async () => {
    const onRun = vi.fn()
    const { container } = render(<TerminalHarness onRun={onRun} />)
    await act(async () => {
      fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [png('sketch.png'), new File(['%PDF-1.4'], 'bracket.pdf', { type: 'application/pdf' })] } })
    })
    await waitFor(() => expect(screen.getAllByTestId('mimir-attachment')).toHaveLength(2))
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask mimir' }), { target: { value: 'Make a bracket for this' } })
    fireEvent.submit(container.querySelector('form.term-in')!)
    const [text, files] = onRun.mock.calls[0] as [string, PilotAttachment[]]
    expect(text).toBe('Make a bracket for this')
    expect(files.map((f) => [f.name, f.type])).toEqual([['sketch.png', 'image/png'], ['bracket.pdf', 'application/pdf']])
    expect(screen.queryAllByTestId('mimir-attachment')).toHaveLength(0)
  })

  it('sends files with no text, and takes a dropped file', async () => {
    const onRun = vi.fn()
    const { container } = render(<TerminalHarness onRun={onRun} />)
    const form = container.querySelector('form.term-in')!
    await act(async () => {
      fireEvent.drop(form, { dataTransfer: { types: ['Files'], files: [png('photo.png')] } })
    })
    await waitFor(() => expect(screen.getAllByTestId('mimir-attachment')).toHaveLength(1))
    fireEvent.submit(form)
    expect((onRun.mock.calls[0] as [string, PilotAttachment[]])[1].map((f) => f.name)).toEqual(['photo.png'])
  })

  it('has no attach button without attachments', () => {
    render(<Terminal sessionTitle="new" transcript={emptyTranscript()} running={false} replaying={false} paused={false} showSpeed={false} speed="1" onSpeed={() => undefined} showThinking={false} onShowThinking={() => undefined} canReplay={false} onReplay={() => undefined} onPause={() => undefined} onRun={vi.fn()} onStop={() => undefined} suggestions={[]} approvals={{ onApprove: async () => undefined, onCancel: async () => undefined }} emptyNote="Ask" announcement="" />)
    expect(screen.queryByTestId('mimir-attach')).toBeNull()
  })
})
