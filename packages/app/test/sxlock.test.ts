// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileRef, Host, SxlockKeyRef, SxlockResult } from '@slicerx/contracts'
import { SXLOCK_HEADER_BYTES, SxlockError, isSxlock, openSxlock, readSxlockHeader, sealSxlock, tokenKeys, type SxlockKeys } from '@slicerx/embed/sxlock'
import { get, set, type PlateEntry } from '../src/state/store'

vi.mock('../src/export/actions', () => ({ sx3mfBytes: async () => new TextEncoder().encode('PK project bracket-v2') }))

// The account service of supabase/migrations/0010_sxlock.sql, in memory: same derivation, same refusals.
class Accounts {
  online = true
  keys = new Map<string, { user: string; secret: Buffer; retired: boolean; revoked: boolean }>()

  private active(user: string): string {
    for (const [id, k] of this.keys) if (k.user === user && !k.retired && !k.revoked) return id
    const id = randomUUID()
    this.keys.set(id, { user, secret: randomBytes(32), retired: false, revoked: false })
    return id
  }

  private derive(secret: Buffer, owner: string, keyId: string, salt: string): string {
    const uuid = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex')
    return createHmac('sha256', secret).update(Buffer.concat([Buffer.from('sxlock/v1'), uuid(owner), uuid(keyId), Buffer.from(salt, 'hex')])).digest('hex')
  }

  rotate(user: string): void {
    for (const k of this.keys.values()) if (k.user === user) k.retired = true
  }

  revoke(id: string): void {
    this.keys.get(id)!.revoked = true
  }

  as(user: string | null): SxlockKeys {
    const no = (reason: 'offline' | 'signed_out' | 'wrong_account' | 'revoked' | 'unknown_key') => ({ ok: false as const, reason, message: reason })
    return {
      seal: async (salt) => {
        if (!this.online) return no('offline')
        if (!user) return no('signed_out')
        const keyId = this.active(user)
        return { ok: true, value: { owner: user, keyId, contentKey: this.derive(this.keys.get(keyId)!.secret, user, keyId, salt) } }
      },
      open: async (ref: SxlockKeyRef): Promise<SxlockResult<string>> => {
        if (!this.online) return no('offline')
        if (!user) return no('signed_out')
        if (ref.owner !== user) return no('wrong_account')
        const k = this.keys.get(ref.keyId)
        if (!k || k.user !== user) return no('unknown_key')
        if (k.revoked) return no('revoked')
        return { ok: true, value: this.derive(k.secret, ref.owner, ref.keyId, ref.salt) }
      },
    }
  }
}

const RV = randomUUID()
const ASH = randomUUID()
const project = new TextEncoder().encode('PK\x03\x04 3D/3dmodel.model <object name="bracket-v2"/>')
const text = (b: Uint8Array) => Buffer.from(b).toString('latin1')
const code = async (p: Promise<unknown>) => p.then(() => 'opened', (e: unknown) => (e instanceof SxlockError ? e.code : String(e)))
const flip = (b: Uint8Array, at: number) => {
  const c = b.slice()
  c[at] = (c[at] ?? 0) ^ 1
  return c
}

let accounts: Accounts
beforeEach(() => {
  accounts = new Accounts()
})

