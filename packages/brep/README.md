# sx-brep

Exact solids for SlicerX's modeling tools. Bodies are boundary representations on the SMLib kernel (NVIDIA usd-brep, Apache-2.0), so a hole as deep as the part, a cut flush with a face or a hundred holes in a plate come out as closed solids with exact volumes. `tessellate` turns a body into the welded triangle mesh the rest of SlicerX uses, each triangle labeled with the face it came from.

The kernel's source is not in this repository. `scripts/fetch-smlib.sh` downloads it at the pinned commit, checks its SHA-256 and unpacks the kernel and its C API into a cache (`~/.cache/slicerx/smlib/<commit>`, or `SX_SMLIB_CACHE`), and prints the directory. `build.rs` compiles it from there, or from `SX_SMLIB_DIR`. Without it the crate builds a stand-in that answers every call with an error, so `cargo build --workspace` never needs the kernel; `SX_BREP_REQUIRE=1` makes a missing kernel a build error instead.

```sh
sh packages/brep/scripts/fetch-smlib.sh
SX_BREP_REQUIRE=1 cargo test -p sx-brep --release
```

A first build compiles about 230 C++ files (about 450 CPU seconds, one minute on 8 cores).

## API

`sx_brep::call(op, request_json) -> Result<String, String>`, with the operations listed in `src/lib.rs`: `box`, `cylinder`, `extrude`, `boolean`, `subtract`, `cut`, `info`, `tessellate`, `free` and `count`. Bodies stay in the kernel, named by number, until freed. An op that changes a body makes a new one and leaves its inputs as they were. `KERNEL` says whether the build has the kernel.

The kernel runs on one thread: `cpp/tbb` stands in for the oneTBB headers it includes and runs its loops in order. Calls take a lock.

## Licenses

Our wrapper is Apache-2.0. The kernel is Apache-2.0, by NVIDIA Corporation; THIRD-PARTY.md has the details.
