// Boost.Polygon library detail/robust_fpt.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code..

// Ported from C++ boost 1.76.0 to Rust in 2020/2021, 2025 by Eadf (github.com/eadf)

use crate::diagram::{ColorType, Diagram, EdgeIndex, Vertex, VertexIndex};
use crate::{BvError, InputType};

impl Diagram {
    #[inline(always)]
    /// Returns a reference to all the vertices
    pub fn vertices(&self) -> &[Vertex] {
        &self.vertices_
    }

    /// returns the number of vertices in the diagram
    #[inline(always)]
    pub fn num_vertices(&self) -> usize {
        self.vertices_.len()
    }

    #[inline(always)]
    /// Computes an AABB large enough to contain all the vertices
    pub fn vertices_get_aabb<I: InputType>(&self) -> crate::utils::visual_utils::Aabb2 {
        let mut rv = crate::utils::visual_utils::Aabb2::default();
        for v in self.vertices_.iter() {
            rv.update_vertex(v.x(), v.y());
        }
        rv
    }

    /// Returns the vertex associated with the vertex_id
    #[inline(always)]
    pub(crate) fn vertex_(&self, vertex_id: VertexIndex) -> Option<&Vertex> {
        debug_assert_eq!(self.vertices_[vertex_id.usize()].id_, vertex_id);
        self.vertices_.get(vertex_id.usize())
    }

    /// Returns the vertex associated with the vertex_id
    #[inline(always)]
    pub fn vertex(&self, vertex_id: VertexIndex) -> Result<&Vertex, BvError> {
        debug_assert_eq!(self.vertices_[vertex_id.usize()].id_, vertex_id);
        self.vertices_
            .get(vertex_id.usize())
            .ok_or_else(|| BvError::IdError(format!("Vertex id {} does not exists.", vertex_id.0)))
    }

    #[inline(always)]
    /// OR the previous color field value with this new color value
    pub fn vertex_or_color(&mut self, vertex_id: VertexIndex, color: ColorType) {
        self.vertex_or_color_(vertex_id, color)
    }

    /// Returns the color field of the vertex.
    #[inline(always)]
    pub fn vertex_get_color(&self, vertex_id: VertexIndex) -> Option<ColorType> {
        self.vertices_.get(vertex_id.usize()).map(|v| v.get_color())
    }

    /// Overwrites the content of dest with the content of source.
    /// edge_id is compensated accordingly
    #[inline(always)]
    pub(super) fn vertex_copy_(&mut self, dest: VertexIndex, source: VertexIndex) {
        if let Some(mut v) = self.vertices_.get(source.usize()).cloned() {
            v.id_ = VertexIndex(dest.u32());
            self.vertices_[dest.usize()] = v;
        } else {
            debug_assert!(false, "Vertex not found {source:?}");
        }
    }

    #[inline(always)]
    pub(super) fn vertex_set_incident_edge_(
        &mut self,
        vertex_id: VertexIndex,
        edge: Option<EdgeIndex>,
    ) {
        if let Some(vertex) = self.vertices_.get_mut(vertex_id.usize()) {
            vertex.incident_edge_ = edge;
        }
    }

    /// return one of the edges originating at the vertex
    #[inline(always)]
    pub fn vertex_get_incident_edge(&self, vertex_id: VertexIndex) -> Option<EdgeIndex> {
        self.vertex_(vertex_id).and_then(|x| x.incident_edge_)
    }

    /// Set the color of the vertex. This affects only the public bits, not the internal
    #[inline(always)]
    pub(crate) fn vertex_set_color_(&mut self, vertex_id: VertexIndex, color: ColorType) {
        if let Some(vertex) = self.vertices_.get_mut(vertex_id.usize()) {
            let _ = vertex.set_color(color);
        }
    }

    /// Set the color of the vertex. This affects only the public bits, not the internal
    #[inline(always)]
    pub fn vertex_set_color(
        &mut self,
        vertex_id: VertexIndex,
        color: ColorType,
    ) -> Result<(), BvError> {
        self.vertex_set_color_(vertex_id, color);
        Ok(())
    }

    /// returns true if this vertex coincides with a site point
    #[inline]
    pub(crate) fn vertex_is_site_point_(&self, vertex_id: VertexIndex) -> Option<bool> {
        self.vertices_
            .get(vertex_id.usize())
            .map(|cell| cell.is_site_point())
    }

    /// returns true if this vertex coincides with a site point
    #[inline]
    pub fn vertex_is_site_point(&self, vertex_id: VertexIndex) -> Result<bool, BvError> {
        self.vertex_is_site_point_(vertex_id).ok_or_else(|| {
            BvError::IdError(format!(
                "Vertex id {} (probably) does not exists",
                vertex_id.0
            ))
        })
    }

    pub(super) fn vertex_new_2_(&mut self, x: f64, y: f64, is_site_vertex: bool) -> VertexIndex {
        let new_vertex_id = VertexIndex(self.vertices_.len() as u32);
        let new_edge = Vertex::new_3(new_vertex_id, x, y, is_site_vertex);
        self.vertices_.push(new_edge);
        #[cfg(feature = "console_debug")]
        assert_eq!(self.vertices_.len() - 1, new_vertex_id.usize());
        new_vertex_id
    }

    #[inline(always)]
    /// OR the previous color field value with this new color value
    pub(crate) fn vertex_or_color_(&mut self, vertex_id: VertexIndex, color: ColorType) {
        if let Some(vertex) = self.vertices_.get_mut(vertex_id.usize()) {
            vertex.color_ = vertex.or_color(color);
        }
    }
}
