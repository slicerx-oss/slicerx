SlicerX {{version}} for testers. SlicerX is pre-alpha: expect rough edges, and slices can still differ from Bambu Studio and OrcaSlicer. Please report bugs in the SlicerX Discord or as GitHub issues.

Downloads:

- macOS (Apple Silicon and Intel): `SlicerX_{{version}}_universal.dmg`, signed with a Developer ID and notarized
- Windows (x64): `SlicerX_{{version}}_x64-setup.exe` (recommended) or `SlicerX_{{version}}_x64_en-US.msi`, both signed by Sean Leonard
- Linux (x64): `SlicerX_{{version}}_amd64.AppImage` or `SlicerX_{{version}}_amd64.deb`, unsigned. Built on Ubuntu 24.04, so they need glibc 2.39 or newer.

`SHA256SUMS.txt` has the checksums, and `downloads.json` lists the same files for the site.

Print watch (failure detection from your printer's camera) is included and runs locally with the SigLIP2 model from the watch-model-v1 release. On Macs it runs on Apple Silicon only, since ONNX Runtime has no Intel Mac build.

Built from public main at {{commit}}.
