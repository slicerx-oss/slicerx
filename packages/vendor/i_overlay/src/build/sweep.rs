use crate::core::fill_rule::FillRule;
use crate::core::solver::Solver;
use crate::geom::end::End;
use crate::geom::v_segment::VSegment;
use crate::segm::segment::{Segment, SegmentFill};
use crate::segm::winding::WindingCount;
use crate::util::log::Int;
use alloc::vec::Vec;
use core::cmp::Ordering;
use core::ops::ControlFlow;
use i_float::int::number::int::IntNumber;
use i_float::int::point::IntPoint;
use i_float::triangle::Triangle;
use i_tree::Expiration;
use i_tree::key::exp::KeyExpCollection;
use i_tree::key::tree::KeyExpTree;

pub(crate) trait FillStrategy<C> {
    fn add_and_fill(this: C, bot: C) -> (C, SegmentFill);
}

pub(crate) trait FillHandler<C, I: IntNumber, D = ()> {
    type Output;
    fn handle(
        &mut self,
        index: usize,
        segment: &Segment<C, I, D>,
        fill: SegmentFill,
    ) -> ControlFlow<Self::Output>;
    fn finalize(self) -> Self::Output;
}

#[inline]
fn sweep_with_handler<I, C, D, F, S, H>(
    scan: &mut S,
    segments: &[Segment<C, I, D>],
    mut handler: H,
) -> H::Output
where
    I: IntNumber + Expiration,
    C: WindingCount,
    F: FillStrategy<C>,
    S: KeyExpCollection<VSegment<I>, I, C>,
    H: FillHandler<C, I, D>,
{
    let mut node = Vec::with_capacity(4);
    let n = segments.len();
    let mut i = 0;

    while i < n {
        let p = segments[i].x_segment.a;

        node.push(End {
            index: i,
            point: segments[i].x_segment.b,
        });
        i += 1;

        while i < n && segments[i].x_segment.a == p {
            node.push(End {
                index: i,
                point: segments[i].x_segment.b,
            });
            i += 1;
        }

        if node.len() > 1 {
            node.sort_by(|s0, s1| Triangle::clock_order(p, s1.point, s0.point));
        }

        let mut sum_count = scan.first_less_or_equal_by(p.x, C::new(0, 0), |s| s.is_under_point_order(p));

        for se in node.iter() {
            let sid = unsafe { segments.get_unchecked(se.index) };
            let (new_sum, fill) = F::add_and_fill(sid.count, sum_count);
            sum_count = new_sum;

            if let ControlFlow::Break(result) = handler.handle(se.index, sid, fill) {
                return result;
            }

            if sid.x_segment.is_not_vertical() {
                scan.insert(sid.x_segment.into(), sum_count, p.x);
            }
        }

        node.clear();
    }

    handler.finalize()
}

/// Up to this many entries, `ScanList::under_point` reads every entry once: it drops the expired ones and counts the
/// ones under the point, so no binary search runs. Longer lists drop the expired entries first and then search.
const SCAN_LINEAR_MAX: usize = 16;

/// Up to this many entries after the insertion point, `ScanList::insert_from_point` moves them up one at a time, which
/// costs less than a memmove call for so few; a longer tail moves through `Vec::insert`.
const SCAN_SHIFT_MAX: usize = 16;

/// The segments the sweep line crosses, from the bottom up, each with the winding count above it: `KeyExpList` of
/// `i_tree` for `VSegment` keys, with the same order and answers. A segment leaves the list once the sweep reaches its
/// right end (its expiration).
pub(crate) struct ScanList<I: IntNumber, C> {
    buffer: Vec<(VSegment<I>, C)>,
    min_exp: I,
}

impl<I: IntNumber + Expiration, C: Copy> ScanList<I, C> {
    #[inline]
    fn new(capacity: usize) -> Self {
        Self {
            buffer: Vec::with_capacity(capacity),
            min_exp: I::max_expiration(),
        }
    }

    #[inline]
    fn clear(&mut self) {
        self.min_exp = I::max_expiration();
        self.buffer.clear();
    }

    #[inline]
    fn reserve_capacity(&mut self, capacity: usize) {
        let additional = capacity.saturating_sub(self.buffer.capacity());
        if additional > 0 {
            self.buffer.reserve(additional);
        }
    }

    /// Drops the segments that end at or before `time`. The entries before the first such segment stay in place; from
    /// it on, every entry is written to the next free place, which moves on only for an entry that stays, so that part
    /// of the pass does not branch on each entry.
    #[inline]
    fn clear_expired(&mut self, time: I) {
        if self.min_exp > time {
            return;
        }
        let mut min_exp = I::max_expiration();
        let len = self.buffer.len();
        let mut w = 0usize;
        while w < len {
            let exp = self.buffer[w].0.b.x;
            if exp <= time {
                break;
            }
            min_exp = min_exp.min(exp);
            w += 1;
        }
        for r in w..len {
            let e = self.buffer[r];
            let exp = e.0.b.x;
            let keep = exp > time;
            self.buffer[w] = e;
            w += usize::from(keep);
            min_exp = if keep && exp < min_exp { exp } else { min_exp };
        }
        self.buffer.truncate(w);
        self.min_exp = min_exp;
    }

