use regex::Regex;
use std::sync::LazyLock;

pub(super) static RE_PREDICATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?P<node1>L.+), (?P<node2>L.+)\)==(?P<result>.+)").unwrap());

pub(super) static RE_NODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"L:(?P<left>.+),R:(?P<right>.+)").unwrap());

pub(super) static RE_NODE_SINGLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"#(?P<si>\d+)\((?P<x>-?\d+),(?P<y>-?\d+)\),ii:(?P<ii>-?\d+),f:(?P<f>\d+)").unwrap()
});

pub(super) static RE_NODE_DOUBLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"#(?P<si>\d+)\((?P<x1>-?\d+),(?P<y1>-?\d+)\)-\((?P<x2>-?\d+),(?P<y2>-?\d+)\),ii:(?P<ii>-?\d+),f:(?P<f>\d+)").unwrap()
});

pub(super) static RE_NODE_INVERS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"#(?P<si>\d+)\((?P<x1>-?\d+),(?P<y1>-?\d+)\)¿\((?P<x2>-?\d+),(?P<y2>-?\d+)\),ii:(?P<ii>-?\d+),f:(?P<f>\d+)").unwrap()
});
