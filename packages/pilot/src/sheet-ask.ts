// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether the person asked this turn to see a size sheet, the sizes or the drawing, read from their own words, never
// the model's. A sheet shown in a turn that asked for it waits for them over its drawing; any other sheet without a
// size that must fit goes ahead with its sizes at once, so a resize or an added detail never stops on one.
//
// It counts as an ask to see when the words name the sheet, the drawing, the dimensions, the measurements or the sizes,
// and either ask to see them ("show me", "let me see", "what are") or ask for no change ("the main sizes of the print,
// please"). Words that change something ("make the lid thicker", "change the sizes to fit my phone") are no ask to see,
// unless they also ask to see ("show me the sizes, then make it wider").

const SEEN = /\b(?:(?:dimension|dimensions|size|sizes|measurement)\s+sheet|sheet|drawings?|dimensions|measurements|sizes)\b/i
const SEE = /\b(?:show|shows|see|view|display|open|bring\s+up|pull\s+up|what\s+are|what's|what\s+is|give\s+me|list|read\s+out)\b/i
const CHANGE = /\b(?:make|change|set|resize|scale|increase|decrease|reduce|enlarge|shrink|widen|lengthen|shorten|thicken|add|remove|cut|fit|move|turn|raise|lower)\b/i

/** True when the text asks to see the size sheet, the sizes or the drawing (see the rules above). */
export function asksSheet(text: string): boolean {
  return SEEN.test(text) && (SEE.test(text) || !CHANGE.test(text))
}
