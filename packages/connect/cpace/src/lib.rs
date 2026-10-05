// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `CPace`, the balanced PAKE of draft-irtf-cfrg-cpace, cipher suite CPACE-RISTR255-SHA512.
//!
//! Both sides derive a generator from the shared password (the pairing code), send `Y = y * G`
//! and compute `K = y * Y_peer`. Someone without the password learns nothing they can test offline:
//! each run gives them one guess. The group operations (element derivation, encoding, scalar
//! multiplication) are curve25519-dalek's; this crate only lays out the draft's hash inputs, and
//! the tests check it against the draft's own vectors (appendix B.3). [`pair`] is the code pairing
//! with sx-link built on it. The TypeScript twin is `packages/connect/link-client/src/cpace.ts`, and
//! `vectors.json` pins the two together.
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::Identity as _;
use sha2::{Digest as _, Sha512};
use zeroize::Zeroize as _;

/// The domain separation string of the ristretto255 group.
pub const DSI: &[u8] = b"CPaceRistretto255";
/// SHA-512's input block size, which the generator string pads to.
const S_IN_BYTES: usize = 128;

/// `prepend_len`: the length as LEB128, then the bytes.
pub fn prepend_len(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 2);
    let mut n = data.len();
    loop {
        let low = u8::try_from(n & 0x7f).unwrap_or(0);
        n >>= 7;
        out.push(if n == 0 { low } else { low | 0x80 });
        if n == 0 {
            break;
        }
    }
    out.extend_from_slice(data);
    out
}

/// `lv_cat`: each part with its length in front.
pub fn lv_cat(parts: &[&[u8]]) -> Vec<u8> {
    parts.iter().flat_map(|p| prepend_len(p)).collect()
}

/// `generator_string(DSI, PRS, CI, sid, 128)`.
pub fn generator_string(prs: &[u8], ci: &[u8], sid: &[u8]) -> Vec<u8> {
    let zpad = S_IN_BYTES.saturating_sub(1 + prepend_len(prs).len() + prepend_len(DSI).len());
    lv_cat(&[DSI, prs, &vec![0u8; zpad], ci, sid])
}

/// `calculate_generator`: SHA-512 of the generator string, mapped with ristretto255's element derivation.
pub fn generator(prs: &[u8], ci: &[u8], sid: &[u8]) -> RistrettoPoint {
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&Sha512::digest(generator_string(prs, ci, sid)));
    RistrettoPoint::from_uniform_bytes(&wide)
}

/// `sample_scalar` from 32 random bytes: the bits above the group's 252 are cleared, so the value
/// is below the group order as it stands.
pub fn scalar(mut random: [u8; 32]) -> Scalar {
    if let Some(top) = random.last_mut() {
        *top &= 0x0f;
    }
    let y = Scalar::from_bytes_mod_order(random);
    random.zeroize();
    y
}

/// `Y = encode(y * G)`, the message each side sends.
pub fn share(y: &Scalar, g: &RistrettoPoint) -> [u8; 32] {
    (g * y).compress().to_bytes()
}

/// `K = scalar_mult_vfy(y, Y_peer)`. `None` when the peer's message does not decode or `K` is
/// the identity, where the draft says to abort.
pub fn secret(y: &Scalar, peer: &[u8]) -> Option<[u8; 32]> {
    let point = CompressedRistretto::from_slice(peer).ok()?.decompress()?;
    let mut k = point * y;
    let out = (k != RistrettoPoint::identity()).then(|| k.compress().to_bytes());
    k.zeroize();
    out
}

/// `transcript_ir(Ya, ADa, Yb, ADb)`: the initiator's message first.
pub fn transcript_ir(ya: &[u8], ada: &[u8], yb: &[u8], adb: &[u8]) -> Vec<u8> {
    [lv_cat(&[ya, ada]), lv_cat(&[yb, adb])].concat()
}

