// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Account deletion terms. The database function account_deletion_policy()
// returns the same text; the integration test checks that they match.
import type { AccountDeletionPolicy } from '@slicerx/contracts'

export const ACCOUNT_DELETION_POLICY: AccountDeletionPolicy = {
  graceDays: 30,
  removed: [
    'Your profile, handle and avatar',
    'Your email address and sign-in methods',
    'Your API tokens (revoked as soon as you ask)',
    'Your paired devices',
    'Your likes, follows, collections, downloads and makes',
    'Your creator page and every model you uploaded, with their files',
    'Your synced printer, filament and process profiles, printers, fleets and devices',
    'Your cloud slicing jobs and deliveries',
  ],
  kept: [
    'Your comments, with your name and the text removed, so replies keep their thread',
    'Moderation audit entries about your account, with the actor and target ids only',
    'A record that this account id was deleted and when',
  ],
}
