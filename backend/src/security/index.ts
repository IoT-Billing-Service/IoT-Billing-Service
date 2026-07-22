import { SecretManager } from './secret_manager.js';
import { VerifiedRemoteProvider } from './secret_provider.js';
import { getEnv } from '../config/env.js';

let sharedSecretManager: SecretManager | null = null;

/**
 * Initializes and returns the shared SecretManager instance.
 * Needs to be called at application startup.
 */
export async function initSecretManager(): Promise<SecretManager> {
  if (sharedSecretManager) {
    return sharedSecretManager;
  }
  
  // For local development or environments without a public key, we omit the key.
  // In a real production deployment, this might be loaded from an env var.
  const provider = new VerifiedRemoteProvider();
  
  // Rotate every 15 minutes, keep previous secrets active for 2 minutes
  sharedSecretManager = new SecretManager(provider, {
    rotationIntervalMs: 15 * 60 * 1000,
    gracePeriodMs: 2 * 60 * 1000,
  });

  await sharedSecretManager.init();
  return sharedSecretManager;
}

export function getSecretManager(): SecretManager {
  if (!sharedSecretManager) {
    throw new Error('SecretManager is not initialized');
  }
  return sharedSecretManager;
}
