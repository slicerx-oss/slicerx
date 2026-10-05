// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How the sync engine reaches the service: the sync_pull and sync_push
// database functions, called with the signed-in user's session.
import { z } from 'zod'
import { type CloudResult, fail, ok } from '../result'
import type { SyncEntity } from './types'

export interface PulledRow {
  entity: SyncEntity
  revision: number
  row: unknown
}

export interface PushChange {
  entity: SyncEntity
  row: Record<string, unknown>
  /** null creates the row. */
  baseRevision: number | null
}

export interface PushResult {
  idx: number
  status: 'applied' | 'conflict' | 'rejected'
  /** The stored row (applied), the current row or null (conflict), or `{ code, message }` (rejected). */
  row: unknown
}

export interface SyncTransport {
  /** Rows above `since`, oldest first, at most `limit`. */
  pull(since: number, limit: number): Promise<CloudResult<PulledRow[]>>
  push(changes: PushChange[], deviceId: string | null): Promise<CloudResult<PushResult[]>>
}

/** The part of a Supabase client the transport uses, so any client version fits. */
export interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string | undefined } | null }>
}

const revision = z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)])
const pulled = z.array(
  z.object({ entity: z.enum(['profile', 'printer', 'fleet']), revision, row_data: z.unknown() }),
)
const pushed = z.array(
  z.object({ idx: z.number().int(), status: z.enum(['applied', 'conflict', 'rejected']), row_data: z.unknown() }),
)

async function call<T>(
  client: RpcClient,
  fn: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<CloudResult<T>> {
  let res: Awaited<ReturnType<RpcClient['rpc']>>
  try {
    res = await client.rpc(fn, args)
  } catch (e) {
    return fail('offline', e instanceof Error ? e.message : 'the service could not be reached')
  }
  if (res.error) {
    const code = res.error.code ?? ''
    if (code === '42501' || code === 'PGRST301' || code === 'PGRST302') return fail('unauthorized', res.error.message)
    if (code === '22023') return fail('bad_request', res.error.message)
    // supabase-js reports network failures with an empty code.
    if (code === '') return fail('offline', res.error.message)
    return fail('unavailable', res.error.message)
  }
  const parsed = schema.safeParse(res.data)
  return parsed.success ? ok(parsed.data) : fail('invalid_response', parsed.error.message)
}

export function supabaseSyncTransport(client: RpcClient): SyncTransport {
  return {
    async pull(since, limit) {
      const res = await call(client, 'sync_pull', { p_since: since, p_limit: limit }, pulled)
      return res.ok ? ok(res.value.map((r) => ({ entity: r.entity, revision: r.revision, row: r.row_data }))) : res
    },
    async push(changes, deviceId) {
      const res = await call(client, 'sync_push', { p_changes: changes, p_device: deviceId }, pushed)
      return res.ok ? ok(res.value.map((r) => ({ idx: r.idx, status: r.status, row: r.row_data }))) : res
    },
  }
}
