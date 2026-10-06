# sx-cpp-map

A fork of [cpp_map 0.2.0](https://codeberg.org/eadf/cpp_map_rs) by eadf, published for the SlicerX slicing engine ([sx-core](https://crates.io/crates/sx-core)). SOURCE.md lists every change. The library name stays `cpp_map`, so code that uses the original builds unchanged with `cpp_map = { package = "sx-cpp-map", version = "=0.2.0" }`. License: MIT OR Apache-2.0, the same as the original.

The original README follows.

---

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
