# SlicerX names

The named features of SlicerX. This file is the source of truth for spelling, meaning, color and status. Names are lowercase everywhere, including at the start of a sentence and in headings. atlas joined the rule on 2026-10-02 (owner); it was capitalized before.

Rule for new names: name only what is ours or clearly better than what the other slicers ship. A straight port keeps its common name (Arachne stays Arachne). Every named setting gets a tooltip.

| Name | What it is | Where users see it | Color | Mark | Status |
|---|---|---|---|---|---|
| slicerx | The product | Everywhere | purple to pink (`--grad`) | Icons-slicerx option 1: the X as offset perimeters | Picked 2026-10-01 |
| mimir | The assistant: answers, diagnoses, watches prints through the camera, suggests fixes behind approval cards. Was PrintPilot. | Dock button, chat panel, phone alerts, home page | purple to pink | Icons-mimir option 1: Mannaz rune over one filament drop (`mimir` in design/icons.js) | Picked; code rename waits on a trademark check (Grafana Mimir exists), owner chose later |
| aegis | Our variable-width wall generator, built on preFlight's Athena method. The default. | Wall generator: classic, arachne, aegis | purple to cyan | Icons-aegis option 1: a shield of two walls | Live as the default since 2026-10-01; "athena" is a permanent alias; mark picked |
| sleipnir | Adaptive layer height: thin layers where steps would show, thick where they don't | Last option in the layer height picker | cyan to green (#8be9fd to #50fa7b) | Icons-sleipnir-horse option 5: a horse head with thin layers on the curve, thick below (`sleipnir` in design/icons.js) | Name chosen; being added to the picker |
| norn | Edit from Preview: click a toolpath to see and change the setting that made it, with before and after (time and grams difference, the old paths as a ghost) | Preview | to pick | to draw | Shipped 2026-10-03: name cleared by the owner, built in packages/app/src/norn (checkpoint 11da885), unit tests pass, no end-to-end browser test yet |
| huginn and muninn | mimir's two model tiers, Odin's ravens: huginn ("thought") is the quick look, a small fast vision model for check-ins and frame reads; muninn ("memory") is the deep think, the large model for diagnosis, tuning from a failed print and planning. mimir picks per job. | Settings > mimir: Model, "Automatic (huginn for quick looks, muninn for deep thinking)", with an option to pin one | to pick | huginn: a raven on a perch, heavy beak and shaggy throat (`huginn` in design/icons.js); muninn: the same raven in flight, wing raised (`muninn`). Together they spar while a camera connects and rest side by side when it shows no picture | Approved 2026-10-01. Owner picks on the ChatGPT plan: huginn = gpt-5.6-luna (text, tools, images and the SlicerX request shape confirmed by probe), muninn = gpt-5.6-terra. |
| atlas | The prime tower that places and sizes itself | Tower position, Auto on by default | orange to pink (#ffb86c to #ff79c6) | Icons-Atlas option 1: a tower striped by color changes | Engine built; mark picked; name not yet in the UI |
| heimdall | Preview playback that runs the print as the machine will: every move and tool change, with the H2D, H2C and U1 heads, rack, dock and swaps animated, driven by dragging the Time or Moves slider | Preview, playback bar | yellow to cyan (Icons-Heimdall gradient) | Icons-Heimdall, mark to pick | Picked 2026-10-03 (owner); built in packages/ui/viewport toolchanger.ts and toolhead.ts; name not yet in the UI |

Tooltips:
- aegis: "aegis varies wall width to fit the part, so thin features print solid and walls stay even, with far fewer width changes than Arachne."
- sleipnir: "sleipnir changes the layer height as the part goes up: thin layers on curves and slopes where steps would show, thick layers on straight walls to save time. Range 0.08 to 0.28 mm. On multi-color plates it keeps layers fixed where colors change, so it adds no filament changes."
- heimdall: "heimdall plays the print back the way the machine will run it: every move and every tool change, with the rack and the swaps, at the speed you drag."

Rejected: Bifrost; "Vary layer height"; svalinn (replaced by aegis the same day).

Reserve names, unused: Leviathan (the engine, once the benchmark win is clear; Icons-Leviathan, gradient red to orange). Marks are picked when a name ships. Heimdall moved from the reserve to Preview playback on 2026-10-03; mimir's watch mode needs another name if it gets one.

Brand canvas: https://claude.ai/artifact/QbPNZkvJARaAuwKJVy79KT

The code-wide rename from PrintPilot to mimir is done (2026-10-01): UI, prompts, knowledge, docs and copy. Identifiers, package and crate names, stored keys and URLs keep the old spelling.
