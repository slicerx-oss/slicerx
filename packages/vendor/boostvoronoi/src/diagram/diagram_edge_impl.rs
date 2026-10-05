// Boost.Polygon library detail/robust_fpt.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code..

// Ported from C++ boost 1.76.0 to Rust in 2020/2021, 2025 by Eadf (github.com/eadf)

use crate::diagram::{CellIndex, ColorType, Diagram, Edge, EdgeIndex, SourceIndex, VertexIndex};
use crate::{BvError, InputType, tln};

impl Diagram {
    #[inline(always)]
    /// Creates a range checked EdgeIndex out of an usize.
    /// Panics if index is out of bounds (like slice indexing)
    pub fn edge_index_unchecked(&self, idx: usize) -> EdgeIndex {
        assert!(idx < self.edges_.len(), "edge index out of bounds");
        EdgeIndex(idx as u32)
    }

    #[inline(always)]
    /// Returns a reference to the list of edges
    pub fn edges(&self) -> &[Edge] {
        &self.edges_
    }

    /// returns the number of edges in the diagram
    #[inline(always)]
    pub fn num_edges(&self) -> usize {
        self.edges_.len()
    }

    #[inline(always)]
    /// Returns the edge associated with the edge id
    pub(crate) fn edge_(&self, edge_id: EdgeIndex) -> Option<&Edge> {
        debug_assert_eq!(self.edges_[edge_id.usize()].id_, edge_id);
        self.edges_.get(edge_id.usize())
    }

    /// Returns an edge associated with the edge id
    pub fn edge(&self, edge_id: EdgeIndex) -> Result<&Edge, BvError> {
        self.edge_(edge_id).ok_or_else(|| {
            BvError::IdError(format!("The edge with id:{} does not exist", edge_id.0))
        })
    }

    /// Return the edge represented as a straight line
    /// if the edge does not exist or if it lacks v0 or v1; None will be returned.
    pub(crate) fn edge_as_line_(&self, edge: EdgeIndex) -> Option<[f64; 4]> {
        let v0 = self.edge_get_vertex0_(edge).and_then(|v| self.vertex_(v))?;
        let v1 = self.edge_get_vertex1_(edge).and_then(|v| self.vertex_(v))?;
        Some([v0.x(), v0.y(), v1.x(), v1.y()])
    }

    /// Return the edge represented as a straight line
    /// if the edge does not exist or if it lacks v0 or v1; None will be returned.
    #[inline]
    pub fn edge_as_line(&self, edge_id: EdgeIndex) -> Result<[f64; 4], BvError> {
        self.edge_as_line_(edge_id).ok_or_else(|| {
            BvError::IdError(format!(
                "Edge id:{} (probably) does not exists, or some vertex is missing",
                edge_id.0
            ))
        })
    }

    /// Iterates over all edges, colors each edge as exterior if it has an unbroken primary edge
    /// link connection to an infinite edge.
    pub fn color_exterior_edges(&mut self, external_color: ColorType) {
        for edge_id in self.decoupled_edges_iter() {
            if !self.edge_is_finite_(edge_id).unwrap() {
                self.iterative_color_exterior(edge_id, external_color);
            }
        }
    }

    /// Mark all edges connected to an 'infinite' edge via primary edges as 'external'
    /// You should only call this on edges that you know are infinite. i.e. lacks one or two vertexes
    fn iterative_color_exterior(&mut self, start_edge: EdgeIndex, external_color: ColorType) {
        let mut queue = Vec::with_capacity(self.num_edges() / 100);
        queue.push(start_edge);

        while let Some(edge_id) = queue.pop() {
            // Skip if already colored
            if self.edge_get_color_(edge_id).unwrap() & external_color != 0 {
                continue;
            }

            // Color edge as EXTERNAL
            self.edge_or_color_(edge_id, external_color);

            let v1 = self.edge_get_vertex1_(edge_id);
            if self.edge_get_vertex0_(edge_id).is_some() && v1.is_none() {
                // this edge leads to nowhere, continue to next in queue
                continue;
            }

            // Color twin edge as EXTERNAL
            if let Some(twin) = self.edge_get_twin_(edge_id) {
                self.edge_or_color_(twin, external_color);
            }

            if v1.is_none()
                || v1
                    .and_then(|v1| self.vertex_is_site_point_(v1))
                    .unwrap_or(true)
                || !self.edge_(edge_id).is_some_and(|x| x.is_primary())
            {
                // Don't expand from this edge
                continue;
            }

            // Color the vertex
            if let Some(v) = v1 {
                self.vertex_set_color_(v, external_color);

                // Add all incident edges to queue
                if let Some(incident_edge) = self.vertex_get_incident_edge(v) {
                    for e in self.edge_rot_next_edges(incident_edge) {
                        if self.edge_get_color_(e).unwrap() & external_color == 0 {
                            // only push unpainted candidate edges.
                            queue.push(e);
                        }
                    }
                }
            }
        }
    }

