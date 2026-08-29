/**
 * Generates self-signed X.509 test fixtures for PKI unit tests.
 * Uses only Node.js 20 built-in crypto — no external dependencies.
 *
 * Uses the generateCertificate API available in newer node versions,
 * falling back to a forge-less DER build.
 */

import { generateKeyPairSync, X509Certificate, createSign, createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';

// ── ASN.1 / DER encoding helpers ──────────────────────────────────────────────

function encLen(len) {
  if (len < 128) return Buffer.from([len]);
  if (len < 256) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function tlv(tag, content) {
  const c = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), encLen(c.length), c]);
}

const seq = (...parts) => tlv(0x30, Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p))));
const setOf = (...parts) => tlv(0x31, Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p))));
const ctx0 = (c) => tlv(0xa0, c);
const ctx3 = (c) => tlv(0xa3, c);
const implCtx6 = (s) => tlv(0x86, Buffer.from(s, 'ascii')); // URI generalName

// Primitives
const boolDer = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const intDer = (hex) => {
  const b = Buffer.from(hex, 'hex');
  // Add leading zero if high bit set (to keep it positive)
  return tlv(0x02, (b[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), b]) : b);
};
const bitStringDer = (bytes) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), bytes]));
const octetStringDer = (bytes) => tlv(0x04, bytes);
const oidDer = (bytes) => tlv(0x06, Buffer.from(bytes));
const utf8Str = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const printStr = (s) => tlv(0x13, Buffer.from(s, 'ascii'));

