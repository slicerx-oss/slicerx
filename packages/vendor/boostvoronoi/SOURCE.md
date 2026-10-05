boostvoronoi 0.12.1 from crates.io (BSL-1.0, eadf), with changes in
`src/extended_scalar/extended_int.rs`, `src/extended_scalar/robust_sqrt_expr.rs`,
`src/predicate/exact_circle_formation.rs` and `src/predicate/lazy_circle_formation.rs`, and a new
`src/extended_scalar/fixed_int.rs` (ours, under the crate's license); the examples, benches and tests of
the crate are left out, and so are its optional integrations (glam, nalgebra, cgmath, mint, geo, serde),
which SlicerX does not use.

The Voronoi builder checks circle events with exact integer arithmetic whenever the floating point
estimate is not sure (`exact_circle_formation`), and on the outlines the Arachne and aegis walls read
that is most of them: `ExtendedInt` arithmetic was a fifth of all the work of an aegis slice. These
changes make it cheaper and keep every result the same, chunk for chunk:

- `mul_slice` multiplies operands of one or two 32-bit chunks as one 128-bit product, written straight
  into the inline chunks, and runs the schoolbook loop of longer ones over the pairs that exist instead of
  skipping the others.
- A new result (the usual case: every operator starts from zero) is worked out in a buffer on the stack
  and copied in at once, for products, sums and differences of up to 24 chunks, as a fixed number of
  chunks rather than a copy of a varying length; the in-place code of the original stays for the rest.
- A value keeps up to 12 chunks inline instead of 8 (the products of the exact predicates often have 9
  to 12), so fewer of them go to the heap. Values from integers are written straight into the inline
  chunks, and the conversion to floating point reads the top three chunks by index (each step rounded as
  before).
- The exact point, segment, segment predicate works out the terms its coordinates share once
  (`dx * dx + dy * dy` and two dot products, which it repeated up to five times), and the part of
  `sqrt_expr_evaluator_pss4` that depends on `B` alone (`B[0] * B[1]` and the square root of
  `sqrt(B[0] * B[1]) + B[2]`) once for its up to four calls with the same `B`. Every operation gives the
  same chunks for the same operands, so the values are the same.
- The exact predicates and the square root evaluators are written once and instantiated for two big
  integers: `FixedInt` (`fixed_int.rs`), which the lazy predicates call, and `ExtendedInt`. `FixedInt`
  does what `ExtendedInt` does for a new value, with the same chunks and chunk count (sums, differences
  with their equal-top-chunk and zero-top-chunk rules, products), in a fixed array of 24 chunks with a
  signed count: it is `Copy`, has no drop, no spill to the heap and no length kept apart from the count.
  A result longer than 24 chunks (a few hundred in a slice of tens of millions, deep in the nested square
  root evaluations) raises a flag on the thread, and the lazy predicate runs that exact predicate again on
  `ExtendedInt` from the same start, so every circle event is the one the original computes. The engine
  WASM keeps the `ExtendedInt` path alone (the same results, without a second copy of the predicates in
  its size budget). A randomized test checks `FixedInt` against `ExtendedInt` chunk for chunk, and a
  verification build that runs every exact predicate on both found no difference on the request fixtures
  and the benchmark requests.

  An earlier attempt at a fixed-size integer (boost's own `extended_int<64>`, 64 chunks) measured slower:
  every operation then copies 256 bytes. This one keeps 24 chunks (96 bytes), which hold all but a handful
  of values, and leaves those to `ExtendedInt`.

The diagrams, and the G-code, are the same. Measured on the ball under aegis walls at one thread,
instructions retired: about 12 percent fewer for the first three changes, 6 percent for the shared terms
(with the faster copies), and 5 percent for `FixedInt`.
