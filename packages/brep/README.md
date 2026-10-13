# sx-brep

Exact solids for SlicerX's modeling tools. Bodies are boundary representations on the SMLib kernel (NVIDIA usd-brep, Apache-2.0), so a hole as deep as the part, a cut flush with a face or a hundred holes in a plate come out as closed solids with exact volumes. `tessellate` turns a body into the welded triangle mesh the rest of SlicerX uses, each triangle labeled with the face it came from.

The kernel's source is not in this repository. `scripts/fetch-smlib.sh` downloads it at the pinned commit, checks its SHA-256, unpacks the kernel and its C API into a cache (`~/.cache/slicerx/smlib/<commit>`, or `SX_SMLIB_CACHE`) and prints the directory. `build.rs` compiles it from there, or from `SX_SMLIB_DIR`. Without it the crate builds a stand-in that answers every call with an error, so `cargo build --workspace` never needs the kernel; `SX_BREP_REQUIRE=1` makes a missing kernel a build error instead.

```sh
sh packages/brep/scripts/fetch-smlib.sh
SX_BREP_REQUIRE=1 cargo test -p sx-brep --release
```

A first build compiles about 230 C++ files (about 450 CPU seconds, one minute on 8 cores).

## Our routines in the kernel

Nine kernel routines cite Numerical Recipes, whose code is not under an open source license. After unpacking, `scripts/swap-routines.sh` replaces each one's body with a call to our own version in `cpp/routines.cpp`, written from the published algorithms (the file names the source for each), and turns the `smos_Pythag` macro into `hypot`:

| Kernel routine | Ours |
| --- | --- |
| `N_RealMatrixSingleValueDecompose`, `SmMatrix::SVDecompose` | one-sided Jacobi SVD |
| `N_SingleValueDecomposeSolve`, `SmMatrix::SolveWithSVDMatrices` | pseudo-inverse solve, small singular values dropped |
| `SmMatrix::EigenSystemJacobiSolver` | cyclic Jacobi |
| `M_TridiagonalSystem` | elimination without pivoting (Thomas) |
| `M_CorneredTridiagonalSystem` | Sherman-Morrison on the tridiagonal solve |
| `N_FuncFindMinima` | Brent's minimizer |
| `N_SolveQuadraticEq` | the cancellation-free quadratic formula |

`tests/routines.rs` (with `--features routine-probe`) runs them, and kernel code that calls them (plane and line fits, matrix inverse, 3x3 eigenvectors, a mirror and a skew transform of a solid), against the values the original routines gave, at 1e-6 relative. Two exceptions: for two or more equations the original tridiagonal solvers return values that solve no system their documentation describes, so ours are checked against the system itself, and a skewed cylinder's B-spline volume is checked against the exact value, which ours is closer to.

## API

`sx_brep::call(op, request_json) -> Result<String, String>`, with the operations listed in `src/lib.rs`: `box`, `cylinder`, `extrude`, `boolean`, `subtract`, `cut`, `info`, `tessellate`, `free` and `count`. Bodies stay in the kernel, named by number, until freed. An op that changes a body makes a new one and leaves its inputs as they were. `KERNEL` says whether the build has the kernel.

The kernel runs on one thread: `cpp/tbb` stands in for the oneTBB headers it includes and runs its loops in order. Calls take a lock.

## Licenses

Our wrapper is Apache-2.0. The kernel is Apache-2.0, by NVIDIA Corporation; THIRD-PARTY.md has the details.
