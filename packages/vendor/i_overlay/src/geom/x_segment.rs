use crate::geom::line_range::LineRange;
use core::cmp::Ordering;
use i_float::int::number::int::IntNumber;
use i_float::int::point::IntPoint;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct XSegment<I: IntNumber> {
    pub(crate) a: IntPoint<I>,
    pub(crate) b: IntPoint<I>,
}

impl<I: IntNumber> XSegment<I> {
    #[inline(always)]
    pub(crate) fn y_range(&self) -> LineRange<I> {
        if self.a.y < self.b.y {
            LineRange {
                min: self.a.y,
                max: self.b.y,
            }
        } else {
            LineRange {
                min: self.b.y,
                max: self.a.y,
            }
        }
    }

    #[inline(always)]
    pub(crate) fn is_not_vertical(&self) -> bool {
        self.a.x != self.b.x
    }

    #[inline(always)]
    pub(crate) fn is_not_intersect_y_range(&self, range: &LineRange<I>) -> bool {
        // Both ends above the range or both below it, read from the segment's lower and upper y, so the test has no
        // branch of its own.
        (range.min > self.a.y.max(self.b.y)) | (range.max < self.a.y.min(self.b.y))
    }
}

impl<I: IntNumber> PartialOrd for XSegment<I> {
    #[inline(always)]
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl<I: IntNumber> Ord for XSegment<I> {
    #[inline(always)]
    fn cmp(&self, other: &Self) -> Ordering {
        let a = self.a.cmp(&other.a);
        if a == Ordering::Equal {
            self.b.cmp(&other.b)
        } else {
            a
        }
    }
}
