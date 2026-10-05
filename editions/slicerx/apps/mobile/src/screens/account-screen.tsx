// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Account and settings: who is signed in, alerts, paired devices, what mimir may do without
// asking, and haptics.
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { type AccountDeletionPolicy, type AuthProvider, type CorePermissionClass, type PermissionMode, type PermissionPolicy, type SignInMethod, type StoreResult } from '@slicerx/contracts'
import { ApproveSheet } from '../components/approve-sheet'
import { SwitchRow } from '../components/controls'
import { Hairline, Row, Screen, ScreenHeader, SectionLabel } from '../components/layout'
import { Wordmark } from '../components/mark'
import { SignIn } from '../components/sign-in'
import { Txt } from '../components/text'
import { font, t } from '../components/theme'

export interface AccountInfo {
  name: string
  email?: string | undefined
  /** Such as "Member" or "Free". */
  plan?: string | undefined
}

export interface NotificationPrefs {
  printDone: boolean
  printFailed: boolean
  attention: boolean
  approvals: boolean
}

export interface AccountDataProps {
  /** AuthClient.accountDeletionPolicy(); null while it loads. */
  policy: AccountDeletionPolicy | null
  /** AuthClient.pendingAccountDeletion(): set once deletion was requested. */
  pending: { purgeAfter: string } | null
  /** Builds the export and opens the share sheet. */
  onExport: () => Promise<void>
  onRequestDeletion: () => Promise<void>
  onCancelDeletion: () => Promise<void>
}

/** How alerts reach the phone while the app is closed. Mirrors PushState in the store. */
export type PushInfo = { kind: 'off' } | { kind: 'unsupported'; reason: string } | { kind: 'no-hub' } | { kind: 'on'; hostName: string }

export interface AccountScreenProps {
  account: AccountInfo | null
  push: PushInfo
  policy: PermissionPolicy
  onPolicyChange: (cls: CorePermissionClass, mode: PermissionMode) => Promise<void>
  notifications: NotificationPrefs
  onNotificationsChange: (next: NotificationPrefs) => void
  haptics: boolean
  onHapticsChange: (on: boolean) => void
  pairedCount: number
  onOpenPairing: () => void
  /** AuthClient.signInMethods(): what this edition offers, in display order. */
  signInMethods: readonly SignInMethod[]
  onSignInWithEmail: (email: string) => Promise<StoreResult<void>>
  onSignInWithProvider: (provider: AuthProvider) => Promise<StoreResult<void>>
  onSignOut: () => void
  /** Data export and deletion for a signed-in account. Apple requires deletion inside the app. */
  data: AccountDataProps
  version: string
}