    /// Create and insert a new edge
    fn create_and_insert_edge(
        &mut self,
        cell_id: CellIndex,
        is_linear: bool,
        is_primary: bool,
    ) -> EdgeIndex {
        let new_edge_id = EdgeIndex(self.edges_.len() as u32);
        let new_edge = Edge::new_(new_edge_id, cell_id, is_linear, is_primary);
        self.edges_.push(new_edge);
        tln!("Created and inserted new edge : e={}", new_edge_id.0);
        new_edge_id
    }

    /// Overwrites the content of dest with the content of source.
    /// edge_id of the new dest is corrected
    pub(crate) fn edge_copy_(&mut self, dest: EdgeIndex, source: EdgeIndex) {
        let mut e = self.edges_[source.usize()];
        e.id_ = dest;
        self.edges_[dest.usize()] = e;
    }

    #[inline]
    /// Returns the color field of the edge.
    pub(crate) fn edge_get_color_(&self, edge_id: EdgeIndex) -> Option<ColorType> {
        self.edge_(edge_id).map(|edge| edge.get_color())
    }

    #[inline]
    /// Returns the color field of the edge.
    pub fn edge_get_color(&self, edge_id: EdgeIndex) -> Result<ColorType, BvError> {
        self.edge_get_color_(edge_id).ok_or_else(|| {
            BvError::IdError(format!("edge id {} (probably) does not exists", edge_id.0))
        })
    }

    #[inline]
    /// Sets the color field with new value
    pub(crate) fn edge_set_color_(&mut self, edge_id: EdgeIndex, color: ColorType) {
        if let Some(edge) = self.edges_.get_mut(edge_id.usize()) {
            let _ = edge.set_color(color);
        }
    }

    #[inline]
    /// Sets the color field with new value
    // todo: raise proper error when id not found
    pub fn edge_set_color(&mut self, edge_id: EdgeIndex, color: ColorType) -> Result<(), BvError> {
        self.edge_set_color_(edge_id, color);
        Ok(())
    }

    #[inline]
    /// OR the previous color field value with this new color value
    pub(crate) fn edge_or_color_(&mut self, edge_id: EdgeIndex, color: ColorType) {
        if let Some(edge) = self.edges_.get_mut(edge_id.usize()) {
            let _ = edge.or_color(color);
        }
    }

    #[inline]
    /// OR the previous color field value with this new color value
    // Todo: add error on edge index problems
    pub fn edge_or_color(&mut self, edge_id: EdgeIndex, color: ColorType) -> Result<(), BvError> {
        self.edge_or_color_(edge_id, color);
        Ok(())
    }

    #[inline]
    pub(crate) fn edge_set_twin_(&mut self, edge_id: EdgeIndex, twin_id: EdgeIndex) {
        if let Some(edge) = self.edges_.get_mut(edge_id.usize()) {
            edge.twin_ = Some(twin_id);
        }
    }

    #[inline]
    pub(crate) fn edge_get_twin_(&self, edge_id: EdgeIndex) -> Option<EdgeIndex> {
        if let Some(edge) = self.edges_.get(edge_id.usize()) {
            return edge.twin_();
        }
        None
    }

    #[inline]
    pub fn edge_get_twin(&self, edge_id: EdgeIndex) -> Result<EdgeIndex, BvError> {
        self.edge_get_twin_(edge_id)
            .ok_or_else(|| BvError::IdError(format!("Edge {} does not have a twin", edge_id.0)))
    }

    #[inline]
    pub(super) fn edge_get_next_(&self, edge_id: EdgeIndex) -> Option<EdgeIndex> {
        self.edges_.get(edge_id.usize()).and_then(|e| e.next_())
    }

