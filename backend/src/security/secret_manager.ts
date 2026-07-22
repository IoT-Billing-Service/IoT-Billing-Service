import { EventEmitter } from 'events';
import type { SecretProvider, SecretPayload } from './secret_provider.js';
import { recordSecretRotationEvent, setSecretManagerActiveSecrets } from '../api/metrics/prometheus.js';

export interface SecretManagerConfig {
  rotationIntervalMs: number;
  gracePeriodMs: number;
}

export class SecretManager extends EventEmitter {
  private activePayload: SecretPayload | null = null;
  private previousPayload: SecretPayload | null = null;
  
  private rotationTimer: NodeJS.Timeout | null = null;
  private gracePeriodTimer: NodeJS.Timeout | null = null;

  constructor(
    private provider: SecretProvider,
    private config: SecretManagerConfig
  ) {
    super();
  }

  /**
   * Initializes the manager by fetching the first set of secrets.
   */
  async init(): Promise<void> {
    if (this.activePayload) return;
    try {
      this.activePayload = await this.provider.fetchSecrets();
      this.logAudit('SecretRotationInit', 'success', 'Initial secrets fetched');
      setSecretManagerActiveSecrets(1);
      this.startRotation();
    } catch (error) {
      this.logAudit('SecretRotationInit', 'failure', String(error));
      throw error;
    }
  }

  /**
   * Returns the currently active secrets.
   */
  getSecrets(): Record<string, string> {
    if (!this.activePayload) {
      throw new Error('SecretManager not initialized');
    }
    return this.activePayload.secrets;
  }

  /**
   * Returns the previous secrets if within grace period, otherwise null.
   */
  getPreviousSecrets(): Record<string, string> | null {
    return this.previousPayload?.secrets ?? null;
  }

  private startRotation(): void {
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    
    this.rotationTimer = setInterval(() => {
      this.rotate().catch((err) => {
        console.error('Background secret rotation failed:', err);
      });
    }, this.config.rotationIntervalMs);
  }

  /**
   * Forces a manual rotation of secrets.
   */
  async rotate(): Promise<void> {
    const startTime = Date.now();
    try {
      const newPayload = await this.provider.fetchSecrets();
      
      // Keep old secrets for the grace period
      this.previousPayload = this.activePayload;
      this.activePayload = newPayload;
      
      if (this.gracePeriodTimer) clearTimeout(this.gracePeriodTimer);
      this.gracePeriodTimer = setTimeout(() => {
        this.previousPayload = null;
        this.logAudit('SecretGracePeriodExpired', 'success', 'Previous secrets purged');
        setSecretManagerActiveSecrets(1);
        this.emit('gracePeriodExpired');
      }, this.config.gracePeriodMs);

      const durationMs = Date.now() - startTime;
      
      this.logAudit('SecretRotation', 'success', 'Secrets rotated successfully');
      recordSecretRotationEvent('success', durationMs);
      setSecretManagerActiveSecrets(2); // active and previous
      
      this.emit('rotated', {
        version: newPayload.version,
        durationMs
      });
      
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.logAudit('SecretRotation', 'failure', String(error));
      recordSecretRotationEvent('failure', durationMs);
      
      this.emit('rotationFailed', {
        error,
        durationMs
      });
      
      throw error;
    }
  }

  stop(): void {
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    if (this.gracePeriodTimer) clearTimeout(this.gracePeriodTimer);
  }

  /**
   * Logs a PCI-DSS / SOC2 compliant audit record.
   */
  private logAudit(event: string, outcome: 'success' | 'failure', detail: string): void {
    // PCI-DSS requires capturing: event type, timestamp, success/failure status
    // It should explicitly NOT log the secrets themselves.
    console.log(JSON.stringify({
      level: outcome === 'success' ? 'info' : 'error',
      event,
      outcome,
      detail,
      timestamp: new Date().toISOString(),
      activeVersion: this.activePayload?.version ?? null,
      previousVersion: this.previousPayload?.version ?? null
    }));
  }
}
