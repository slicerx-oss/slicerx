// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! small vector helpers on plain arrays, and the [`Plane`] type

use serde::{Deserialize, Serialize};

pub type V3 = [f64; 3];
pub type V2 = [f64; 2];

pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub fn len(a: V3) -> f64 {
    dot(a, a).sqrt()
}

pub fn normalize(a: V3) -> Option<V3> {
    let l = len(a);
    (l > 1e-300 && l.is_finite()).then(|| scale(a, 1.0 / l))
}

pub fn lerp(a: V3, b: V3, t: f64) -> V3 {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

pub fn tri_normal(a: V3, b: V3, c: V3) -> V3 {
    cross(sub(b, a), sub(c, a))
}

/// some unit vector perpendicular to `n` (which must be unit length)
pub fn any_perpendicular(n: V3) -> V3 {
    let helper = if n[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    normalize(cross(n, helper)).unwrap_or([0.0, 0.0, 1.0])
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Plane {
    pub normal: V3,
    pub offset: f64,
}

impl Plane {
    pub fn new(point: V3, normal: V3) -> Option<Self> {
        let n = normalize(normal)?;
        Some(Self {
            normal: n,
            offset: dot(n, point),
        })
    }

    pub fn horizontal(z: f64) -> Self {
        Self {
            normal: [0.0, 0.0, 1.0],
            offset: z,
        }
    }

    pub fn distance(&self, p: V3) -> f64 {
        dot(self.normal, p) - self.offset
    }

    #[must_use]
    pub fn flipped(&self) -> Self {
        Self {
            normal: scale(self.normal, -1.0),
            offset: -self.offset,
        }
    }

    pub fn origin(&self) -> V3 {
        scale(self.normal, self.offset)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub origin: V3,
    pub u: V3,
    pub v: V3,
    pub w: V3,
}

impl Frame {
    pub const WORLD: Self = Self {
        origin: [0.0; 3],
        u: [1.0, 0.0, 0.0],
        v: [0.0, 1.0, 0.0],
        w: [0.0, 0.0, 1.0],
    };

    pub fn from_normal(origin: V3, w: V3, u_hint: Option<V3>) -> Option<Self> {
        let w = normalize(w)?;
        let u = u_hint
            .and_then(|h| normalize(sub(h, scale(w, dot(h, w)))))
            .unwrap_or_else(|| any_perpendicular(w));
        let v = cross(w, u);
        Some(Self { origin, u, v, w })
    }

    pub fn at(&self, p: V2, h: f64) -> V3 {
        add(
            self.origin,
            add(add(scale(self.u, p[0]), scale(self.v, p[1])), scale(self.w, h)),
        )
    }

    pub fn project(&self, p: V3) -> V2 {
        let d = sub(p, self.origin);
        [dot(d, self.u), dot(d, self.v)]
    }

    pub fn height(&self, p: V3) -> f64 {
        dot(sub(p, self.origin), self.w)
    }
}
