// SPDX-License-Identifier:BSL-1.0

// Boost.Polygon library detail/voronoi_structures.hpp header file
//
//          Copyright Eadf (github.com/eadf) 2021.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

//! Some basic geometry data structures together with From trait implementations.

use crate::{InputType, diagram::Vertex};
use num_traits::AsPrimitive;
#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};
use std::fmt;

#[cfg(feature = "cgmath")]
mod cgmath_impl;
#[cfg(feature = "geo")]
mod geo_impl;
#[cfg(test)]
mod tests;

#[cfg(feature = "mint")]
mod mint_impl;

#[cfg(feature = "nalgebra")]
mod impl_nalgebra;

#[cfg(feature = "glam")]
mod glam_impl;

/// A really simple 2d coordinate container type - integer only
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Copy, Clone, PartialEq, PartialOrd, Eq, Hash)]
pub struct Point<T: InputType> {
    pub x: T,
    pub y: T,
}

impl<T: InputType> Point<T> {
    /// Create a new `Point`
    #[inline(always)]
    pub const fn new(x: T, y: T) -> Self {
        Self { x, y }
    }

    /// Got "conflicting implementations of trait `std::convert::From...`"
    /// So I picked the name `as_f64` for this conversion
    #[inline(always)]
    pub fn as_f64(&self) -> [f64; 2] {
        [self.x.as_(), self.y.as_()]
    }

    #[cfg(all(feature = "ce_corruption_check", feature = "geo"))]
    #[inline(always)]
    pub fn distance_to_point(&self, x: f64, y: f64) -> f64 {
        use geo::{Distance, Euclidean, Point};
        let p1: Point = Point::new(x, y);
        let p2: Point = Point::from(self.as_f64());
        Euclidean.distance(p1, p2)
    }

    /// Cast a `Point<T>` to `Point<T2>`
    #[inline(always)]
    pub fn cast<T2: InputType>(self) -> Point<T2>
    where
        T: AsPrimitive<T2>,
    {
        Point::<T2> {
            x: self.x.as_(),
            y: self.y.as_(),
        }
    }
}

impl<T: InputType> From<Point<T>> for [f64; 2] {
    #[inline]
    /// Converts to `[f64;2]` from `boostvoronoi::geometry::Point<T>`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let c1 = [1,2];
    /// let p:Point<i32> = Point::from(c1);
    /// let c2: [f64;2] = p.into();
    /// println!("c1:{:?}, c2:{:?}", c1, c2);
    /// assert_eq!(c1[0] as f64, c2[0]);
    /// assert_eq!(c1[1] as f64, c2[1]);
    /// ```
    fn from(coordinate: Point<T>) -> Self {
        coordinate.as_f64()
    }
}

impl<T: InputType> fmt::Debug for Point<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "({:.12},{:.12})", self.x, self.y,)
    }
}

impl<T: InputType> From<&Point<T>> for Point<T> {
    #[inline]
    /// A copy conversion from `&boostvoronoi::geometry::Point` to `boostvoronoi::geometry::Point`
    /// This makes it possible to accept an `Iter<Into<Point>>` and `Iter<&Point>` in the same method.
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let c = [1,2];
    /// let p1:Point<i32> = Point::from(c);
    /// let p2:Point<i32> = Point::from(&p1);
    ///
    /// assert_eq!(p2.x,c[0]);
    /// assert_eq!(p2.y,c[1]);
    /// ```
    fn from(point: &Self) -> Self {
        *point
    }
}

impl<T: InputType> From<&Line<T>> for Line<T> {
    #[inline]
    /// A copy conversion from `&boostvoronoi::geometry::Line` to `boostvoronoi::geometry::Line`
    /// This makes it possible to accept an `Iter<Into<Line>>` and `Iter<&Line>` in the same method.
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let c = [1,2,3,4];
    /// let p1:Line<i32> = Line::from(c);
    /// let p2:Line<i32> = Line::from(&p1);
    ///
    /// assert_eq!(p2.start.x,c[0]);
    /// assert_eq!(p2.start.y,c[1]);
    /// assert_eq!(p2.end.x,c[2]);
    /// assert_eq!(p2.end.y,c[3]);
    /// ```
    fn from(point: &Self) -> Self {
        *point
    }
}

impl<T: InputType> From<[T; 2]> for Point<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Point` from `[T;2]`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let c = [1,2];
    /// let p:Point<i32> = Point::from(c);
    /// assert_eq!(p.x,c[0]);
    /// assert_eq!(p.y,c[1]);
    /// ```
    fn from(p: [T; 2]) -> Self {
        Self { x: p[0], y: p[1] }
    }
}

impl<T: InputType> From<&[T; 2]> for Point<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Point` from `&\[T;2\]`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let c = [1,2];
    /// let p:Point<i32> = Point::from(&c);
    /// assert_eq!(p.x,c[0]);
    /// assert_eq!(p.y,c[1]);
    /// ```
    fn from(c: &[T; 2]) -> Self {
        Self { x: c[0], y: c[1] }
    }
}

