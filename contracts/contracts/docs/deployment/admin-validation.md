# Admin Address Validation & Pre-Deployment Checklist (Issue #16)

## Threat

`set_admin` stored the supplied address as `DataKey::AdminAddress` with **no
validation**. Installing the Stellar zero account
(`GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`) — or the contract's
own address — as admin would **permanently brick governance**: the zero account
has no controlling key (no one can satisfy `require_auth` for it), and a
contract-id admin can never sign. With no admin able to act, every
state-mutating admin function is blocked.

**Invariant:** after construction, `admin != zero account` and
`admin != contract_id`.

## Mitigation (`admin_validation.rs`)

`validate_admin` runs before any admin address is stored (in both `set_admin`
and `recover_admin`):

1. **Proof of control** — `proposed.require_auth()`. The zero account cannot
   produce a signature, so it can never be installed. This is the primary,
   soroban-idiomatic guard.
2. **Not the contract id** — rejects `proposed == env.current_contract_address()`.
3. **Defense-in-depth** — rejects the canonical zero-account strkey explicitly
   (`ContractError::InvalidAdminAddress`).

### Emergency recovery

`recover_admin(proposed_admin)` is an override callable only within
`RECOVERY_WINDOW = 10` ledgers of the **first** admin set (anchored by
`DataKey::AdminInitLedger`). It lets a botched deployment be corrected before
the window closes; afterwards it returns `ContractError::AdminRecoveryWindowClosed`.
The proposed admin is validated identically.

## A note on the blueprint

- There is no separate `initialize()` constructor storing `Symbol::new("admin")`;
  the real admin-setting path is `set_admin` storing `DataKey::AdminAddress`.
  Validation was applied there (and in `recover_admin`).
- `Address::is_contract()` + an `AdminInterface` `ping` probe (blueprint step 2)
  was **not** implemented: forcing a contract admin to implement a specific
  interface is a heavier design decision and the `require_auth` proof-of-control
  guard already covers the lock-out attack for both account and contract admins.

## Pre-deployment validation checklist

- [ ] The admin address is a real, key-controlled account or a contract you
      control — **never** the zero account `GAAAA…AWHF`.
- [ ] The admin address is **not** the deployed contract's own address.
- [ ] The deployer can produce a signature for the admin address (so
      `set_admin` / `require_admin_auth` can succeed).
- [ ] If the initial `set_admin` was wrong, run `recover_admin` **within 10
      ledgers** of the first set — confirm the window before relying on it.
- [ ] Multi-sig admin (`AdminMofN`), if used, is configured with the intended
      M-of-N signer set before handing off control.

## Tests

`admin_validation_tests.rs`: valid admin accepted; zero account rejected;
contract-id rejected (blueprint step 4); `recover_admin` works inside the window
and is refused after it; recovery still validates the proposed admin. Pure-logic
unit tests for the strkey constant and recovery-window boundary live in
`admin_validation.rs`.