    /// `KeyExpList::first_less_or_equal_by` with the segments' order against `p`: the count above the segment under
    /// `p`, or `default` with none, and where `p` falls among the segments (None when one of them holds it).
    #[inline]
    fn under_point(&mut self, p: IntPoint<I>, default: C) -> (C, Option<usize>) {
        if self.buffer.len() <= SCAN_LINEAR_MAX {
            return self.under_point_linear(p, default);
        }
        self.clear_expired(p.x);
        self.search(p, default)
    }

    /// `under_point` on a short list, in one pass that drops the expired entries and compares every entry that stays
    /// with `p`. The list is ordered from the bottom up at `p` and segments that crossed were split, so the entries
    /// under `p` come first and at most one entry holds `p`, right after them; the number under `p` is then where the
    /// binary search lands, and the one through `p` is the one it finds. When the entries do not read that way, the
    /// binary search runs, as before.
    #[inline]
    fn under_point_linear(&mut self, p: IntPoint<I>, default: C) -> (C, Option<usize>) {
        let time = p.x;
        // The entries under `p`, one past the last of them, and the entries through `p` with the last one's place.
        let mut under = 0usize;
        let mut under_end = 0usize;
        let mut holders = 0usize;
        let mut holder = 0usize;
        if self.min_exp > time {
            for (i, e) in self.buffer.iter().enumerate() {
                let order = Triangle::clock_order(e.0.a, p, e.0.b);
                let is_under = order == Ordering::Less;
                let holds = order == Ordering::Equal;
                under += usize::from(is_under);
                under_end = if is_under { i + 1 } else { under_end };
                holders += usize::from(holds);
                holder = if holds { i } else { holder };
            }
        } else {
            let len = self.buffer.len();
            let mut min_exp = I::max_expiration();
            let mut w = 0usize;
            for r in 0..len {
                let e = self.buffer[r];
                let exp = e.0.b.x;
                let keep = exp > time;
                // An expired entry's order is not used.
                let order = Triangle::clock_order(e.0.a, p, e.0.b);
                let is_under = keep & (order == Ordering::Less);
                let holds = keep & (order == Ordering::Equal);
                self.buffer[w] = e;
                under += usize::from(is_under);
                under_end = if is_under { w + 1 } else { under_end };
                holders += usize::from(holds);
                holder = if holds { w } else { holder };
                w += usize::from(keep);
                min_exp = if keep && exp < min_exp { exp } else { min_exp };
            }
            self.buffer.truncate(w);
            self.min_exp = min_exp;
        }
        // Every other entry is above `p` when the ones under it fill the front and the one through it, if any, comes
        // right after them.
        if under_end != under || holders > 1 || holders == 1 && holder != under {
            return self.search(p, default);
        }
        if holders == 1 {
            return (self.buffer[holder].1, None);
        }
        let count = if under > 0 {
            self.buffer[under - 1].1
        } else {
            default
        };
        (count, Some(under))
    }

    /// The binary search of `under_point`, on a list without expired entries.
    #[inline]
    fn search(&self, p: IntPoint<I>, default: C) -> (C, Option<usize>) {
        match self.buffer.binary_search_by(|e| e.0.is_under_point_order(p)) {
            Ok(index) => (self.buffer[index].1, None),
            Err(index) => (
                if index > 0 {
                    self.buffer[index - 1].1
                } else {
                    default
                },
                Some(index),
            ),
        }
    }

    /// `KeyExpList::insert` of a segment that starts at the point `p` of the last `under_point`, after `group` others
    /// that start there. A segment that starts left of `p` (or under it, at its x) is under the new one exactly when
    /// it is under `p` (the two orders read the same three points), so the new one goes among those that start at
    /// `p`, where `p` fell: the place the binary search finds. When a segment held `p`, the binary search runs.
    #[inline]
    fn insert_from_point(&mut self, at: Option<usize>, group: usize, key: VSegment<I>, val: C, time: I) {
        self.clear_expired(time);
        self.min_exp = self.min_exp.min(key.b.x);
        let index = match at {
            Some(k) => {
                let mut i = k;
                while i < k + group && self.buffer[i].0.cmp(&key) == Ordering::Less {
                    i += 1;
                }
                i
            }
            None => self
                .buffer
                .binary_search_by(|e| e.0.cmp(&key))
                .unwrap_or_else(|index| index),
        };
        let len = self.buffer.len();
        if len - index > SCAN_SHIFT_MAX {
            self.buffer.insert(index, (key, val));
            return;
        }
        self.buffer.push((key, val));
        let mut t = len;
        while t > index {
            self.buffer[t] = self.buffer[t - 1];
            t -= 1;
        }
        self.buffer[index] = (key, val);
    }
}

