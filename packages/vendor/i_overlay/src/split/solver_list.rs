use crate::core::edge_data::OverlayEdgeData;
use crate::core::integer::OverlayInt;
use crate::core::solver::Solver;
use crate::segm::segment::Segment;
use crate::segm::winding::WindingCount;
use crate::split::cross_solver::CrossSolver;
use crate::split::snap_radius::SnapRadius;
use crate::split::solver::SplitSolver;
use alloc::vec::Vec;

impl<I> SplitSolver<I>
where
    I: OverlayInt,
{
    /// Splits crossing segments in passes until none cross.
    ///
    /// Whether two segments cross depends only on their end points (the snap radius only moves the
    /// crossing point), so a pair that met no crossing in one pass meets none in the next while both
    /// segments stay as they were. After the first pass, only pairs with at least one segment that the
    /// last split created (or that the last pass marked) are compared; the other pairs were compared
    /// already and gave nothing.
    pub(super) fn list_split<C: WindingCount, D: OverlayEdgeData<C>>(
        &mut self,
        snap_radius: SnapRadius,
        segments: &mut Vec<Segment<C, I, D>>,
        solver: &Solver,
        store: &mut D::Store,
    ) -> bool {
        let mut need_to_fix = true;

        let mut snap_radius = snap_radius;
        let mut any_intersection = false;
        let mut reusable_buffer = Vec::new();

        // Empty in the first pass (every pair is compared); afterwards whether each segment is new.
        let mut fresh: Vec<bool> = Vec::new();
        let mut fresh_list: Vec<usize> = Vec::new();
        let mut moved: Vec<Segment<C, I, D>> = Vec::new();

        while need_to_fix && segments.len() > 1 {
            need_to_fix = false;
            self.marks.clear();

            let radius_squared = snap_radius.radius_squared::<I>();

            if fresh.is_empty() {
                for (i, si) in segments.iter().enumerate() {
                    let xsi = &si.x_segment;
                    let ri = xsi.y_range();
                    for (j, sj) in segments.iter().enumerate().skip(i + 1) {
                        let xsj = &sj.x_segment;
                        if xsi.b.x < xsj.a.x {
                            break;
                        }

                        if xsj.is_not_intersect_y_range(&ri) {
                            continue;
                        }

                        if CrossSolver::<I>::only_touch(xsi, xsj) {
                            continue;
                        }
                        let is_round = Self::cross_apart(i, j, xsi, xsj, &mut self.marks, radius_squared);
                        need_to_fix = need_to_fix || is_round
                    }
                }
            } else {
                // `fresh_list` holds the new segments' indices in order.
                let mut next_fresh = 0usize;
                for (i, si) in segments.iter().enumerate() {
                    let xsi = &si.x_segment;
                    let ri = xsi.y_range();
                    while next_fresh < fresh_list.len() && fresh_list[next_fresh] <= i {
                        next_fresh += 1;
                    }
                    if fresh[i] {
                        for (j, sj) in segments.iter().enumerate().skip(i + 1) {
                            let xsj = &sj.x_segment;
                            if xsi.b.x < xsj.a.x {
                                break;
                            }

                            if xsj.is_not_intersect_y_range(&ri) {
                                continue;
                            }

                            if CrossSolver::<I>::only_touch(xsi, xsj) {
                                continue;
                            }
                            let is_round = Self::cross_apart(i, j, xsi, xsj, &mut self.marks, radius_squared);
                            need_to_fix = need_to_fix || is_round
                        }
                    } else {
                        for &j in &fresh_list[next_fresh..] {
                            let xsj = &segments[j].x_segment;
                            if xsi.b.x < xsj.a.x {
                                break;
                            }

                            if xsj.is_not_intersect_y_range(&ri) {
                                continue;
                            }

                            if CrossSolver::<I>::only_touch(xsi, xsj) {
                                continue;
                            }
                            let is_round = Self::cross_apart(i, j, xsi, xsj, &mut self.marks, radius_squared);
                            need_to_fix = need_to_fix || is_round
                        }
                    }
                }
            }

            if self.marks.is_empty() {
                return any_intersection;
            }
            any_intersection = true;

            // A segment that was split can come back whole from another split; it counts as new.
            self.apply_list(
                segments,
                &mut reusable_buffer,
                solver,
                store,
                &mut moved,
                &mut fresh,
            );
            fresh_list.clear();
            fresh_list.extend(fresh.iter().enumerate().filter(|(_, f)| **f).map(|(i, _)| i));

            snap_radius.increment();

            if need_to_fix && !solver.is_list_split(segments) {
                // finish with tree solver if edges is become large
                self.tree_split(snap_radius, segments, solver, store);
                return true;
            }
        }

        any_intersection
    }
}
