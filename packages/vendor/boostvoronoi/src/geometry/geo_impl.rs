use crate::prelude::*;
use num_traits::AsPrimitive;

impl<T: InputType + geo::CoordNum> From<geo::Coord<T>> for Point<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Point` from `geo::Coord`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let c = geo::Coord{x:1,y:2};
    /// let p:Point<i32> = Point::from(c);
    /// assert_eq!(p.x, c.x);
    /// assert_eq!(p.y, c.y);
    /// ```
    fn from(c: geo::Coord<T>) -> Self {
        Self { x: c.x, y: c.y }
    }
}

impl<T: InputType + geo::CoordNum> From<&geo::Coord<T>> for Point<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Point` from `&geo::Coord`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let c = geo::Coord{x:1,y:2};
    /// let p:Point<i32> = Point::from(&c);
    /// assert_eq!(p.x, c.x);
    /// assert_eq!(p.y, c.y);
    /// ```
    fn from(c: &geo::Coord<T>) -> Self {
        Self { x: c.x, y: c.y }
    }
}

impl<T: InputType + geo::CoordNum> From<Point<T>> for geo::Coord<T> {
    #[inline]
    /// Converts to `geo::Coord` from `boostvoronoi::geometry::Point`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let p = Point{x:1,y:2};
    /// let c = geo::Coord::<i32>::from(p);
    /// assert_eq!(p.x, c.x);
    /// assert_eq!(p.y, c.y);
    /// ```
    fn from(p: Point<T>) -> Self {
        Self { x: p.x, y: p.y }
    }
}

impl<T: InputType + geo::CoordNum> From<&geo::Point<T>> for Point<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Point` from `&geo::Point`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let g = geo::Point::new(1,2);
    /// let p:Point<i32> = Point::from(&g);
    /// assert_eq!(p.x, g.x());
    /// assert_eq!(p.y, g.y());
    /// ```
    fn from(p: &geo::Point<T>) -> Self {
        Self { x: p.x(), y: p.y() }
    }
}

impl<T: InputType + geo::CoordNum> From<geo::Point<T>> for Point<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Point` from `geo::Point`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let g = geo::Point::new(1,2);
    /// let p:Point<i32> = Point::from(g.clone());
    /// assert_eq!(p.x, g.x());
    /// assert_eq!(p.y, g.y());
    /// ```
    fn from(p: geo::Point<T>) -> Self {
        Self { x: p.x(), y: p.y() }
    }
}

impl<T: InputType + geo::CoordNum> From<Point<T>> for geo::Point<T> {
    #[inline]
    /// Converts to `geo::Point` from `boostvoronoi::geometry::Point`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let p = Point{x:1,y:2};
    /// let g = geo::Point::<i32>::from(p);
    /// assert_eq!(p.x, g.x());
    /// assert_eq!(p.y, g.y());
    /// ```
    fn from(p: Point<T>) -> Self {
        Self::new(p.x, p.y)
    }
}

impl<T: InputType + geo::CoordNum> From<&Point<T>> for geo::Coord<T> {
    #[inline]
    /// Converts to `geo::Coord` from `&boostvoronoi::geometry::Point`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let p = Point{x:1,y:2};
    /// let c = geo::Coord::<i32>::from(&p);
    /// assert_eq!(p.x,c.x);
    /// assert_eq!(p.y,c.y);
    /// ```
    fn from(p: &Point<T>) -> Self {
        Self { x: p.x, y: p.y }
    }
}

impl<F: geo::CoordFloat + 'static> From<&Vertex> for geo::Coord<F>
where
    f64: AsPrimitive<F>,
{
    #[inline]
    /// Converts to `geo::Coord` from `&boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// # use num_traits::AsPrimitive;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let c = geo::Coord::<f32>::from(&v);
    /// assert_eq!(v.x(),c.x.as_());
    /// assert_eq!(v.y(),c.y.as_());
    /// ```
    fn from(v: &Vertex) -> Self {
        Self {
            x: v.x().as_(),
            y: v.y().as_(),
        }
    }
}

