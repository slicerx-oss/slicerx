// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! TLS for LAN devices that present self-signed certificates (Bambu Lab printers).
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, ring, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as TlsError, SignatureScheme};

use crate::error::{Error, Result};

/// Accepts any server certificate but still verifies handshake signatures, so the channel is
/// encrypted and bound to whoever holds the presented key. It does not prove the peer is the
/// printer the user meant; the LAN access code that follows is the real credential.
/// For a Bambu Lab printer it also checks the certificate against Bambu Lab's CA and the printer's
/// serial, and records the result (`certificate_check`) without refusing the connection.
#[derive(Debug)]
struct AcceptSelfSigned {
    provider: Arc<CryptoProvider>,
    observe: Option<Observe>,
}

/// The printer a Bambu Lab connection is meant for: its serial, and the address the check is kept under.
#[derive(Debug)]
struct Observe {
    serial: String,
    host: String,
}

/// What the certificate check found for a printer. It never decides whether to connect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CertificateCheck {
    /// Issued by a Bambu Lab CA for this printer's serial.
    pub verified: bool,
    /// What was found, in plain words, for diagnostics.
    pub detail: String,
}

fn checks() -> &'static Mutex<HashMap<String, CertificateCheck>> {
    static CHECKS: OnceLock<Mutex<HashMap<String, CertificateCheck>>> = OnceLock::new();
    CHECKS.get_or_init(Mutex::default)
}

/// The certificate check of the last Bambu Lab connection to `host`, if there was one.
pub fn certificate_check(host: &str) -> Option<CertificateCheck> {
    checks().lock().ok()?.get(host).cloned()
}