// Generalized time: YYYYMMDDHHmmssZ
const genTime = (d) => {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const s = `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x18, Buffer.from(s, 'ascii'));
};

// OIDs
const OID_EC_PUBKEY = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256      = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_ECDSA_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const OID_CN        = [0x55, 0x04, 0x03];
const OID_ORG       = [0x55, 0x04, 0x0a];
const OID_SAN       = [0x55, 0x1d, 0x11];
const OID_BC        = [0x55, 0x1d, 0x13];

function rdnSeq(pairs) {
  return seq(...pairs.map(([o, v]) => setOf(seq(oidDer(o), printStr(v)))));
}

function algId() {
  return seq(oidDer(OID_ECDSA_SHA256));
}

function spkiFromRaw(rawPub) {
  return seq(seq(oidDer(OID_EC_PUBKEY), oidDer(OID_P256)), bitStringDer(rawPub));
}

function extBasicConstraints(isCA) {
  const value = isCA ? seq(boolDer(true)) : seq();
  return seq(oidDer(OID_BC), boolDer(true), octetStringDer(value));
}

function extSAN(uris) {
  const generalNames = uris.map(u => implCtx6(u));
  const value = seq(...generalNames);
  return seq(oidDer(OID_SAN), octetStringDer(value));
}

function buildTbsCert({ serial, issuerPairs, subjectPairs, notBefore, notAfter, rawPublicKey, extensions }) {
  const version = ctx0(intDer('02')); // v3 = 2
  const serialInt = intDer(serial.toString(16).padStart(2, '0'));
  const sig = algId();
  const issuer = rdnSeq(issuerPairs);
  const validity = seq(genTime(notBefore), genTime(notAfter));
  const subject = rdnSeq(subjectPairs);
  const spki = spkiFromRaw(rawPublicKey);

  const parts = [version, serialInt, sig, issuer, validity, subject, spki];
  if (extensions && extensions.length > 0) {
    parts.push(ctx3(seq(...extensions)));
  }
  return seq(...parts);
}

function signAndBuild(tbs, privKeyPem) {
  const signer = createSign('SHA256');
  signer.update(tbs);
  signer.end();
  const sig = signer.sign(privKeyPem);
  return seq(tbs, algId(), bitStringDer(sig));
}

function toPem(der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

// ── Generate key pairs ────────────────────────────────────────────────────────

function makeKeyPair() {
  const { publicKey: pubDer, privateKey: privPem } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  // The last 65 bytes of a P-256 SPKI are the uncompressed point (04 || x || y)
  const rawPub = Buffer.from(pubDer).slice(-65);
  return { rawPub, privPem };
}

const caKey = makeKeyPair();
const deviceKey = makeKeyPair();
const untrustedCaKey = makeKeyPair();

const now = Date.now();
const MS = (d) => new Date(now + d * 86400000);

const CA_PAIRS = [[OID_CN, 'IoT Billing Test CA'], [OID_ORG, 'IoT Billing Test']];
const DEV_PAIRS = [[OID_CN, 'iot-device-001'], [OID_ORG, 'IoT Billing Test']];
const SPIFFE_URI = 'spiffe://cluster.local/ns/billing/sa/iot-device';

// CA cert (self-signed)
const caTbs = buildTbsCert({
  serial: 1,
  issuerPairs: CA_PAIRS,
  subjectPairs: CA_PAIRS,
  notBefore: MS(-1),
  notAfter: MS(3650),
  rawPublicKey: caKey.rawPub,
  extensions: [extBasicConstraints(true)],
});
const caDer = signAndBuild(caTbs, caKey.privPem);
const caPem = toPem(caDer);

// Valid device cert (signed by CA, has SPIFFE URI)
const devTbs = buildTbsCert({
  serial: 2,
  issuerPairs: CA_PAIRS,
  subjectPairs: DEV_PAIRS,
  notBefore: MS(-1),
  notAfter: MS(365),
  rawPublicKey: deviceKey.rawPub,
  extensions: [extBasicConstraints(false), extSAN([SPIFFE_URI])],
});
const devDer = signAndBuild(devTbs, caKey.privPem);
const devicePem = toPem(devDer);

// Expired device cert
const expiredTbs = buildTbsCert({
  serial: 3,
  issuerPairs: CA_PAIRS,
  subjectPairs: [[OID_CN, 'iot-device-expired']],
  notBefore: new Date('2020-01-01T00:00:00Z'),
  notAfter:  new Date('2020-01-02T00:00:00Z'),
  rawPublicKey: deviceKey.rawPub,
  extensions: [extBasicConstraints(false)],
});
const expiredDer = signAndBuild(expiredTbs, caKey.privPem);
const expiredPem = toPem(expiredDer);

// Untrusted device cert (signed by a different CA)
const untrustedTbs = buildTbsCert({
  serial: 4,
  issuerPairs: [[OID_CN, 'Untrusted CA']],
  subjectPairs: [[OID_CN, 'iot-device-untrusted']],
  notBefore: MS(-1),
  notAfter: MS(365),
  rawPublicKey: deviceKey.rawPub,
  extensions: [extBasicConstraints(false)],
});
const untrustedDer = signAndBuild(untrustedTbs, untrustedCaKey.privPem);
const untrustedPem = toPem(untrustedDer);

// Soon-to-expire device cert (20 days from now — still inside the 30-day warn
// window used by the expiry-warning tests, but beyond the 3-day window, so
// both assertions hold for a comfortable CI lifetime).
const soonTbs = buildTbsCert({
  serial: 5,
  issuerPairs: CA_PAIRS,
  subjectPairs: [[OID_CN, 'iot-device-soon-expire']],
  notBefore: MS(-1),
  notAfter: MS(20),
  rawPublicKey: deviceKey.rawPub,
  extensions: [extBasicConstraints(false)],
});
const soonDer = signAndBuild(soonTbs, caKey.privPem);
const soonExpiryPem = toPem(soonDer);

// Future (not yet valid) device cert — starts 30 days from now so the
// CERT_NOT_YET_VALID assertion holds for a comfortable CI lifetime.
const futureTbs = buildTbsCert({
  serial: 6,
  issuerPairs: CA_PAIRS,
  subjectPairs: [[OID_CN, 'iot-device-future']],
  notBefore: MS(30),
  notAfter: MS(365),
  rawPublicKey: deviceKey.rawPub,
  extensions: [extBasicConstraints(false)],
});
const futureDer = signAndBuild(futureTbs, caKey.privPem);
const futurePem = toPem(futureDer);

// ── Verify certs are parseable ────────────────────────────────────────────────

for (const [name, pem] of Object.entries({ caPem, devicePem, expiredPem, untrustedPem, soonExpiryPem, futurePem })) {
  try {
    const cert = new X509Certificate(pem);
    console.log(`✓ ${name}: subject="${cert.subject}", SAN="${cert.subjectAltName || 'none'}"`);
  } catch (e) {
    console.error(`✗ ${name}: ${e.message}`);
    process.exit(1);
  }
}

// ── Write output ──────────────────────────────────────────────────────────────

const outDir = './tests/unit/crypto';
mkdirSync(outDir, { recursive: true });

writeFileSync(`${outDir}/pki_test_certs.json`, JSON.stringify(
  { caPem, devicePem, expiredPem, untrustedPem, soonExpiryPem, futurePem },
  null, 2,
));
console.log('\nPKI test fixtures written to', `${outDir}/pki_test_certs.json`);