impl<F: geo::CoordFloat + 'static> From<Vertex> for geo::Coord<F>
where
    f64: AsPrimitive<F>,
{
    #[inline]
    /// Converts to `geo::Coord` from `boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// # use num_traits::AsPrimitive;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let c = geo::Coord::<f32>::from(v.clone());
    /// assert_eq!(v.x(),c.x.as_());
    /// assert_eq!(v.y(),c.y.as_());
    /// ```
    fn from(v: Vertex) -> Self {
        Self {
            x: v.x().as_(),
            y: v.y().as_(),
        }
    }
}

impl<F: geo::CoordFloat + 'static> From<&Vertex> for geo::Point<F>
where
    f64: AsPrimitive<F>,
{
    #[inline]
    /// Converts to `geo::Point` from `&boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// # use num_traits::AsPrimitive;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let c = geo::Point::<f32>::from(&v);
    /// assert_eq!(v.x(),c.x().as_());
    /// assert_eq!(v.y(),c.y().as_());
    /// ```
    fn from(v: &Vertex) -> Self {
        Self::new(v.x().as_(), v.y().as_())
    }
}

impl<F: geo::CoordFloat + 'static> From<Vertex> for geo::Point<F>
where
    f64: AsPrimitive<F>,
{
    #[inline]
    /// Converts to `geo::Point` from `boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// # use num_traits::AsPrimitive;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let p = geo::Point::<f32>::from(v.clone());
    /// assert_eq!(v.x(),p.x().as_());
    /// assert_eq!(v.y(),p.y().as_());
    /// ```
    fn from(v: Vertex) -> Self {
        Self::new(v.x().as_(), v.y().as_())
    }
}

impl<T: InputType + geo::CoordNum> From<Line<T>> for geo::Line<T> {
    #[inline]
    /// Converts to `geo::Line` from `boostvoronoi::geometry::Line`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let bl = Line::from([0,1,2,3]);
    /// let gl = geo::Line::<i32>::from(bl);
    /// assert_eq!(bl.start.x,gl.start.x);
    /// assert_eq!(bl.start.y,gl.start.y);
    /// assert_eq!(bl.end.x,gl.end.x);
    /// assert_eq!(bl.end.y,gl.end.y);
    /// ```
    fn from(line: Line<T>) -> Self {
        Self {
            start: geo::Coord::from(line.start),
            end: geo::Coord::from(line.end),
        }
    }
}

impl<T: InputType + geo::CoordNum> From<geo::Line<T>> for Line<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Line` from `geo::Line`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let gl = geo::Line::from([(0,1),(2,3)]);
    /// let bl = Line::<i32>::from(gl);
    /// assert_eq!(bl.start.x,gl.start.x);
    /// assert_eq!(bl.start.y,gl.start.y);
    /// assert_eq!(bl.end.x,gl.end.x);
    /// assert_eq!(bl.end.y,gl.end.y);
    /// ```
    fn from(line: geo::Line<T>) -> Self {
        Self {
            start: Point::from(line.start),
            end: Point::from(line.end),
        }
    }
}

impl<T: InputType + geo::CoordNum> From<&geo::Line<T>> for Line<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Line` from `&geo::Line`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let gl = geo::Line::from([(0,1),(2,3)]);
    /// let bl = Line::<i32>::from(&gl);
    /// assert_eq!(bl.start.x,gl.start.x);
    /// assert_eq!(bl.start.y,gl.start.y);
    /// assert_eq!(bl.end.x,gl.end.x);
    /// assert_eq!(bl.end.y,gl.end.y);
    /// ```
    fn from(line: &geo::Line<T>) -> Self {
        Self {
            start: Point::from(line.start),
            end: Point::from(line.end),
        }
    }
}
