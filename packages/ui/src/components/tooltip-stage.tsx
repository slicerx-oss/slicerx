// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tooltip stage in a tip: the tool's loop as inline SVG, so it takes the app's colors from the tokens. It runs on
// CSS alone, holds its finished frame under reduced motion, and paints over the viewport's own gradient. Until `play`
// is on it waits paused on that finished frame, then starts from the top.
import { useEffect, useMemo, useRef } from 'react'
import { STAGE_H, STAGE_STILL, STAGE_W, stageInner, type StageTool } from './tooltip-stage-svg'

export function TooltipStage({ tool, label, play = true }: { tool: StageTool; label: string; play?: boolean }) {
  const html = useMemo(() => stageInner(tool), [tool])
  const svg = useRef<SVGSVGElement>(null)
  // CSS holds the finished frame through `data-play`; the SMIL clock (path morphs) is set by hand
  useEffect(() => {
    const el = svg.current
    if (!el?.pauseAnimations) return
    if (play) {
      el.setCurrentTime(0)
      el.unpauseAnimations()
    } else {
      el.pauseAnimations()
      el.setCurrentTime(STAGE_STILL)
    }
  }, [play, html])
  return (
    <div className="sx-demo sx-stage" role="img" aria-label={label} data-play={play ? true : undefined} style={{ aspectRatio: `${STAGE_W} / ${STAGE_H}` }}>
      <svg ref={svg} className="sxs" viewBox={`0 0 ${STAGE_W} ${STAGE_H}`} width="100%" height="100%" aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
