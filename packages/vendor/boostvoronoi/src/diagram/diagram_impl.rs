// Boost.Polygon library detail/robust_fpt.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code..

// Ported from C++ boost 1.76.0 to Rust in 2020/2021, 2025 by Eadf (github.com/eadf)

use super::{Cell, CellIndex, Diagram, Edge, EdgeIndex, SourceIndex, Vertex, VertexIndex};
use crate::{InputType, tln};

impl SourceIndex {
    pub const INVALID: Self = Self(u32::MAX);
    pub fn usize(self) -> usize {
        self.0 as usize
    }

    pub fn u32(self) -> u32 {
        self.0
    }
}

impl Diagram {
    pub(crate) fn new(input_size: usize) -> Self {
        Self {
            cells_: Vec::<Cell>::with_capacity(input_size),
            vertices_: Vec::<Vertex>::with_capacity(input_size),
            edges_: Vec::<Edge>::with_capacity(input_size * 2),
        }
    }

    /// clear the list of cells, vertices and edges
    pub fn clear(&mut self) {
        self.cells_.clear();
        self.vertices_.clear();
        self.edges_.clear();
    }

    /// reserves space for a number of additional sites
    #[inline(always)]
    pub fn reserve_(&mut self, additional_sites: usize) {
        self.cells_.reserve(additional_sites);
        self.vertices_.reserve(additional_sites << 1);
        self.edges_
            .reserve((additional_sites << 2) + (additional_sites << 1));
    }

    #[inline(always)]
    pub(crate) fn process_single_site_<I: InputType>(
        &mut self,
        site: &crate::site_event::SiteEvent<I>,
    ) {
        let _ = self.make_new_cell_with_category_(
            CellIndex(site.sorted_index()),
            SourceIndex(site.initial_index()),
            site.source_category(),
        );
    }

    /// Make sure the diagram is consistent. Removes degenerate edges, connects incident
    /// edges etc. etc
    pub(crate) fn finish(&mut self) {
        // Remove degenerate edges.
        #[cfg(feature = "console_debug")]
        self.debug_print_edges("b4 degenerate");

        if !self.edges_.is_empty() {
            let mut last_edge = EdgeIndex(0);
            let mut it = last_edge;
            let edges_end: u32 = self.edges_.len() as u32;

            //let mut edges_to_erase: Vec<usize> = Vec::new();
            while it.u32() < edges_end {
                let is_equal = {
                    let v1 = self.edge_get_vertex0_(it).and_then(|v| self.vertex_(v));
                    let v2 = self.edge_get_vertex1_(it).and_then(|v| self.vertex_(v));
                    //tln!("looking at edge:{}, v1={:?}, v2={:?}", it, v1, v2);
                    v1.is_some()
                        && v2.is_some()
                        && v1.unwrap().vertex_equality_predicate_eq(v2.unwrap())
                };

                if is_equal {
                    self.remove_edge_(it);
                } else {
                    if it != last_edge {
                        //edge_type * e1 = &(*last_edge = *it);
                        self.edge_copy_(last_edge, it);
                        //edge_type * e2 = &(*(last_edge + 1) = *(it + 1));
                        self.edge_copy_(EdgeIndex(last_edge.u32() + 1), EdgeIndex(it.u32() + 1));
                        let e1 = last_edge;
                        let e2 = EdgeIndex(last_edge.u32() + 1);

                        // e1->twin(e2);
                        self.edge_set_twin_(e1, e2);

                        // e2->twin(e1);
                        self.edge_set_twin_(e2, e1);

                        if let Some(e1p) = self.edge_get_prev_(e1) {
                            // e1 -> prev() -> next(e1);
                            self.edge_set_next_(e1p, Some(e1));

                            //e2 -> next() -> prev(e2);
                            let _ = self
                                .edge_get_next_(e2)
                                .map(|n| self.edge_set_prev_(n, Some(e2)));
                        }
                        let e2_prev = self.edge_get_prev_(e2);
                        if let Some(e2_prev) = e2_prev {
                            //e1 -> next() -> prev(e1);
                            let _ = self
                                .edge_get_next_(e1)
                                .map(|n| self.edge_set_prev_(n, Some(e1)));

                            //e2 -> prev() -> next(e2);
                            self.edge_set_next_(e2_prev, Some(e2));
                        }
                    }
                    last_edge = EdgeIndex(last_edge.u32() + 2);
                }
                it = EdgeIndex(it.u32() + 2);
            }

            // Remove all elements from last_edge to the end
            self.edges_.truncate(last_edge.usize());
        }
        #[cfg(feature = "console_debug")]
        self.debug_print_edges("after degenerate");
        tln!();

        // Set up incident edge pointers for cells and vertices.
        for edge_it in self.decoupled_edges_iter() {
            if let Some(cell) = self.edge_get_cell_(edge_it) {
                if self.cell_get_incident_edge_(cell).is_none() {
                    self.cell_set_incident_edge_(cell, Some(edge_it));
                }
            }
            if let Some(vertex) = self.edge_get_vertex0_(edge_it) {
                self.vertex_set_incident_edge_(vertex, Some(edge_it));
            }
        }

        #[cfg(feature = "console_debug")]
        for (i, v) in self.vertices_.iter().enumerate() {
            tln!(
                "vertex #{} contains a point: ({:.12}, {:.12}) ie:{}",
                i,
                v.x(),
                v.y(),
                v.get_incident_edge_()
                    .map_or("-".to_string(), |x| x.0.clone().to_string())
            );
        }

        tln!("vertices b4 degenerate {}", self.num_vertices());
        // Remove degenerate vertices by compacting the list
        if !self.vertices_.is_empty() {
            let mut write_idx = 0usize;

            for read_vertex in self.decoupled_vertices_iter() {
                // Skip degenerate vertices (those with no incident edge)
                if self.vertex_get_incident_edge(read_vertex).is_none() {
                    continue;
                }
                let write_vertex = VertexIndex(write_idx as u32);
                // If we're compacting, copy vertex data and update all its edges
                if write_vertex != read_vertex {
                    self.vertex_copy_(write_vertex, read_vertex);

                    // Update all edges around this vertex to point to new location
                    if let Some(start_edge) = self.vertex_get_incident_edge(write_vertex) {
                        let mut edge = start_edge;
                        loop {
                            self.edge_set_vertex0_(edge, Some(write_vertex));
                            match self.edge_rot_next(edge) {
                                Some(next_edge) if next_edge != start_edge => {
                                    edge = next_edge;
                                }
                                _ => break, // Either None or back to start
                            }
                        }
                    }
                }
                write_idx += 1;
            }
            // Truncate the list to remove trailing degenerate vertices
            self.vertices_.truncate(write_idx);
        }
        tln!("vertices after degenerate {}", self.vertices_.len());

        // Set up next/prev pointers for infinite edges.
        if self.vertices_.is_empty() {
            if !self.edges_.is_empty() {
                // Update prev/next pointers for the line edges.
                let mut edge_it = self.decoupled_edges_iter();

                let mut edge1 = edge_it.next();
                if let Some(e1) = edge1 {
                    self.edge_set_next_(e1, edge1);
                    self.edge_set_prev_(e1, edge1);
                }
                edge1 = edge_it.next();
                let mut edge_it_value = edge_it.next();
                while edge_it_value.is_some() {
                    let edge2 = edge_it_value;
                    edge_it_value = edge_it.next();
                    //dbg!(edge1.unwrap(),edge2.unwrap());

                    if let Some(edge1) = edge1 {
                        self.edge_set_next_(edge1, edge2);
                        self.edge_set_prev_(edge1, edge2);
                    }
                    if let Some(edge2) = edge2 {
                        self.edge_set_next_(edge2, edge1);
                        self.edge_set_prev_(edge2, edge1);
                    }
                    edge1 = edge_it_value;
                    edge_it_value = edge_it.next();
                }
                if let Some(e1) = edge1 {
                    self.edge_set_next_(e1, edge1);
                    self.edge_set_prev_(e1, edge1);
                }
            }
        } else {
            // Update prev/next pointers for the ray edges.
            // let mut cell_it_keys = self.cells_.keys();
            for cell_it in self.decoupled_cells_iter() {
                if self.cell_is_degenerate_(cell_it) {
                    continue;
                }
                // Move to the previous edge while
                // it is possible in the CW direction.
                let mut left_edge = self.cell_get_incident_edge_(cell_it);
                let terminal_edge = left_edge;
                while let Some(new_left_edge) = left_edge.and_then(|e| self.edge_get_prev_(e)) {
                    left_edge = Some(new_left_edge);
                    // Terminate if this is not a boundary cell.
                    if left_edge == terminal_edge {
                        break;
                    }
                }

                if left_edge.and_then(|e| self.edge_get_prev_(e)).is_some() {
                    continue;
                }

                let mut right_edge = self.cell_get_incident_edge_(cell_it);
                while let Some(new_right_edge) = right_edge.and_then(|e| self.edge_get_next_(e)) {
                    right_edge = Some(new_right_edge);
                }

                let _ = left_edge.map(|le| self.edge_set_prev_(le, right_edge));
                let _ = right_edge.map(|re| self.edge_set_next_(re, left_edge));
            }
        }
    }

