// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print: pick a model, pick a printer or a fleet, set Easy settings, see where it slices,
// then send after a confirm sheet.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { EASY_GOALS, type EasyGoal, type EasySettings, type Fleet, type SupportMode } from '@slicerx/contracts'
import { ApproveSheet } from '../components/approve-sheet'
import { Button, IconButton } from '../components/button'
import { Segmented, SwitchRow } from '../components/controls'
import { haptic } from '../components/feedback'
import { Icon } from '../components/icon'
import { EmptyState, Row, Screen, ScreenHeader, SectionLabel } from '../components/layout'
import { StatePill, fmtLeft, type PrinterView } from '../components/printers/printer-bits'
import { Sheet } from '../components/sheet'
import { Skeleton } from '../components/status'
import { Txt } from '../components/text'
import { font, t } from '../components/theme'
import { Thumb } from '../components/thumb'

export interface ModelChoice {
  id: string
  name: string
  source: 'library' | 'file'
  /** Such as "3MF, 2 plates" or "STL, 4.1 MB". */
  detail?: string
  thumbUri?: string
}

export type SendTarget = { kind: 'printer'; printerId: string } | { kind: 'fleet'; fleetId: string }

/** Where slicing runs, as decided by the pairing agent. */
export interface SliceLocation {
  kind: 'desktop' | 'browser' | 'cloud' | 'phone'
  name: string
  detail?: string
}

export interface SendSelection {
  modelId: string
  target: SendTarget
  goal: EasyGoal
  settings: EasySettings
}

export interface Estimate {
  timeS: number
  grams: number
  plates: number
}

export interface SendPrintScreenProps {
  library: ModelChoice[]
  printers: PrinterView[]
  fleets: Fleet[]
  sliceLocation: SliceLocation | null
  /**
   * Set when cloud slicing would work but the access token is null (signed out). Shows a
   * sign-in prompt in place of the slicing row, never an error.
   */
  onSignInForCloud?: (() => void) | undefined
  initialModelId?: string
  initialTarget?: SendTarget
  /** Lets the parent estimate time and filament for the current choice. */
  onSelectionChange?: (sel: SendSelection | null) => void
  estimate: Estimate | null
  estimating: boolean
  /** Opens the system file picker; the parent adds the file to `library` and returns its id. */
  onPickFile: () => Promise<string | null>
  /** Called after the person confirms in the sheet. */
  onSend: (sel: SendSelection) => Promise<void>
  onBack: () => void
}

const GOALS: { value: EasyGoal; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'standard', label: 'Standard' },
  { value: 'fine', label: 'Fine' },
  { value: 'strong', label: 'Strong' },
]

const GOAL_NOTE: Record<EasyGoal, string> = {
  draft: 'Thicker layers, fastest print',
  standard: 'Balanced detail and time',
  fine: 'Thin layers for visible parts',
  strong: 'More walls and denser infill',
}

// Painted supports need the desktop's paint tool, so the phone offers Off and Auto.
const SUPPORTS: { value: SupportMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'auto', label: 'Auto' },
]

/** Older goal presets said "everywhere"; on the phone that is Auto. */
function supportMode(v: SupportMode | 'everywhere'): SupportMode {
  return v === 'everywhere' ? 'auto' : v
}

const WHERE_ICON = { desktop: 'desktop', browser: 'laptop', cloud: 'cloud-slice', phone: 'phone' } as const

const ready = (p: PrinterView) => p.status?.state === 'idle' || p.status?.state === 'finished'

function Choice({ selected, disabled, onPress, children, testID }: { selected: boolean; disabled?: boolean; onPress: () => void; children: ReactNode; testID?: string }) {
  return (
    <Pressable
      role="radio"
      aria-checked={selected} aria-disabled={disabled === true}
      disabled={disabled}
      onPress={() => {
        haptic.select()
        onPress()
      }}
      style={({ pressed }) => [styles.choice, selected ? styles.choiceOn : null, pressed ? { backgroundColor: t.color.ink2 } : null, disabled ? { opacity: 0.45 } : null]}
      testID={testID}
    >
      <View style={[styles.radio, selected ? styles.radioOn : null]}>{selected ? <View style={styles.radioDot} /> : null}</View>
      {children}
    </Pressable>
  )
}

