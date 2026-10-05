use crate::prelude::*;
use num_traits::AsPrimitive;

impl From<&Vertex> for glam::DVec2 {
    #[inline]
    /// Converts to `glam::DVec2` from `&boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let p = glam::DVec2::from(&v);
    /// assert_eq!(v.x(),p.x);
    /// assert_eq!(v.y(),p.y);
    /// ```
    fn from(v: &Vertex) -> Self {
        Self::new(v.x(), v.y())
    }
}

impl From<Vertex> for glam::DVec2 {
    #[inline]
    /// Converts to `glam::DVec2` from `boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// # use num_traits::AsPrimitive;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let p = glam::DVec2::from(v.clone());
    /// assert_eq!(v.x(),p.x.as_());
    /// assert_eq!(v.y(),p.y.as_());
    /// ```
    fn from(v: Vertex) -> Self {
        Self::new(v.x(), v.y())
    }
}

impl From<&Vertex> for glam::Vec2 {
    #[inline]
    /// Converts to `glam::Vec2` from `&boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// # use num_traits::AsPrimitive;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let p = glam::Vec2::from(&v);
    /// assert_eq!(v.x(),p.x.as_());
    /// assert_eq!(v.y(),p.y.as_());
    /// ```
    fn from(v: &Vertex) -> Self {
        Self::new(v.x().as_(), v.y().as_())
    }
}

impl From<Vertex> for glam::Vec2 {
    #[inline]
    /// Converts to `glam::Vec2` from `boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// # use num_traits::AsPrimitive;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let p = glam::Vec2::from(v.clone());
    /// assert_eq!(v.x(),p.x.as_());
    /// assert_eq!(v.y(),p.y.as_());
    /// ```
    fn from(v: Vertex) -> Self {
        Self::new(v.x().as_(), v.y().as_())
    }
}

impl From<glam::IVec2> for Point<i32> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Point<i32>` from `glam::IVec2`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let m = glam::IVec2::new(1,2);
    /// let p:Point<i32> = Point::from(m);
    /// assert_eq!(p.x,m.x);
    /// assert_eq!(p.y,m.y);
    /// ```
    fn from(p: glam::IVec2) -> Self {
        Self { x: p.x, y: p.y }
    }
}

impl From<&glam::IVec2> for Point<i32> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Point<i32>` from `&glam::IVec2`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let m = glam::IVec2::new(1,2);
    /// let p:Point<i32> = Point::from(&m);
    /// assert_eq!(p.x,m.x);
    /// assert_eq!(p.y,m.y);
    /// ```
    fn from(p: &glam::IVec2) -> Self {
        Self { x: p.x, y: p.y }
    }
}

impl From<Point<i32>> for glam::IVec2 {
    #[inline]
    /// Converts to `glam::IVec2` from `boostvoronoi::geometry::Point<i32>`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let p = Point::<i32>{x:1,y:2};
    /// let c = glam::IVec2::from(p);
    /// assert_eq!(p.x,c.x);
    /// assert_eq!(p.y,c.y);
    /// ```
    fn from(p: Point<i32>) -> Self {
        Self::new(p.x, p.y)
    }
}

impl From<Line<i32>> for [glam::IVec2; 2] {
    #[inline]
    /// Converts to `[glam::IVec2;2]` from `boostvoronoi::geometry::Line<i32>`
    /// ```
    /// # use boostvoronoi::geometry::Line;
    /// let bl = Line::<i32>::from([0,1,2,3]);
    /// let ml:[glam::IVec2;2] = bl.into();
    /// assert_eq!(bl.start.x,ml[0].x);
    /// assert_eq!(bl.start.y,ml[0].y);
    /// assert_eq!(bl.end.x,ml[1].x);
    /// assert_eq!(bl.end.y,ml[1].y);
    ///
    /// let ml = [glam::IVec2::new(1,2),glam::IVec2::new(3,4)];
    /// let bl = Line::from(ml);
    /// assert_eq!(bl.start.x,ml[0].x);
    /// assert_eq!(bl.start.y,ml[0].y);
    /// assert_eq!(bl.end.x,ml[1].x);
    /// assert_eq!(bl.end.y,ml[1].y);
    /// ```
    fn from(l: Line<i32>) -> Self {
        [glam::IVec2::from(l.start), glam::IVec2::from(l.end)]
    }
}
