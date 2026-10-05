use crate::InputType;
use crate::beach_line as vb;
use crate::beach_line::tests::common;
use crate::predicate as vp;
use crate::site_event as vse;
use std::fs::File;
use std::io::{self, BufReader, prelude::*};
use std::path::Path;

fn parse_site<I>(site_input: &str) -> vse::SiteEvent<I>
where
    I: InputType,
{
    let site = if let Some(caps) = common::RE_NODE_SINGLE.captures(site_input) {
        let ii = (&caps)["ii"].parse::<u32>().unwrap();
        print!(
            "si:{},x:{},y:{},ii:{},f:{}",
            &caps["si"], &caps["x"], &caps["y"], ii, &caps["f"]
        );
        let mut site = vse::SiteEvent::<I>::new(
            vse::Site::Point(
                [
                    (&caps)["x"].parse::<I>().unwrap(),
                    (&caps)["y"].parse::<I>().unwrap(),
                ]
                .into(),
            ),
            ii,
        );
        site.set_flags((&caps)["f"].parse::<u32>().unwrap());
        site.set_sorted_index((&caps)["si"].parse::<u32>().unwrap());
        site
    } else if let Some(caps) = common::RE_NODE_DOUBLE.captures(site_input) {
        let ii = (&caps)["ii"].parse::<u32>().unwrap();
        print!(
            "si:{},x1:{},y1:{},x2:{},y2:{},ii:{},f:{}",
            &caps["si"], &caps["x1"], &caps["y1"], &caps["x2"], &caps["y2"], ii, &caps["f"]
        );
        let mut site = vse::SiteEvent::<I>::new(
            vse::Site::Segment(
                [
                    (&caps)["x1"].parse::<I>().unwrap(),
                    (&caps)["y1"].parse::<I>().unwrap(),
                ]
                .into(),
                [
                    (&caps)["x2"].parse::<I>().unwrap(),
                    (&caps)["y2"].parse::<I>().unwrap(),
                ]
                .into(),
            ),
            ii,
        );
        site.set_flags((&caps)["f"].parse::<u32>().unwrap());
        site.set_sorted_index((&caps)["si"].parse::<u32>().unwrap());
        site
    } else if let Some(caps) = common::RE_NODE_INVERS.captures(site_input) {
        let ii = (&caps)["ii"].parse::<u32>().unwrap();
        /*print!(
            "si:{},x1:{},y1:{},x2:{},y2:{},ii:{},f:{}",
            &caps["si"], &caps["x1"], &caps["y1"], &caps["x2"], &caps["y2"], ii, &caps["f"]
        );*/
        let mut site = vse::SiteEvent::<I>::new(
            vse::Site::Segment(
                [
                    (&caps)["x1"].parse::<I>().unwrap(),
                    (&caps)["y1"].parse::<I>().unwrap(),
                ]
                .into(),
                [
                    (&caps)["x2"].parse::<I>().unwrap(),
                    (&caps)["y2"].parse::<I>().unwrap(),
                ]
                .into(),
            ),
            ii,
        );
        site.set_flags((&caps)["f"].parse::<u32>().unwrap());
        site.set_sorted_index((&caps)["si"].parse::<u32>().unwrap());
        site
    } else {
        panic!("All re_single & re_double, re_inverse failed for {site_input}",)
    };
    let result = format!("{site:?}");
    //println!("\n{} -> {}", site_input, result);
    assert_eq!(site_input, result);
    site
}

fn parse_node<I>(node: &str) -> vb::BeachLineNodeKey<I>
where
    I: InputType,
{
    let caps = common::RE_NODE.captures(node).unwrap();
    println!("LEFT:{}", &caps["left"]);
    let site1 = parse_site(&caps["left"]);

    println!("RIGHT:{}", &caps["right"]);
    let site2 = parse_site(&caps["right"]);
    assert_eq!(format!("{site2:?}"), &caps["right"]);
    println!();
    let key = vb::BeachLineNodeKey::<I>::new_2(site1, site2);
    assert_eq!(format!("{key:?}").replace(", id=0", ""), node);
    key
}

#[ignore]
#[test]
/// This test is massive, 9+ megs of node_comparison_predicate() -> disabled by default, but it works
fn beachline_multiple_2() -> io::Result<()> {
    let file = File::open(Path::new("src/beach_line/node_comparisons.txt")).unwrap();
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = line?;
        println!("new line:{line}");
        let mut found_any = false;

        for cap in common::RE_PREDICATE.captures_iter(line.as_str()) {
            let node1 = parse_node::<i64>(&cap["node1"]);
            let node2 = parse_node::<i64>(&cap["node2"]);
            let result = vp::node_comparison_predicate::node_comparison::<i64>(&node1, &node2);
            println!("Result:{}", &cap["result"]);
            let expected_result = (&cap)["result"].parse::<bool>().unwrap();
            println!("result:{result}, expected_result:{expected_result}");
            assert_eq!(result, expected_result);
            found_any = true;
        }
        if line.len() > 1 {
            assert!(found_any);
        }
    }
    Ok(())
}
