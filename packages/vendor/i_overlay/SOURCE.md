i_overlay 9.0.0 from crates.io (MIT OR Apache-2.0, Nail Sharipov), with changes in
`src/split/solver_list.rs`, `src/split/solver.rs`, `src/split/cross_solver.rs`, `src/segm/sort.rs`,
`src/geom/x_segment.rs` and `src/build/sweep.rs`; the tests and docs of the crate are left out.

The list solver splits crossing segments in passes, comparing every pair of segments whose x ranges
meet, until a pass finds no crossing that needs rounding. Whether two segments cross depends only on
their end points (the snap radius, which grows each pass, moves only the crossing point), so a pair
that gave no crossing in one pass gives none in the next while both segments stay as they were.
After the first pass the solver therefore compares only pairs with at least one segment that the
last split created or marked, and skips the rest. A segment counts as unchanged when a segment with
the same end points was in the list before the split and received no mark; a segment that was split
can come back whole from another segment's split, and then counts as new. After a pass the solver sorts
only the segments that the split shortened or created and merges them into the others, which kept their
order (`SplitSolver::apply_list` in `src/split/solver.rs`), and that merge says which segments are new; a
segment that merges with one that was not split counts as old.

`CrossSolver::cross` first checks whether the two segments share an end point. Two such segments
cross only when they lie on one line (the original finds two of its four directions zero and returns
nothing unless all four are), so one direction settles them; about half the pairs compared are
neighbors on a contour. The list solver's scan makes that check itself, inline (`CrossSolver::only_touch`),
and calls the rest of the test only for the other pairs; after a split, the pieces around each crossing
point touch in the same way. Its y range test reads the segment's lower and upper y, so the test has no
branch of its own.

The fill sweep of the list strategy keeps its own list of the segments the sweep line crosses
(`ScanList` in `src/build/sweep.rs`) in place of `KeyExpList` from `i_tree`, with the same order and the
same answers. A segment that starts at the sweep point goes where the query for that point found the point,
among the segments that start there, instead of through a binary search of its own: a segment that starts
left of the point, or under it at its x, is under the new segment exactly when it is under the point, since
both orders read the same three points. Segments whose right end the sweep has passed leave in one pass that
keeps the entries before the first of them in place and does not branch on each entry after it.

A list of at most 16 segments (the knot slice's lists hold about six at a sweep point) answers the query for
a point in one pass instead: the pass drops the segments the sweep has passed and compares every other one
with the point, counting the ones under it. The list is ordered from the bottom up at the point and segments
that crossed were split, so the ones under the point come first and at most one segment holds the point,
right after them; the count is then where the binary search lands, and the one through the point is the one
it finds. When the entries do not read that way, the binary search runs as before. A new segment moves a
tail of at most 16 entries up one at a time instead of through a memmove call.

The split solver sorts its segments, at the start and after each pass (the shortened and new ones), with a
counting sort by the x of their left ends into about as many bins as segments, each bin in list order, and
then one insertion pass that moves segments only within their bins (`sort_list_by_ab` in
`src/segm/sort.rs`), in place of the bin sort of `i_key_sort`, which sorts each of at most 256 bins on its
own. Equal segments can come out in another order; merging adds their counts, so the result does not show
it. A list with a bin of more than 32 segments still goes to the bin sort.

The result is the same: every request fixture and benchmark plate gives the same G-code and preview
bytes. On the ball plate (one thread) it saves about 6 percent of all instructions, since the later
passes made up two thirds of the pairs compared, and the end point check about 1 percent more. Replaying
every overlay of the x-mark and spire slices (one thread), the scan list saves about 1 percent of the
instructions and 4 to 6 percent of the cycles, mostly the binary searches and the branches of dropping
segments, and the sort and merge after a split pass about 4 percent of the instructions and 6 to 7 percent
of the cycles more. Replaying every overlay of the knot (P1S classic, no supports), x-mark and spire slices
from a bench-release build (one thread, minimum of 6 rounds), the counting sort saves 3.5 to 4.5 percent of
the instructions and 4 to 9 percent of the cycles. The one-pass query runs 3 to 4.5 percent more
instructions and saves 7 to 14 percent of the cycles, which went to the binary search's branches and
dependent loads and to memmove calls. The inline touch check and the y range test without branches save
about 1 percent of the instructions and 6 to 7 percent of the cycles on the knot and spire slices (x-mark is
unchanged).
