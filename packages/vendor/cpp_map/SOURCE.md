cpp_map 0.2.0 from crates.io (MIT OR Apache-2.0, eadf), with two changes: the unit tests are
removed, and node levels come from a fixed-seed generator (restarted for each new skip list)
instead of the thread's random one. boostvoronoi builds its beach line on this list, and with
random levels a segment Voronoi diagram of the same outline differed from run to run, which
made the output of the Arachne generator differ from run to run.
