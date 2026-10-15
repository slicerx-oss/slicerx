// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

export class StaleBody extends Error {
  readonly code = 'stale_body'
  readonly bodyId: string
  readonly currentRevision: string | null
  constructor(bodyId: string, currentRevision: string | null) {
    super('The body changed or was replaced. Inspect it again before editing.')
    this.bodyId = bodyId
    this.currentRevision = currentRevision
  }
}

/** Hosts advance this ledger at every successful commit, including Undo and Redo. */
export class BodyRevisions {
  private readonly session = crypto.randomUUID()
  private serial = 0
  private readonly entries = new Map<string, string>()

  private next(): string {
    if (this.serial >= Number.MAX_SAFE_INTEGER) throw new Error('Body revision counter exhausted')
    return `${this.session}:${++this.serial}`
  }

  /** Creation and replacement always invalidate references, even when the id is reused. */
  register(bodyId: string): string {
    const revision = this.next()
    this.entries.set(bodyId, revision)
    return revision
  }

  current(bodyId: string): string {
    const revision = this.entries.get(bodyId)
    if (!revision) throw new StaleBody(bodyId, null)
    return revision
  }

  assert(bodyId: string, expected: string): void {
    const revision = this.entries.get(bodyId) ?? null
    if (!revision || revision !== expected) throw new StaleBody(bodyId, revision)
  }

  /** Call synchronously with the model commit; a refusal must not advance the ledger. */
  committed(bodyId: string): string {
    this.current(bodyId)
    return this.register(bodyId)
  }

  remove(bodyId: string): void {
    this.entries.delete(bodyId)
  }
}
