#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Usage: node src/cli.ts [--only moonraker,bambu] [--state idle] [--auth] [--digest] [--force-logins] [--camera]
// Prints one JSON line with the ports, then serves until stdin closes or a signal arrives.
import type { PrinterState } from '@slicerx/contracts'
import { ALL_MOCKS, startMocks, MOCK_ACCESS_CODE, MOCK_API_KEY, MOCK_CLOUD_TOKEN, MOCK_DIGEST, MOCK_DUET_PASSWORD, MOCK_HA_TOKEN, MOCK_MOONRAKER_LOGIN, MOCK_RTSP_CAMERA, MOCK_SERIAL, type MockName } from './index.ts'

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const only = flag('--only')?.split(',').filter((n): n is MockName => (ALL_MOCKS as string[]).includes(n))
const state = flag('--state') as PrinterState | undefined
const running = await startMocks({ ...(only ? { only } : {}), ...(state ? { state } : {}), auth: args.includes('--auth'), digest: args.includes('--digest'), forceLogins: args.includes('--force-logins'), camera: args.includes('--camera') })

// The credentials are throwaway values that only these fakes accept.
console.log(JSON.stringify({ ports: running.ports, control: running.control, serial: MOCK_SERIAL, accessCode: MOCK_ACCESS_CODE, apiKey: MOCK_API_KEY, duetPassword: MOCK_DUET_PASSWORD, digestUser: MOCK_DIGEST.user, digestPassword: MOCK_DIGEST.password, haToken: MOCK_HA_TOKEN, cloudToken: MOCK_CLOUD_TOKEN, rtspCamera: MOCK_RTSP_CAMERA, moonrakerLogin: MOCK_MOONRAKER_LOGIN }))

const stop = () => { void running.stop().then(() => process.exit(0)) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
// Cargo tests spawn this with a piped stdin, so a dying parent ends the mock too.
process.stdin.on('end', stop)
process.stdin.resume()
