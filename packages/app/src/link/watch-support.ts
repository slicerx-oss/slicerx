// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether the print watch (sx-watch) can run on this computer. It runs beside the desktop app on Windows, Linux and
// Apple silicon Macs. ONNX Runtime has no x86_64 macOS build, so the universal Mac app carries an arm64 watch and never
// starts it on an Intel Mac (apps/desktop/src-tauri/src/watch.rs). The shell already tells the page its OS with the CPU,
// "macOS 15.1 (x86_64)", through the crash host (src-tauri/src/crash.rs), so that is what is read here.
import { useEffect, useState } from 'react'
import { nativeCrashHost, type CrashHost } from '../bugs/reports'

/** False for macOS on x86_64, as the shell's OS line names it; true for everything else, an unknown line included. */
export function watchRunsOn(os: string): boolean {
  return !/^macOS\b.*\(x86_64\)$/.test(os.trim())
}

let asked: { from: CrashHost | null; runs: Promise<boolean> } | null = null

/** Asks the shell once. The browser has no shell to ask and keeps the rows as before. */
export function printWatchRuns(): Promise<boolean> {
  const from = nativeCrashHost()
  if (!asked || asked.from !== from) {
    asked = {
      from,
      runs: from
        ? from.take(false).then(
            (got) => watchRunsOn(got.os),
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