impl ServerCertVerifier for AcceptSelfSigned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, TlsError> {
        if let Some(o) = &self.observe {
            let intermediates: Vec<&[u8]> = intermediates.iter().map(AsRef::as_ref).collect();
            let check = check_chain(
                end_entity.as_ref(),
                &intermediates,
                &o.serial,
                bambu_anchors(),
                &self.provider,
            );
            if let Ok(mut map) = checks().lock() {
                map.insert(o.host.clone(), check);
            }
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, TlsError> {
        // webpki parses only X.509 v3, and Bambu Lab printers present v1 certificates; the key is
        // read here and the signature checked against it either way.
        match verify_with_key(message, cert, dss, &self.provider) {
            Some(r) => r,
            None => verify_tls12_signature(
                message,
                cert,
                dss,
                &self.provider.signature_verification_algorithms,
            ),
        }
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, TlsError> {
        match verify_with_key(message, cert, dss, &self.provider) {
            Some(r) => r,
            None => verify_tls13_signature(
                message,
                cert,
                dss,
                &self.provider.signature_verification_algorithms,
            ),
        }
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Checks a handshake signature against the public key in `cert`, a certificate of any X.509
/// version. None when the certificate cannot be read, so the caller falls back to webpki.
fn verify_with_key(
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
    provider: &CryptoProvider,
) -> Option<std::result::Result<HandshakeSignatureValid, TlsError>> {
    let (alg_id, key) = public_key(cert.as_ref())?;
    let algs = provider
        .signature_verification_algorithms
        .mapping
        .iter()
        .find(|(scheme, _)| *scheme == dss.scheme)
        .map(|(_, algs)| *algs);
    let Some(algs) = algs else {
        return Some(Err(TlsError::PeerMisbehaved(
            rustls::PeerMisbehaved::SignedHandshakeWithUnadvertisedSigScheme,
        )));
    };
    for alg in algs {
        if alg.public_key_alg_id().as_ref() != alg_id {
            continue;
        }
        return Some(match alg.verify_signature(key, message, dss.signature()) {
            Ok(()) => Ok(HandshakeSignatureValid::assertion()),
            Err(_) => Err(TlsError::InvalidCertificate(
                rustls::CertificateError::BadSignature,
            )),
        });
    }
    Some(Err(TlsError::General(format!(
        "the printer's key cannot make {:?} signatures",
        dss.scheme
    ))))
}

/// The parts of a DER certificate the checks read. Version 1 certificates have no `[0]` version
/// field; v2 and v3 do.
struct Cert<'a> {
    /// The whole TBSCertificate element, what the issuer signed.
    tbs: &'a [u8],
    /// The contents of the signature AlgorithmIdentifier.
    signature_alg: &'a [u8],
    signature: &'a [u8],
    /// The whole issuer and subject Name elements.
    issuer: &'a [u8],
    subject: &'a [u8],
    /// The contents of the key's AlgorithmIdentifier, and the key bits.
    key_alg: &'a [u8],
    key: &'a [u8],
}

fn parse(cert: &[u8]) -> Option<Cert<'_>> {
    let (_, certificate, _) = der(cert, 0x30)?;
    let (tbs, mut fields, rest) = element(certificate, 0x30)?;
    let (_, signature_alg, rest) = der(rest, 0x30)?;
    let (_, signature, _) = der(rest, 0x03)?;
    if fields.first() == Some(&0xa0) {
        fields = der(fields, 0xa0)?.2;
    }
    // serial and signature algorithm, then issuer, validity and subject, then the key
    let fields = der(fields, 0x02)?.2;
    let fields = der(fields, 0x30)?.2;
    let (issuer, _, fields) = element(fields, 0x30)?;
    let fields = der(fields, 0x30)?.2;
    let (subject, _, fields) = element(fields, 0x30)?;
    let (_, spki, _) = der(fields, 0x30)?;
    let (_, key_alg, rest) = der(spki, 0x30)?;
    let (_, key, _) = der(rest, 0x03)?;
    Some(Cert {
        tbs,
        signature_alg,
        signature: bits(signature)?,
        issuer,
        subject,
        key_alg,
        key: bits(key)?,
    })
}

/// A bit string's bits: it starts with its count of unused bits, which is 0 for keys and signatures.
fn bits(b: &[u8]) -> Option<&[u8]> {
    match b.split_first()? {
        (&0, rest) => Some(rest),
        _ => None,
    }
}

/// The subjectPublicKeyInfo of a DER certificate: the algorithm identifier's contents and the key bits.
fn public_key(cert: &[u8]) -> Option<(&[u8], &[u8])> {
    let c = parse(cert)?;
    Some((c.key_alg, c.key))
}

/// The common name in a DER Name, when it is a string.
fn common_name(name: &[u8]) -> Option<String> {
    const CN: &[u8] = &[0x55, 0x04, 0x03];
    let (_, mut sets, _) = der(name, 0x30)?;
    while !sets.is_empty() {
        let (_, set, rest) = der(sets, 0x31)?;
        sets = rest;
        let (_, pair, _) = der(set, 0x30)?;
        let (_, oid, value) = der(pair, 0x06)?;
        if oid == CN {
            let tag = *value.first()?;
            let (_, text, _) = der(value, tag)?;
            return String::from_utf8(text.to_vec()).ok();
        }
    }
    None
}

/// A trust anchor: its Name and key.
struct Anchor {
    subject: Vec<u8>,
    key_alg: Vec<u8>,
    key: Vec<u8>,
}

fn anchors_from(pem: &str) -> Vec<Anchor> {
    use rustls::pki_types::pem::PemObject;
    CertificateDer::pem_slice_iter(pem.as_bytes())
        .filter_map(std::result::Result::ok)
        .filter_map(|c| {
            let p = parse(c.as_ref())?;
            Some(Anchor {
                subject: p.subject.to_vec(),
                key_alg: p.key_alg.to_vec(),
                key: p.key.to_vec(),
            })
        })
        .collect()
}

/// Bambu Lab's printer CAs, from Bambu Studio's printer.cer (certs/bambu-ca.pem, AGPL-3.0, see REUSE.toml).
fn bambu_anchors() -> &'static [Anchor] {
    static ANCHORS: OnceLock<Vec<Anchor>> = OnceLock::new();
    ANCHORS.get_or_init(|| anchors_from(include_str!("../certs/bambu-ca.pem")))
}

/// Whether a key signed `cert`'s contents.
fn signed_by(c: &Cert<'_>, key_alg: &[u8], key: &[u8], provider: &CryptoProvider) -> bool {
    provider.signature_verification_algorithms.all.iter().any(|alg| {
        alg.signature_alg_id().as_ref() == c.signature_alg
            && alg.public_key_alg_id().as_ref() == key_alg
            && alg.verify_signature(key, c.tbs, c.signature).is_ok()
    })
}

/// [`check_certificate`], and when the leaf names no Bambu Lab CA as its issuer, a device CA the
/// printer sent with it (BBL Device CA N7-V2 on a P2S, O1C2-V2 on an H2C, N6-V2 on an X2D) that a
/// Bambu Lab CA signed and that signed the leaf.
fn check_chain(
    cert: &[u8],
    intermediates: &[&[u8]],
    serial: &str,
    anchors: &[Anchor],
    provider: &CryptoProvider,
) -> CertificateCheck {
    let direct = check_certificate(cert, serial, anchors, provider);
    let Some(leaf) = parse(cert) else {
        return direct;
    };
    if direct.verified || anchors.iter().any(|a| a.subject == leaf.issuer) {
        return direct;
    }
    let by_device_ca = intermediates.iter().filter_map(|i| parse(i)).find(|ca| {
        ca.subject == leaf.issuer
            && signed_by(&leaf, ca.key_alg, ca.key, provider)
            && anchors
                .iter()
                .any(|a| a.subject == ca.issuer && signed_by(ca, &a.key_alg, &a.key, provider))
    });
    match by_device_ca {
        Some(ca) if direct.detail.contains("not issued") => CertificateCheck {
            verified: true,
            detail: format!(
                "issued by Bambu Lab for this printer, through {}",
                common_name(ca.subject).unwrap_or_else(|| "a device CA".to_owned())
            ),
        },
        _ => direct,
    }
}

/// Whether `cert` was issued by one of `anchors` for the printer with `serial`. A Bambu Lab
/// printer's certificate names its serial as the common name.
fn check_certificate(
    cert: &[u8],
    serial: &str,
    anchors: &[Anchor],
    provider: &CryptoProvider,
) -> CertificateCheck {
    let unverified = |detail: &str| CertificateCheck {
        verified: false,
        detail: detail.to_owned(),
    };
    let Some(c) = parse(cert) else {
        return unverified("the printer's certificate could not be read");
    };
    if !common_name(c.subject).is_some_and(|cn| cn.eq_ignore_ascii_case(serial)) {
        return unverified("the certificate is not for this printer's serial number");
    }
    let Some(anchor) = anchors.iter().find(|a| a.subject == c.issuer) else {
        return unverified("the certificate was not issued by a Bambu Lab CA");
    };
    if signed_by(&c, &anchor.key_alg, &anchor.key, provider) {
        CertificateCheck {
            verified: true,
            detail: "issued by Bambu Lab for this printer".to_owned(),
        }
    } else {
        unverified("the certificate names a Bambu Lab CA, but its signature does not match it")
    }
}

/// One DER element with tag `want` at the start of `input`: (tag, contents, rest).
fn der(input: &[u8], want: u8) -> Option<(u8, &[u8], &[u8])> {
    let (_, contents, rest) = element(input, want)?;
    Some((want, contents, rest))
}

/// One DER element with tag `want` at the start of `all`: (the whole element, contents, rest).
fn element(all: &[u8], want: u8) -> Option<(&[u8], &[u8], &[u8])> {
    let (&tag, input) = all.split_first()?;
    if tag != want {
        return None;
    }
    let (&first, mut input) = input.split_first()?;
    let len = if first < 0x80 {
        usize::from(first)
    } else {
        let n = usize::from(first & 0x7f);
        if n == 0 || n > 4 || input.len() < n {
            return None;
        }
        let (bytes, rest) = input.split_at(n);
        input = rest;
        bytes.iter().fold(0usize, |a, &b| (a << 8) | usize::from(b))
    };
    if input.len() < len {
        return None;
    }
    let (contents, rest) = input.split_at(len);
    Some((all.get(..all.len() - rest.len())?, contents, rest))
}

/// The subject common name of a DER certificate. A Bambu Lab printer's LAN certificate names its
/// serial number there.
pub(crate) fn subject_common_name(cert: &[u8]) -> Option<String> {
    common_name(parse(cert)?.subject)
}

/// Opens TLS 1.2 to `host:port` without SNI and returns the leaf certificate's subject common name,
/// whoever signed it. Nothing is sent after the handshake. Checked on an H2D: an SNI it does not
/// expect gets no answer, none at all gets the certificate.
pub(crate) async fn peer_common_name(host: &str, port: u16, timeout: std::time::Duration) -> Option<String> {
    let ip: std::net::IpAddr = host.parse().ok()?;
    let run = async {
        let tcp = tokio::net::TcpStream::connect((ip, port)).await.ok()?;
        let connector = tokio_rustls::TlsConnector::from(bambu_lan_config().ok()?);
        let tls = connector
            .connect(rustls::pki_types::ServerName::IpAddress(ip.into()), tcp)
            .await
            .ok()?;
        let leaf = tls.get_ref().1.peer_certificates()?.first()?.as_ref().to_vec();
        subject_common_name(&leaf)
    };
    tokio::time::timeout(timeout, run).await.ok().flatten()
}

/// TLS 1.2 only, for Bambu Lab's MQTT (8883), FTPS (990) and camera (6000 and RTSPS 322) ports. Every Bambu Lab
/// printer speaks 1.2, and P2S firmware 01.02.00.00 reportedly never answers a 1.3 hello.
const BAMBU_VERSIONS: &[&rustls::SupportedProtocolVersion] = &[&rustls::version::TLS12];

pub(crate) fn lan_client_config() -> Result<Arc<ClientConfig>> {
    client_config(None, rustls::DEFAULT_VERSIONS)
}

/// The LAN config for a Bambu Lab printer's FTPS and camera ports, where no check is recorded.
pub(crate) fn bambu_lan_config() -> Result<Arc<ClientConfig>> {
    client_config(None, BAMBU_VERSIONS)
}

/// The LAN config for a Bambu Lab printer: it connects whatever the certificate, and records
/// whether Bambu Lab's CA issued it for `serial`, under `host` (`certificate_check`).
pub(crate) fn bambu_client_config(serial: &str, host: &str) -> Result<Arc<ClientConfig>> {
    client_config(
        Some(Observe {
            serial: serial.to_owned(),
            host: host.to_owned(),
        }),
        BAMBU_VERSIONS,
    )
}

fn client_config(
    observe: Option<Observe>,
    versions: &[&'static rustls::SupportedProtocolVersion],
) -> Result<Arc<ClientConfig>> {
    let provider = Arc::new(ring::default_provider());
    let cfg = ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(versions)
        .map_err(|e| Error::Config(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptSelfSigned { provider, observe }))
        .with_no_client_auth();
    Ok(Arc::new(cfg))
}

/// A client config that trusts no certificate at all. Plain `http://` printers never use it;
/// it exists so an `https://` redirect or URL fails instead of being trusted by accident.
pub(crate) fn no_trust_config() -> Result<Arc<ClientConfig>> {
    let cfg = ClientConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::Config(e.to_string()))?
        .with_root_certificates(rustls::RootCertStore::empty())
        .with_no_client_auth();
    Ok(Arc::new(cfg))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
    use rustls::server::{ClientHello, ResolvesServerCert};
    use rustls::sign::CertifiedKey;
    use rustls::{ClientConfig, ServerConfig, SupportedProtocolVersion};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use super::{
        anchors_from, bambu_anchors, bambu_client_config, bambu_lan_config, certificate_check,
        check_certificate, check_chain, common_name, lan_client_config, parse, public_key,
    };

    #[derive(Debug)]
    struct Fixed(Arc<CertifiedKey>);

    impl ResolvesServerCert for Fixed {
        fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
            Some(self.0.clone())
        }
    }