/** One line for the "while the app is closed" row. */
export function pushDetail(p: PushInfo): string {
  switch (p.kind) {
    case 'on':
      return `On, sent by ${p.hostName}`
    case 'no-hub':
      return 'Needs a paired computer running SlicerX'
    case 'unsupported':
      return p.reason
    case 'off':
      return 'Off while every alert above is off'
  }
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

/** "October 30, 2026" for an ISO timestamp, in the phone's locale. */
export function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

export function deletionLines(policy: AccountDeletionPolicy | null): string[] {
  if (!policy) return ['Your account and the data tied to it will be deleted.']
  return [
    `Your account is deleted after ${policy.graceDays} days. Sign in before then to cancel.`,
    ...policy.removed.map((r) => `Removed: ${r}`),
    ...policy.kept.map((k) => `Kept: ${k}`),
  ]
}

export function AccountScreen(p: AccountScreenProps) {
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [dataError, setDataError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = (task: () => Promise<void>) => {
    setDataError(null)
    setBusy(true)
    task()
      .catch((e: unknown) => setDataError(e instanceof Error && e.message ? e.message : 'Something went wrong. Try again'))
      .finally(() => setBusy(false))
  }

  const change = (cls: CorePermissionClass, mode: PermissionMode) => {
    setSaveError(null)
    p.onPolicyChange(cls, mode).catch((e: unknown) => setSaveError(e instanceof Error ? e.message : 'Could not save. Try again'))
  }
  const permError = saveError

  const n = p.notifications
  return (
    <Screen header={<ScreenHeader title="Account" />} testID="account-screen">
      <View style={styles.who}>
        {p.account ? (
          <>
            <View style={styles.avatar}>
              <Txt style={{ fontFamily: font.bodySemi, fontSize: 18, color: t.color.fg }}>{initials(p.account.name)}</Txt>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Txt variant="heading" numberOfLines={1}>
                {p.account.name}
              </Txt>
              <Txt variant="caption" tone="muted" numberOfLines={1}>
                {[p.account.email, p.account.plan].filter(Boolean).join('  ')}
              </Txt>
            </View>
          </>
        ) : (
          <View style={{ flex: 1 }}>
            <SignIn
              methods={p.signInMethods}
              onEmail={p.onSignInWithEmail}
              onProvider={p.onSignInWithProvider}
              reason="Sign in to sync profiles and use cloud slicing. Printers on paired computers work without an account."
            />
          </View>
        )}
      </View>

      <SectionLabel label="Notifications" />
      <SwitchRow title="Print finished" value={n.printDone} onChange={(v) => p.onNotificationsChange({ ...n, printDone: v })} testID="notify-done" />
      <SwitchRow title="Print failed" value={n.printFailed} onChange={(v) => p.onNotificationsChange({ ...n, printFailed: v })} testID="notify-failed" />
      <SwitchRow title="Printer needs attention" detail="Filament runout, door open, paused" value={n.attention} onChange={(v) => p.onNotificationsChange({ ...n, attention: v })} testID="notify-attention" />
      <SwitchRow title="Approval waiting" detail="A print or a change needs your answer" value={n.approvals} onChange={(v) => p.onNotificationsChange({ ...n, approvals: v })} testID="notify-approvals" />
      <Row icon={p.push.kind === 'on' ? 'alert-bell' : 'bell-off'} iconColor={p.push.kind === 'on' ? t.color.green : t.color.muted} title="While the app is closed" detail={pushDetail(p.push)} testID="push-state" />

      <SectionLabel label="mimir" />
      <Txt variant="caption" tone="dim" style={styles.note}>
        mimir asks you before anything reaches a printer or changes a saved profile. That cannot be turned off here.
      </Txt>
      {permError ? (
        <Txt variant="caption" color={t.color.orange} style={styles.note} aria-live="polite">
          {permError}
        </Txt>
      ) : null}
      <SwitchRow title="Slice and arrange without asking" detail="Orient, cut, arrange and slice in your project" value={p.policy.classes.slice === 'allow'} onChange={(v) => change('slice', v ? 'allow' : 'ask')} testID="perm-slice" />

      <SectionLabel label="This phone" />
      <Row icon="link" title="Paired devices" detail={p.pairedCount === 0 ? 'None yet' : `${p.pairedCount} paired`} chevron onPress={p.onOpenPairing} testID="open-pairing" />
      <SwitchRow icon="vibration" title="Haptics" value={p.haptics} onChange={p.onHapticsChange} testID="haptics" />

      {p.account ? (
        <>
          <SectionLabel label="Your data" />
          {dataError ? (
            <Txt variant="caption" color={t.color.orange} style={styles.note} aria-live="polite" testID="data-error">
              {dataError}
            </Txt>
          ) : null}
          <Row
            icon="export"
            title="Export my data"
            detail={exporting ? 'Preparing your export' : 'A JSON file of everything stored about you'}
            chevron
            onPress={
              exporting
                ? undefined
                : () => {
                    setExporting(true)
                    run(() => p.data.onExport().finally(() => setExporting(false)))
                  }
            }
            testID="export-data"
          />
          {p.data.pending ? (
            <>
              <Txt variant="caption" color={t.color.orange} style={styles.note} testID="deletion-pending">
                {`Your account is scheduled for deletion on ${fmtDate(p.data.pending.purgeAfter)}. Nothing is removed until then.`}
              </Txt>
              <Row icon="undo" title="Keep my account" detail="Cancel the deletion" onPress={busy ? undefined : () => run(p.data.onCancelDeletion)} testID="cancel-deletion" />
            </>
          ) : (
            <Row icon="delete" title="Delete account" detail={p.data.policy ? `Removed after ${p.data.policy.graceDays} days` : undefined} destructive chevron onPress={() => setDeleting(true)} testID="delete-account" />
          )}
          <Hairline style={{ marginTop: t.space(2) }} />
          <Row icon="lock" title="Sign out" destructive onPress={p.onSignOut} testID="sign-out" />
          <ApproveSheet
            open={deleting}
            onClose={() => setDeleting(false)}
            title="Delete your account?"
            lines={deletionLines(p.data.policy)}
            confirmLabel="Delete account"
            danger
            onConfirm={p.data.onRequestDeletion}
            testID="delete-sheet"
          />
        </>
      ) : null}

      <View style={{ alignItems: 'center', gap: 6, paddingTop: t.space(4) }}>
        <Wordmark size={16} />
        <Txt variant="mono" tone="dim" style={{ fontSize: 12 }}>
          {p.version}
        </Txt>
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  who: { flexDirection: 'row', alignItems: 'center', gap: t.space(1.5), paddingHorizontal: t.gutter, paddingVertical: t.space(1) },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: t.color.ink3, borderWidth: 1, borderColor: t.color.line, alignItems: 'center', justifyContent: 'center' },
  note: { paddingHorizontal: t.gutter },
})
