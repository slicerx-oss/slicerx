// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The part of crash reporting that loads with the shell: the log capture, the desktop shell's crash host, and the
// error listeners. Errors before the report code has loaded wait here and are handed to it when it starts
// (reports.ts, loaded after the first frame), so nothing that crashes early is lost.
import { startLogCapture } from './log'

/** A crash the desktop shell recorded: a Rust panic, or the web view's process dying. */
export interface NativeCrash {
  /** The report file's name, handed back to ack once the report is queued. */
  file: string
  source: 'panic' | 'webview'
  title: string
  stack: string
  /** When it happened, in ms since the epoch. */
  at: number
}

export interface NativeCrashes {
  reports: NativeCrash[]
  /** How many times the page has loaded in this run of the shell; more than 1 means the web view reloaded. */
  pageLoads: number
  /** The operating system and its version, as the shell reads it. */
  os: string
}

/** The desktop shell's side of crash reporting (apps/desktop/src/host/crash.ts). */
export interface CrashHost {
  /** `pageLoad` is true once per page load, so the shell can count reloads. */
  take(pageLoad: boolean): Promise<NativeCrashes>
  ack(files: string[]): Promise<void>
  /** Panics on a background thread of the shell, for the developer test command. */
  testPanic(): Promise<void>
}

let crashHost: CrashHost | null = null

/** Called once by an app entry with a native shell (the desktop app). */
export function registerCrashHost(h: CrashHost | null): void {
  crashHost = h
}

export function nativeCrashHost(): CrashHost | null {
  return crashHost
}

export interface CrashInfo {
  where?: string
  componentStack?: string
  /** A promise rejection nothing handled; its reason may be anything, not only an Error. */
  rejection?: boolean
}

type Report = (error: unknown, o?: CrashInfo) => void
let report: Report | null = null
const early: [unknown, CrashInfo | undefined][] = []

/** Reports a crash, or keeps it until the report code has loaded. */
export function reportCrash(error: unknown, o?: CrashInfo): void {
  if (report) report(error, o)
  else if (early.length < 10) early.push([error, o])
}

/** Called by reports.ts when it starts: crashes go to it from now on, starting with the ones that waited. */
export function takeOver(r: Report | null): void {
  report = r
  if (r) for (const [e, o] of early.splice(0)) r(e, o)
}

const onError = (e: ErrorEvent) => reportCrash(e.error ?? (e.message ? new Error(`${e.message}${e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : ''}`) : 'Unknown error'))
const onRejection = (e: PromiseRejectionEvent) => reportCrash(e.reason, { rejection: true })

let listening = false

/** Starts the log and the error listeners. Returns the stop; a second start while they run does nothing and stops nothing. */
export function startCrashCapture(): () => void {
  startLogCapture()
  if (listening) return () => undefined
  listening = true
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    listening = false
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
