use crate::namespace::{tenant_get_or, tenant_set, TenantSlot};
use soroban_sdk::{contracttype, symbol_short, Address, Env, String};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoadConfig {
    pub peak_load_multiplier: i128,
    pub low_load_discount: i128,
    pub active_window: String,
}

pub fn set_grid_admin(env: &Env, tenant: Address, admin: Address) {
    tenant.require_auth();
    tenant_set(env, &tenant, TenantSlot::GridAdmin, &admin);
}

pub fn set_peak_multiplier(env: &Env, tenant: Address, admin: Address, multiplier: i128) {
    let stored_admin: Address = tenant_get_or(env, &tenant, TenantSlot::GridAdmin, tenant.clone());
    if admin != stored_admin {
        panic!("Unauthorized");
    }
    admin.require_auth();

    tenant_set(env, &tenant, TenantSlot::PeakLoadMultiplier, &multiplier);
    env.events().publish(
        (symbol_short!("MulAct"), tenant),
        (symbol_short!("peak"), multiplier),
    );
}

pub fn set_low_discount(env: &Env, tenant: Address, admin: Address, discount: i128) {
    let stored_admin: Address = tenant_get_or(env, &tenant, TenantSlot::GridAdmin, tenant.clone());
    if admin != stored_admin {
        panic!("Unauthorized");
    }
    admin.require_auth();

    tenant_set(env, &tenant, TenantSlot::LowLoadDiscount, &discount);
    env.events().publish(
        (symbol_short!("MulAct"), tenant),
        (symbol_short!("offpeak"), discount),
    );
}

pub fn bill_consumption(
    env: &Env,
    tenant: Address,
    user: Address,
    base_rate: i128,
    timestamp: u64,
) -> i128 {
    user.require_auth();

    let hour = (timestamp / 3600) % 24;
    let mut final_rate = base_rate;

    if (18..=22).contains(&hour) {
        let peak: i128 = tenant_get_or(env, &tenant, TenantSlot::PeakLoadMultiplier, 2);
        final_rate *= peak;
        env.events().publish(
            (symbol_short!("BillAppl"), tenant.clone()),
            (user.clone(), symbol_short!("peak"), final_rate),
        );
    } else {
        let discount: i128 = tenant_get_or(env, &tenant, TenantSlot::LowLoadDiscount, 100);
        final_rate = final_rate * discount / 100;
        env.events().publish(
            (symbol_short!("BillAppl"), tenant.clone()),
            (user.clone(), symbol_short!("offpeak"), final_rate),
        );
    }

    let mut balance: i128 = tenant_get_or(env, &tenant, TenantSlot::Balance(user.clone()), 0);
    balance -= final_rate;
    tenant_set(env, &tenant, TenantSlot::Balance(user), &balance);

    final_rate
}
