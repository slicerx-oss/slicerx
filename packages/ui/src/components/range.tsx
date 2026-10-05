'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { InputHTMLAttributes, ReactNode } from 'react'

export interface RangeProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'min' | 'max' | 'step' | 'onChange' | 'type'> {
  id: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  /** Accessible name when there is no Field label around it. */
  label?: string
  /** Unit read out with the value: mm, %, C. */
  unit?: string
  /** Mono captions under the track, spread evenly. */
  ticks?: readonly ReactNode[]
}

/** A slider with a filled track. Pair it with Field and show the value in the label's aside. */
export function Range({ id, value, min, max, step = 1, onChange, label, unit, ticks, className, ...rest }: RangeProps) {
  const share = max > min ? ((value - min) / (max - min)) * 100 : 0
  const input = (
    <input
      id={id}
      type="range"
      className={className ? `sx-range ${className}` : 'sx-range'}
      value={value}
      min={min}
      max={max}
      step={step}
      aria-label={label}
      aria-valuetext={unit ? `${value} ${unit}` : undefined}
      style={{ ['--p' as string]: `${share}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
      {...rest}
    />
  )
  if (!ticks?.length) return input
  return (
    <div>
      {input}
      <div className="sx-ticks" aria-hidden="true">
        {ticks.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
    </div>
  )
}
