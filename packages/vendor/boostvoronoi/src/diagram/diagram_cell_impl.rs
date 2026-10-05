// Boost.Polygon library detail/robust_fpt.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code..

// Ported from C++ boost 1.76.0 to Rust in 2020/2021, 2025 by Eadf (github.com/eadf)

use crate::BvError;
use crate::diagram::{Cell, CellIndex, ColorBits, Diagram, EdgeIndex, SourceIndex};

impl Diagram {
    #[inline(always)]
    /// Returns a reference to the list of cells
    pub fn cells(&self) -> &[Cell] {
        &self.cells_
    }

    /// returns the number of cells in the diagram
    #[inline(always)]
    pub fn num_cells(&self) -> usize {
        self.cells_.len()
    }

    #[inline(always)]
    fn cell_(&self, cell_id: CellIndex) -> Option<&Cell> {
        debug_assert_eq!(self.cells_[cell_id.usize()].id_, cell_id);
        self.cells_.get(cell_id.usize())
    }

    #[inline(always)]
    /// Returns a Cell reference belonging to the cell_id
    pub fn cell(&self, cell_id: CellIndex) -> Result<&Cell, BvError> {
        debug_assert_eq!(self.cells_[cell_id.usize()].id_, cell_id);
        self.cells_.get(cell_id.usize()).ok_or_else(|| {
            BvError::IdError(format!("The cell with id:{} does not exist", cell_id.0))
        })
    }

    /// push a new cell on the output. Nothing but id and source category is initialized
    pub(super) fn make_new_cell_with_category_(
        &mut self,
        cell_id: CellIndex, // same as sorted_index
        initial_index: SourceIndex,
        sc: ColorBits,
    ) -> CellIndex {
        // fill cell with temporary blocks- they will be over-written later
        // Todo: fix this dirty hack with Option<>
        while self.cells_.len() < cell_id.usize() {
            self.cells_.push(Cell::new(
                CellIndex::INVALID,
                SourceIndex::INVALID,
                ColorBits::TEMPORARY_CELL.0,
            ));
        }
        self.cells_.push(Cell::new(cell_id, initial_index, sc.0));
        #[cfg(feature = "console_debug")]
        assert_eq!(self.cells_[cell_id.usize()].id().0, cell_id.0);

        #[cfg(feature = "console_debug")]
        {
            let cell = &self.cells_[cell_id.usize()];
            {
                assert_eq!(cell.id_.0, cell_id.0);
                assert_eq!(cell.source_index_, initial_index);
                assert_eq!(cell.color_, sc.0);
            }
        }
        cell_id
    }

    #[inline(always)]
    pub(super) fn cell_get_incident_edge_(&self, cell_id: CellIndex) -> Option<EdgeIndex> {
        self.cell_(cell_id).and_then(|cell| cell.incident_edge_)
    }

    #[inline(always)]
    pub(super) fn cell_is_degenerate_(&self, cell_id: CellIndex) -> bool {
        if let Some(cell) = self.cell_(cell_id) {
            return cell.is_degenerate();
        }
        false
    }

    #[inline]
    pub(super) fn edge_set_cell_(&mut self, edge_id: EdgeIndex, cell_id: CellIndex) {
        if let Some(edge) = self.edges_.get_mut(edge_id.usize()) {
            edge.cell_ = Some(cell_id);
        }
    }

    #[inline]
    pub(super) fn edge_get_cell_(&self, edge_id: EdgeIndex) -> Option<CellIndex> {
        self.edges_.get(edge_id.usize())?.cell_()
    }

    #[inline]
    pub fn edge_get_cell(&self, edge_id: EdgeIndex) -> Result<CellIndex, BvError> {
        self.edge_get_cell_(edge_id).ok_or_else(|| {
            BvError::IdError(format!(
                "Either the edge id:{} or the cell didn't exists",
                edge_id.0
            ))
        })
    }

    #[inline(always)]
    pub(super) fn cell_set_incident_edge_(&mut self, cell_id: CellIndex, edge: Option<EdgeIndex>) {
        if let Some(cell) = self.cells_.get_mut(cell_id.usize()) {
            cell.incident_edge_ = edge;
        }
    }
}
