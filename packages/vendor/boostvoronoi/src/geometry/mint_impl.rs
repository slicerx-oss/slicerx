use crate::prelude::*;
use num_traits::AsPrimitive;

impl<T: InputType> From<Line<T>> for [mint::Point2<T>; 2] {
    #[inline]
    /// Converts to `[mint::Point2<T>;2]` from `boostvoronoi::geometry::Line`
    /// ```
    /// # use boostvoronoi::geometry::Line;
    /// let bl = Line::<i32>::from([0,1,2,3]);
    /// let ml:[mint::Point2<i32>;2] = bl.into();
    /// assert_eq!(bl.start.x,ml[0].x);
    /// assert_eq!(bl.start.y,ml[0].y);
    /// assert_eq!(bl.end.x,ml[1].x);
    /// assert_eq!(bl.end.y,ml[1].y);
    ///
    /// let ml = [mint::Point2::<i32>::from([1,2]),mint::Point2::from([3,4])];
    /// let bl = Line::<i32>::from(ml);
    /// assert_eq!(bl.start.x,ml[0].x);
    /// assert_eq!(bl.start.y,ml[0].y);
    /// assert_eq!(bl.end.x,ml[1].x);
    /// assert_eq!(bl.end.y,ml[1].y);
    /// ```
    fn from(l: Line<T>) -> Self {
        [mint::Point2::from(l.start), mint::Point2::from(l.end)]
    }
}

impl<I: InputType> mint::IntoMint for Line<I> {
    type MintType = [mint::Point2<I>; 2];
}

impl<I: InputType> mint::IntoMint for Point<I> {
    type MintType = mint::Point2<I>;
}

impl<I: InputType> From<Point<I>> for mint::Point2<I> {
    #[inline]
    /// Converts to `mint::Point2` from `boostvoronoi::geometry::Point`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let p:Point<i32> = Point{x:1, y:2};
    /// let m = mint::Point2::from(p);
    ///
    /// assert_eq!(p.x,m.x);
    /// assert_eq!(p.y,m.y);
    /// ```
    fn from(p: Point<I>) -> Self {
        Self::from([p.x, p.y])
    }
}

impl<I: InputType> From<mint::Point2<I>> for Point<I> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Point` from `mint::Point2`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let m = mint::Point2{x:1,y:2};
    /// let p:Point<i32> = Point::from(m);
    /// assert_eq!(p.x,m.x);
    /// assert_eq!(p.y,m.y);
    /// ```
    fn from(p: mint::Point2<I>) -> Self {
        Self { x: p.x, y: p.y }
    }
}

impl<I: InputType> From<&mint::Point2<I>> for Point<I> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Point` from `&mint::Point2`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let m = mint::Point2{x:1,y:2};
    /// let p:Point<i32> = Point::from(&m);
    /// assert_eq!(p.x,m.x);
    /// assert_eq!(p.y,m.y);
    /// ```
    fn from(p: &mint::Point2<I>) -> Self {
        Self { x: p.x, y: p.y }
    }
}

impl mint::IntoMint for &Vertex {
    type MintType = mint::Point2<f64>;
}

impl mint::IntoMint for Vertex {
    type MintType = mint::Point2<f64>;
}

impl From<&Vertex> for mint::Point2<f64> {
    #[inline]
    /// Converts to `mint::Point2<f64>` from `&boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let p = mint::Point2::<f64>::from(&v);
    /// assert_eq!(v.x(),p.x);
    /// assert_eq!(v.y(),p.y);
    /// ```
    fn from(v: &Vertex) -> Self {
        Self { x: v.x(), y: v.y() }
    }
}

impl From<Vertex> for mint::Point2<f64> {
    #[inline]
    /// Converts to `mint::Point2<f64>` from `boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let p = mint::Point2::<f64>::from(v.clone());
    /// assert_eq!(v.x(),p.x);
    /// assert_eq!(v.y(),p.y);
    /// ```
    fn from(v: Vertex) -> Self {
        Self { x: v.x(), y: v.y() }
    }
}

impl From<Vertex> for mint::Point2<f32> {
    #[inline]
    /// Converts to `mint::Point2<f32>` from `boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// # use num_traits::AsPrimitive;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let p = mint::Point2::<f32>::from(v.clone());
    /// assert_eq!(v.x(),p.x.as_());
    /// assert_eq!(v.y(),p.y.as_());
    /// ```
    fn from(v: Vertex) -> Self {
        Self {
            x: v.x().as_(),
            y: v.y().as_(),
        }
    }
}

impl From<&Vertex> for mint::Point2<f32> {
    #[inline]
    /// Converts to `mint::Point2<f32>` from `&boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// # use num_traits::AsPrimitive;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let p = mint::Point2::<f32>::from(&v);
    /// assert_eq!(v.x(),p.x.as_());
    /// assert_eq!(v.y(),p.y.as_());
    /// ```
    fn from(v: &Vertex) -> Self {
        Self {
            x: v.x().as_(),
            y: v.y().as_(),
        }
    }
}