    /// prints cells and vertices to the console
    /// edges will be printed if the 'edge_filter' returns true for that edge id.
    #[cfg(feature = "console_debug")]
    pub fn debug_print_all<FN: Fn(u32) -> bool>(&self, edge_filter: FN) {
        use crate::{t, tln};
        tln!();
        tln!("output:");
        for (i, c) in self.cells_.iter().enumerate() {
            print!("cell#{} {:?} ", i, &c);
            if c.contains_point() {
                tln!("point");
            } else if c.contains_segment() {
                tln!("segment");
            } else if c.contains_segment_startpoint() {
                tln!("startpoint");
            } else if c.contains_segment_endpoint() {
                tln!("endpoint");
            } else {
                tln!();
            }
        }
        for (i, v) in self.vertices_.iter().enumerate() {
            assert_eq!(i, v.id_.usize());

            let edges1: Vec<u32> = v.get_incident_edge_().map_or_else(
                || Vec::default(),
                |incident_edge| {
                    self.edge_rot_next_iterator(incident_edge)
                        .map(|x| x.0)
                        .filter(|&x| edge_filter(x))
                        .collect()
                },
            );
            let edges2: Vec<u32> = v.get_incident_edge_().map_or_else(
                || Vec::default(),
                |incident_edge| {
                    self.edge_rot_next_iterator(incident_edge)
                        .filter_map(|x| self.edge_get_twin_(x))
                        .map(|x| x.0)
                        .filter(|&x| edge_filter(x))
                        .collect()
                },
            );
            //if !(edges1.is_empty() && edges2.is_empty()) {
            t!("vertex#{} {:?}", i, &v);
            t!(" outgoing edges:{:?}", edges1);
            tln!(" incoming edges:{:?}", edges2);
            //}
        }
    }

    #[cfg(feature = "console_debug")]
    pub fn debug_print_edges(&self, text: &str) {
        tln!("edges {} {}", text, self.edges_.len());
        for (i, e) in self.edges_.iter().enumerate() {
            tln!("edge{} ({:?})", e.id_.0, &e);
            assert_eq!(i, e.id_.usize());
        }
    }
}
