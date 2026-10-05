#![allow(unused_imports)]
use super::super::BvError;
use super::super::diagram::Diagram;
use super::super::geometry::{Line, Point};
use super::super::site_event as vse;

#[test]
fn inverse_test_1() {
    type I1 = i32;

    let mut a_site = vse::SiteEvent::<I1>::new(
        vse::Site::Segment(Point { x: 10, y: 10 }, Point { x: 50, y: 50 }),
        1,
    );
    assert!(!a_site.is_inverse());
    let _ = a_site.inverse();
    assert!(a_site.is_inverse());
}

#[test]
fn inverse_test_2() {
    type I1 = i32;

    let mut a_site = vse::SiteEvent::<I1>::new(
        vse::Site::Segment(Point { x: 10, y: 11 }, Point { x: 12, y: 13 }),
        1,
    );
    assert!(!a_site.is_inverse());
    assert_eq!(a_site.x0(), 10);
    assert_eq!(a_site.y0(), 11);
    assert_eq!(a_site.x1(), 12);
    assert_eq!(a_site.y1(), 13);

    let _ = a_site.inverse();
    assert!(a_site.is_inverse());
    assert_eq!(a_site.x0(), 12);
    assert_eq!(a_site.y0(), 13);
    assert_eq!(a_site.x1(), 10);
    assert_eq!(a_site.y1(), 11);

    let _ = a_site.inverse();
    assert!(!a_site.is_inverse());
    assert_eq!(a_site.x0(), 10);
    assert_eq!(a_site.y0(), 11);
    assert_eq!(a_site.x1(), 12);
    assert_eq!(a_site.y1(), 13);
}
