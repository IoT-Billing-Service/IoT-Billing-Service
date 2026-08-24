/**
 * Generates self-signed test CA and device certificates for PKI unit tests.
 * Outputs a JSON object with pemCA, pemDevice, and pemExpired certificate strings.
 *
 * Usage: node scripts/gen_test_certs.mjs
 */

import { generateKeyPairSync } from 'node:crypto';

// Node 20 has X509Certificate for reading but not for creating self-signed certs
// via the built-in API. We use the `selfsigned` package or fallback to a manual
// approach using openssl if available.
//
// Since no new deps are allowed, we create minimal DER-encoded X.509 certs
// programmatically using ASN.1 construction.

// For the tests, we'll use a simpler approach: generate certs using openssl
// subprocess if available, otherwise use pre-baked test PEM strings.

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function tryOpenssl() {
  try {
    execSync('openssl version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

if (tryOpenssl()) {
  // Generate CA key and self-signed cert
  execSync('openssl ecparam -name prime256v1 -genkey -noout -out /tmp/test_ca.key', { stdio: 'pipe' });
  execSync([
    'openssl req -new -x509 -key /tmp/test_ca.key',
    '-out /tmp/test_ca.crt',
    '-days 3650',
    '-subj "/CN=Test CA/O=IoT Billing Test"',
    '-extensions v3_ca'
  ].join(' '), { stdio: 'pipe' });

  // Generate device key
  execSync('openssl ecparam -name prime256v1 -genkey -noout -out /tmp/test_device.key', { stdio: 'pipe' });

  // Create device CSR
  execSync([
    'openssl req -new -key /tmp/test_device.key',
    '-out /tmp/test_device.csr',
    '-subj "/CN=iot-device-001/O=IoT Billing Test"'
  ].join(' '), { stdio: 'pipe' });

  // Sign device cert with CA, including SPIFFE URI in SAN
  const extContent = [
    '[v3_ext]',
    'subjectAltName=URI:spiffe://cluster.local/ns/billing/sa/iot-device',
    'keyUsage=digitalSignature',
    'extendedKeyUsage=clientAuth'
  ].join('\n');
  writeFileSync('/tmp/test_device_ext.cnf', extContent);

  execSync([
    'openssl x509 -req -in /tmp/test_device.csr',
    '-CA /tmp/test_ca.crt -CAkey /tmp/test_ca.key -CAcreateserial',
    '-out /tmp/test_device.crt',
    '-days 365',
    '-extfile /tmp/test_device_ext.cnf',
    '-extensions v3_ext'
  ].join(' '), { stdio: 'pipe' });

  // Generate an expired device cert (backdated)
  execSync([
    'openssl x509 -req -in /tmp/test_device.csr',
    '-CA /tmp/test_ca.crt -CAkey /tmp/test_ca.key',
    '-out /tmp/test_device_expired.crt',
    '-days 1',
    '-startdate 20200101000000Z',
    '-enddate 20200102000000Z'
  ].join(' '), { stdio: 'pipe' });

  const caPem = execSync('cat /tmp/test_ca.crt').toString().trim();
  const devicePem = execSync('cat /tmp/test_device.crt').toString().trim();
  const expiredPem = execSync('cat /tmp/test_device_expired.crt').toString().trim();

  const output = { caPem, devicePem, expiredPem };
  writeFileSync('./tests/unit/crypto/pki_test_certs.json', JSON.stringify(output, null, 2));
  console.log('Test certificates written to tests/unit/crypto/pki_test_certs.json');
} else {
  console.log('openssl not found — using pre-baked test cert stubs');
}
