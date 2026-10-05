// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the viewport makes of the GPU: whether to start on the low quality tier, and whether to warn that 3D is
// drawn on the processor. WebKit reports a made-up GPU name to pages, so on Linux the desktop shell reads the
// real renderer itself and passes it in; that name wins over the one WebGL gives.

/** Renderers that draw on the processor: Mesa's llvmpipe and softpipe, SwiftShader, Windows' basic renderer. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i
/** Old mobile GPUs that cannot keep up with the high tier. */
const SLOW = /mali-4|adreno \(tm\) 3/i

export interface GpuProfile {
  /** The renderer name the viewport reports in stats(). */
  name: string
  /** Start on the low quality tier with a smaller environment and pixel ratio. */
  weak: boolean
  /** 3D is drawn on the processor. */
  software: boolean
  /** The name came from the desktop shell, not from WebGL. */
  fromShell: boolean
}

/** A WebGL2 context that refuses a major performance caveat fails to start on most software renderers. */
function refusesCaveat(): boolean {
  try {
    const probe = document.createElement('canvas')
    const ok = probe.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
    ok?.getExtension('WEBGL_lose_context')?.loseContext()
    return !ok
  } catch {
    return false
  }
}

/**
 * `webgl` is the renderer WebGL reports; `shell` the one the desktop shell read, when it has one. The shell's
 * name is trusted as is. WebGL's may be masked, so a software renderer is also caught by the caveat probe.
 */
export function gpuProfile(webgl: string, shell?: string | null, probe: () => boolean = refusesCaveat, cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 8 : 8): GpuProfile {
  const fromShell = Boolean(shell)
  const name = shell || webgl
  const software = SOFTWARE.test(name) || (!fromShell && probe())
  return { name, weak: SOFTWARE.test(name) || SLOW.test(name) || cores <= 2, software, fromShell }
}
