# sx-brep

Exact solids for SlicerX's modeling tools. Bodies are boundary representations on the SMLib kernel (NVIDIA usd-brep, Apache-2.0), so a hole as deep as the part, a cut flush with a face or a hundred holes in a plate come out as closed solids with exact volumes. `tessellate` turns a body into the welded triangle mesh the rest of SlicerX uses, each triangle labeled with the face it came from.

The kernel's source is not in this repository. `scripts/fetch-smlib.sh` downloads it at the pinned commit, checks its SHA-256, unpacks the kernel and its C API into a cache (`~/.cache/slicerx/smlib/<commit>`, or `SX_SMLIB_CACHE`) and prints the directory. `build.rs` compiles it from there, or from `SX_SMLIB_DIR`. Without it the crate builds a stand-in that answers every call with an error, so `cargo build --workspace` never needs the kernel; `SX_BREP_REQUIRE=1` makes a missing kernel a build error instead.

```sh
sh packages/brep/scripts/fetch-smlib.sh
SX_BREP_REQUIRE=1 cargo test -p sx-brep --release
```

CI runs the required-kernel suite on Linux and macOS. `kernel_detection` checks both the detection flag and a real `count` call; with `SX_BREP_REQUIRE=1`, a stand-in build cannot pass. The same environment must be present when building and when running the tests.

A first build compiles about 230 C++ files (about 450 CPU seconds, one minute on 8 cores).

## Input limits

Operation names are limited to 128 UTF-8 bytes. Requests are limited to 32 MiB of UTF-8 JSON, 64 nested containers and 1,000,000 JSON values. Serialized bodies are limited to 8 MiB before checksum verification or the kernel reader. The native wrapper and browser adapter reject oversized requests before copying them into the kernel. The `sx-geom` CLI also bounds `brep.*` input before JSON parsing, including whitespace. Numeric body handles remain the preferred path for a process or worker that keeps its bodies alive.

The saved-body checksum detects changed text; it is not authentication. These limits bound input parsing, not the time or memory of an arbitrary modeling operation. Native serialized-body input still requires the existing developer opt-in. Worker/process termination and recovery remain necessary for a hard execution deadline.

## Our routines in the kernel

Eleven kernel routines and all of `SmIntegrator.cpp` cite Numerical Recipes, whose code is not under an open source license. After unpacking, `scripts/swap-routines.sh` replaces each routine's body with a call to our own version in `cpp/routines.cpp`, turns the `smos_Pythag` macro into `hypot`, and removes `SmIntegrator.cpp`, whose classes `cpp/integrator.cpp` defines instead. Ours are written from the published algorithms (each file names its sources). `fetch-smlib.sh` checks that every one is swapped out before it hands over the copy. The list is a sweep of the whole kernel, not only the routines a feature reaches:

| Kernel routine | Ours |
| --- | --- |
| `N_RealMatrixSingleValueDecompose`, `SmMatrix::SVDecompose` | one-sided Jacobi SVD |
| `N_SingleValueDecomposeSolve`, `SmMatrix::SolveWithSVDMatrices` | pseudo-inverse solve, small singular values dropped |
| `SmMatrix::EigenSystemJacobiSolver` | cyclic Jacobi |
| `M_TridiagonalSystem` | elimination without pivoting (Thomas) |
| `M_CorneredTridiagonalSystem` | Sherman-Morrison on the tridiagonal solve |
| `N_FuncFindMinima` | Brent's minimizer |
| `N_SolveQuadraticEq` | the cancellation-free quadratic formula |
| `SmMatrix::LUDecompose`, `SmMatrix::SolveWithLUMatrix` | Gaussian elimination with scaled partial pivoting |
| `SmIntegrator` (quadrature) | Romberg and Simpson on the refined trapezoid rule, Neville interpolation |
| `SmODEIntegrator` (ODE steps) | classical Runge-Kutta, the Cash-Karp pair, modified midpoint, Bulirsch-Stoer extrapolation |

`tests/routines.rs` (with `--features routine-probe`) runs them, and kernel code that calls them (plane and line fits, matrix inverse, 3x3 eigenvectors, a mirror and a skew transform of a solid), against the values the original routines gave, at 1e-6 relative. LU runs through `Invert` and `SolveLinearSystem` too, on matrices that are singular or sit at the pivot limit. The fixed steps (Runge-Kutta, Cash-Karp, midpoint), the interpolation and the trapezoid sums are the same formulas as the original's and agree to 1e-12. Adaptive integration can rightly take other steps than the original, so the adaptive drivers, and the volumes and areas the kernel computes with them, are held to the exact value: within the accuracy asked for, and four times it for ODEs, whose tolerance bounds each step rather than the run. The original ODE driver ignores its start values and integrates from zero; every caller in the kernel starts from zero, so this changes no result. Two more exceptions: for two or more equations the original tridiagonal solvers return values that solve no system their documentation describes, so ours are checked against the system itself, and a skewed cylinder's B-spline volume is checked against the exact value, which ours is closer to.

## API

`sx_brep::call(op, request_json) -> Result<String, String>`, with the operations listed in `src/lib.rs`: `box`, `cylinder`, `primitive`, `extrude`, `boolean`, `subtract`, `cut`, `fillet`, `chamfer`, `push`, `hole`, `info`, `tessellate`, `free` and `count`. Bodies stay in the kernel, named by number, until freed. An op that changes a body makes a new one and leaves its inputs as they were. `KERNEL` says whether the build has the kernel.

The kernel runs on one thread: `cpp/tbb` stands in for the oneTBB headers it includes and runs its loops in order. Calls take a lock.

## WebAssembly

The browser runs the same kernel and wrapper as a wasm module in `lib/`, built by `scripts/build-wasm.sh` with a pinned Emscripten (6.0.10, `-Oz` with link-time optimization, wasm exceptions, one thread). The geometry worker loads it the first time an op needs it (`packages/app/src/geom/brep.ts`), so the app shell never carries it; `apps/web/scripts/bundle-size.mjs` fails a build that puts it in a startup chunk and holds the wasm to a 1400 KB gzip ceiling. The module loads only for exact solids, which are behind a developer flag.

The build is committed so the web build needs no C++ toolchain. Rebuild it after a change to `cpp/` or the pinned kernel:

```sh
sh packages/brep/scripts/fetch-smlib.sh
sh packages/brep/scripts/build-wasm.sh
```

| File | Bytes | gzip | SHA-256 |
| --- | --- | --- | --- |
| `lib/sx_brep.wasm` | 3,258,490 | 1,284,621 | `dcfb958ace7911657a9484919fc8894457a72f47784f951565888ba5c2a6e867` |
| `lib/sx_brep.mjs` | 63,340 | | `ecda0a5fb31873ad175525b589c3fc45c98ed0aa967b23186df002eb0997760c` |

## Licenses

Our wrapper is Apache-2.0. The kernel is Apache-2.0, by NVIDIA Corporation; THIRD-PARTY.md has the details.