describe('locked project format', () => {
  it('round trips for the owner and keeps the project unreadable inside', async () => {
    const locked = await sealSxlock(project, accounts.as(RV))
    expect(isSxlock(locked)).toBe(true)
    expect(Buffer.from(locked).includes('bracket-v2')).toBe(false)
    expect(Buffer.from(locked).includes('PK')).toBe(false)
    const h = readSxlockHeader(locked)
    expect(h).toMatchObject({ version: 1, format: 'sx3mf', cipher: 'aes-256-gcm', owner: RV })
    expect(locked.length).toBe(SXLOCK_HEADER_BYTES + project.length + 16)
    expect(text(await openSxlock(locked, accounts.as(RV)))).toBe(text(project))
  })

  it('refuses a tampered header', async () => {
    const locked = await sealSxlock(project, accounts.as(RV))
    expect(await code(openSxlock(flip(locked, 50), accounts.as(RV)))).toBe('damaged') // salt
    expect(await code(openSxlock(flip(locked, 80), accounts.as(RV)))).toBe('damaged') // nonce
    expect(await code(openSxlock(flip(locked, 8), accounts.as(RV)))).toBe('unsupported') // version
    expect(await code(openSxlock(flip(locked, 11), accounts.as(RV)))).toBe('unsupported') // reserved
    expect(await code(openSxlock(flip(locked, 0), accounts.as(RV)))).toBe('not_sxlock')
    // Naming another owner does not move the file to that account.
    const moved = locked.slice()
    moved.set(Buffer.from(ASH.replace(/-/g, ''), 'hex'), 12)
    expect(await code(openSxlock(moved, accounts.as(ASH)))).toBe('unknown_key')
    expect(await code(openSxlock(moved, accounts.as(RV)))).toBe('wrong_account')
  })

  it('refuses tampered or cut ciphertext', async () => {
    const locked = await sealSxlock(project, accounts.as(RV))
    expect(await code(openSxlock(flip(locked, SXLOCK_HEADER_BYTES + 3), accounts.as(RV)))).toBe('damaged')
    expect(await code(openSxlock(flip(locked, locked.length - 1), accounts.as(RV)))).toBe('damaged')
    expect(await code(openSxlock(locked.slice(0, locked.length - 4), accounts.as(RV)))).toBe('damaged')
    expect(await code(openSxlock(locked.slice(0, SXLOCK_HEADER_BYTES), accounts.as(RV)))).toBe('damaged')
  })

  it('opens only for the owning account', async () => {
    const locked = await sealSxlock(project, accounts.as(RV))
    expect(await code(openSxlock(locked, accounts.as(ASH)))).toBe('wrong_account')
    expect(await code(openSxlock(locked, accounts.as(null)))).toBe('signed_out')
  })

  it('keeps files under a rotated key and refuses a revoked one', async () => {
    const before = await sealSxlock(project, accounts.as(RV))
    accounts.rotate(RV)
    const after = await sealSxlock(project, accounts.as(RV))
    expect(readSxlockHeader(after).keyId).not.toBe(readSxlockHeader(before).keyId)
    expect(text(await openSxlock(before, accounts.as(RV)))).toBe(text(project))
    accounts.revoke(readSxlockHeader(before).keyId)
    expect(await code(openSxlock(before, accounts.as(RV)))).toBe('revoked')
    expect(text(await openSxlock(after, accounts.as(RV)))).toBe(text(project))
  })

  it('says plainly that a locked file needs to be online', async () => {
    const locked = await sealSxlock(project, accounts.as(RV))
    accounts.online = false
    const e = await openSxlock(locked, accounts.as(RV)).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(SxlockError)
    expect((e as SxlockError).code).toBe('offline')
    expect((e as SxlockError).message).toMatch(/only online/)
  })
})

