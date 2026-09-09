export function scvalToString(val) {
  if (val && val.type === 'address') {
    return val.value ?? null;
  }
  if (val && val.type === 'scv_string') {
    return val.value ?? null;
  }
  return val ? String(val.value ?? val) : null;
}

export function scvalToBigInt(val) {
  if (val && val.type === 'i128' && typeof val.value === 'string') {
    return BigInt(val.value);
  }
  if (val && val.type === 'u32' && typeof val.value === 'number') {
    return BigInt(val.value);
  }
  const raw = val?.value ?? val;
  try {
    return BigInt(
      typeof raw === 'string' && !/^-?\d+$/.test(raw) ? 0 : (raw ?? 0),
    );
  } catch {
    return 0n;
  }
}

export default scvalToBigInt;
