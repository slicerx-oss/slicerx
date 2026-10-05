# sx3mf

Reader and writer for the `sx:` metadata of the open `.sx3mf` project format. An `.sx3mf` is a 3MF project with a few `sx:` entries in its model part; `SPEC.md` describes it. Licensed Apache-2.0.

## Public API

```rust
pub fn inspect(zip_bytes: &[u8]) -> Result<Sx3mfInfo, Error>;
pub fn write_metadata(model_xml: &str, meta: &Sx3mfMetadata) -> Result<String, Error>;
pub fn stamp(zip_bytes: &[u8], meta: &Sx3mfMetadata, thumbnail_png: Option<&[u8]>) -> Result<Vec<u8>, Error>;
```

- `inspect` reads the `sx:` entries, the standard title, designer and application entries and the package thumbnail. A plain 3MF reads with `is_sx3mf: false`.
- `write_metadata` inserts or replaces the `sx:` entries in a model part and binds `xmlns:sx`. It is idempotent.
- `stamp` turns a 3MF package into an `.sx3mf`: it rewrites the model part and, when given, stores the thumbnail. Every other part is copied with its compressed bytes untouched. The upload scan uses it to make library files.

`Sx3mfInfo` serializes to the camelCase JSON of `packages/contracts/src/sx3mf.ts`. The test `write_contract_fixture` writes `packages/contracts/fixtures/sx3mf-info.json`.

## Dependencies

- `zip` 8.6.0 (deflate through zlib-rs only)
- `quick-xml` 0.42.0
- `thiserror` 2.0.21
- `serde` 1.0.229

## Status

`cargo test -p sx3mf`: 18 tests. Clippy and rustfmt are clean. There is no fuzz target yet.
