# sx-brep

Exact solids for SlicerX's modeling tools. Bodies are boundary representations on the SMLib kernel (NVIDIA usd-brep, Apache-2.0), so a hole as deep as the part, a cut flush with a face or a hundred holes in a plate come out as closed solids with exact volumes. `tessellate` turns a body into the welded triangle mesh the rest of SlicerX uses, each triangle labeled with the face it came from.

The kernel's source is not in this repository. `scripts/fetch-smlib.sh` downloads it at the pinned commit, checks its SHA-256, unpacks the kernel and its C API into a cache (`~/.cache/slicerx/smlib/<commit>`, or `SX_SMLIB_CACHE`) and prints the directory. `build.rs` compiles it from there, or from `SX_SMLIB_DIR`. Without it the crate builds a stand-in that answers every call with an error, so `cargo build --workspace` never needs the kernel; `SX_BREP_REQUIRE=1` makes a missing kernel a build error instead.

```sh
sh packages/brep/scripts/fetch-smlib.sh
SX_BREP_REQUIRE=1 cargo test -p sx-brep --release
```

CI requires the real-kernel suite on Linux, macOS and Windows. The fetch step publishes a native absolute kernel path, including on Windows. `kernel_detection` checks both the detection flag and a real `count` call; with `SX_BREP_REQUIRE=1`, a stand-in build cannot pass. The same environment must be present when building and when running the tests.

A first build compiles about 230 C++ files (about 450 CPU seconds, one minute on 8 cores).

## Input limits

Operation names are limited to 128 UTF-8 bytes. Requests are limited to 32 MiB of UTF-8 JSON, 64 nested containers and 1,000,000 JSON values. Serialized bodies are limited to 8 MiB before checksum verification or the kernel reader. The native wrapper and browser adapter reject oversized requests before copying them into the kernel. The `sx-geom` CLI also bounds `brep.*` input before JSON parsing, including whitespace. Numeric body handles remain the preferred path for a process or worker that keeps its bodies alive.

The saved-body checksum detects changed text; it is not authentication. These limits bound input parsing, not the time or memory of an arbitrary modeling operation. Native serialized-body input still requires the existing developer opt-in. Worker/process termination and recovery remain necessary for a hard execution deadline.
## Solid regression fixtures

`tests/solid-cases.json` describes procedural brackets, open enclosures with 2 mm and 0.6 mm walls, a plate with 100 holes, and a cube with four fillets. Each volume is represented as `a + b * pi`, derived from boxes, cylinders and circular fillet segments. The native and committed-WASM tests run the same cases at scales 0.1, 1 and 10, both at the origin and translated by [1000, -700, 350] mm.

```sh
SX_BREP_REQUIRE=1 cargo test -p sx-brep --release --test solids
node --test packages/brep/tests/solids-wasm.mjs
```

Both paths check analytic volume, bounds, manifold status, save/reopen, closed and consistently oriented tessellation, and released body counts. Analytic relative volume tolerance is 1e-6, or 1e-4 for fillets that may use spline surfaces. Tessellation uses a scale-relative 0.01 mm chord and a 15 degree angle; its separate volume tolerance is 0.5 percent. Mesh volume is measured relative to the placement origin to avoid cancellation from large world coordinates. These are correctness tests, not timing benchmarks or proof of complete numerical conditioning.

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
| `lib/sx_brep.wasm` | 3,259,520 | 1,288,899 | `37a7b36b7a22e9329c06ed68f76ad52416c2c69311c58ea708705d6de52caa9a` |
| `lib/sx_brep.mjs` | 63,340 | 17,861 | `ecda0a5fb31873ad175525b589c3fc45c98ed0aa967b23186df002eb0997760c` |

Gzip sizes use Node zlib at level 9, matching the web bundle gate. The previous WASM was 1,288,185 bytes by the same method; this build adds 714 bytes and remains below the 1,400,000-byte ceiling.

## Licenses

Our wrapper is Apache-2.0. The kernel is Apache-2.0, by NVIDIA Corporation; THIRD-PARTY.md has the details.