/// A really simple 2d line type - integer only
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub struct Line<T: InputType> {
    pub start: Point<T>,
    pub end: Point<T>,
}

impl<T: InputType, IT: Copy + Into<Point<T>>> From<[IT; 2]> for Line<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Line<T>` from `[Into<Point<T>>;2]`
    fn from(l: [IT; 2]) -> Self {
        Self {
            start: l[0].into(),
            end: l[1].into(),
        }
    }
}

impl<T: InputType, IT: Copy + Into<Point<T>>> From<&[IT; 2]> for Line<T> {
    /// Converts to `boostvoronoi::geometry::Line<T>` from `&[Into<Point<T>>;2]`
    #[inline(always)]
    fn from(l: &[IT; 2]) -> Self {
        Self {
            start: l[0].into(),
            end: l[1].into(),
        }
    }
}

impl<T: InputType> Line<T> {
    /// Create a new Line
    #[inline(always)]
    pub fn new(start: Point<T>, end: Point<T>) -> Self {
        Self { start, end }
    }

    /// Cast a `Line<T>` to `Line<T2>`
    #[inline(always)]
    pub fn cast<T2: InputType>(self) -> Line<T2>
    where
        T: AsPrimitive<T2>,
    {
        Line {
            start: self.start.cast::<T2>(),
            end: self.end.cast::<T2>(),
        }
    }
}

impl<T: InputType> From<[T; 4]> for Line<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Line` from `[T;4]`
    /// ```
    /// # use boostvoronoi::geometry::Line;
    /// let a = [0,1,2,3];
    /// let bl = Line::<i32>::from(a);
    /// assert_eq!(bl.start.x,a[0]);
    /// assert_eq!(bl.start.y,a[1]);
    /// assert_eq!(bl.end.x,a[2]);
    /// assert_eq!(bl.end.y,a[3]);
    /// ```
    fn from(l: [T; 4]) -> Self {
        Self {
            start: Point { x: l[0], y: l[1] },
            end: Point { x: l[2], y: l[3] },
        }
    }
}

impl<T: InputType> From<Line<T>> for [T; 4] {
    #[inline]
    /// Converts to `[T;4]` from `boostvoronoi::geometry::Line`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let l = Line::from([0,1,2,3]);
    /// let a = <[i32;4]>::from(l);
    /// assert_eq!(l.start.x,a[0]);
    /// assert_eq!(l.start.y,a[1]);
    /// assert_eq!(l.end.x,a[2]);
    /// assert_eq!(l.end.y,a[3]);
    /// ```
    fn from(l: Line<T>) -> Self {
        [l.start.x, l.start.y, l.end.x, l.end.y]
    }
}

impl<T: InputType> From<&Line<T>> for [T; 4] {
    #[inline]
    /// Converts to `[T;4]` from `&boostvoronoi::geometry::Line`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let l = Line::from([0,1,2,3]);
    /// let a = <[i32;4]>::from(&l);
    /// assert_eq!(l.start.x,a[0]);
    /// assert_eq!(l.start.y,a[1]);
    /// assert_eq!(l.end.x,a[2]);
    /// assert_eq!(l.end.y,a[3]);
    /// ```
    fn from(l: &Line<T>) -> Self {
        [l.start.x, l.start.y, l.end.x, l.end.y]
    }
}

impl<T: InputType> From<&[T; 4]> for Line<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Line` from `&[T;4]`
    /// ```
    /// # use boostvoronoi::geometry::Line;
    /// let a = [0,1,2,3];
    /// let bl = Line::<i32>::from(&a);
    /// assert_eq!(bl.start.x,a[0]);
    /// assert_eq!(bl.start.y,a[1]);
    /// assert_eq!(bl.end.x,a[2]);
    /// assert_eq!(bl.end.y,a[3]);
    /// ```
    fn from(l: &[T; 4]) -> Self {
        Self {
            start: Point { x: l[0], y: l[1] },
            end: Point { x: l[2], y: l[3] },
        }
    }
}

impl From<&Vertex> for [f32; 2] {
    #[inline]
    /// Converts to `[T;2]` from `&boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// # use num_traits::AsPrimitive;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let a = <[f32;2]>::from(&v);
    /// assert_eq!(v.x(),a[0].as_());
    /// assert_eq!(v.y(),a[1].as_());
    /// ```
    fn from(v: &Vertex) -> Self {
        [v.x().as_(), v.y().as_()]
    }
}

impl From<&Vertex> for [f64; 2] {
    #[inline]
    /// Converts to `[T;2]` from `&boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let a = <[f64;2]>::from(&v);
    /// assert_eq!(v.x(),a[0]);
    /// assert_eq!(v.y(),a[1]);
    /// ```
    fn from(v: &Vertex) -> Self {
        [v.x(), v.y()]
    }
}
