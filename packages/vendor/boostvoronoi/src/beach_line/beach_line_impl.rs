// SPDX-License-Identifier:BSL-1.0

// Boost.Polygon library detail/voronoi_structures.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code.

// Ported from C++ boost 1.76.0 to Rust in 2020/2021,2025 by Eadf (github.com/eadf)

use super::{
    BeachLine, BeachLineIndex, BeachLineNodeData, BeachLineNodeDataType, BeachLineNodeKey,
    BeachlineCursor,
};
use crate::{BvError, InputType};
#[cfg(feature = "console_debug")]
use crate::{t, tln};
use cpp_map::skiplist::{Index, SkipList};
use std::cell::{Cell, RefCell};
use std::ops::Deref;
use std::rc::Rc;

impl<I: InputType> BeachLine<I> {
    #[cfg(feature = "console_debug")]
    #[inline(always)]
    pub(crate) fn len(&self) -> usize {
        self.beach_line_.borrow().len()
    }

    #[inline(always)]
    pub(crate) fn is_empty(&self) -> bool {
        self.beach_line_.borrow().is_empty()
    }

    #[inline(always)]
    pub(crate) fn get_pointer(
        &self,
        new_key_id: BeachLineIndex,
    ) -> Result<BeachlineCursor<I>, BvError> {
        BeachlineCursor::new_from_index(Rc::clone(&self.beach_line_), Some(new_key_id))
    }

    #[inline(always)]
    /// Returns a pointer to the last beach-line item or None
    pub(crate) fn last(&self) -> Result<BeachlineCursor<I>, BvError> {
        BeachlineCursor::new_from_index(
            Rc::clone(&self.beach_line_),
            self.beach_line_.borrow().last(),
        )
    }

    #[inline(always)]
    /// Returns the last position of the beach-line list
    pub(crate) fn last_position(&self) -> Option<BeachLineIndex> {
        self.beach_line_.borrow().last()
    }

    /// updates the node_index of the key, inserts it into the list and
    /// returns a copy of it
    #[cfg(not(feature = "console_debug"))]
    pub(crate) fn insert(
        &mut self,
        position: Option<BeachLineIndex>,
        key: BeachLineNodeKey<I>,
        data: Option<BeachLineNodeData>,
    ) -> Result<(BeachLineNodeKey<I>, BeachLineIndex), BvError> {
        let node = Rc::new(Cell::new(data));
        let node_index = if let Some(position) = position {
            self.beach_line_
                .borrow_mut()
                .insert_with_hint(key, node, position)?
        } else {
            self.beach_line_.borrow_mut().insert(key, node)?
        };
        Ok((key, node_index))
    }

    /// updates the node_index of the key, inserts it into the list and
    /// returns a copy of it
    #[cfg(feature = "console_debug")]
    pub(crate) fn insert(
        &mut self,
        position: Option<BeachLineIndex>,
        key: BeachLineNodeKey<I>,
        data: BeachLineNodeData,
        _ce: &crate::circle_event::CircleEventQueue,
    ) -> Result<(BeachLineNodeKey<I>, BeachLineIndex), BvError> {
        let node = Rc::from(Cell::from(Some(data)));
        let node_clone = node.clone();
        let node_index = if let Some(position) = position {
            let rv = self
                .beach_line_
                .borrow_mut()
                .insert_with_hint(key, node, position)?;
            t!("inserted beach_line_1:");
            rv
        } else {
            let rv = self.beach_line_.borrow_mut().insert(key, node)?;
            t!("inserted beach_line_2:");
            rv
        };
        self.dbgpa_compat_node_(&key, &node_clone, _ce)?;
        Ok((key, node_index))
    }

    /// updates the node_index of the key, inserts it into the list and
    /// returns a copy of it
    #[cfg(not(feature = "console_debug"))]
    pub(crate) fn insert_2(
        &mut self,
        key: BeachLineNodeKey<I>,
    ) -> Result<(BeachLineNodeKey<I>, BeachLineIndex), BvError> {
        let node = Rc::new(Cell::new(None));
        let node_index = self.beach_line_.borrow_mut().insert(key, node)?;
        Ok((key, node_index))
    }

