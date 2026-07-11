//! Tenant-scoped storage keys for issue #6.
//!
//! The storage invariant is:
//! `tenant_a != tenant_b => namespace(tenant_a)` has no keys in common with
//! `namespace(tenant_b)`.
//! Typed Soroban keys enforce that invariant without dynamic string keys or
//! lossy symbol truncation.

use soroban_sdk::{contracttype, Address, Env, IntoVal, TryFromVal, Val};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TenantSlot {
    GridAdmin,
    PeakLoadMultiplier,
    LowLoadDiscount,
    Balance(Address),
    SensorStream,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TenantKey {
    Registry(Address),
    Entry(Address, TenantSlot),
}

pub fn tenant_key(tenant: &Address, slot: TenantSlot) -> TenantKey {
    TenantKey::Entry(tenant.clone(), slot)
}

pub fn register_tenant(env: &Env, tenant: &Address) {
    let key = TenantKey::Registry(tenant.clone());
    if !env.storage().instance().has(&key) {
        env.storage()
            .instance()
            .set(&key, &env.ledger().timestamp());
    }
}

pub fn tenant_registered(env: &Env, tenant: &Address) -> bool {
    env.storage()
        .instance()
        .has(&TenantKey::Registry(tenant.clone()))
}

pub fn tenant_set<V>(env: &Env, tenant: &Address, slot: TenantSlot, value: &V)
where
    V: IntoVal<Env, Val>,
{
    register_tenant(env, tenant);
    env.storage()
        .instance()
        .set(&tenant_key(tenant, slot), value);
}

pub fn tenant_get<V>(env: &Env, tenant: &Address, slot: TenantSlot) -> Option<V>
where
    V: TryFromVal<Env, Val>,
{
    env.storage().instance().get(&tenant_key(tenant, slot))
}

pub fn tenant_get_or<V>(env: &Env, tenant: &Address, slot: TenantSlot, default: V) -> V
where
    V: TryFromVal<Env, Val>,
{
    tenant_get(env, tenant, slot).unwrap_or(default)
}

pub fn tenant_remove(env: &Env, tenant: &Address, slot: TenantSlot) {
    env.storage().instance().remove(&tenant_key(tenant, slot));
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address};

    #[test]
    fn overlapping_slots_are_isolated_per_tenant() {
        let env = Env::default();
        let mut tenants = soroban_sdk::Vec::new(&env);

        for i in 0..5i128 {
            let tenant = Address::generate(&env);
            tenant_set(&env, &tenant, TenantSlot::PeakLoadMultiplier, &(100 + i));
            tenant_set(&env, &tenant, TenantSlot::LowLoadDiscount, &(10 + i));
            tenants.push_back(tenant);
        }

        for i in 0..tenants.len() {
            let tenant = tenants.get(i).unwrap();
            assert!(tenant_registered(&env, &tenant));
            assert_eq!(
                tenant_get::<i128>(&env, &tenant, TenantSlot::PeakLoadMultiplier),
                Some(100 + i as i128)
            );
            assert_eq!(
                tenant_get::<i128>(&env, &tenant, TenantSlot::LowLoadDiscount),
                Some(10 + i as i128)
            );
        }
    }

    #[test]
    fn same_user_balance_isolated_across_tenants() {
        let env = Env::default();
        let tenant_a = Address::generate(&env);
        let tenant_b = Address::generate(&env);
        let user = Address::generate(&env);

        tenant_set(&env, &tenant_a, TenantSlot::Balance(user.clone()), &111i128);
        tenant_set(&env, &tenant_b, TenantSlot::Balance(user.clone()), &222i128);

        assert_eq!(
            tenant_get::<i128>(&env, &tenant_a, TenantSlot::Balance(user.clone())),
            Some(111)
        );
        assert_eq!(
            tenant_get::<i128>(&env, &tenant_b, TenantSlot::Balance(user)),
            Some(222)
        );
    }
}
