# Oracle Staleness & Flash-Loan Circuit Breaker (Issue #21)

## Threat

The billing engine reads a SEP-40 oracle price (`PriceData { price, decimals,
last_updated }`) and uses it to compute USD-equivalent charges, with **no
staleness or deviation check**. During a flash-loan attack — a window of just
1–2 ledger closes (~5–10s) — on-chain liquidity is distorted and the oracle's
spot price can swing up to ~20% from the true price, or simply go stale by
minutes. An attacker who triggers billing-cycle finalization inside that window
has devices billed at a manipulated price (e.g. 20% below market).

**Invariant:** the price used for billing is always within `MAX_DEVIATION_BPS`
(5%) of the moving-average reference, or is a previously-validated
last-known-good price.

## Defence — layered checks (`oracle_circuit_breaker.rs`)

| Bound | Value | Meaning |
|---|---|---|
| `TARGET_FRESHNESS_SECS` | 5 | 1 ledger close — the freshness target. |
| `MAX_STALENESS_SECS` | 50 | 10 ledger closes — older spot fails the freshness check. |
| `PRICE_HISTORY_LEN` | 30 | Observations kept for the moving-average reference. |
| `MAX_DEVIATION_BPS` | 500 | 5% — max tolerated spot-vs-average deviation. |

1. **Freshness check** — `ledger_timestamp - last_updated > MAX_STALENESS_SECS`
   marks the spot stale (saturating subtraction, so a backwards clock reads as
   stale rather than underflowing).
2. **Deviation check** — keep a ring buffer of the last 30 observations, compute
   their moving average, and flag the spot if it deviates more than 5% from it.
   A 1–2 sample manipulation among 30 barely moves the average, so the
   short-lived flash-loan outlier is caught.
3. **Circuit breaker** — combine the two checks:

   | stale | deviates | decision | price used |
   |---|---|---|---|
   | no | no | `Spot` | spot (recorded; advances last-known-good) |
   | no | yes | `MovingAverage` | moving average (spot still recorded so the average self-corrects) |
   | yes | no | `MovingAverage` | moving average (spot **not** recorded — not a fresh sample) |
   | yes | yes | `CircuitBreaker` | last-known-good price; emits `PrStale` |

   When a fallback is needed but there is no history/last-known-good price (e.g.
   a stale first-ever read), the call returns `ContractError::OraclePriceUnavailable`
   rather than silently billing at a stale value.

`PrStale` events carry a reason code: `1` = stale only, `2` = deviation only,
`3` = both (breaker tripped).

## On "VWAP"

The issue blueprint says VWAP, but SEP-40 `get_price` exposes no per-observation
*volume*, so a true volume-weighted average is not computable on-chain here. The
implementation uses a simple moving average (time-weighted by the cadence of
observations) — the standard manipulation-resistant reference when volumes are
unavailable. The name is called out so it is not mistaken for VWAP.

## Why this defeats the attack

The flash-loan window is 1–2 ledger closes. Against 30 historical samples, even
a 20% spot manipulation moves the average by ~1%, so the deviation check sees a
~19% gap and refuses the spot, billing at the average instead. A manipulation
that also makes the feed stale trips the full breaker and falls back to the last
price that passed both checks. Either way the billed price honours the 5%
invariant.

## Residual considerations

- **Sustained manipulation** lasting many ledgers would eventually drag the
  moving average; this breaker targets the short flash-loan window, not a
  prolonged feed compromise. Pair with oracle-source redundancy for the latter.
- **Cold start:** until the ring buffer has data, the deviation check cannot
  fire; the first fresh price is trusted to seed history.
- **Parameter tuning:** `MAX_STALENESS_SECS`, `PRICE_HISTORY_LEN`, and
  `MAX_DEVIATION_BPS` are the knobs; widen the window/deviation for volatile
  assets, tighten for stable ones.

## Tests

- `oracle_circuit_breaker_tests.rs`:
  `test_flash_loan_manipulation_trips_breaker` (20% swing → moving average; then
  stale+deviating → last-known-good — blueprint step 4),
  `test_fresh_in_tolerance_price_is_used`, `test_stale_with_no_history_errors`,
  `test_history_tracks_real_price_over_time`.
- Pure-logic unit tests in `oracle_circuit_breaker.rs` (`mod tests`): staleness
  boundary, 5% deviation threshold, moving average, decision matrix, reason
  codes, and the flash-loan-swing decision.
