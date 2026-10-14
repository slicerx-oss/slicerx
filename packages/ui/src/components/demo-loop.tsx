// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A short demo loop in a tooltip, of one of two kinds. A stage loop is live SVG on the shared tooltip stage: its module
// loads when the tip first shows, a box of the stage's size holds its place from the first frame, and it stays paused
// on its finished frame until `play` turns on (the tip's media stage). A recorded loop is an animated WebP shown like a
// GIF (an img, looping, no player controls) over its still poster; it is fetched only once `play` turns on. Neither
// runs under reduced motion, and both paint over the viewport's own colors.
import { useEffect, useState } from 'react'
import { STAGE_H, STAGE_W, type StageTool } from './tooltip-stage-svg'
import { TooltipStage } from './tooltip-stage'

/** A stage loop: its module loads on demand, so the shapes and keyframes stay out of the startup bundle. */
export interface StageDemo {
  stage: () => Promise<StageTool>
  /** What the loop shows, for screen readers. */
  label: string
  /** The tip's sentence when the anchor has none of its own. */
  body?: string
  replacesBody?: undefined
}

/** One recorded demo loop: the animated file and its still poster for a dark theme, the same for a light one, and the size the tip shows them at. */
export interface RecordedDemo {
  stage?: undefined
  body?: string
  src: string
  poster: string
  light?: { src: string; poster: string }
  width: number
  height: number
  /** What the loop shows, for screen readers. */
  label: string
  /** The loop says it all (it carries its own line of text): the tip shows its title and keys only. */
  replacesBody?: boolean
}

export type TipDemo = StageDemo | RecordedDemo

// Stage loops that have loaded: the next tip draws at once, with no wait.
const stages = new Map<StageDemo['stage'], StageTool>()

// Loops that have finished loading once: the browser keeps them, so the next tip shows them at once, with no fade.
const loaded = new Set<string>()

/** Whether a loop has loaded in this session. */
export function demoLoaded(src: string): boolean {
  return loaded.has(src)
}

/** Whether the app's theme is a light one, by the color scheme the theme sets on the root. */
function lightTheme(): boolean {
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  return (root.style.getPropertyValue('color-scheme') || getComputedStyle(root).colorScheme) === 'light'
}

function StageLoop({ demo, play }: { demo: StageDemo; play: boolean }) {
  const [tool, setTool] = useState<StageTool | undefined>(() => stages.get(demo.stage))
  useEffect(() => {
    if (tool) return
    let live = true
    void demo.stage().then((t) => {
      stages.set(demo.stage, t)
      if (live) setTool(t)
    })
    return () => {
      live = false
    }
  }, [demo, tool])
  // The box has the stage's size before the loop arrives, so the tip never grows.
  if (!tool) return <div className="sx-demo sx-stage" role="img" aria-label={demo.label} style={{ aspectRatio: `${STAGE_W} / ${STAGE_H}` }} />
  return <TooltipStage tool={tool} label={demo.label} play={play} />
}

export function DemoLoop({ demo, play }: { demo: TipDemo; play: boolean }) {
  if (demo.stage) return <StageLoop demo={demo} play={play} />
  return <RecordedLoop demo={demo} play={play} />
}

function RecordedLoop({ demo, play }: { demo: RecordedDemo; play: boolean }) {
  // the loop drawn in the app's studio colors for the theme in use
  const [{ src, poster }] = useState(() => (lightTheme() && demo.light ? demo.light : demo))
  const [ready, setReady] = useState(() => loaded.has(src))
  return (
    <div className="sx-demo" role="img" aria-label={demo.label} style={{ aspectRatio: `${demo.width} / ${demo.height}` }}>
      <img className="sx-demo-poster" src={poster} width={demo.width} height={demo.height} alt="" decoding="async" draggable={false} />
      {play ? (
        <img
          className="sx-demo-loop"
          src={src}
          width={demo.width}
          height={demo.height}
          alt=""
          decoding="async"
          draggable={false}
          data-ready={ready ? true : undefined}
          onLoad={() => {
            loaded.add(src)
            setReady(true)
          }}
        />
      ) : null}
    </div>
  )
}
