// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the agent bridge records while the app runs (dev and test builds only, docs/agent-bridge.md): console lines and
// page errors, backend calls (address and status only), toasts, and dialogs opening and closing, each with a time and a
// sequence number. A read passes the last number it saw (`since`) and gets what came after, plus the new marker.
// Nothing here keeps a request or response body, a header or a query string, and console text has tokens masked.

export type LogKind = 'console' | 'network' | 'toast' | 'dialog'

export interface Entry {
  seq: number
  /** ISO time. */
  at: string
  kind: LogKind
  [field: string]: unknown
}

/** Entries kept per kind; older ones drop off. */
const KEEP = 1000
const TEXT_MAX = 2000

/** Masks what could be a secret in console text: JWTs, bearer tokens and token-like query values. */
export function redact(text: string): string {
  return text
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[jwt]')
    .replace(/(Bearer\s+)[^\s"',]+/gi, '$1[redacted]')
    .replace(/([?&#](?:code|token|access_token|refresh_token|id_token|apikey|api_key|key|token_hash)=)[^&#\s"']+/gi, '$1[redacted]')
}

/** An address as the network log keeps it: origin and path only, never the query or fragment (they can carry tokens). */
export function safeUrl(url: string, base = 'http://localhost/'): string {
  if (/^(data|blob):/i.test(url)) return `${url.slice(0, url.indexOf(':'))}:`
  try {
    const u = new URL(url, base)
    return `${u.origin === 'null' ? `${u.protocol}//` : u.origin}${u.pathname}`
  } catch {
    return url.split(/[?#]/)[0] ?? ''
  }
}

function text(args: unknown[]): string {
  const s = args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return `${a.name}: ${a.message}`
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
  return redact(s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}...` : s)
}

/** The title a person reads on a dialog: its labelled heading, its label, or its first heading. */
export function dialogTitle(el: Element): string {
  const by = el.getAttribute('aria-labelledby')
  const doc = el.ownerDocument
  const labelled = by
    ? by
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent ?? '')
        .join(' ')
    : ''
  const t = labelled || el.getAttribute('aria-label') || el.querySelector('h1, h2, h3')?.textContent || ''
  return t.replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** Shown on screen: in the document, with a size, and not hidden by style. */
export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false
  const view = el.ownerDocument.defaultView
  const style = view?.getComputedStyle(el)
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
  const r = el.getBoundingClientRect()
  // jsdom lays nothing out, so a laid-out size only counts where layout exists.
  const laidOut = r.width > 0 || r.height > 0 || el.getClientRects().length > 0
  if (el instanceof HTMLDialogElement) return el.open
  return laidOut || !hasLayout(el)
}

function hasLayout(el: Element): boolean {
  return (el.ownerDocument.body?.getBoundingClientRect().width ?? 0) > 0
}

const DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"]'
const TOASTS = '.sx-toast'

export interface Capture {
  /** The newest sequence number. */
  marker(): number
  read(kind: LogKind, since?: number, limit?: number): { marker: number; entries: Entry[] }
  /** Dialogs on screen now. */
  openDialogs(): { title: string; testid: string | null; since: string }[]
  /** Toasts on screen now. */
  visibleToasts(): { text: string; tone: string }[]
  /** Records now instead of on the next tick (tests and reads call it). */
  flush(): void
  stop(): void
}

/** Starts recording in `win`. Call before the app makes its backend clients, so their fetch goes through the wrapper. */
export function installCapture(win: Window & typeof globalThis): Capture {
  let seq = 0
  const logs: Record<LogKind, Entry[]> = { console: [], network: [], toast: [], dialog: [] }
  const push = (kind: LogKind, fields: Record<string, unknown>) => {
    const list = logs[kind]
    list.push({ seq: ++seq, at: new Date().toISOString(), kind, ...fields })
    if (list.length > KEEP) list.splice(0, list.length - KEEP)
  }
  const undo: (() => void)[] = []

  // Console lines, as they are printed.
  const con = win.console as unknown as Record<string, (...a: unknown[]) => void>
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = con[level]
    if (typeof orig !== 'function') continue
    con[level] = (...args: unknown[]) => {
      push('console', { level, text: text(args) })
      orig.apply(win.console, args)
    }
    undo.push(() => {
      con[level] = orig
    })
  }

  // Page errors, rejected promises nobody caught, content security refusals, and resources that failed to load.
  const onError = (e: Event) => {
    const t = e.target
    if (t && t !== win && t instanceof win.Element) {
      const src = (t as HTMLImageElement).currentSrc || t.getAttribute('src') || t.getAttribute('href') || ''
      push('network', { method: 'GET', url: safeUrl(src, win.location.href), status: null, ok: false, resource: t.tagName.toLowerCase(), error: 'failed to load' })
      return
    }
    const ev = e as ErrorEvent
    push('console', { level: 'pageerror', text: redact(`${ev.message ?? 'error'}${ev.filename ? ` (${safeUrl(ev.filename, win.location.href)}:${ev.lineno}:${ev.colno})` : ''}`) })
  }
  const onRejection = (e: PromiseRejectionEvent) => push('console', { level: 'pageerror', text: `Unhandled rejection: ${text([e.reason])}` })
  const onCsp = (e: SecurityPolicyViolationEvent) =>
    push('console', { level: 'csp', text: `Refused by ${e.effectiveDirective || e.violatedDirective}: ${safeUrl(e.blockedURI || '', win.location.href)}` })
  win.addEventListener('error', onError, true)
  win.addEventListener('unhandledrejection', onRejection)
  win.document.addEventListener('securitypolicyviolation', onCsp as EventListener)
  undo.push(() => {
    win.removeEventListener('error', onError, true)
    win.removeEventListener('unhandledrejection', onRejection)
    win.document.removeEventListener('securitypolicyviolation', onCsp as EventListener)
  })

  // Backend calls: method, address without its query, status and time. Never a body or a header.
  const origFetch = win.fetch
  if (typeof origFetch === 'function') {
    win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
      const started = Date.now()
      try {
        const res = await origFetch.call(win, input, init)
        push('network', { method, url: safeUrl(url, win.location.href), status: res.status, ok: res.ok, ms: Date.now() - started })
        return res
      } catch (e) {
        push('network', { method, url: safeUrl(url, win.location.href), status: null, ok: false, ms: Date.now() - started, error: e instanceof Error ? redact(e.message) : 'failed' })
        throw e
      }
    }
    undo.push(() => {
      win.fetch = origFetch
    })
  }

  // Toasts and dialogs, from the page itself, so every source (the store, the ui provider, a feature) is seen.
  const seenToasts = new WeakSet<Element>()
  const dialogIds = new WeakMap<Element, number>()
  const open = new Map<number, { el: Element; title: string; testid: string | null; since: string }>()
  let nextDialog = 0
  const scan = () => {
    const doc = win.document
    for (const t of doc.querySelectorAll(TOASTS)) {
      if (seenToasts.has(t)) continue
      seenToasts.add(t)
      push('toast', { text: redact((t.textContent ?? '').replace(/\s+/g, ' ').trim()), tone: t.getAttribute('data-tone') ?? 'plain' })
    }
    const now = new Set<number>()
    for (const d of doc.querySelectorAll(DIALOGS)) {
      if (!isVisible(d)) continue
      let id = dialogIds.get(d)
      if (id === undefined) {
        id = ++nextDialog
        dialogIds.set(d, id)
      }
      now.add(id)
      if (!open.has(id)) {
        const entry = { el: d, title: dialogTitle(d), testid: d.getAttribute('data-testid'), since: new Date().toISOString() }
        open.set(id, entry)
        push('dialog', { event: 'open', title: entry.title, testid: entry.testid })
      }
    }
    for (const [id, d] of open) {
      if (now.has(id)) continue
      open.delete(id)
      push('dialog', { event: 'close', title: d.title, testid: d.testid })
    }
  }
  const Observer = win.MutationObserver
  const observer = Observer ? new Observer(() => scan()) : null
  observer?.observe(win.document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'style', 'class', 'hidden'] })
  // Style changes higher up (a parent shown or hidden) do not always reach the observer.
  const timer = win.setInterval(scan, 500)
  undo.push(() => {
    observer?.disconnect()
    win.clearInterval(timer)
  })
  scan()

  return {
    marker: () => seq,
    read(kind, since = 0, limit = 200) {
      scan()
      const entries = logs[kind].filter((e) => e.seq > since)
      return { marker: seq, entries: entries.slice(-Math.max(1, Math.min(limit, KEEP))) }
    },
    openDialogs: () => {
      scan()
      return [...open.values()].map(({ title, testid, since }) => ({ title, testid, since }))
    },
    visibleToasts: () =>
      [...win.document.querySelectorAll(TOASTS)].filter(isVisible).map((t) => ({ text: (t.textContent ?? '').replace(/\s+/g, ' ').trim(), tone: t.getAttribute('data-tone') ?? 'plain' })),
    flush: scan,
    stop: () => {
      for (const u of undo.splice(0)) u()
    },
  }
}
