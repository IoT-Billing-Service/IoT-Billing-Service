import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SecretManager } from '../../src/security/secret_manager.js';
import type { SecretProvider, SecretPayload } from '../../src/security/secret_provider.js';
import { VerifiedRemoteProvider } from '../../src/security/secret_provider.js';

class MockFailingProvider implements SecretProvider {
  async fetchSecrets(): Promise<SecretPayload> {
    throw new Error('Network error');
  }
}

describe('SecretManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fetch initial secrets on init', async () => {
    const provider = new VerifiedRemoteProvider();
    const manager = new SecretManager(provider, { rotationIntervalMs: 1000, gracePeriodMs: 500 });
    
    await manager.init();
    
    const secrets = manager.getSecrets();
    expect(secrets).toBeDefined();
    expect(secrets.DATABASE_URL).toContain('rotated_pw_1');
    
    manager.stop();
  });

  it('should rotate secrets on interval', async () => {
    const provider = new VerifiedRemoteProvider();
    const manager = new SecretManager(provider, { rotationIntervalMs: 1000, gracePeriodMs: 500 });
    
    await manager.init();
    expect(manager.getSecrets().DATABASE_URL).toContain('rotated_pw_1');
    
    // Fast forward to trigger rotation
    await vi.advanceTimersByTimeAsync(1000);
    
    expect(manager.getSecrets().DATABASE_URL).toContain('rotated_pw_2');
    
    manager.stop();
  });

  it('should keep previous secrets during grace period', async () => {
    const provider = new VerifiedRemoteProvider();
    const manager = new SecretManager(provider, { rotationIntervalMs: 1000, gracePeriodMs: 500 });
    
    await manager.init();
    
    // Trigger rotation
    await manager.rotate();
    
    // We should now have active payload 2, and previous payload 1
    expect(manager.getSecrets().DATABASE_URL).toContain('rotated_pw_2');
    expect(manager.getPreviousSecrets()?.DATABASE_URL).toContain('rotated_pw_1');
    
    // Fast forward past grace period
    await vi.advanceTimersByTimeAsync(500);
    
    // Previous secrets should be null now
    expect(manager.getPreviousSecrets()).toBeNull();
    
    manager.stop();
  });

  it('should emit rotation events', async () => {
    const provider = new VerifiedRemoteProvider();
    const manager = new SecretManager(provider, { rotationIntervalMs: 1000, gracePeriodMs: 500 });
    
    const rotationSpy = vi.fn();
    const graceSpy = vi.fn();
    
    manager.on('rotated', rotationSpy);
    manager.on('gracePeriodExpired', graceSpy);
    
    await manager.init();
    await manager.rotate();
    
    expect(rotationSpy).toHaveBeenCalledOnce();
    
    await vi.advanceTimersByTimeAsync(500);
    
    expect(graceSpy).toHaveBeenCalledOnce();
    
    manager.stop();
  });

  it('should handle rotation failures gracefully', async () => {
    const failingProvider = new MockFailingProvider();
    const manager = new SecretManager(failingProvider, { rotationIntervalMs: 1000, gracePeriodMs: 500 });
    
    const failSpy = vi.fn();
    manager.on('rotationFailed', failSpy);
    
    await expect(manager.init()).rejects.toThrow('Network error');
    
    // Init failure doesn't trigger rotationFailed event (only background rotation does), 
    // but we can test rotate directly.
    await expect(manager.rotate()).rejects.toThrow('Network error');
    
    expect(failSpy).toHaveBeenCalledOnce();
    
    manager.stop();
  });
});
