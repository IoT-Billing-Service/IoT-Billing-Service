import { scValToNative, xdr } from '@stellar/stellar-sdk';

function isXdrScval(val) {
  return Boolean(val) && typeof val.switch === 'function';
}

export function scvalToString(val) {
  if (!val) return null;
  if (isXdrScval(val)) {
    try {
      return String(scValToNative(val));
    } catch {
      return null;
    }
  }
  if (
    val.type === 'address' ||
    val.type === 'scv_string' ||
    val.type === 'symbol'
  ) {
    return val.value ?? null;
  }
  const raw = val.value;
  return typeof raw === 'string' || typeof raw === 'number'
    ? String(raw)
    : null;
}

export function scvalToBigInt(val) {
  if (!val) return 0n;
  if (isXdrScval(val)) {
    try {
      const n = scValToNative(val);
      return typeof n === 'bigint' ? n : BigInt(n ?? 0);
    } catch {
      return 0n;
    }
  }
  // Signed/unsigned 64/128/256-bit values arrive as decimal strings.
  if (
    ['i64', 'u64', 'i128', 'u128', 'i256', 'u256'].includes(val.type) &&
    typeof val.value === 'string'
  ) {
    return BigInt(val.value);
  }
  if (typeof val.value === 'number') {
    return BigInt(val.value);
  }
  if (typeof val.value === 'bigint') {
    return val.value;
  }
  if (typeof val.value === 'string' && /^-?\d+$/.test(val.value)) {
    return BigInt(val.value);
  }
  return 0n;
}

/**
 * Soroban emits tuple values as an SCVec: `{ type: 'vec', value: [...] }`.
 * Flatten to the plain array of element SCVals, or null if not a vec.
 */
export function unwrapVec(val) {
  if (!val) return null;
  if (isXdrScval(val)) {
    if (val.switch().name === 'scvVec') {
      return val.vec() ?? [];
    }
    return null;
  }
  if (val.type === 'vec' && Array.isArray(val.value)) {
    return val.value;
  }
  if (Array.isArray(val.value)) {
    return val.value;
  }
  return null;
}

export { xdr };

export default scvalToBigInt;
