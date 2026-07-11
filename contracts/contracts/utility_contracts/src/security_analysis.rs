# Buffer Vault Security Analysis

## Overview
This document analyzes the security properties of the Pre-Paid Buffer Requirement Check implementation to ensure protection against malicious buffer draining and other attack vectors.

## Security Properties Implemented

### 1. Buffer Isolation
- **Main Balance Protection**: Withdrawals can only access the main balance (`accumulated_balance`), never the buffer balance
- **Segregated Storage**: Buffer funds are stored in a separate field (`buffer_balance`) within the `ContinuousFlow` struct
- **Access Control**: Only the designated `payer` can add additional buffer funds

### 2. Authorization Controls
- **Stream Creation**: Requires both `provider` and `payer` authorization to ensure buffer deposit is consented
- **Buffer Addition**: Only the original `payer` can add additional buffer funds
- **Stream Closure**: Only the `provider` can initiate amicable closure and buffer refund
- **Withdrawal Protection**: Standard withdrawals are restricted to main balance only

### 3. Buffer Depletion Security
- **Automatic Termination**: Stream is automatically terminated when buffer is fully depleted
- **Warning System**: `BufferWarning` event is emitted when buffer falls below 1-hour threshold
- **No Partial Refunds**: Buffer is only refunded on amicable closure, not after natural depletion

### 4. Mathematical Precision
- **Fixed-Point Math**: Uses `i128` for precise calculations without floating-point errors
- **Time-Based Accrual**: Buffer consumption is calculated based on exact elapsed time
- **Overflow Protection**: All arithmetic operations use `saturating_*` methods

## Attack Vectors Mitigated

### 1. Malicious Buffer Draining
**Threat**: Attacker attempts to drain buffer funds through unauthorized withdrawals
**Mitigation**: 
- Withdrawal functions only access `accumulated_balance`
- Buffer balance is completely isolated from withdrawal operations
- Authorization checks prevent unauthorized access

### 2. Buffer Underflow Attacks
**Threat**: Attacker attempts to create negative buffer balances through rate manipulation
**Mitigation**:
- All arithmetic uses overflow protection
- Flow rate changes require proper authorization
- Buffer calculations are based on time, not manipulable state

### 3. Replay Attacks
**Threat**: Attacker replays old transactions to manipulate buffer state
**Mitigation**:
- Timestamp-based calculations prevent replay
- Ledger timestamp advances prevent stale transaction execution
- Authorization tokens are single-use

### 4. Authorization Bypass
**Threat**: Attacker attempts to bypass payer authorization for buffer deposits
**Mitigation**:
- Stream creation requires dual authorization (provider + payer)
- Buffer operations require specific role-based authorization
- Mock auth system prevents unauthorized access in tests

### 5. Race Conditions
**Threat**: Concurrent operations attempt to manipulate buffer state inconsistently
**Mitigation**:
- All state updates are atomic within single transactions
- Flow calculations are performed before any state modifications
- Buffer warning flags are set atomically with balance updates

## Security Invariants

### Invariant 1: Buffer Integrity
- Buffer balance can only decrease through legitimate flow consumption
- Buffer balance can only increase through authorized payer deposits
- Buffer balance is never accessible through standard withdrawal functions

### Invariant 2: Authorization Boundaries
- Only payer can modify buffer balance upward
- Only provider can initiate stream closure
- Both parties must authorize stream creation

### Invariant 3: Temporal Consistency
- Buffer consumption is strictly time-based
- Past consumption cannot be reversed
- Future consumption cannot be accelerated

### Invariant 4: Event Integrity
- All buffer state changes emit corresponding events
- Warning events are emitted exactly once per threshold breach
- Depletion events are emitted only upon actual buffer exhaustion

## Formal Verification Points

### 1. Buffer Non-Negativity
```rust
assert!(flow.buffer_balance >= 0);
```
All buffer operations maintain non-negative balance through saturating arithmetic.

### 2. Authorization Verification
```rust
if operation == BufferAdd {
    assert!(invoker == flow.payer);
}
if operation == StreamClose {
    assert!(invoker == flow.provider);
}
```

### 3. Isolation Guarantee
```rust
fn withdraw_from_flow() {
    // Only accesses accumulated_balance, never buffer_balance
    let available = flow.accumulated_balance;
    // buffer_balance is untouched
}
```

### 4. Termination Correctness
```rust
if flow.buffer_balance == 0 && flow.accumulated_balance == 0 {
    assert!(flow.status == StreamStatus::Depleted);
}
```

## Test Coverage

