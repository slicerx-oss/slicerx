// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether the print watch (sx-watch) can run on this computer. It runs beside the desktop app on Windows, Linux and
// Apple silicon Macs. ONNX Runtime has no x86_64 macOS build, so the universal Mac app carries an arm64 watch and never
// starts it on an Intel Mac (apps/desktop/src-tauri/src/watch.rs). The web view says "MacIntel" on every Mac, so the
// desktop app registers the shell's own answer (the shell_arch command, src-tauri/src/platform.rs).
import { useEffect, useState } from 'react'
import { isMac } from '../lib/keys'

/** The CPU the desktop shell runs on, as Rust names it: "aarch64" or "x86_64". */
export type ShellArch = () => Promise<string>

let shellArch: ShellArch | null = null
let asked: { from: ShellArch | null; runs: Promise<boolean> } | null = null

/** Called once by the desktop app. The browser has none, and shows the print watch as before. */
export function registerShellArch(f: ShellArch | null): void {
  shellArch = f
}

/** False only on a Mac whose shell runs on x86_64. No shell, or a shell that does not answer, counts as able to. */
export function printWatchRuns(): Promise<boolean> {
  const from = shellArch
  if (!asked || asked.from !== from) {
    asked = {
      from,
      runs:
        from && isMac()
          ? from().then(
              (arch) => arch !== 'x86_64',
              () => true,
            )
          : Promise.resolve(true),
    }
  }
  return asked.runs
}

/** Whether the print watch runs here, or null until the shell has answered. */
export function usePrintWatchRuns(): boolean | null {
  const [runs, setRuns] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    void printWatchRuns().then((r) => live && setRuns(r))
    return () => {
      live = false
    }
  }, [])
  return runs
}
