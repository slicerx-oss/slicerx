// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

/** Single consumer async queue: producers push, one `for await` drains. */
export class Channel<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiting: ((r: IteratorResult<T>) => void) | null = null
  private closed = false
  private failure: unknown = null

  push(item: T): void {
    if (this.closed) return
    if (this.waiting) {
      const w = this.waiting
      this.waiting = null
      w({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  close(error?: unknown): void {
    if (this.closed) return
    this.closed = true
    if (error !== undefined) this.failure = error
    if (this.waiting) {
      const w = this.waiting
      this.waiting = null
      w({ value: undefined, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) {
        if (this.failure !== null) throw this.failure
        return
      }
      const r = await new Promise<IteratorResult<T>>((res) => {
        this.waiting = res
      })
      if (r.done) {
        if (this.failure !== null) throw this.failure
        return
      }
      yield r.value
    }
  }
}