/// The intermediate session key, initiator and responder order:
/// `SHA-512(lv_cat(DSI || "_ISK", sid, K) || transcript_ir)`.
pub fn isk_ir(sid: &[u8], k: &[u8; 32], ya: &[u8], ada: &[u8], yb: &[u8], adb: &[u8]) -> [u8; 64] {
    let dsi = [DSI, b"_ISK"].concat();
    let mut h = Sha512::new();
    h.update(lv_cat(&[&dsi, sid, k]));
    h.update(transcript_ir(ya, ada, yb, adb));
    let mut out = [0u8; 64];
    out.copy_from_slice(&h.finalize());
    out
}

pub mod pair;

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        let s: String = s.split_whitespace().collect();
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn arr32(s: &str) -> [u8; 32] {
        hex(s).try_into().unwrap()
    }

    // draft-irtf-cfrg-cpace-18, appendix B.3.
    const CI: &str = "6f630b425f726573706f6e6465720b415f696e69746961746f72";
    const SID: &str = "7e4b4791d6a8ef019b936c79fb7f2c57";

    #[test]
    fn matches_the_draft_vectors() {
        let (ci, sid) = (hex(CI), hex(SID));
        let gs = generator_string(b"Password", &ci, &sid);
        assert_eq!(gs.len(), 172);
        assert_eq!(
            gs,
            hex("11435061636552697374726574746f3235350850617373776f726464
                 00000000000000000000000000000000000000000000000000000000
                 00000000000000000000000000000000000000000000000000000000
                 00000000000000000000000000000000000000000000000000000000
                 000000000000000000000000000000001a6f630b425f726573706f6e
                 6465720b415f696e69746961746f72107e4b4791d6a8ef019b936c79
                 fb7f2c57")
        );
        let g = generator(b"Password", &ci, &sid);
        assert_eq!(
            g.compress().to_bytes(),
            arr32("a6fc82c3b8968fbb2e06fee81ca858586dea50d248f0c7ca6a18b0902a30b36b")
        );
        let ya = Scalar::from_bytes_mod_order(arr32(
            "da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08",
        ));
        let yb = Scalar::from_bytes_mod_order(arr32(
            "d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d",
        ));
        let msg_a = share(&ya, &g);
        let msg_b = share(&yb, &g);
        assert_eq!(
            msg_a,
            arr32("d40fb265a7abeaee7939d91a585fe59f7053f982c296ec413c624c669308f87a")
        );
        assert_eq!(
            msg_b,
            arr32("08bcf6e9777a9c313a3db6daa510f2d398403319c2341bd506a92e672eb7e307")
        );
        let k = secret(&ya, &msg_b).unwrap();
        assert_eq!(k, secret(&yb, &msg_a).unwrap());
        assert_eq!(
            k,
            arr32("e22b1ef7788f661478f3cddd4c600774fc0f41e6b711569190ff88fa0e607e09")
        );
        assert_eq!(
            isk_ir(&sid, &k, &msg_a, b"ADa", &msg_b, b"ADb").to_vec(),
            hex(
                "4c5469a16b2364c4b944ebc1a79e51d1674ad47db26e8718154f59faebfaa52d8346f30aa58377117eb20d527f2cbc5c76381f7fd372e89df8239f87f2e02ed1"
            )
        );
    }

    #[test]
    fn identity_and_invalid_messages_abort() {
        let y = scalar([7; 32]);
        assert!(secret(&y, &[0u8; 32]).is_none(), "the identity");
        assert!(secret(&y, &[0xff; 32]).is_none(), "not an encoding");
        assert!(secret(&y, &[1; 31]).is_none(), "wrong length");
    }

    #[test]
    fn lengths_use_leb128() {
        assert_eq!(prepend_len(&[0; 127])[0], 127);
        assert_eq!(&prepend_len(&[0; 128])[..2], &[0x80, 0x01]);
        assert_eq!(&prepend_len(&[0; 300])[..2], &[0xac, 0x02]);
    }
}
