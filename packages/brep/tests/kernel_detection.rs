// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// a required-kernel run must execute the kernel, not pass the stand-in skips
#[test]
fn real_kernel_detection() {
    let count = sx_brep::call("count", "{}");
    assert_eq!(
        sx_brep::KERNEL,
        count.is_ok(),
        "kernel detection disagrees with execution"
    );
    if std::env::var("SX_BREP_REQUIRE").as_deref() == Ok("1") {
        let reply = count.expect("SX_BREP_REQUIRE=1 must execute the real SMLib kernel");
        let value: serde_json::Value = serde_json::from_str(&reply).expect("kernel JSON");
        assert_eq!(value["bodies"], 0);
    }
}
