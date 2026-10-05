use crate::geom::x_segment::XSegment;
use crate::segm::segment::Segment;
use alloc::vec::Vec;
use i_float::int::number::int::IntNumber;
use i_key_sort::sort::key::SortKey;
use i_key_sort::sort::two_keys_cmp::TwoKeysAndCmpSort;

pub(crate) trait ShapeSegmentsSort {
    fn sort_by_ab(&mut self, parallel: bool);
}

impl<I: IntNumber + SortKey, C: Send + Sync + Copy, D: Send + Sync + Copy> ShapeSegmentsSort
    for [Segment<C, I, D>]
{
    #[inline]
    fn sort_by_ab(&mut self, parallel: bool) {
        self.sort_by_two_keys_then_by(
            parallel,
            |s| s.x_segment.a.x,
            |s| s.x_segment.a.y,
            |s0, s1| s0.x_segment.b.cmp(&s1.x_segment.b),
        )
    }
}

/// Up to this many segments, `sort_list_by_ab` sorts by insertion alone.
const INSERTION_MAX: usize = 16;

/// A bin with more segments than this sends the list to `sort_by_ab`, where sorting it by insertion could cost more.
const BIN_LEN_MAX: u32 = 32;

pub(crate) trait ShapeSegmentsListSort {
    /// The order of `sort_by_ab` for a list the caller owns: a counting sort by `a.x` into about as many bins as
    /// segments (at most 1024), each bin keeping its segments in list order, then one insertion pass, which moves
    /// segments only within their bins. Equal segments can come out in another order than `sort_by_ab` leaves them;
    /// merging adds their counts, so the order does not show. A list with a bin longer than `BIN_LEN_MAX` goes to
    /// `sort_by_ab`.
    fn sort_list_by_ab(&mut self, parallel: bool);
}

impl<I: IntNumber + SortKey, C: Send + Sync + Copy, D: Send + Sync + Copy> ShapeSegmentsListSort
    for Vec<Segment<C, I, D>>
{
    fn sort_list_by_ab(&mut self, parallel: bool) {
        let n = self.len();
        if n <= INSERTION_MAX {
            insertion_by_ab(self);
            return;
        }
        if n <= 64 {
            counting_sort_by_ab::<C, I, D, 64>(self, parallel);
        } else {
            counting_sort_by_ab::<C, I, D, 1024>(self, parallel);
        }
    }
}

/// Whether `s0` comes before `s1`: by `a`, then by `b`, each by x and then y.
#[inline(always)]
fn ab_less<I: IntNumber>(s0: &XSegment<I>, s1: &XSegment<I>) -> bool {
    (s0.a.x, s0.a.y, s0.b.x, s0.b.y) < (s1.a.x, s1.a.y, s1.b.x, s1.b.y)
}

/// Insertion sort by `ab_less`: few moves when the segments are nearly in order.
#[inline]
fn insertion_by_ab<C: Copy, I: IntNumber, D: Copy>(segments: &mut [Segment<C, I, D>]) {
    for i in 1..segments.len() {
        if ab_less(&segments[i].x_segment, &segments[i - 1].x_segment) {
            let s = segments[i];
            let mut j = i;
            while j > 0 && ab_less(&s.x_segment, &segments[j - 1].x_segment) {
                segments[j] = segments[j - 1];
                j -= 1;
            }
            segments[j] = s;
        }
    }
}

/// The counting sort of `sort_list_by_ab` with at most `BINS` bins (a power of two).
#[inline]
fn counting_sort_by_ab<C, I, D, const BINS: usize>(list: &mut Vec<Segment<C, I, D>>, parallel: bool)
where
    I: IntNumber + SortKey,
    C: Send + Sync + Copy,
    D: Send + Sync + Copy,
{
    let n = list.len();
    let mut min_x = list[0].x_segment.a.x;
    let mut max_x = min_x;
    for s in list.iter() {
        let x = s.x_segment.a.x;
        min_x = min_x.min(x);
        max_x = max_x.max(x);
    }
    let power = (n.next_power_of_two().trailing_zeros() as usize).min(BINS.trailing_zeros() as usize);
    let shift = max_x.distance_bits(min_x).saturating_sub(power);
    let bin_count = max_x.shifted_distance(min_x, shift) + 1;
    debug_assert!(bin_count <= BINS);

    // The bins' sizes, then where each bin starts.
    let mut starts = [0u32; BINS];
    for s in list.iter() {
        starts[s.x_segment.a.x.shifted_distance(min_x, shift)] += 1;
    }
    let mut longest = 0;
    let mut sum = 0;
    for start in starts.iter_mut().take(bin_count) {
        let len = *start;
        longest = longest.max(len);
        *start = sum;
        sum += len;
    }
    if longest > BIN_LEN_MAX {
        list.sort_by_ab(parallel);
        return;
    }

    let mut sorted = Vec::with_capacity(list.capacity());
    let spare = sorted.spare_capacity_mut();
    for s in list.iter() {
        let k = s.x_segment.a.x.shifted_distance(min_x, shift);
        spare[starts[k] as usize].write(*s);
        starts[k] += 1;
    }
    // SAFETY: the bins cover `0..n` once, so every place below `n` was written.
    unsafe { sorted.set_len(n) };
    insertion_by_ab(&mut sorted);
    *list = sorted;
}