describe('integrator tokens', () => {
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('opens with a token the server accepts and posts only the header fields', async () => {
    const locked = await sealSxlock(project, accounts.as(RV))
    const h = readSxlockHeader(locked)
    let sent: Record<string, unknown> = {}
    const key = (await accounts.as(RV).open(h)) as { ok: true; value: string }
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return answer(200, key.value)()
    })
    const keys = tokenKeys({ supabaseUrl: 'https://db.example/', anonKey: 'anon', token: 'sxk_t', fetch: fetch as unknown as typeof globalThis.fetch })
    expect(text(await openSxlock(locked, keys))).toBe(text(project))
    expect(fetch.mock.calls[0]?.[0]).toBe('https://db.example/rest/v1/rpc/sxlock_open_with_token')
    expect(sent).toEqual({ p_token: 'sxk_t', p_owner: RV, p_key_id: h.keyId, p_salt: h.salt })
  })

  it('locks for the token\'s account with sxlock_seal', async () => {
    const sealed = (await accounts.as(RV).seal!('ab'.repeat(32))) as { ok: true; value: { owner: string; keyId: string; contentKey: string } }
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ owner: sealed.value.owner, key_id: sealed.value.keyId, content_key: sealed.value.contentKey }]), { status: 200 }))
    const keys = tokenKeys({ supabaseUrl: 'https://db.example', anonKey: 'anon', token: 'sxk_t', fetch: fetch as unknown as typeof globalThis.fetch })
    const locked = await sealSxlock(project, keys)
    expect(readSxlockHeader(locked).owner).toBe(RV)
    expect(String(fetch.mock.calls[0]?.[0 as never])).toMatch(/rpc\/sxlock_seal_with_token$/)
    const denied = tokenKeys({ supabaseUrl: 'https://db.example', anonKey: 'anon', token: 'sxk_t', fetch: answer(403, { code: '42501', hint: 'missing_scope', message: 'no' }) as unknown as typeof globalThis.fetch })
    expect(await code(sealSxlock(project, denied))).toBe('missing_scope')
  })

  it('refuses a token without the sxlock_open scope, and says when it is offline', async () => {
    const locked = await sealSxlock(project, accounts.as(RV))
    const scoped = tokenKeys({ supabaseUrl: 'https://db.example', anonKey: 'anon', token: 'sxk_t', fetch: answer(403, { code: '42501', hint: 'missing_scope', message: 'no' }) as unknown as typeof fetch })
    expect(await code(openSxlock(locked, scoped))).toBe('missing_scope')
    const other = tokenKeys({ supabaseUrl: 'https://db.example', anonKey: 'anon', token: 'sxk_t', fetch: answer(403, { code: '42501', hint: 'wrong_account', message: 'no' }) as unknown as typeof fetch })
    expect(await code(openSxlock(locked, other))).toBe('wrong_account')
    const down = tokenKeys({ supabaseUrl: 'https://db.example', anonKey: 'anon', token: 'sxk_t', fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch })
    expect(await code(openSxlock(locked, down))).toBe('offline')
    const tool = tokenKeys({ supabaseUrl: 'https://db.example', anonKey: 'anon', token: 'sxk_t', fetch: answer(200, 'not a key') as unknown as typeof fetch })
    expect(await code(openSxlock(locked, tool))).toBe('invalid')
  })
})

