[![Latest version](https://img.shields.io/crates/v/cpp_map.svg)](https://crates.io/crates/cpp_map)
[![Documentation](https://docs.rs/cpp_map/badge.svg)](https://docs.rs/cpp_map)
[![workflow](https://ci.codeberg.org/api/badges/14523/status.svg)](https://ci.codeberg.org/repos/14523)
[![dependency status](https://deps.rs/crate/cpp_map/0.2.0/status.svg)](https://deps.rs/crate/cpp_map/0.2.0)
![license](https://img.shields.io/crates/l/cpp_map)

# cpp_map.rs
# C++ `std::map` Emulator for Rust

A simple C++ `std::map` emulator for Rust.

This library provides a data structure that emulates C++'s `std::map`, particularly its pointer-based cursors/iterators.

## Key Features

- Replicates C++ behavior where `insert(key, value)` is a no-op if the key exists (the new value isn't used)
- Maintains pointer stability like C++'s std::map
- Provides familiar C++-style iterator interface

## Implementations

### Skip List
- O(log n) search and insert
- O(1) sequential access

### Linked List
- O(n) search and insert
- O(1) sequential access

### Performance Note

For primarily position/hint-based operations, the linked list implementation will typically be faster.

### Minimum Supported Rust Version (MSRV)

The minimum supported version of Rust for `cpp_map` is `1.87.0`.

## License

Licensed under either of

* [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0)
* [MIT license](http://opensource.org/licenses/MIT)

at your option.
