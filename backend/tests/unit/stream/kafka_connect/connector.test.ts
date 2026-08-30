import { describe, it, expect } from 'vitest';
import {
  BlockchainEventSinkConnector,
  ConfigException,
} from '../../../../src/stream/kafka_connect/connector.js';

const base = {
  brokers: 'localhost:9092',
  clientId: 'iot-billing-kafka-connect',
  groupId: 'iot-billing-blockchain-sink',
  topic: 'blockchain.events',
};

describe('BlockchainEventSinkConnector', () => {
  it('reports a version', () => {
    const c = new BlockchainEventSinkConnector();
    expect(c.version()).toBe('1.0.0');
  });

  it('starts with a valid config and produces a typed task config', () => {
    const c = new BlockchainEventSinkConnector();
    const cfg = c.start({ ...base, 'verify-public-key': 'PEMDATA' });
    expect(cfg.brokers).toBe('localhost:9092');
    expect(cfg.topic).toBe('blockchain.events');
    expect(cfg.verifyPublicKeyPem).toBe('PEMDATA');
    expect(c.currentConfig).toEqual(cfg);
  });

  it('throws ConfigException on missing required fields', () => {
    const c = new BlockchainEventSinkConnector();
    expect(() => c.start({})).toThrow(ConfigException);
    expect(() => c.start({ ...base, brokers: '' })).toThrowError(/brokers/);
    expect(() => c.start({ ...base, topic: undefined as unknown as string })).toThrow(
      ConfigException,
    );
  });

  it('fan-out of taskConfigs returns maxTasks configs', () => {
    const c = new BlockchainEventSinkConnector();
    c.start(base);
    expect(c.taskConfigs(3)).toHaveLength(3);
    expect(c.taskConfigs(0)).toHaveLength(1);
  });

  it('taskConfigs throws before start()', () => {
    const c = new BlockchainEventSinkConnector();
    expect(() => c.taskConfigs(1)).toThrow(/not started/);
  });

  it('stop clears the config', () => {
    const c = new BlockchainEventSinkConnector();
    c.start(base);
    expect(c.currentConfig).not.toBeNull();
    c.stop();
    expect(c.currentConfig).toBeNull();
  });
});
