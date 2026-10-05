use crate::prelude::*;
use num_traits::AsPrimitive;

impl<T: InputType + cgmath::BaseNum> From<cgmath::Point2<T>> for Point<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Point` from `cgmath::Point2`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let c = cgmath::Point2{x:1,y:2};
    /// let p:Point<i32> = Point::from(c);
    /// assert_eq!(p.x,c.x);
    /// assert_eq!(p.y,c.y);
    /// ```
    fn from(p: cgmath::Point2<T>) -> Self {
        Self { x: p.x, y: p.y }
    }
}

impl<T: InputType + cgmath::BaseNum> From<&cgmath::Point2<T>> for Point<T> {
    #[inline]
    /// Converts to `boostvoronoi::geometry::Point` from `&cgmath::Point2`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let c = cgmath::Point2{x:1,y:2};
    /// let p:Point<i32> = Point::from(&c);
    /// assert_eq!(p.x,c.x);
    /// assert_eq!(p.y,c.y);
    /// ```
    fn from(p: &cgmath::Point2<T>) -> Self {
        Self { x: p.x, y: p.y }
    }
}

impl<T: InputType + cgmath::BaseNum> From<Point<T>> for cgmath::Point2<T> {
    #[inline]
    /// Converts to `geo::Coord` from `boostvoronoi::geometry::Point`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// let p = Point{x:1,y:2};
    /// let c = cgmath::Point2::<i32>::from(p);
    /// assert_eq!(p.x,c.x);
    /// assert_eq!(p.y,c.y);
    /// ```
    fn from(p: Point<T>) -> Self {
        Self { x: p.x, y: p.y }
    }
}

impl<F: cgmath::BaseFloat + 'static> From<&Vertex> for cgmath::Point2<F>
where
    f64: AsPrimitive<F>,
{
    #[inline]
    /// Converts to `cgmath::Point2<f32>` from `&boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// # use num_traits::AsPrimitive;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let p = cgmath::Point2::<f32>::from(&v);
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

impl<F: cgmath::BaseFloat + 'static> From<Vertex> for cgmath::Point2<F>
where
    f64: AsPrimitive<F>,
{
    #[inline]
    /// Converts to `cgmath::Point2` from `boostvoronoi::diagram::Vertex`
    /// ```
    /// # use boostvoronoi::prelude::*;
    /// # use num_traits::AsPrimitive;
    ///
    /// let v = Vertex::new_3(VertexIndex::default(),1.0,2.0,false);
    /// let p = cgmath::Point2::<f32>::from(v.clone());
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
