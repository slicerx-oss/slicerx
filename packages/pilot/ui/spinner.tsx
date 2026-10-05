// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useState } from 'react'
import { useReducedMotion } from './use-reduced-motion'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** The terminal's braille spinner; a still dot when reduced motion is on. */
export function Spinner({ className }: { className?: string }) {
  const reduced = useReducedMotion()
  const [i, setI] = useState(0)
  useEffect(() => {
    if (reduced) return undefined
    const id = setInterval(() => setI((x) => (x + 1) % FRAMES.length), 80)
    return () => clearInterval(id)
  }, [reduced])
  return (
    <span className={className} aria-hidden="true">
      {reduced ? '•' : FRAMES[i]}
    </span>
  )
}
