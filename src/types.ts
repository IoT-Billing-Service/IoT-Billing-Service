/**
 * IoT Billing Platform — Core Domain Types
 * 
 * Type-safe definitions for blockchain-backed payment auditing.
 * All monetary values use bigint stroops (7 decimal places) to prevent
 * floating-point errors in financial calculations.
 */

// ─── Monetary Types ────────────────────────────────────────────────────────────

/** Amount in stroops (1 XLM = 10,000,000 stroops). Prevents float rounding. */
export type Stroops = bigint;

/** Human-readable amount with currency code. */
export interface MonetaryAmount {
  readonly value: string;      // Decimal string, e.g. "150.00"
  readonly currency: string;    // ISO 4217 or crypto asset code
  readonly stroops: Stroops;   // Exact bigint representation
}

// ─── Transaction Types ─────────────────────────────────────────────────────────

/** Transaction status in the billing lifecycle. */
export type TransactionStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'disputed'
  | 'settled'
  | 'refunded';

/** Immutable audit record for a single IoT billing transaction. */
export interface BillingTransaction {
  readonly id: string;                    // UUID v4
  readonly deviceId: string;              // IoT device identifier
  readonly customerId: string;            // Customer account
  readonly amount: MonetaryAmount;
  readonly status: TransactionStatus;
  readonly createdAt: Date;
  readonly submittedAt?: Date;
  readonly confirmedAt?: Date;
  readonly ledgerSequence?: number;        // Blockchain ledger number
  readonly txHash?: string;               // On-chain transaction hash
  readonly memo?: string;                 // Stellar memo or reference
  readonly metadata: TransactionMetadata;
}

/** Contextual data attached to each transaction. */
export interface TransactionMetadata {
  readonly deviceType: string;            // e.g. 'smart-meter', 'ev-charger'
  readonly region: string;                // ISO 3166-2 region code
  readonly energyKwh?: number;            // For energy billing
  readonly durationSeconds?: number;      // For time-based billing
  readonly sessionId: string;             // Unique charging/session ID
  readonly tariffRate: string;            // Rate applied at time of tx
}

// ─── Blockchain Types ────────────────────────────────────────────────────────

/** Cryptographic verification result. */
export interface VerificationResult {
  readonly isValid: boolean;
  readonly verifiedAt: Date;
  readonly signatureValid: boolean;
  readonly hashMatch: boolean;
  readonly ledgerConfirmed: boolean;
  readonly confirmations: number;
  readonly verifier: string;              // Public key of verifier
}

/** On-chain transaction envelope (Stellar/Soroban compatible). */
export interface BlockchainEnvelope {
  readonly txHash: string;
  readonly sourceAccount: string;
  readonly sequence: string;
  readonly operations: BlockchainOperation[];
  readonly signatures: Signature[];
  readonly memo?: string;
  readonly fee: Stroops;
  readonly networkPassphrase: string;
}

export interface BlockchainOperation {
  readonly type: 'payment' | 'invokeContract' | 'createAccount';
  readonly destination?: string;
  readonly amount?: Stroops;
  readonly assetCode?: string;
  readonly contractId?: string;
  readonly functionName?: string;
  readonly args?: string[];
}

export interface Signature {
  readonly publicKey: string;
  readonly signature: string;              // Base64-encoded
  readonly hint: string;                   // 4-byte key hint
}

// ─── Explorer / Audit Types ─────────────────────────────────────────────────

/** Filter criteria for transaction queries. */
export interface TransactionFilter {
  readonly deviceId?: string;
  readonly customerId?: string;
  readonly status?: TransactionStatus;
  readonly fromDate?: Date;
  readonly toDate?: Date;
  readonly minAmount?: Stroops;
  readonly maxAmount?: Stroops;
  readonly txHash?: string;
  readonly region?: string;
  readonly deviceType?: string;
}

/** Sort direction for result ordering. */
export type SortDirection = 'asc' | 'desc';

/** Pagination cursor for efficient traversal. */
export interface PageCursor {
  readonly limit: number;                 // Max 100
  readonly offset?: number;
  readonly afterId?: string;              // Cursor-based pagination
}

/** Paginated response wrapper. */
export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly prevCursor?: string;
}

// ─── Compliance Types ──────────────────────────────────────────────────────

/** PCI-DSS Level 1 audit log entry. */
export interface AuditLogEntry {
  readonly timestamp: Date;
  readonly eventType: 'transaction_created' | 'transaction_submitted' | 'transaction_confirmed' | 'transaction_failed' | 'verification_attempt' | 'dispute_opened' | 'refund_issued';
  readonly transactionId: string;
  readonly actor: string;                 // System component or user ID
  readonly details: Record<string, unknown>;
  readonly integrityHash: string;         // SHA-256 of entry for tamper detection
  readonly previousHash: string;         // Chain hash for log integrity
}

/** SOC2 Type II control evidence. */
export interface ControlEvidence {
  readonly controlId: string;
  readonly controlName: string;
  readonly evidenceType: 'automated_test' | 'manual_review' | 'system_log' | 'third_party_attestation';
  readonly timestamp: Date;
  readonly result: 'pass' | 'fail' | 'exception';
  readonly supportingData: Record<string, unknown>;
}

// ─── Performance Types ─────────────────────────────────────────────────────

/** Performance metrics for billing operations. */
export interface BillingMetrics {
  readonly p50LatencyMs: number;
  readonly p99LatencyMs: number;
  readonly throughputTps: number;
  readonly errorRate: number;
  readonly activeDevices: number;
  readonly pendingTransactions: number;
}

/** Health check status. */
export interface HealthStatus {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly components: ComponentHealth[];
  readonly timestamp: Date;
}

export interface ComponentHealth {
  readonly name: string;
  readonly status: 'up' | 'down' | 'degraded';
  readonly latencyMs: number;
  readonly lastChecked: Date;
}