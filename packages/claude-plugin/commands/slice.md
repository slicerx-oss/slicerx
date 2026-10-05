---
disable-model-invocation: true
description: Estimate or slice a model with SlicerX
argument-hint: <path-or-url> [printer] [filament] [intent]
---

Slice or estimate the model the user named, following the slice-model skill.

Arguments: $ARGUMENTS

The first argument is the model path or URL. Any others are the printer, the filament and the intent (draft, standard, fine or strong), in any order. Estimate first and report time, grams and layers, then ask whether to write G-code.
