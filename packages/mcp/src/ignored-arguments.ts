// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The warning a tool gives for arguments it does not take, shared by the slice, estimate, arrange and cloud slice
// tools: they accept unknown names for now and run without them, so a client sees what was ignored.

/** Arguments a client may mean as a printer, process or filament profile; profiles is where those go. */
const PROFILE_LIKE = new Set(['printer', 'process', 'filament', 'machine'])

/**
 * The warning for arguments a tool does not take (`known` are the ones it does), or undefined when there are
 * none. The tools accept them for now and slice without them, so a client sees what was ignored.
 */
export function ignoredArgumentsMessage(args: Record<string, unknown>, known: readonly string[]): string | undefined {
  const ignored = Object.keys(args).filter((k) => !known.includes(k))
  if (!ignored.length) return undefined
  const hint = ignored.some((k) => PROFILE_LIKE.has(k)) ? ' Name the printer, process and filament in profiles instead, by id from slicerx_list_profiles, such as "profiles": ["machine:snapmaker-u1", "process:standard"].' : ''
  return `Ignored arguments this tool does not take: ${ignored.join(', ')}.${hint}`
}
