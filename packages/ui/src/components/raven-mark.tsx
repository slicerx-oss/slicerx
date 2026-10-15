// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The still mark lives apart from the animated ravens, so only the pages that show it load it.
import { RAVEN_BODY, RAVEN_EYE, RAVEN_WING, RING, RUNES } from './raven'
import { assistantBrand, onAssistantBrand } from '@slicerx/contracts'
import { useSyncExternalStore } from 'react'
import { Icon } from '../icons/icon'

/**
 * The battle ravens as a still mark: huginn and muninn face each other inside the rune ring, a spark between them.
 * Drawn in currentColor only, so a host can tint it as a watermark. Never animated. Decorative.
 */
export function RavenMark({ className }: { className?: string }) {
  const brand = useSyncExternalStore(onAssistantBrand, assistantBrand, assistantBrand)
  if (brand.icon !== 'builtin:mimir') return <Icon name="mimir" className={['sx-raven-mark', className].filter(Boolean).join(' ')} style={{ opacity: 0.08 }} />
  const bird = (at: string) => (
    <g transform={at}>
      <path d={RAVEN_BODY} />
      <path d={RAVEN_WING} />
      <circle {...RAVEN_EYE} className="sx-raven-mark-eye" />
    </g>
  )
  return (
    <svg className={['sx-raven-mark', className].filter(Boolean).join(' ')} viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <circle cx="60" cy="60" r="56" />
      <circle cx="60" cy="60" r="42" />
      {RING.map((c, i) => {
        const at = `rotate(${(i * 360) / RING.length} 60 60) translate(58.5 8) scale(.75)`
        return c === ' ' ? <circle key={i} cx="2" cy="4" r=".9" transform={at} className="sx-raven-mark-dot" /> : <path key={i} d={RUNES[c]} transform={at} />
      })}
      <path className="sx-raven-mark-spark" transform="translate(60 43) scale(.8)" d="M0-7.5l1.2 6 5.8-1.5-4.7 3.7 3.2 5.3-5.5-3.5-5.5 3.5 3.2-5.3-4.7-3.7 5.8 1.5z" />
      {bird('translate(57 31) scale(-1.4 1.4)')}
      {bird('translate(63 31) scale(1.4)')}
    </svg>
  )
}
