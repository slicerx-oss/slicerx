// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Image, View } from 'react-native'
import { Icon, type IconName } from './icon'
import { t } from './theme'

/** Square model thumbnail with a quiet placeholder when there is no image. */
export function Thumb({ uri, size = 52, icon = 'cube' }: { uri?: string | undefined; size?: number; icon?: IconName }) {
  const frame = { width: size, height: size, borderRadius: t.radius.md, backgroundColor: t.color.ink2, borderWidth: 1, borderColor: t.color.lineSoft, overflow: 'hidden' as const }
  if (uri) return <Image source={{ uri }} style={frame} resizeMode="cover" accessibilityIgnoresInvertColors />
  return (
    <View style={[frame, { alignItems: 'center', justifyContent: 'center' }]}>
      <Icon name={icon} size={size * 0.42} color={t.color.dim} />
    </View>
  )
}