    #[inline]
    pub fn edge_get_next(&self, edge_id: EdgeIndex) -> Result<EdgeIndex, BvError> {
        self.edge_get_next_(edge_id).ok_or_else(|| {
            BvError::IdError(format!("Edge {} did not have any next edge", edge_id.0))
        })
    }

    #[inline]
    pub(super) fn edge_get_prev_(&self, edge_id: EdgeIndex) -> Option<EdgeIndex> {
        self.edges_.get(edge_id.usize()).and_then(|e| e.prev_())
    }

    #[inline]
    pub fn edge_get_prev(&self, edge_id: EdgeIndex) -> Result<EdgeIndex, BvError> {
        self.edge_get_prev_(edge_id).ok_or_else(|| {
            BvError::IdError(format!("Edge {} did not have any prev edge", edge_id.0))
        })
    }

    /// Returns true if the edge is finite (segment, parabolic arc).
    /// Returns false if the edge is infinite (ray, line).
    #[inline]
    pub(crate) fn edge_is_finite_(&self, edge_id: EdgeIndex) -> Option<bool> {
        Some(self.edge_get_vertex0_(edge_id).is_some() && self.edge_get_vertex1_(edge_id).is_some())
    }

    /// Returns true if the edge is finite (segment, parabolic arc).
    /// Returns false if the edge is infinite (ray, line).
    #[inline]
    pub fn edge_is_finite(&self, edge_id: EdgeIndex) -> Result<bool, BvError> {
        self.edge_is_finite_(edge_id)
            .ok_or_else(|| BvError::IdError(format!("Edge id {} doesn't exists", edge_id.0)))
    }

    /// Returns true if the edge is infinite (ray, line).
    /// Returns false if the edge is finite (segment, parabolic arc).
    #[inline]
    pub(crate) fn edge_is_infinite_(&self, edge_id: EdgeIndex) -> Option<bool> {
        Some(!self.edge_is_finite_(edge_id)?)
    }

    /// Returns true if the edge is infinite (ray, line).
    /// Returns false if the edge is finite (segment, parabolic arc).
    #[inline]
    pub fn edge_is_infinite(&self, edge_id: EdgeIndex) -> Result<bool, BvError> {
        self.edge_is_infinite_(edge_id)
            .ok_or_else(|| BvError::IdError(format!("Edge id {} doesn't exists", edge_id.0)))
    }

    /// Remove degenerate edge.
    pub(super) fn remove_edge_(&mut self, edge: EdgeIndex) {
        // Update the endpoints of the incident edges to the second vertex.
        let vertex = self.edge_get_vertex0_(edge);
        let mut updated_edge = self
            .edge_get_twin_(edge)
            .and_then(|e| self.edge_rot_next(e));

        while updated_edge != self.edge_get_twin_(edge) {
            if let Some(u_edge) = updated_edge {
                self.edge_set_vertex0_(u_edge, vertex);
                updated_edge = self.edge_rot_next(u_edge);
            } else {
                break;
            }
        }
        let edge1 = edge;
        let edge2 = self.edge_get_twin_(edge);

        if let Some(edge2) = edge2 {
            // Update prev/next pointers for the incident edges.
            if let Some(next) = self.edge_rot_next(edge1) {
                //edge1_rot_next->twin()->next(edge2_rot_prev);
                let _ = self
                    .edge_get_twin_(next)
                    .map(|t| self.edge_set_next_(t, self.edge_rot_prev(edge2)));

                //edge2_rot_prev->prev(edge1_rot_next->twin());
                let _ = self
                    .edge_rot_prev(edge2)
                    .map(|p| self.edge_set_prev_(p, self.edge_get_twin_(next)));
            }
        }

        //edge1_rot_prev->prev(edge2_rot_next->twin());
        let _ = self.edge_rot_prev(edge1).map(|e| {
            self.edge_set_prev_(
                e,
                edge2
                    .and_then(|e| self.edge_rot_next(e))
                    .and_then(|n| self.edge_get_twin_(n)),
            )
        });

        if let Some(nt) = edge2
            .and_then(|e| self.edge_rot_next(e))
            .and_then(|n| self.edge_get_twin_(n))
        {
            //edge2_rot_next->twin()->next(edge1_rot_prev);
            self.edge_set_next_(nt, self.edge_rot_prev(edge1));
        }
    }