    // A throwaway key and an X.509 v1 certificate, the kind Bambu Lab printers present (an H2D
    // sends a v1 RSA 2048 certificate from "BBL CA"). Made once with OpenSSL; they guard nothing.
    const CERT: &[u8] = include_bytes!("../tests/fixtures/v1-test.cert.pem");
    const KEY: &[u8] = include_bytes!("../tests/fixtures/v1-test.key.pem");

    // A test CA and a v1 leaf it signed for serial 01P00A000000001, like a printer's; and the same leaf
    // signed by a self-made CA that calls itself "BBL CA". Throwaway keys, made once with OpenSSL.
    const TEST_CA: &str = include_str!("../tests/fixtures/test-ca.cert.pem");
    const SIGNED_LEAF: &[u8] = include_bytes!("../tests/fixtures/signed-leaf.cert.pem");
    const SIGNED_KEY: &[u8] = include_bytes!("../tests/fixtures/signed-leaf.key.pem");
    const LOOKALIKE_LEAF: &[u8] = include_bytes!("../tests/fixtures/lookalike-leaf.cert.pem");
    const SERIAL: &str = "01P00A000000001";

    async fn handshake(version: &'static SupportedProtocolVersion) -> std::io::Result<Vec<u8>> {
        handshake_with(version, CERT, KEY, lan_client_config().unwrap()).await
    }

