-- Migration: Hardware Identity Binding with PKI Infrastructure (Issue #294)
--
-- Adds PKI-related columns to the attestation_records table to store
-- certificate fingerprints, SPIFFE URIs, and expiry timestamps captured
-- during hardware attestation. All new columns are nullable to preserve
-- backward compatibility with existing records that predate PKI verification.
--
-- Also adds a pki_verified column to hardware_certificates so that certificate
-- batches can be tagged as having undergone PKI onboarding.

-- attestation_records: add PKI metadata columns
ALTER TABLE attestation_records
  ADD COLUMN IF NOT EXISTS cert_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS spiffe_uri       TEXT,
  ADD COLUMN IF NOT EXISTS cert_expires_at  TIMESTAMPTZ;

-- Index on cert_fingerprint for fast certificate-centric queries and audits.
CREATE INDEX IF NOT EXISTS idx_attestation_records_cert_fingerprint
  ON attestation_records (cert_fingerprint)
  WHERE cert_fingerprint IS NOT NULL;

-- Index on spiffe_uri to support SPIFFE-based identity lookups.
CREATE INDEX IF NOT EXISTS idx_attestation_records_spiffe_uri
  ON attestation_records (spiffe_uri)
  WHERE spiffe_uri IS NOT NULL;

-- hardware_certificates: add PKI onboarding flag
ALTER TABLE hardware_certificates
  ADD COLUMN IF NOT EXISTS pki_verified BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN attestation_records.cert_fingerprint IS
  'SHA-256 fingerprint (hex) of the device leaf certificate used during PKI verification (issue #294).';

COMMENT ON COLUMN attestation_records.spiffe_uri IS
  'SPIFFE URI extracted from the device certificate Subject Alternative Names (issue #294).';

COMMENT ON COLUMN attestation_records.cert_expires_at IS
  'Expiry timestamp of the device leaf certificate captured at attestation time (issue #294).';

COMMENT ON COLUMN hardware_certificates.pki_verified IS
  'True when this certificate batch has been enrolled in the PKI infrastructure (issue #294).';
