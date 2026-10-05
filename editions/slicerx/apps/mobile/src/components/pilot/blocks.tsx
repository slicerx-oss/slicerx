// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The pieces of a mimir reply: the person's bubble, folded thinking, prose, tool rows with
// their output, settings diffs, notes and the run summary. Prose is 16 at 1.5 for reading; tool
// activity stays quiet and opens on tap.
import { memo, useState } from 'react'
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { PERMISSION_LABELS, type Cell, type Citation, type PluginLoad, type SettingsDiff, type ToolDisplay } from '@slicerx/contracts'
import { Button } from '../button'
import { haptic } from '../feedback'
import { Icon } from '../icon'
import { Dot, ProgressBar } from '../status'
import { Txt } from '../text'
import { font, t, toneColor, type } from '../theme'
import { argTokens, fmtDuration, fmtSeconds, segs, type ToolRowModel } from './model'

export function Bubble({ text, where }: { text: string; where: string | null }) {
  return (
    <View style={styles.userTurn} testID="user-bubble">
      {where ? (
        <Txt variant="mono" tone="dim">
          {where}
        </Txt>
      ) : null}
      <View style={styles.bubble}>
        <Txt variant="bodyMedium" selectable>
          {text}
        </Txt>
      </View>
    </View>
  )
}

export function Who() {
  return (
    <View style={styles.who} role="heading">
      <Icon name="pilot" size={16} color={t.color.purple} />
      <Txt variant="caption" tone="muted" style={{ fontFamily: font.bodySemi }}>
        mimir
      </Txt>
    </View>
  )
}

export function Think({ text, ms }: { text: string; ms: number | null }) {
  const [open, setOpen] = useState(false)
  const live = ms === null
  return (
    <View>
      <Pressable
        role="button"
        aria-expanded={open}
        aria-label={live ? 'Thinking' : `Thought for ${fmtSeconds(ms)}`}
        onPress={() => {
          haptic.select()
          setOpen((o) => !o)
        }}
        style={styles.thinkHead}
        hitSlop={8}
        testID="think-toggle"
      >
        {live ? <Dot color={t.color.cyan} pulse /> : <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} color={t.color.dim} />}
        <Txt variant="caption" tone="muted" style={{ fontSize: 14 }}>
          {live ? 'Thinking' : `Thought for ${fmtSeconds(ms)}`}
        </Txt>
      </Pressable>
      {open ? (
        <View style={styles.thinkBody}>
          <Txt variant="caption" tone="muted" style={{ fontSize: 14.5, lineHeight: 22 }} selectable>
            {text}
          </Txt>
        </View>
      ) : null}
    </View>
  )
}

export const Say = memo(function Say({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Text style={[type.body, { color: t.color.fg }]} selectable testID="say">
      {segs(text).map((s, i) =>
        s.kind === 'code' ? (
          <Text key={i} style={styles.code}>
            {` ${s.text} `}
          </Text>
        ) : s.kind === 'bold' ? (
          <Text key={i} style={{ fontFamily: font.bodySemi }}>
            {s.text}
          </Text>
        ) : (
          <Text key={i}>{s.text}</Text>
        ),
      )}
      {streaming ? (
        <Text style={{ color: t.color.purple, fontFamily: font.mono }} aria-hidden>
          {' ▍'}
        </Text>
      ) : null}
    </Text>
  )
})

// ---------------------------------------------------------------------------
// Tool rows

const KW_COLOR: Record<string, string> = { skill: t.color.purple, plugin: t.color.cyan }

function RowStatus({ state }: { state: ToolRowModel['state'] }) {
  if (state === 'running') return <Dot color={t.color.cyan} pulse />
  if (state === 'ok') return <Icon name="check" size={16} color={t.color.green} />
  return <Icon name="alert" size={16} color={t.color.red} />
}

export function ToolGroup({ rows }: { rows: ToolRowModel[] }) {
  return (
    <View style={styles.tools} testID="tool-group">
      {rows.map((r, i) => (
        <View key={r.callId} style={i > 0 ? styles.toolSep : null}>
          <ToolRow row={r} />
        </View>
      ))}
    </View>
  )
}