    /// Serves `cert` with `key` once and connects to it with `client`; the bytes the server sent.
    async fn handshake_with(
        version: &'static SupportedProtocolVersion,
        cert: &[u8],
        key: &[u8],
        client: Arc<ClientConfig>,
    ) -> std::io::Result<Vec<u8>> {
        let cert = CertificateDer::from_pem_slice(cert).unwrap();
        let key = PrivateKeyDer::from_pem_slice(key).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        // with_single_cert would check the key against the certificate with webpki, which refuses
        // v1 too; a printer has no such check, so the pair is served as it is.
        let signer = provider.key_provider.load_private_key(key).unwrap();
        let certified = Arc::new(CertifiedKey::new(vec![cert], signer));
        let server = ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[version])
            .unwrap()
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(Fixed(certified)));
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server));
        let serve = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await?;
            let mut tls = acceptor.accept(tcp).await?;
            tls.write_all(b"ok").await?;
            tls.shutdown().await
        });
        let connector = tokio_rustls::TlsConnector::from(client);
        let tcp = TcpStream::connect(addr).await?;
        let name = ServerName::try_from("192.0.2.1").unwrap();
        let mut tls = connector.connect(name, tcp).await?;
        let mut got = Vec::new();
        tls.read_to_end(&mut got).await?;
        serve.await.unwrap()?;
        Ok(got)
    }

    #[tokio::test]
    async fn a_printer_with_a_version_1_certificate_completes_the_handshake() {
        for version in [&rustls::version::TLS12, &rustls::version::TLS13] {
            let got = handshake(version).await;
            assert_eq!(
                got.as_deref().map_err(ToString::to_string),
                Ok(&b"ok"[..]),
                "{version:?}"
            );
        }
    }

    #[tokio::test]
    async fn bambu_lab_ports_offer_tls_1_2_only() {
        // A printer that takes 1.2 connects; one that takes only 1.3 is never offered it.
        for client in [
            bambu_lan_config().unwrap(),
            bambu_client_config(SERIAL, "192.0.2.78").unwrap(),
        ] {
            let got = handshake_with(&rustls::version::TLS12, CERT, KEY, client.clone()).await;
            assert_eq!(got.as_deref().map_err(ToString::to_string), Ok(&b"ok"[..]));
            assert!(
                handshake_with(&rustls::version::TLS13, CERT, KEY, client)
                    .await
                    .is_err()
            );
        }
    }

    #[test]
    fn the_key_is_read_from_a_version_1_certificate() {
        let cert = CertificateDer::from_pem_slice(CERT).unwrap();
        let (alg, key) = public_key(cert.as_ref()).expect("a v1 certificate's key");
        // rsaEncryption, then the RSA key: a SEQUENCE of modulus and exponent
        assert!(alg.starts_with(&[0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]));
        assert_eq!(key.first(), Some(&0x30));
    }

    fn der(pem: &[u8]) -> CertificateDer<'static> {
        CertificateDer::from_pem_slice(pem).unwrap()
    }

    fn provider() -> rustls::crypto::CryptoProvider {
        rustls::crypto::ring::default_provider()
    }

    #[test]
    fn the_bundled_bambu_lab_cas_load() {
        let names: Vec<String> = bambu_anchors()
            .iter()
            .filter_map(|a| common_name(&a.subject))
            .collect();
        assert_eq!(names, ["BBL CA", "BBL CA2 RSA", "BBL CA2 ECC"]);
    }

    #[test]
    fn a_v1_leaf_signed_by_a_trusted_ca_for_this_serial_is_verified() {
        let leaf = der(SIGNED_LEAF);
        assert!(parse(leaf.as_ref()).is_some(), "a v1 leaf parses");
        let check = check_certificate(leaf.as_ref(), SERIAL, &anchors_from(TEST_CA), &provider());
        assert!(check.verified, "{check:?}");
        // the serial is compared without regard to case, as printers and labels differ
        assert!(
            check_certificate(
                leaf.as_ref(),
                &SERIAL.to_lowercase(),
                &anchors_from(TEST_CA),
                &provider()
            )
            .verified
        );
    }

    #[test]
    fn a_certificate_for_another_serial_is_not_verified() {
        let check = check_certificate(
            der(SIGNED_LEAF).as_ref(),
            "01P00A000000002",
            &anchors_from(TEST_CA),
            &provider(),
        );
        assert!(!check.verified);
        assert!(check.detail.contains("serial"), "{check:?}");
    }

    #[test]
    fn a_self_made_bbl_ca_lookalike_is_not_verified() {
        let check = check_certificate(der(LOOKALIKE_LEAF).as_ref(), SERIAL, bambu_anchors(), &provider());
        assert!(!check.verified);
        assert!(check.detail.contains("signature"), "{check:?}");
    }

    // A root, a device CA it signed and a leaf the device CA signed for SERIAL, the shape of a P2S or
    // H2C chain (BBL CA2 RSA, BBL Device CA N7-V2, the printer). Throwaway, made once with OpenSSL.
    const CHAIN_ROOT: &str = include_str!("../tests/fixtures/chain-root.cert.pem");
    const CHAIN_DEVICE_CA: &[u8] = include_bytes!("../tests/fixtures/chain-device-ca.cert.pem");
    const CHAIN_LEAF: &[u8] = include_bytes!("../tests/fixtures/chain-leaf.cert.pem");

    #[test]
    fn a_leaf_from_a_device_ca_that_a_trusted_ca_signed_is_verified() {
        let (leaf, ca) = (der(CHAIN_LEAF), der(CHAIN_DEVICE_CA));
        let anchors = anchors_from(CHAIN_ROOT);
        let check = check_chain(leaf.as_ref(), &[ca.as_ref()], SERIAL, &anchors, &provider());
        assert!(check.verified, "{check:?}");
        assert!(check.detail.contains("Test Device CA N7-V2"), "{check:?}");
        // Without the device CA the leaf names no trusted issuer.
        assert!(!check_chain(leaf.as_ref(), &[], SERIAL, &anchors, &provider()).verified);
        // The device CA does not make a leaf for another printer good.
        assert!(
            !check_chain(
                leaf.as_ref(),
                &[ca.as_ref()],
                "01P00A000000002",
                &anchors,
                &provider()
            )
            .verified
        );
        // A device CA no trusted CA signed proves nothing.
        assert!(
            !check_chain(
                leaf.as_ref(),
                &[ca.as_ref()],
                SERIAL,
                &anchors_from(TEST_CA),
                &provider()
            )
            .verified
        );
    }

    #[test]
    fn a_certificate_from_another_issuer_is_not_verified() {
        let check = check_certificate(der(SIGNED_LEAF).as_ref(), SERIAL, bambu_anchors(), &provider());
        assert!(!check.verified);
        assert!(check.detail.contains("not issued by a Bambu Lab CA"), "{check:?}");
    }

    #[tokio::test]
    async fn a_bambu_lab_connection_goes_ahead_and_records_the_check() {
        // The lookalike is refused by the check, but the connection still comes up: the check only records.
        let host = "192.0.2.77";
        let client = bambu_client_config(SERIAL, host).unwrap();
        let got = handshake_with(&rustls::version::TLS12, LOOKALIKE_LEAF, SIGNED_KEY, client).await;
        assert_eq!(got.as_deref().map_err(ToString::to_string), Ok(&b"ok"[..]));
        let check = certificate_check(host).expect("a recorded check");
        assert!(!check.verified, "{check:?}");
    }

    /// A real printer's certificate, for checking the bundled CAs against hardware. Runs only with
    /// SX_BAMBU_LEAF (a PEM file, from `openssl s_client -connect <printer>:8883`) and SX_BAMBU_SERIAL set.
    #[test]
    fn a_real_bambu_lab_printer_certificate_is_verified() {
        let (Ok(path), Ok(serial)) = (std::env::var("SX_BAMBU_LEAF"), std::env::var("SX_BAMBU_SERIAL"))
        else {
            return;
        };
        let pem = std::fs::read(path).unwrap();
        let check = check_certificate(der(&pem).as_ref(), &serial, bambu_anchors(), &provider());
        assert!(check.verified, "{check:?}");
    }
}
