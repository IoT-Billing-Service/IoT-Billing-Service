/**
 * OAuth2 Scope Registry — Issue #57
 *
 * Defines every scope that the billing platform may grant to third-party
 * clients. Scopes are deliberately narrow following the principle of least
 * privilege required by SOC2 and PCI-DSS.
 *
 * Hierarchy convention:
 *   <resource>:read   — inspect resource data, never mutate
 *   <resource>:write  — create / update resource data
 *   <resource>:admin  — destructive / privileged operations (revoke, delete)
 */

export const OAUTH2_SCOPES = {
  /** Read billing records and cycle summaries for owned accounts. */
  BILLING_READ: 'billing:read',
  /** Create billing records and trigger cycle finalisation. */
  BILLING_WRITE: 'billing:write',
  /** Read device metadata (serial, status, tier) for owned devices. */
  DEVICES_READ: 'devices:read',
  /** Read aggregated telemetry analytics for owned devices. */
  ANALYTICS_READ: 'analytics:read',
  /** Read account balance and profile information. */
  ACCOUNT_READ: 'account:read',
} as const;

export type OAuth2Scope = (typeof OAUTH2_SCOPES)[keyof typeof OAUTH2_SCOPES];

/** All valid scope strings as a set for O(1) membership checks. */
export const ALL_SCOPES = new Set<string>(Object.values(OAUTH2_SCOPES));

/**
 * Returns true when every space-separated token in `requested` is a member
 * of `ALL_SCOPES` and also present in `allowed`.
 */
export function validateScopes(requested: string, allowed: string): boolean {
  const allowedSet = new Set(allowed.split(' ').filter(Boolean));
  return requested
    .split(' ')
    .filter(Boolean)
    .every((s) => ALL_SCOPES.has(s) && allowedSet.has(s));
}

/**
 * Normalise a raw scope string: deduplicate tokens, sort for deterministic
 * storage, drop any unknown scopes.
 */
export function normaliseScopes(raw: string): string {
  const tokens = [...new Set(raw.split(' ').filter((s) => ALL_SCOPES.has(s)))];
  tokens.sort();
  return tokens.join(' ');
}