### Security Tests Implemented
1. **test_buffer_creation_requirement**: Verifies mandatory buffer deposit
2. **test_buffer_security_against_malicious_draining**: Tests isolation and authorization
3. **test_stream_creation_without_buffer_fails**: Ensures buffer requirement enforcement
4. **test_buffer_refund_only_on_amicable_closure**: Validates refund conditions
5. **test_buffer_math_precision**: Tests mathematical accuracy under edge conditions

### Attack Scenario Tests
- Unauthorized withdrawal attempts
- Authorization bypass attempts
- Buffer manipulation through rate changes
- Race condition simulations
- Precision boundary testing

## Recommendations for Production Deployment

### 1. Additional Monitoring
- Implement buffer balance monitoring alerts
- Track buffer warning events for proactive intervention
- Monitor unusual buffer depletion patterns

### 2. Rate Limiting
- Consider implementing rate limits on buffer additions
- Monitor for rapid buffer cycling attacks
- Implement cooldown periods for certain operations

### 3. Audit Trail
- Maintain comprehensive logs of all buffer operations
- Implement event indexing for security analysis
- Consider off-chain audit trail storage

### 4. Economic Considerations
- Monitor for economic attacks on buffer pricing
- Consider dynamic buffer requirements based on market conditions
- Implement circuit breakers for unusual activity patterns

## Conclusion

The buffer vault implementation provides robust security guarantees against malicious buffer draining and other attack vectors. The combination of proper authorization controls, mathematical precision, and isolation mechanisms ensures that buffer funds remain secure while providing the intended functionality of continuous stream protection.

The implementation satisfies all acceptance criteria:
1. ✅ Streams cannot be created without correct buffer size
2. ✅ Buffer funds are utilized upon main balance depletion  
3. ✅ Amicable closures trigger accurate refunds

The security analysis demonstrates that the buffer vault system is resilient against known attack vectors and maintains the integrity of user funds throughout the stream lifecycle.

# Storage Key TTL Audit (Issue #18)

## Threat
Persistent storage entries have a finite TTL. When a device stream is inactive
beyond its TTL, the host archives/evicts the entry. The ghost sweeper read
stream keys without first bumping their TTL, so a key could be garbage-collected
between the `has()` existence check and the `get()` read — yielding a missing or
garbage read (a TOCTOU bug).

## Mitigation
All eviction-prone persistent reads/writes in `ghost_sweeper.rs` now route
through `storage_ttl.rs`:
- `ttl_safe_read<K, V>` — extends the entry's TTL, then reads; returns `None`
  if the key is absent (graceful, never garbage).
- `set_with_ttl<K, V>` — writes, then pins a fresh 14-day TTL.

Invariant: every key accessed through these helpers has, after the call,
TTL ≥ `now + MIN_TTL_THRESHOLD_LEDGERS` (7 days).

## Audited persistent keys

| Storage key | Access site | Access kind | TTL policy |
|---|---|---|---|
| `DataKey::ContinuousFlow(stream_id)` | `prune_ghost_stream`, `get_ghost_stream_candidates`, `check_stream_eligibility` | read | `ttl_safe_read` (extend → read; None if evicted) |
| `DataKey::StreamArchive(stream_id)` | `prune_ghost_stream` | write | `set_with_ttl` (14-day TTL) |
| `DataKey::SweeperStatistics` | `update_sweeper_statistics` | write | `set_with_ttl` (14-day TTL) |
| `DataKey::DeviceHash(pubkey)` | `prune_ghost_stream` | remove | n/a (intentional deletion) |

## TTL parameters (`storage_ttl.rs`)

| Constant | Value | Meaning |
|---|---|---|
| `DAY_LEDGERS` | 17,280 | ledger closes per day at 5s/close (86,400 / 5) |
| `TTL_WINDOW_DAYS` | 14 | TTL window applied to swept/created entries |
| `TTL_EXTEND_TO_LEDGERS` | 241,920 | 14 days, the extend-to target |
| `MIN_TTL_THRESHOLD_LEDGERS` | 120,960 | 7 days; only extend when remaining TTL drops below this |

Note: the issue's "604,800 ledger closes" for the 7-day default conflates
seconds with ledgers; 7 days at 5s/close is 7 × 17,280 = 120,960 closes.

## Test-teardown audit
The TTL behaviour is exercised in `ghost_sweeper_tests.rs::ttl_gc_tests`:
graceful `None` for absent/GC'd keys, `set_with_ttl` roundtrip, and a GC
simulation that fast-forwards ~150% of the TTL window before asserting a clean
`None` read.
