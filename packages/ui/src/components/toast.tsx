'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'

export type ToastTone = 'plain' | 'ok' | 'info' | 'warn' | 'error'

export interface ToastOptions {
  tone?: ToastTone
  /** Milliseconds before it goes away. */
  duration?: number
  /** A button on the toast, for example an undo. */
  action?: { label: string; run: () => void }
}

interface ToastRecord {
  id: number
  message: ReactNode
  tone: ToastTone
  action?: { label: string; run: () => void }
}

const ToastContext = createContext<((message: ReactNode, options?: ToastOptions) => void) | null>(null)

const TONE_ICON: Record<Exclude<ToastTone, 'plain'>, IconName> = { ok: 'check', info: 'thinking', warn: 'alert', error: 'alert' }

/** Mount once near the root. Toasts render bottom center and announce through role status. */
export function ToastProvider({ children, max = 3 }: { children?: ReactNode; max?: number }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const next = useRef(1)
  const toast = useCallback(
    (message: ReactNode, options?: ToastOptions) => {
      const id = next.current++
      const tone = options?.tone ?? 'plain'
      setToasts((list) => [...list, { id, message, tone, ...(options?.action ? { action: options.action } : {}) }].slice(-max))
      window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), options?.duration ?? 2600)
    },
    [max],
  )
  const value = useMemo(() => toast, [toast])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sx-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="sx-toast" data-tone={t.tone === 'plain' ? undefined : t.tone}>
            {t.tone === 'plain' ? null : <Icon name={TONE_ICON[t.tone]} />}
            <span>{t.message}</span>
            {t.action ? (
              <button type="button" className="sx-toast-action" onClick={() => { t.action?.run(); setToasts((list) => list.filter((x) => x.id !== t.id)) }}>
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/** Returns toast(message, { tone, duration }). Throws outside a ToastProvider, which is a bug. */
export function useToast(): (message: ReactNode, options?: ToastOptions) => void {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast needs a ToastProvider above it')
  return ctx
}