describe('locked projects in the app', () => {
  const entry = { id: 'kept', name: 'kept.stl', handle: { id: 'kept', name: 'kept', parts: [] }, parts: [], colors: ['#fff'], transform: [] } as unknown as PlateEntry
  const storeOf = (keys: SxlockKeys) => ({ sxlockSeal: (s: string) => keys.seal!(s), sxlockOpen: (r: SxlockKeyRef) => keys.open(r) })

  beforeEach(() => set({ plate: [entry], plates: [{ id: 'p1', name: 'Plate 1', objects: [entry], settings: { sequence: 'by-layer' } }], activePlate: 'p1', toast: null }))

  it('exports a locked project the owner can open', async () => {
    const saved: { name: string; blob: Blob }[] = []
    const host = { store: storeOf(accounts.as(RV)), files: { save: async (name: string, blob: Blob) => (saved.push({ name, blob }), { id: name, name, size: blob.size }) } } as unknown as Host
    const { exportLockedProject } = await import('../src/export/locked')
    expect(await exportLockedProject(host)).toBe(true)
    expect(saved[0]?.name).toMatch(/\.sxlock$/)
    const bytes = new Uint8Array(await saved[0]!.blob.arrayBuffer())
    expect(new TextDecoder().decode(await openSxlock(bytes, accounts.as(RV)))).toBe('PK project bracket-v2')
  })

  it('an embedding app passes its own keys, which win over the store', async () => {
    const saved: Blob[] = []
    const host = { sxlock: accounts.as(ASH), store: storeOf(accounts.as(RV)), files: { save: async (name: string, blob: Blob) => (saved.push(blob), { id: name, name, size: blob.size }) } } as unknown as Host
    const { exportLockedProject } = await import('../src/export/locked')
    expect(await exportLockedProject(host)).toBe(true)
    expect(readSxlockHeader(new Uint8Array(await saved[0]!.arrayBuffer())).owner).toBe(ASH)
  })

  it('without accounts or signed out, nothing is written', async () => {
    const save = vi.fn()
    const { exportLockedProject } = await import('../src/export/locked')
    expect(await exportLockedProject({ files: { save } } as unknown as Host)).toBe(false)
    expect(await exportLockedProject({ store: storeOf(accounts.as(null)), files: { save } } as unknown as Host)).toBe(false)
    expect(save).not.toHaveBeenCalled()
    expect(get().toast?.text).toMatch(/Sign in/)
  })

  it('a build with no account service says so instead of asking to go online', async () => {
    const none = { ok: false as const, reason: 'unavailable' as const, message: 'no service' }
    const save = vi.fn()
    const host = { store: { sxlockSeal: async () => none, sxlockOpen: async () => none }, files: { save } } as unknown as Host
    const { exportLockedProject } = await import('../src/export/locked')
    expect(await exportLockedProject(host)).toBe(false)
    expect(save).not.toHaveBeenCalled()
    expect(get().toast?.text).toBe('Locked projects need a SlicerX account service, and this build has none.')
  })

  it('offline, opening a locked file leaves the open project untouched', async () => {
    const locked = await sealSxlock(project, accounts.as(RV))
    accounts.online = false
    const ref: FileRef = { id: 'f1', name: 'bracket.sxlock', size: locked.length }
    const read = vi.fn(async () => locked.slice().buffer)
    const host = { store: storeOf(accounts.as(RV)), files: { read } } as unknown as Host
    const before = get().plate
    const { addFileRefs } = await import('../src/state/actions')
    await addFileRefs(host, [ref])
    expect(get().plate).toBe(before)
    expect(get().unsavedPrompt ?? null).toBeNull()
    expect(get().toast?.text).toMatch(/bracket\.sxlock: Locked projects open only online/)
  })
})