    /// inserts a new node key into the list and
    /// returns a copy of it
    #[cfg(feature = "console_debug")]
    pub(crate) fn insert_2(
        &mut self,
        key: BeachLineNodeKey<I>,
        _ce: &crate::circle_event::CircleEventQueue,
    ) -> Result<(BeachLineNodeKey<I>, BeachLineIndex), BvError> {
        let data_node = Rc::from(Cell::from(None));
        let node_index = self.beach_line_.borrow_mut().insert(key, data_node)?;
        t!("inserted beach_line_2:");
        let _ = self.dbgpa_compat_node_(
            &key,
            self.beach_line_.borrow().get_v_at(node_index).unwrap(),
            _ce,
        );
        Ok((key, node_index))
    }

    /// Clear the beach line list
    #[inline(always)]
    pub fn clear(&mut self) {
        self.beach_line_.borrow_mut().clear();
    }

    /// mapping: BeachLineIndexType->(BeachLineNodeKey,BeachLineNodeDataType)
    pub(crate) fn get_node(
        &self,
        beachline_index: &BeachLineIndex,
    ) -> Result<(BeachLineNodeKey<I>, BeachLineNodeDataType), BvError> {
        let bl_borrow = self.beach_line_.borrow();
        let node = bl_borrow.get_at(*beachline_index);

        if node.is_none() {
            eprintln!("Failed to retrieve beach line key : {beachline_index}");
            return Err(BvError::InternalError(format!(
                "Tried to retrieve a beach line node that doesn't exist. Id:{}. {}:{}",
                beachline_index,
                file!(),
                line!()
            )));
        }
        let node = node.unwrap();
        Ok((*node.0, Rc::clone(node.1)))
    }

    #[inline(always)]
    /// Returns the first beach line element in the container whose key is not considered to go
    /// before position (i.e., either it is equivalent or goes after).
    /// Returns None if no data is found
    pub(crate) fn lower_bound(
        &self,
        key: BeachLineNodeKey<I>,
    ) -> Result<BeachlineCursor<I>, BvError> {
        BeachlineCursor::lower_bound(Rc::clone(&self.beach_line_), key)
    }

    #[allow(dead_code)]
    #[cfg(feature = "console_debug")]
    pub(crate) fn debug_cmp_all(&self, key: BeachLineNodeKey<I>) {
        use crate::predicate::node_comparison_predicate;
        for (i, (k, _)) in self.beach_line_.borrow().iter().rev().enumerate() {
            t!("#{}:", i);
            let _rv = node_comparison_predicate::node_comparison::<I>(k, &key);
        }
    }

    #[cfg(feature = "console_debug")]
    #[allow(dead_code)]
    pub(crate) fn debug_print_all(&self) -> Result<(), BvError> {
        tln!();
        tln!("beach_line.len()={}", self.beach_line_.borrow().len());
        for (i, (node_key, node_data)) in self.beach_line_.borrow().iter().rev().enumerate() {
            t!(
                "beach_line{} L:{:?},R:{:?}",
                i,
                &node_key.left_site(),
                &node_key.right_site()
            );

            if let Some(data) = node_data.get() {
                if let Some(circle_event) = data.circle_event_ {
                    t!(" -> CircleEvent:{}", circle_event);
                } else {
                    t!(" -> CircleEvent:-");
                }
                t!(", edge:{:?}", data.edge_);
            } else {
                t!(" temporary bisector");
            }
            tln!();
        }
        tln!();
        Ok(())
    }

    #[cfg(feature = "console_debug")]
    pub(crate) fn dbgpa_compat_(
        &self,
        ce: &crate::circle_event::CircleEventQueue,
    ) -> Result<(), BvError> {
        tln!("-----beach_line----{}", self.beach_line_.borrow().len());
        for (i, (node_key, node_data)) in self.beach_line_.borrow().iter().enumerate() {
            t!("#{}:", i);
            self.dbgpa_compat_node_(node_key, node_data, ce)?;
        }
        tln!();
        Ok(())
    }