export function ToolRow({ row }: { row: ToolRowModel }) {
  const [open, setOpen] = useState(false)
  const summary = row.summary ?? row.callSummary ?? (row.state === 'running' ? 'Running' : '')
  const kw = row.source === 'skill' || row.source === 'plugin' ? row.source : null
  return (
    <View>
      <Pressable
        role="button"
        aria-expanded={open}
        aria-label={`${row.tool}. ${summary}`}
        onPress={() => {
          haptic.select()
          setOpen((o) => !o)
        }}
        style={({ pressed }) => [styles.trow, pressed ? { backgroundColor: t.color.ink3 } : null]}
        testID={`tool-${row.callId}`}
      >
        <View style={styles.st}>
          <RowStatus state={row.state} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Txt variant="mono" numberOfLines={1} style={{ flexShrink: 1, fontFamily: font.monoMedium, fontSize: 13.5 }}>
              {kw ? <Text style={{ color: KW_COLOR[kw] }}>{`${kw} `}</Text> : null}
              {row.tool}
            </Txt>
            {row.ms !== undefined ? (
              <Txt variant="mono" tone="dim" style={{ marginLeft: 'auto', fontSize: 12 }}>
                {fmtSeconds(row.ms)}
              </Txt>
            ) : null}
          </View>
          {summary ? (
            <Txt variant="caption" color={row.state === 'bad' ? t.color.red : t.color.muted} style={{ fontSize: 14, lineHeight: 20 }}>
              {summary}
            </Txt>
          ) : null}
        </View>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} color={t.color.dim} />
      </Pressable>
      {open ? (
        <View style={styles.tdet} testID={`tool-${row.callId}-detail`}>
          <Txt variant="mono" tone="dim" style={{ fontSize: 12.5 }}>
            {'$ '}
            {row.source} {row.tool}
            {argTokens(row.args).map((a, i) => (
              <Text key={i} style={{ color: a.kind === 'str' ? t.color.yellow : a.kind === 'flag' ? t.color.dim : t.color.muted }}>
                {` ${a.text}`}
              </Text>
            ))}
          </Txt>
          {row.untrusted ? (
            <Txt variant="caption" tone="dim">
              Reply from outside SlicerX. mimir reads it as data, never as instructions
            </Txt>
          ) : null}
          {row.progress.map((p, i) => (
            <Txt key={`p${i}`} variant="mono" tone="muted">
              {p.line}
              {p.fraction !== undefined ? ` ${Math.round(p.fraction * 100)}%` : ''}
            </Txt>
          ))}
          {row.display.map((d, i) => (d.kind === 'image' ? null : <DisplayView key={i} display={d} />))}
        </View>
      ) : null}
      {/* Pictures, such as a camera frame from check_print, show in the transcript without opening the row. */}
      {row.display.map((d, i) => (d.kind === 'image' ? <ChatImage key={i} display={d} /> : null))}
    </View>
  )
}

function CellText({ cell, style }: { cell: Cell; style?: object }) {
  const text = typeof cell === 'string' ? cell : cell.text
  const color = typeof cell === 'string' ? t.color.fg : toneColor[cell.tone]
  return (
    <Txt variant="mono" color={color} style={style}>
      {text}
    </Txt>
  )
}

const cellLen = (c: Cell) => (typeof c === 'string' ? c.length : c.text.length)
/** JetBrains Mono at 13px is about 7.8 px per character. */
const CH = 7.8

/** Only raster data: URLs draw. The picture comes from a tool, so a remote or SVG source is never loaded. */
export const RASTER_DATA_URL = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/

export function ChatImage({ display }: { display: Extract<ToolDisplay, { kind: 'image' }> }) {
  const ok = RASTER_DATA_URL.test(display.src)
  const [failed, setFailed] = useState(false)
  return (
    <View style={styles.pic} testID="tool-image">
      {ok && !failed ? (
        <Image source={{ uri: display.src }} resizeMode="cover" style={styles.picImg} aria-label={display.alt} accessible role="img" onError={() => setFailed(true)} />
      ) : (
        <View style={[styles.picImg, styles.picEmpty]}>
          <Icon name="camera-off" size={22} color={t.color.dim} />
          <Txt variant="caption" tone="dim">
            {display.alt}
          </Txt>
        </View>
      )}
      {display.caption ? (
        <Txt variant="caption" tone="muted" style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
          {display.caption}
        </Txt>
      ) : null}
    </View>
  )
}