describe('autosave of a locked project', () => {
  const entry = { id: 'kept', name: 'kept.stl', handle: { id: 'kept', name: 'kept', parts: [] }, parts: [], colors: ['#fff'], transform: [] } as unknown as PlateEntry
  const storeOf = (keys: SxlockKeys) => ({ sxlockSeal: (s: string) => keys.seal!(s), sxlockOpen: (r: SxlockKeyRef) => keys.open(r) })
  const plain = 'PK project bracket-v2'
  const onPlate = () => set({ plate: [entry], plates: [{ id: 'p1', name: 'Plate 1', objects: [entry], settings: { sequence: 'by-layer' } }], activePlate: 'p1', toast: null, settingsOpen: false })

  beforeEach(async () => {
    const [{ setSnapshotStore, memorySnapshots }, { setLockedSession }] = await Promise.all([import('../src/project/autosave'), import('../src/project/locked-session')])
    setSnapshotStore(memorySnapshots())
    setLockedSession(null)
    onPlate()
  })

  const autosaved = async () => (await (await import('../src/project/autosave')).findRecovery())!

  it('is written in the clear only while no locked project is open', async () => {
    const { autosaveNow } = await import('../src/project/autosave')
    await autosaveNow()
    const snap = await autosaved()
    expect(snap.locked).toBeUndefined()
    expect(text(snap.data)).toBe(plain)
  })

  it('is sealed with the opened file\'s own key and a fresh nonce each time', async () => {
    const original = await sealSxlock(project, accounts.as(RV))
    const { unlockBytes } = await import('../src/export/locked')
    const host = { store: storeOf(accounts.as(RV)) } as unknown as Host
    expect(await unlockBytes(host, 'bracket.sxlock', original.slice().buffer)).not.toBeNull()
    const { autosaveNow, recordRecent, listRecent } = await import('../src/project/autosave')
    await autosaveNow()
    const first = (await autosaved()).data.slice()
    await autosaveNow()
    const snap = await autosaved()
    expect(snap).toMatchObject({ locked: true, name: 'kept.sxlock' })
    expect(isSxlock(snap.data)).toBe(true)
    expect(Buffer.from(snap.data).includes('bracket-v2')).toBe(false)
    const [a, b, o] = [readSxlockHeader(first), readSxlockHeader(snap.data), readSxlockHeader(original)]
    expect({ owner: b.owner, keyId: b.keyId, salt: b.salt }).toEqual({ owner: o.owner, keyId: o.keyId, salt: o.salt })
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false)
    expect(text(await openSxlock(snap.data, accounts.as(RV)))).toBe(plain)
    expect(await code(openSxlock(snap.data, accounts.as(ASH)))).toBe('wrong_account')
    // Nor does a locked project reach recent projects in the clear.
    await recordRecent('copy.sx3mf', new TextEncoder().encode(plain))
    expect(await listRecent()).toEqual([])
  })

  it('replaces a copy in the clear as soon as the project is exported locked', async () => {
    const { autosaveNow } = await import('../src/project/autosave')
    await autosaveNow()
    const host = { store: storeOf(accounts.as(RV)), files: { save: async (name: string) => ({ id: name, name, size: 1 }) } } as unknown as Host
    const { exportLockedProject } = await import('../src/export/locked')
    expect(await exportLockedProject(host)).toBe(true)
    const snap = await autosaved()
    expect(snap.locked).toBe(true)
    expect(Buffer.from(snap.data).includes('bracket-v2')).toBe(false)
  })

  it('recovery asks for sign-in, keeps the autosave, then restores once signed in', async () => {
    const { unlockBytes } = await import('../src/export/locked')
    await unlockBytes({ store: storeOf(accounts.as(RV)) } as unknown as Host, 'b.sxlock', (await sealSxlock(project, accounts.as(RV))).slice().buffer)
    const { autosaveNow, openSnapshot } = await import('../src/project/autosave')
    await autosaveNow()
    const snap = await autosaved()
    // A new session: nothing in memory, nobody signed in.
    ;(await import('../src/project/locked-session')).setLockedSession(null)
    set({ plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }] })
    const loadModel = vi.fn(async (_d: ArrayBuffer, name: string) => ({ id: 'm', name, parts: [] }))
    await openSnapshot({ store: storeOf(accounts.as(null)), slicer: { loadModel } } as unknown as Host, snap)
    expect(get().toast?.text).toMatch(/Sign in to the SlicerX account/)
    expect(get().settingsOpen).toBe(true)
    expect(get().plate).toEqual([])
    expect(await autosaved()).toBeTruthy()

    await openSnapshot({ store: storeOf(accounts.as(RV)), slicer: { loadModel } } as unknown as Host, snap)
    expect(loadModel).toHaveBeenCalledOnce()
    expect(text(new Uint8Array(loadModel.mock.calls[0]![0]))).toBe(plain)
    expect(loadModel.mock.calls[0]![1]).toBe('kept.sx3mf')
    expect((await import('../src/project/locked-session')).lockedSession()?.owner).toBe(RV)
  })

  it('forgets the key when the plates are emptied', async () => {
    const { unlockBytes } = await import('../src/export/locked')
    await unlockBytes({ store: storeOf(accounts.as(RV)) } as unknown as Host, 'b.sxlock', (await sealSxlock(project, accounts.as(RV))).slice().buffer)
    set({ plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }] })
    const { autosaveNow } = await import('../src/project/autosave')
    await autosaveNow()
    expect((await import('../src/project/locked-session')).lockedSession()).toBeNull()
  })
})