/// `sweep_with_handler` on a [`ScanList`].
#[inline]
fn sweep_with_list<I, C, D, F, H>(
    scan: &mut ScanList<I, C>,
    segments: &[Segment<C, I, D>],
    mut handler: H,
) -> H::Output
where
    I: IntNumber + Expiration,
    C: WindingCount,
    F: FillStrategy<C>,
    H: FillHandler<C, I, D>,
{
    let mut node = Vec::with_capacity(4);
    let n = segments.len();
    let mut i = 0;

    while i < n {
        let p = segments[i].x_segment.a;

        node.push(End {
            index: i,
            point: segments[i].x_segment.b,
        });
        i += 1;

        while i < n && segments[i].x_segment.a == p {
            node.push(End {
                index: i,
                point: segments[i].x_segment.b,
            });
            i += 1;
        }

        if node.len() > 1 {
            node.sort_by(|s0, s1| Triangle::clock_order(p, s1.point, s0.point));
        }

        let (mut sum_count, at) = scan.under_point(p, C::new(0, 0));
        let mut group = 0usize;

        for se in node.iter() {
            let sid = unsafe { segments.get_unchecked(se.index) };
            let (new_sum, fill) = F::add_and_fill(sid.count, sum_count);
            sum_count = new_sum;

            if let ControlFlow::Break(result) = handler.handle(se.index, sid, fill) {
                return result;
            }

            if sid.x_segment.is_not_vertical() {
                scan.insert_from_point(at, group, sid.x_segment.into(), sum_count, p.x);
                group += 1;
            }
        }

        node.clear();
    }

    handler.finalize()
}

pub(crate) struct SweepRunner<C, I: IntNumber + Expiration> {
    list: Option<ScanList<I, C>>,
    tree: Option<KeyExpTree<VSegment<I>, I, C>>,
}

impl<C: WindingCount, I: IntNumber + Expiration> SweepRunner<C, I> {
    #[inline]
    pub(crate) fn new() -> Self {
        Self {
            list: None,
            tree: None,
        }
    }

    #[inline]
    pub(crate) fn run<D, F, H>(
        &mut self,
        solver: &Solver,
        segments: &[Segment<C, I, D>],
        handler: H,
    ) -> H::Output
    where
        F: FillStrategy<C>,
        H: FillHandler<C, I, D>,
        D: Send,
    {
        let count = segments.len();
        if solver.is_list_fill(segments) {
            let capacity = count.log2_sqrt().max(4) * 2;
            let mut list = self.take_scan_list(capacity);
            let result = sweep_with_list::<I, C, D, F, _>(&mut list, segments, handler);
            self.list = Some(list);
            result
        } else {
            let capacity = count.log2_sqrt().max(8);
            let mut tree = self.take_scan_tree(capacity);
            let result = sweep_with_handler::<I, C, D, F, _, _>(&mut tree, segments, handler);
            self.tree = Some(tree);
            result
        }
    }

    #[inline]
    pub(crate) fn run_with_fill_rule<D, H>(
        &mut self,
        fill_rule: FillRule,
        solver: &Solver,
        segments: &[Segment<C, I, D>],
        handler: H,
    ) -> H::Output
    where
        H: FillHandler<C, I, D>,
        D: Send,
        EvenOddStrategy: FillStrategy<C>,
        NonZeroStrategy: FillStrategy<C>,
        PositiveStrategy: FillStrategy<C>,
        NegativeStrategy: FillStrategy<C>,
    {
        match fill_rule {
            FillRule::EvenOdd => self.run::<D, EvenOddStrategy, H>(solver, segments, handler),
            FillRule::NonZero => self.run::<D, NonZeroStrategy, H>(solver, segments, handler),
            FillRule::Positive => self.run::<D, PositiveStrategy, H>(solver, segments, handler),
            FillRule::Negative => self.run::<D, NegativeStrategy, H>(solver, segments, handler),
        }
    }

    #[inline]
    fn take_scan_list(&mut self, capacity: usize) -> ScanList<I, C> {
        if let Some(mut list) = self.list.take() {
            list.clear();
            list.reserve_capacity(capacity);
            list
        } else {
            ScanList::new(capacity)
        }
    }

    #[inline]
    fn take_scan_tree(&mut self, capacity: usize) -> KeyExpTree<VSegment<I>, I, C> {
        if let Some(mut tree) = self.tree.take() {
            tree.clear();
            tree.reserve_capacity(capacity);
            tree
        } else {
            KeyExpTree::new(capacity)
        }
    }
}

pub(crate) struct EvenOddStrategy;
pub(crate) struct NonZeroStrategy;
pub(crate) struct PositiveStrategy;
pub(crate) struct NegativeStrategy;