    pub(super) fn edge_set_vertex0_(&mut self, edge_id: EdgeIndex, vertex_id: Option<VertexIndex>) {
        if let Some(edge) = self.edges_.get_mut(edge_id.usize()) {
            edge.vertex_ = vertex_id;
        }
    }

    #[inline]
    pub(crate) fn edge_get_vertex0_(&self, edge_id: EdgeIndex) -> Option<VertexIndex> {
        self.edges_.get(edge_id.usize()).and_then(|x| x.vertex0())
    }

    #[inline]
    // todo: add error when edge is not found
    pub fn edge_get_vertex0(&self, edge_id: EdgeIndex) -> Result<Option<VertexIndex>, BvError> {
        Ok(self.edge_get_vertex0_(edge_id))
    }

    #[inline]
    pub(crate) fn edge_get_vertex1_(&self, edge_id: EdgeIndex) -> Option<VertexIndex> {
        self.edge_get_twin_(edge_id)
            .and_then(|twin| self.edge_get_vertex0_(twin))
    }

    #[inline]
    // todo: add error when edge is not found
    pub fn edge_get_vertex1(&self, edge_id: EdgeIndex) -> Result<Option<VertexIndex>, BvError> {
        Ok(self.edge_get_vertex1_(edge_id))
    }

    #[inline]
    pub(super) fn edge_set_prev_(&mut self, edge_id: EdgeIndex, prev_id: Option<EdgeIndex>) {
        if let Some(edge) = self.edges_.get_mut(edge_id.usize()) {
            edge.prev_ccw_ = prev_id;
        }
    }

    #[inline]
    pub(super) fn edge_set_next_(&mut self, edge_id: EdgeIndex, next_id: Option<EdgeIndex>) {
        if let Some(edge) = self.edges_.get_mut(edge_id.usize()) {
            edge.next_ccw_ = next_id;
        }
    }

    #[inline]
    /// Returns a pointer to the rotation next edge
    /// over the starting point of the half-edge.
    pub fn edge_rot_next(&self, edge_id: EdgeIndex) -> Option<EdgeIndex> {
        self.edge_get_prev_(edge_id)
            .and_then(|p| self.edge_get_twin_(p))
    }

    #[inline]
    /// Returns a pointer to the rotation previous edge
    /// over the starting point of the half-edge.
    pub fn edge_rot_prev(&self, edge_id: EdgeIndex) -> Option<EdgeIndex> {
        self.edge_get_twin_(edge_id)
            .and_then(|twin| self.edge_get_next_(twin))
    }

    /// Insert a new half-edge into the output data structure.
    /// Takes as input left and right sites that form a new bisector.
    /// Returns a pair of pointers to new half-edges.
    pub(crate) fn insert_new_edge_2_<I: InputType>(
        &mut self,
        site1: crate::site_event::SiteEvent<I>,
        site2: crate::site_event::SiteEvent<I>,
    ) -> (EdgeIndex, EdgeIndex) {
        //tln!("-> insert_new_edge_2()");
        //tln!("site1:{:?}\nsite2:{:?}", &site1, &site2);
        // Get sites' indexes.
        let site1_index = site1.sorted_index();
        let site2_index = site2.sorted_index();

        let is_linear = crate::site_event::SiteEvent::is_linear_edge(&site1, &site2);
        let is_primary = crate::site_event::SiteEvent::is_primary_edge(&site1, &site2);

        // Create a new half-edge that belongs to the first site.
        let edge1_id = self.create_and_insert_edge(CellIndex(site1_index), is_linear, is_primary);

        // Create a new half-edge that belongs to the second site.
        let edge2_id = self.create_and_insert_edge(CellIndex(site2_index), is_linear, is_primary);

        // Add the initial cell during the first edge insertion.
        if self.cells_.is_empty() {
            let _ = self.make_new_cell_with_category_(
                CellIndex(site1_index),
                SourceIndex(site1.initial_index()),
                site1.source_category(),
            );
        }

        // The second site represents a new site during site event
        // processing. Add a new cell to the cell records.
        let _ = self.make_new_cell_with_category_(
            CellIndex(site2_index),
            SourceIndex(site2.initial_index()),
            site2.source_category(),
        );

        // Set up pointers to cells. Todo! is this needed? Didn't we do this already?
        self.edge_set_cell_(edge1_id, CellIndex(site1_index));
        self.edge_set_cell_(edge2_id, CellIndex(site2_index));

        // Set up twin pointers.
        self.edge_set_twin_(edge1_id, edge2_id);
        self.edge_set_twin_(edge2_id, edge1_id);

        //tln!("edge1: {:?}", self.get_edge_(edge1_id).get());
        //tln!("edge2: {:?}", self.get_edge_(edge2_id).get());
        //tln!("edges.len():{}", self.edges_.len());
        (edge1_id, edge2_id)
    }

