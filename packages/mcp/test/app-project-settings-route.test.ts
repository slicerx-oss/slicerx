// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it, vi } from 'vitest'
import { routeToApp, type AppLinkCaller } from '../src/app-route'

it('sends an explicitly app-scoped setting patch to the app instead of the local project', async () => {
  const local = vi.fn(async () => ({ summary: 'local', output: {} }))
  const call = vi.fn(async () => ({ summary: 'updated', output: { overrides: { wall_loops: 5 } } }))
  const [tool] = routeToApp([{ name: 'project.set_overrides', run: local }] as never, { call: call as AppLinkCaller['call'] }, 'Workshop', { required: true })
  const args = { changes: { wall_loops: 5 } }
  const result = await tool!.run(args as never, {} as never)
  expect(local).not.toHaveBeenCalled()
  expect(call).toHaveBeenCalledWith('project.set_overrides', args)
  expect(result.output).toMatchObject({ overrides: { wall_loops: 5 }, in: 'app' })
})

it('never edits a server project when --app is required but the live app is closed', async () => {
  const local = vi.fn(async () => ({ summary: 'local', output: {} }))
  const call = async () => { throw Object.assign(new Error('closed'), { code: 'app_closed' }) }
  const [tool] = routeToApp([{ name: 'project.set_overrides', run: local }] as never, { call }, 'Workshop', { required: true })
  await expect(tool!.run({ changes: { wall_loops: 5 } } as never, {} as never)).rejects.toMatchObject({ code: 'not_configured' })
  expect(local).not.toHaveBeenCalled()
})
