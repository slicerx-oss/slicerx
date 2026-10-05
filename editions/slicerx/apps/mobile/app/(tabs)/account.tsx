// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import Constants from 'expo-constants'
import { router } from 'expo-router'
import { useAccountData } from '../../src/data/account'
import { usePairedHosts } from '../../src/pair'
import { usePocketHost } from '../../src/data/provider'
import { useSession } from '../../src/data/queries'
import { requestNotifyPermission } from '../../src/notify/notifier'
import { set, usePocket } from '../../src/state/store'
import { AccountScreen } from '../../src/screens/account-screen'

export default function AccountRoute() {
  const host = usePocketHost()
  const { data: session } = useSession()
  const policy = usePocket((s) => s.policy)
  const notify = usePocket((s) => s.notify)
  const haptics = usePocket((s) => s.haptics)
  const push = usePocket((s) => s.push)
  const hosts = usePairedHosts()
  const data = useAccountData()
  const name = session ? (session.displayName ?? session.handle ?? session.email ?? 'Member') : null
  return (
    <AccountScreen
      account={name ? { name, email: session?.email, plan: host.account.mode === 'offline' ? 'Example account' : 'Member' } : null}
      push={push}
      policy={policy}
      onPolicyChange={async (cls, mode) => {
        set((s) => ({ policy: { ...s.policy, classes: { ...s.policy.classes, [cls]: mode } } }))
      }}
      notifications={notify}
      onNotificationsChange={(next) => {
        set({ notify: next })
        if (Object.values(next).some(Boolean)) void requestNotifyPermission()
      }}
      haptics={haptics}
      onHapticsChange={(on) => set({ haptics: on })}
      pairedCount={hosts.length}
      onOpenPairing={() => router.push('/pair')}
      signInMethods={host.account.signInMethods()}
      onSignInWithEmail={(email) => host.account.signInWithEmail(email)}
      onSignInWithProvider={(provider) => host.account.signInWithOAuth(provider)}
      onSignOut={() => void host.account.signOut()}
      data={data}
      version={Constants.expoConfig?.version ?? '0.1.0'}
    />
  )
}