    #[cfg(feature = "console_debug")]
    pub(crate) fn dbgp_all_cmp(&self) {
        let _iter1 = self.beach_line_.borrow();
        let mut it1 = _iter1.iter().enumerate();
        for it2_v in self.beach_line_.borrow().iter().enumerate().skip(1) {
            let it1_v = it1.next().unwrap();
            let key1 = it1_v.1.0;
            let key2 = it2_v.1.0;
            t!(
                "key(#{}).partial_cmp(key(#{})) == {:?}",
                it1_v.0,
                it2_v.0,
                key1.partial_cmp(key2).unwrap()
            );
            tln!(
                "\tkey(#{}).partial_cmp(key(#{})) == {:?}",
                it2_v.0,
                it1_v.0,
                key2.partial_cmp(key1).unwrap()
            );
        }
    }

    #[cfg(feature = "console_debug")]
    pub(crate) fn dbgpa_compat_node_(
        &self,
        node_key: &BeachLineNodeKey<I>,
        node_data: &BeachLineNodeDataType,
        ce: &crate::circle_event::CircleEventQueue,
    ) -> Result<(), BvError> {
        t!(
            "L:{:?},R:{:?}",
            &node_key.left_site(),
            &node_key.right_site(),
        );
        if let Some(data) = node_data.get() {
            if let Some(_circle_event) = data.circle_event_ {
                if ce.is_active(_circle_event) {
                    t!(" -> CircleEvent: ");
                    ce.dbg_ce(_circle_event);
                } else {
                    t!(" -> CircleEvent=-"); // this is what the c++ code does, should print "inactive"
                }
            } else {
                t!(" -> CircleEvent=-");
            }
            t!(",e={:?}", data.edge_);
        } else {
            t!(" Temporary bisector");
        }

        // t!(" id={}", id);
        tln!();
        Ok(())
    }
}

impl<I: InputType> BeachLineNodeKey<I> {
    /// Constructs degenerate bisector, used to search an arc that is above
    /// the given site. The input to the constructor is the new site point.
    pub fn new_1(new_site: crate::site_event::SiteEvent<I>) -> Self {
        Self {
            left_site_: new_site,
            right_site_: new_site,
        }
    }

    /// Constructs a new bisector. The input to the constructor is the two
    /// sites that create the bisector. The order of sites is important.
    pub fn new_2(
        left_site: crate::site_event::SiteEvent<I>,
        right_site: crate::site_event::SiteEvent<I>,
    ) -> Self {
        Self {
            left_site_: left_site,
            right_site_: right_site,
        }
    }

    #[inline(always)]
    pub(crate) fn left_site(&self) -> &crate::site_event::SiteEvent<I> {
        &self.left_site_
    }

    #[inline(always)]
    pub(crate) fn right_site(&self) -> &crate::site_event::SiteEvent<I> {
        &self.right_site_
    }

    #[inline(always)]
    pub(crate) fn set_right_site(&mut self, site: &crate::site_event::SiteEvent<I>) {
        self.right_site_ = *site; // Copy
    }
}

impl BeachLineNodeData {
    pub fn new_1(new_edge: crate::diagram::EdgeIndex) -> Self {
        Self {
            circle_event_: None,
            edge_: new_edge,
        }
    }

    #[inline(always)]
    pub fn get_circle_event_id(&self) -> Option<crate::circle_event::CircleEventIndex> {
        self.circle_event_
    }

    #[inline(always)]
    pub(crate) fn set_circle_event_id(
        &mut self,
        circle_event: Option<crate::circle_event::CircleEventIndex>,
    ) {
        self.circle_event_ = circle_event;
    }

    #[inline(always)]
    pub(crate) fn edge_id(&self) -> crate::diagram::EdgeIndex {
        self.edge_
    }

    #[inline(always)]
    pub(crate) fn set_edge_id(&mut self, new_edge: crate::diagram::EdgeIndex) {
        self.edge_ = new_edge;
    }
}