export function SendPrintScreen(p: SendPrintScreenProps) {
  const [modelId, setModelId] = useState<string | null>(p.initialModelId ?? null)
  const [target, setTarget] = useState<SendTarget | null>(p.initialTarget ?? null)
  const [goal, setGoal] = useState<EasyGoal>('standard')
  const [supports, setSupports] = useState<SupportMode>(supportMode(EASY_GOALS.standard.supports))
  const [brim, setBrim] = useState(EASY_GOALS.standard.brim)
  const [picking, setPicking] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  const model = p.library.find((m) => m.id === modelId) ?? null
  const settings = useMemo<EasySettings>(() => ({ ...EASY_GOALS[goal], supports, brim }), [goal, supports, brim])
  const selection = useMemo<SendSelection | null>(() => (model && target ? { modelId: model.id, target, goal, settings } : null), [model, target, goal, settings])

  const { onSelectionChange } = p
  // The estimate lives with the parent, which may slice remotely to get it.
  useEffect(() => {
    onSelectionChange?.(selection)
  }, [selection, onSelectionChange])

  const targetName = (() => {
    if (!target) return null
    if (target.kind === 'printer') return p.printers.find((x) => x.info.id === target.printerId)?.info.name ?? null
    const f = p.fleets.find((x) => x.id === target.fleetId)
    return f ? `the first idle printer in ${f.name}` : null
  })()

  const header = <ScreenHeader title="Print" leading={<IconButton icon="chevron-left" label="Back" onPress={p.onBack} color={t.color.fg} />} />

  const footer = (
    <View style={styles.footer}>
      <View style={{ flex: 1, minWidth: 0 }}>
        {p.estimating ? (
          <View style={{ gap: 6 }}>
            <Skeleton width={90} height={14} />
            <Skeleton width={120} height={11} />
          </View>
        ) : p.estimate ? (
          <>
            <Txt variant="mono" style={{ fontFamily: font.monoMedium, fontSize: 15 }} testID="estimate">
              {`${fmtLeft(p.estimate.timeS)}  ${p.estimate.grams.toFixed(1)} g`}
            </Txt>
            <Txt variant="caption" tone="dim">{`${p.estimate.plates} plate${p.estimate.plates === 1 ? '' : 's'}, estimate`}</Txt>
          </>
        ) : (
          <Txt variant="caption" tone="dim">
            {selection ? 'No estimate yet' : 'Pick a model and a printer'}
          </Txt>
        )}
      </View>
      <Button label="Print" icon="send-to-printer" kind="primary" size="lg" disabled={!selection || !p.sliceLocation} onPress={() => setConfirming(true)} testID="send-button" />
    </View>
  )

  return (
    <Screen header={header} footer={footer} testID="send-print-screen">
      <SectionLabel label="Model" />
      {model ? (
        <Row
          title={model.name}
          detail={model.detail}
          mono
          leading={<Thumb uri={model.thumbUri} />}
          trailing={
            <Txt variant="label" color={t.color.purple}>
              Change
            </Txt>
          }
          onPress={() => setPicking(true)}
          testID="model-selected"
        />
      ) : (
        <Row title="Choose a model" detail="From your library or your files" icon="plus" iconColor={t.color.purple} chevron onPress={() => setPicking(true)} testID="model-choose" />
      )}

      <SectionLabel label="Printer" />
      {p.printers.length === 0 ? (
        <EmptyState icon="printer" title="No printers" detail="Pair a computer running SlicerX to see its printers here." />
      ) : (
        <View style={{ paddingHorizontal: t.gutter, gap: 6 }}>
          {p.printers.map((x) => {
            const on = target?.kind === 'printer' && target.printerId === x.info.id
            return (
              <Choice key={x.info.id} selected={on} disabled={!ready(x)} onPress={() => setTarget({ kind: 'printer', printerId: x.info.id })} testID={`target-${x.info.id}`}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt variant="bodyMedium" numberOfLines={1}>
                    {x.info.name}
                  </Txt>
                  <Txt variant="caption" tone="muted" numberOfLines={1}>{`${x.info.vendor} ${x.info.model}`}</Txt>
                </View>
                <StatePill status={x.status} />
              </Choice>
            )
          })}
          {p.fleets.map((f) => {
            const idle = p.printers.filter((x) => f.printerIds.includes(x.info.id) && ready(x)).length
            const on = target?.kind === 'fleet' && target.fleetId === f.id
            return (
              <Choice key={f.id} selected={on} disabled={idle === 0} onPress={() => setTarget({ kind: 'fleet', fleetId: f.id })} testID={`target-fleet-${f.id}`}>
                <Icon name="fleet" size={20} color={t.color.muted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt variant="bodyMedium" numberOfLines={1}>{`Any idle printer in ${f.name}`}</Txt>
                  <Txt variant="caption" tone="muted">{`${idle} of ${f.printerIds.length} idle`}</Txt>
                </View>
              </Choice>
            )
          })}
        </View>
      )}

      <SectionLabel label="Settings" />
      <View style={{ paddingHorizontal: t.gutter, gap: 8 }}>
        <Segmented label="Print goal" value={goal} options={GOALS} onChange={(g) => {
          setGoal(g)
          setSupports(supportMode(EASY_GOALS[g].supports))
          setBrim(EASY_GOALS[g].brim)
        }} testID="goal" />
        <Txt variant="caption" tone="dim">
          {GOAL_NOTE[goal]}
        </Txt>
        <Txt variant="caption" tone="muted" style={{ marginTop: t.space(1) }}>
          Supports
        </Txt>
        <Segmented label="Supports" value={supports} options={SUPPORTS} onChange={setSupports} testID="supports" />
      </View>
      <SwitchRow title="Brim" detail="Helps tall or small parts stay down" value={brim} onChange={setBrim} testID="brim" />

      <SectionLabel label="Slicing" />
      {p.sliceLocation ? (
        <Row title={`Slices on ${p.sliceLocation.name}`} detail={p.sliceLocation.detail} icon={WHERE_ICON[p.sliceLocation.kind]} testID="slice-location" />
      ) : p.onSignInForCloud ? (
        <Row
          title="Sign in to slice in the cloud"
          detail="Or pair a computer running SlicerX"
          icon="cloud-slice"
          iconColor={t.color.purple}
          chevron
          onPress={p.onSignInForCloud}
          testID="slice-sign-in"
        />
      ) : (
        <Row title="Nowhere to slice yet" detail="Pair a computer or turn on cloud slicing" icon="alert" iconColor={t.color.orange} testID="slice-location" />
      )}

      <Sheet open={picking} onClose={() => setPicking(false)} title="Choose a model" testID="model-sheet">
        <Row
          title="From your files"
          detail="3MF, STL or G-code"
          icon="folder"
          chevron
          onPress={() => {
            setFileError(null)
            p.onPickFile()
              .then((id) => {
                if (id) {
                  setModelId(id)
                  setPicking(false)
                }
              })
              .catch((e: unknown) => setFileError(e instanceof Error ? e.message : 'Could not open that file'))
          }}
          testID="pick-file"
        />
        {fileError ? (
          <Txt variant="caption" color={t.color.orange} style={{ paddingHorizontal: t.gutter }} aria-live="polite">
            {fileError}
          </Txt>
        ) : null}
        {p.library.map((m) => (
          <Row
            key={m.id}
            title={m.name}
            detail={m.detail}
            mono
            leading={<Thumb uri={m.thumbUri} size={44} />}
            trailing={m.id === modelId ? <Icon name="check" size={18} color={t.color.purple} /> : undefined}
            onPress={() => {
              haptic.select()
              setModelId(m.id)
              setPicking(false)
            }}
            testID={`pick-${m.id}`}
          />
        ))}
      </Sheet>

      {selection && model && targetName && p.sliceLocation ? (
        <ApproveSheet
          open={confirming}
          onClose={() => setConfirming(false)}
          title={`Print ${model.name}?`}
          lines={[
            `Slices on ${p.sliceLocation.name} with ${GOALS.find((g) => g.value === goal)?.label ?? goal} settings`,
            `Uploads to ${targetName} and starts printing when the upload finishes`,
            ...(p.estimate ? [`About ${fmtLeft(p.estimate.timeS)} and ${p.estimate.grams.toFixed(1)} g of filament`] : []),
          ]}
          confirmLabel="Start print"
          onConfirm={() => p.onSend(selection)}
          testID="send-sheet"
        />
      ) : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  footer: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: t.gutter, paddingTop: 12, paddingBottom: 8, borderTopWidth: 1, borderTopColor: t.color.lineSoft, backgroundColor: t.color.ink0 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 12, paddingVertical: 10, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.color.lineSoft },
  choiceOn: { borderColor: t.color.purpleEdge, backgroundColor: t.color.purpleTint },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: t.color.line, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: t.color.purple },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: t.color.purple },
})