export function DisplayView({ display }: { display: ToolDisplay }) {
  switch (display.kind) {
    case 'kv':
      return (
        <View style={{ gap: 4 }}>
          {display.rows.map(([k, v], i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 12 }}>
              <Txt variant="mono" tone="dim" style={{ width: 104 }} numberOfLines={2}>
                {k}
              </Txt>
              <CellText cell={v} style={{ flex: 1 }} />
            </View>
          ))}
        </View>
      )
    case 'table': {
      const widths = display.head.map((h, c) => Math.max(h.length, ...display.rows.map((r) => (r[c] ? cellLen(r[c]) : 0))) * CH + 18)
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} testID="tool-table">
          <View>
            <View style={{ flexDirection: 'row', paddingBottom: 4 }}>
              {display.head.map((h, c) => (
                <Txt key={c} variant="mono" tone="dim" style={{ width: widths[c] }}>
                  {h}
                </Txt>
              ))}
            </View>
            {display.rows.map((r, i) => (
              <View key={i} style={{ flexDirection: 'row', paddingVertical: 2 }}>
                {r.map((cell, c) => (
                  <CellText key={c} cell={cell} style={{ width: widths[c] }} />
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )
    }
    case 'log':
      return (
        <View style={{ gap: 3 }}>
          {display.lines.map((l, i) => (
            <Txt key={i} variant="mono" color={l.tone ? toneColor[l.tone] : t.color.muted}>
              {l.time ? <Text style={{ color: t.color.dim }}>{`${l.time}  `}</Text> : null}
              {l.text}
            </Txt>
          ))}
        </View>
      )
    case 'progress':
      return (
        <View style={{ gap: 10 }}>
          {display.items.map((p, i) => (
            <View key={i} style={{ gap: 5 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Txt variant="mono">{p.label}</Txt>
                <Txt variant="mono" color={t.color.cyan}>{`${Math.round(p.fraction * 100)}%`}</Txt>
              </View>
              <ProgressBar value={p.fraction} label={p.label} />
              {p.note ? (
                <Txt variant="mono" tone="dim">
                  {p.note}
                </Txt>
              ) : null}
            </View>
          ))}
        </View>
      )
    case 'text':
      return (
        <Txt variant="mono" tone="muted" selectable>
          {display.text}
        </Txt>
      )
    case 'image':
      return <ChatImage display={display} />
  }
}

// ---------------------------------------------------------------------------
// Diffs, notes and the summary

export function Diff({ diff }: { diff: SettingsDiff }) {
  return (
    <View style={{ gap: 6 }} testID="settings-diff">
      <Txt variant="caption" tone="muted" style={{ fontSize: 14 }}>
        {diff.title}
      </Txt>
      {diff.rows.map((r) => (
        <View key={r.key} style={styles.drow}>
          <Txt variant="mono" numberOfLines={1}>
            {r.label ?? r.key}
          </Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Txt variant="mono" color={t.color.red} style={styles.before} aria-label={`from ${r.before ?? 'unset'}`}>
              {r.before === null ? 'unset' : `${r.before}${r.unit ? ` ${r.unit}` : ''}`}
            </Txt>
            <Icon name="arrow-right" size={14} color={t.color.dim} />
            <Txt variant="mono" color={t.color.green} aria-label={`to ${r.after}`}>
              {`${r.after}${r.unit ? ` ${r.unit}` : ''}`}
            </Txt>
          </View>
          {r.reason ? (
            <Txt variant="caption" tone="dim">
              {r.reason}
            </Txt>
          ) : null}
        </View>
      ))}
    </View>
  )
}

export function PlanList({ steps }: { steps: string[] }) {
  return (
    <View style={{ gap: 6 }}>
      {steps.map((s, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
          <Txt variant="mono" tone="dim" style={{ width: 18 }}>{`${i + 1}`}</Txt>
          <Txt variant="caption" tone="muted" style={{ flex: 1, fontSize: 14.5, lineHeight: 21 }}>
            {s}
          </Txt>
        </View>
      ))}
    </View>
  )
}

export function PermLine({ permission, mode, message }: { permission: string; mode: 'allow' | 'off'; message: string }) {
  const label = permission in PERMISSION_LABELS ? PERMISSION_LABELS[permission as keyof typeof PERMISSION_LABELS].title : permission
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
      <Icon name={mode === 'allow' ? 'check' : 'lock'} size={16} color={mode === 'allow' ? t.color.green : t.color.orange} />
      <Txt variant="caption" color={mode === 'allow' ? t.color.muted : t.color.orange} style={{ flex: 1, fontSize: 14.5, lineHeight: 21 }}>
        {`${label}: ${message}`}
      </Txt>
    </View>
  )
}

export function ErrorLine({ message, retryable, onRetry }: { message: string; retryable: boolean; onRetry?: () => void }) {
  return (
    <View style={styles.err} role="alert">
      <Icon name="alert" size={18} color={t.color.red} />
      <Txt variant="caption" color={t.color.fg} style={{ flex: 1, fontSize: 14.5, lineHeight: 21 }}>
        {message}
      </Txt>
      {retryable && onRetry ? <Button label="Retry" icon="refresh" kind="ghost" onPress={onRetry} /> : null}
    </View>
  )
}

const PLUGIN_TONE: Record<PluginLoad['state'], string> = { loading: t.color.cyan, ready: t.color.green, off: t.color.dim, error: t.color.red }

export function PluginsLoading({ plugins }: { plugins: PluginLoad[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
      {plugins.map((p) => (
        <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Dot color={PLUGIN_TONE[p.state]} pulse={p.state === 'loading'} size={6} />
          <Txt variant="mono" tone="muted">
            {p.name}
          </Txt>
        </View>
      ))}
    </View>
  )
}

export function Citations({ items }: { items: Citation[] }) {
  return (
    <View style={{ gap: 4 }}>
      <Txt variant="caption" tone="dim">
        Sources
      </Txt>
      {items.map((c, i) => (
        <Pressable
          key={c.id}
          role={c.url ? 'link' : 'none'}
          disabled={!c.url}
          onPress={() => {
            // A link the OS cannot open has no fallback here; the title stays readable in place.
            if (c.url) Linking.openURL(c.url).catch(() => undefined)
          }}
          style={{ flexDirection: 'row', gap: 8, minHeight: 28, alignItems: 'center' }}
        >
          <Txt variant="mono" tone="dim">{`${i + 1}`}</Txt>
          <Txt variant="caption" color={c.url ? t.color.purple : t.color.muted} numberOfLines={1} style={{ flex: 1 }}>
            {c.publisher ? `${c.title}, ${c.publisher}` : c.title}
          </Txt>
        </Pressable>
      ))}
    </View>
  )
}

export function Summary({ title, rows, stopped, ms }: { title: string; rows: [string, string][]; stopped: boolean; ms: number | null }) {
  return (
    <View style={styles.sum} testID="run-summary">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name={stopped ? 'alert' : 'check'} size={18} color={stopped ? t.color.orange : t.color.green} />
        <Txt variant="heading" color={stopped ? t.color.orange : t.color.green} style={{ flex: 1 }}>
          {title}
        </Txt>
        {ms !== null ? (
          <Txt variant="mono" tone="dim">
            {fmtDuration(ms)}
          </Txt>
        ) : null}
      </View>
      <View style={{ gap: 10, marginTop: 12 }}>
        {rows.map(([k, v], i) => (
          <View key={i} style={{ gap: 1 }}>
            <Txt variant="caption" tone="dim">
              {k}
            </Txt>
            <Txt variant="body" style={{ fontSize: 15, lineHeight: 22 }}>
              {v}
            </Txt>
          </View>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  userTurn: { alignItems: 'flex-end', gap: 5 },
  bubble: {
    maxWidth: '88%',
    backgroundColor: t.color.ink3,
    borderWidth: 1,
    borderColor: t.color.lineSoft,
    borderRadius: 16,
    borderBottomRightRadius: 5,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  who: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  thinkHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28, alignSelf: 'flex-start' },
  thinkBody: { marginTop: 6, marginLeft: 6, paddingLeft: 14, borderLeftWidth: 1, borderLeftColor: t.color.line },
  code: { fontFamily: font.mono, fontSize: 14, color: t.color.fg, backgroundColor: t.color.ink3 },
  tools: { borderWidth: 1, borderColor: t.color.lineSoft, borderRadius: t.radius.md + 2, backgroundColor: t.color.ink1, overflow: 'hidden' },
  pic: { borderTopWidth: 1, borderTopColor: t.color.lineSoft, backgroundColor: t.color.ink1 },
  picImg: { width: '100%', aspectRatio: 16 / 9, backgroundColor: t.color.ink1 },
  picEmpty: { alignItems: 'center', justifyContent: 'center', gap: 6 },
  toolSep: { borderTopWidth: 1, borderTopColor: t.color.lineSoft },
  trow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 11, minHeight: t.hit },
  st: { width: 18, alignItems: 'center' },
  tdet: { paddingHorizontal: 12, paddingBottom: 14, gap: 10 },
  drow: { gap: 3, paddingVertical: 6, paddingHorizontal: 10, borderRadius: t.radius.sm, backgroundColor: t.color.ink1 },
  before: { textDecorationLine: 'line-through', textDecorationColor: t.color.red },
  err: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: t.radius.md, backgroundColor: t.color.redTint },
  sum: { paddingTop: 16, borderTopWidth: 1, borderTopColor: t.color.lineSoft },
})