impl<I: InputType> BeachlineCursor<I> {
    // K= BeachLineNodeKey<I>
    // V= BeachLineNodeDataType

    /// Initiates the pointer with a list, set current to the head of the list.
    #[allow(dead_code)]
    pub(crate) fn new_1(
        list: Rc<RefCell<SkipList<BeachLineNodeKey<I>, BeachLineNodeDataType>>>,
    ) -> Result<Self, BvError> {
        let head = list.try_borrow()?.first();
        Ok(Self {
            current: head,
            list,
        })
    }

    pub(crate) fn new_2(
        list: Rc<RefCell<SkipList<BeachLineNodeKey<I>, BeachLineNodeDataType>>>,
        pos: Index,
    ) -> Result<Self, BvError> {
        Ok(Self {
            current: Some(pos),
            list,
        })
    }

    #[inline(always)]
    pub fn current(&self) -> Option<Index> {
        self.current
    }

    #[inline(always)]
    pub fn current_must_be_valid(&self) -> Result<Index, BvError> {
        if let Some(index) = self.current {
            Ok(index)
        } else {
            Err(BvError::IndexError(
                format!(
                    "current_must_be_valid: was None when Some was expected {} {}",
                    file!(),
                    line!()
                )
                .to_string(),
            ))
        }
    }

    /// Initiates the pointer with a list, set index.
    pub fn new_from_index(
        list: Rc<RefCell<SkipList<BeachLineNodeKey<I>, BeachLineNodeDataType>>>,
        current: Option<BeachLineIndex>,
    ) -> Result<Self, BvError> {
        if current.is_some() {
            Ok(Self {
                current,
                list: Rc::clone(&list),
            })
        } else {
            Err(BvError::IndexError(
                format!(
                    "new_from_index: was None when Some was expected {} {}",
                    file!(),
                    line!()
                )
                .to_string(),
            ))
        }
    }

    #[inline(always)]
    /// Returns a clone of the key at current position.
    /// It the replacement key is present in the value, that key will be returned instead.
    pub fn get_k(&self) -> Result<BeachLineNodeKey<I>, BvError> {
        let list = self.list.try_borrow()?;
        if let Some(current) = self.current {
            if let Some(k) = list.get_k_at(current) {
                return Ok(*k);
            }
        }
        Err(BvError::IndexError(
            format!(
                "get_k: was None when Some was expected {} {}",
                file!(),
                line!()
            )
            .to_string(),
        ))
    }

    #[inline(always)]
    /// Returns a clone of the value at current position
    pub fn get_v(&self) -> Result<BeachLineNodeDataType, BvError> {
        let list = self.list.try_borrow()?;
        if let Some(current) = self.current {
            if let Some(v) = list.get_v_at(current) {
                return Ok(v.clone());
            }
        }
        Err(BvError::IndexError(
            format!(
                "get_v: was None when Some was expected {} {}",
                file!(),
                line!()
            )
            .to_string(),
        ))
    }

    #[allow(clippy::should_implement_trait)]
    #[inline(always)]
    /// Move to the next element.
    /// Note that this is NOT a Rust iterator next() method.
    /// Always check validity of the iterator with is_ok() after next()
    // todo: change the return value to Result<bool, MapError>
    pub fn next(&mut self) -> Result<(), BvError> {
        let list_borrow = self.list.try_borrow()?;
        self.current = list_borrow.next_pos(self.current);
        Ok(())
    }

    #[inline(always)]
    /// Move to the previous element
    /// Always check validity of the iterator with is_ok() after prev()
    // todo: change the return value to Result<bool, MapError>
    pub fn prev(&mut self) -> Result<(), BvError> {
        let list_borrow = self.list.try_borrow()?;
        self.current = list_borrow.prev_pos(self.current);
        Ok(())
    }

    #[allow(dead_code)]
    #[inline(always)]
    /// Move to the first element
    pub fn move_to_head(&mut self) -> Result<(), BvError> {
        self.current = self.list.try_borrow()?.first();
        Ok(())
    }

