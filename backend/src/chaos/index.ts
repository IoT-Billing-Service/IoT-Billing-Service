/**
 * Chaos Engineering — public surface.
 *
 * Import this module to run chaos experiments against the IoT billing
 * pipeline. All exports are tree-shakeable: the experiment runner and
 * fault injector are only bundled when explicitly imported, so the
 * production bundle is unaffected.
 */

export { activateFault, clearAllFaults, getActiveFaults, isFaultActive } from './fault_injector.js';
export { runExperiment } from './experiment_runner.js';
export { createBillingWorkloadDriver } from './billing_workload_driver.js';
export * from './types.js';