    /// Insert a new half-edge into the output data structure with the
    /// start at the point where two previously added half-edges intersect.
    /// Takes as input two sites that create a new bisector, circle event
    /// that corresponds to the intersection point of the two old half-edges,
    /// pointers to those half-edges. Half-edges' direction goes out of the
    /// new Voronoi vertex point. Returns a pair of pointers to a new half-edges.
    pub(crate) fn insert_new_edge_5_<I: InputType>(
        &mut self,
        site1: crate::site_event::SiteEvent<I>,
        site3: crate::site_event::SiteEvent<I>,
        circle: &crate::circle_event::CircleEvent,
        edge12_id: EdgeIndex,
        edge23_id: EdgeIndex,
    ) -> (EdgeIndex, EdgeIndex) {
        /*tln!("-> insert_new_edge_5()");
        tln!(
            "site1:{:?}\nsite3:{:?}\ncircle:{:?}\nedge12_id:{:?}\nedge23_id{:?}\n",
            &site1,
            &site3,
            &circle,
            edge12_id,
            edge23_id
        );*/
        tln!("new vertex@{:?}", circle);

        let is_linear = crate::site_event::SiteEvent::<I>::is_linear_edge(&site1, &site3);
        let is_primary = crate::site_event::SiteEvent::<I>::is_primary_edge(&site1, &site3);

        // Add a new half-edge.
        let new_edge1_id =
            self.create_and_insert_edge(CellIndex(site1.sorted_index()), is_linear, is_primary);

        // Add a new half-edge.
        let new_edge2_id =
            self.create_and_insert_edge(CellIndex(site3.sorted_index()), is_linear, is_primary);

        // Add a new Voronoi vertex.
        let new_vertex_id = self.vertex_new_2_(circle.x(), circle.y(), circle.is_site_point());

        // Update vertex pointers of the old edges.
        self.edge_set_vertex0_(edge12_id, Some(new_vertex_id));
        self.edge_set_vertex0_(edge23_id, Some(new_vertex_id));

        // Update twin pointers.
        self.edge_set_twin_(new_edge1_id, new_edge2_id);
        self.edge_set_twin_(new_edge2_id, new_edge1_id);

        // Update vertex pointer.
        //new_edge2.vertex0(&new_vertex);
        self.edge_set_vertex0_(new_edge2_id, Some(new_vertex_id));

        // Update Voronoi prev/next pointers.
        //edge12->prev(&new_edge1);
        self.edge_set_prev_(edge12_id, Some(new_edge1_id));

        //new_edge1.next(edge12);
        self.edge_set_next_(new_edge1_id, Some(edge12_id));

        //edge12->twin()->next(edge23);
        let edge12_twin_id = self.edge_get_twin_(edge12_id);

        let _ = edge12_twin_id
            .map(|edge12_twin_id| self.edge_set_next_(edge12_twin_id, Some(edge23_id)));

        //edge23->prev(edge12->twin());
        self.edge_set_prev_(edge23_id, edge12_twin_id);

        //edge23->twin()->next(&new_edge2);
        let edge23_twin_id = self.edge_get_twin_(edge23_id);
        let _ = edge23_twin_id
            .map(|edge23_twin_id| self.edge_set_next_(edge23_twin_id, Some(new_edge2_id)));

        //new_edge2.prev(edge23->twin());
        self.edge_set_prev_(new_edge2_id, edge23_twin_id);

        //tln!("edge12: {:?}", self.get_edge_(edge12_id).get());
        //tln!("edge23: {:?}", self.get_edge_(edge23_id).get());
        //tln!("edges.len():{}", self.edges_.len());
        // Return a pointer to the new half-edge.
        (new_edge1_id, new_edge2_id)
    }
}