    #[allow(dead_code)]
    #[inline(always)]
    /// Move to the last element
    pub fn move_to_tail(&mut self) -> Result<(), BvError> {
        self.current = self.list.try_borrow()?.last();
        Ok(())
    }

    #[inline(always)]
    /// Return true if pointer has *NOT* moved past beginning or end of the list
    pub fn is_ok(&self) -> Result<bool, BvError> {
        let list = self.list.try_borrow()?;
        Ok(list.is_pos_valid(self.current))
    }

    #[inline(always)]
    /// Return true if pointer is at head position or if the list is empty
    pub fn is_at_head(&self) -> Result<bool, BvError> {
        Ok(self.list.try_borrow()?.is_at_first(self.current))
    }

    #[allow(dead_code)]
    #[inline(always)]
    /// Return true if pointer is at tail position or if the list is empty
    pub fn is_at_tail(&self) -> Result<bool, BvError> {
        Ok(self.list.try_borrow()?.is_at_last(self.current))
    }

    #[inline(always)]
    /// Replace current key with the new one (re-order the list accordingly)
    pub fn replace_key(&mut self, new_key: BeachLineNodeKey<I>) -> Result<Index, BvError> {
        let result = {
            let mut list = self.list.try_borrow_mut()?;
            list.change_key_of_node(self.current.unwrap(), new_key)
        };
        match result {
            Ok(v) => Ok(v),
            Err(e) => {
                println!("Error: {e:?} when trying to change key");
                let list = self.list.try_borrow()?;
                println!(
                    "     new key:{:?} existing value:{:?}",
                    new_key,
                    list.get_v_at(self.current.unwrap())
                );
                let existing_kv = list.deref().get_kv(&new_key).unwrap();
                println!(
                    "existing key:{:?} existing value:{:?}",
                    existing_kv.0,
                    existing_kv.1.get()
                );
                println!(
                    "existing key .eq() new key == {:?}",
                    existing_kv.0.eq(&new_key)
                );
                println!(
                    "existing key .cmp() new key == {:?}",
                    existing_kv.0.cmp(&new_key)
                );
                println!(
                    "existing key .lt() new key == {:?}",
                    existing_kv.0.lt(&new_key)
                );
                println!(
                    "existing key .gt() new key == {:?}",
                    existing_kv.0.gt(&new_key)
                );
                Err(e)?
            }
        }
    }

    #[inline(always)]
    /// Remove the current element and return it. Move current to the old prev value if existed.
    /// Else pick old next index.
    /// Note: make sure that there are no other Pointer objects at this position.
    pub fn remove_current(&mut self) -> Result<(), BvError> {
        if self.current.is_some() {
            let mut list = self.list.try_borrow_mut()?;
            if list.remove_by_index(&mut self.current).is_none() {
                println!(
                    " Could not remove beachline index:{:?}, something is wrong",
                    self.current
                );
            }
        } else {
            println!(
                " Could not remove beachline index:{:?}, something is wrong",
                self.current
            );
        }
        Ok(())
    }

    #[inline(always)]
    /// Returns a new Pointer positioned at the lower bound item.
    /// Lower bound item is the first element in the container whose key is not considered to go
    /// before position (i.e., either it is equivalent or goes after).
    /// Returns a Pointer where is_ok() returns false if no data is found
    pub fn lower_bound(
        list: Rc<RefCell<SkipList<BeachLineNodeKey<I>, BeachLineNodeDataType>>>,
        key: BeachLineNodeKey<I>,
    ) -> Result<Self, BvError> {
        let position = {
            let bt_list = list.try_borrow()?;
            bt_list.deref().lower_bound(&key)
        };
        Ok(Self {
            list,
            current: position,
        })
    }
}

/// debug utility function, prints beach line index
#[allow(dead_code)]
#[cfg(feature = "console_debug")]
#[inline(always)]
pub(crate) fn debug_print_bli_id(value: Option<BeachLineIndex>) -> String {
    if let Some(value) = value {
        value.to_string()
    } else {
        String::from("-")
    }
}
