# sx-upload-scan

The safety pipeline for files uploaded to the free library. Anyone can upload, so every file is treated as hostile. Licensed Apache-2.0.

`Scanner::scan` takes the uploaded bytes and returns a `ScanReport` and, when every step passed, a converted `.sx3mf` and a preview PNG. It never fails: each problem is a verdict (`clean`, `rejected` or `scan_unavailable`) with stable reason codes. It publishes nothing. The service worker (`sx-cloud`, `scan_worker.rs`) stores the results and records them in the moderation queue.

## Steps, in order

1. Size cap per file, and per upload with `Limits::check_upload`. Defaults: 150 MiB per file (the `quarantine` bucket limit), 300 MiB per upload.
2. SHA-256 of the upload, checked against the hash blocklist.
3. Malware scan of the original bytes with ClamAV (`clamd`, `INSTREAM`). If the scanner cannot answer, the verdict is `scan_unavailable` and nothing is approved.
4. Type detection from content. Only binary or ASCII STL, 3MF and sx3mf pass. The file name is ignored; a name that disagrees with the content adds a warning. Executables, scripts, PDFs, HTML and other archive formats are named and refused.
5. Archive audit (3MF, sx3mf), before anything is inflated: entry count, per-entry and total size, compression ratio, overlapping entries, encrypted entries, duplicate names, names that leave the archive (`..`, absolute paths, backslashes, drive letters), symlinks and special files, compression methods other than store and deflate, data after the zip end record, and executable, script or macro extensions.
6. Entries are read with hard caps and must inflate to the size they declare. Each entry's first bytes are checked for executable, script and nested archive signatures. Only known parts are kept: content types, relationships, `3D/**/*.model`, `Metadata/model_settings.config`, and PNGs. Embedded G-code, slicer settings and auxiliary files are removed and listed in `stripped`. A thumbnail that does not decode is removed; a texture that does not decode rejects the file. Kept XML has no DOCTYPE, no custom entities, is UTF-8 and is nested at most 64 deep. Relationships to removed parts and external relationships are dropped. The archive is rebuilt with fixed timestamps and permissions.
7. An sx3mf is a 3MF with `sx:` metadata in its model part, so it takes the same path as a 3MF. The report names it `sx3mf` when the sanitized model carries that metadata.
8. The mesh is parsed with `sx-core`. A model with no triangles, only degenerate triangles, non-finite coordinates, more than 5 million triangles or a side over 10 m is rejected. The report records the triangle count and bounds.
9. Conversion to sx3mf (`sx3mf::stamp`): the sanitized 3MF gets the listing's `sx:Listing`, `sx:Version`, `sx:VersionId` and `sx:Creator` entries (replacing any the upload carried, and dropping `sx:ExportedBy`), and a 256 px preview as package thumbnail. Every other part is kept byte for byte. An STL becomes a plain 3MF first. The output is read back with `sx3mf::inspect`.
10. The converted file is checked against the blocklist again and scanned once more.

## ClamAV

`Clamd` talks to a `clamd` over TCP or a Unix socket. Set `StreamMaxLength`, `MaxFileSize` and `MaxScanSize` in `clamd.conf` to at least 150 MiB, or large uploads come back as `scan_unavailable`. ClamAV matches the EICAR string as a whole file or as a member of an archive, not inside other data.

For the tests, run `clamd` locally or on another machine bound to 127.0.0.1:3310 (for example with its database in `~/clamav`, config in `~/clamav/clamd.conf`, and updates through `freshclam --config-file ~/clamav/freshclam.conf`). To reach a remote one, tunnel the port:

```sh
ssh -f -N -L 127.0.0.1:3310:127.0.0.1:3310 <clamd-host>
SX_CLAMD_ADDR=127.0.0.1:3310 cargo test -p sx-upload-scan
```

Without `SX_CLAMD_ADDR` the test against a real `clamd` is skipped. The other tests use a stand-in that speaks the protocol and flags EICAR.

## Blocklist

`HashBlocklist::parse` reads one SHA-256 per line with an optional label; `#` starts a comment and a malformed line is an error. The list is deployment data and is not in the repository. The service loads it from `SX_SCAN_BLOCKLIST`.

## Tests

`tests/hostile.rs` builds every fixture in code: zip bombs, size lies, traversal names, symlinks, executables and scripts by name and by content, macros, nested and encrypted archives, trailing data, XML entity and depth bombs, broken PNGs, empty and non-finite meshes, exported sx3mf files, EICAR in an STL header and inside an archive, an unreachable scanner, the blocklist, and the `clamd` protocol. The only malware is the EICAR test string.
