'use client';

import { useState } from 'react';
import { useAutoSaveDraft } from '@/hooks/useAutoSaveDraft';

interface DeviceFormFields {
  name: string;
  deviceId: string;
  type: string;
  firmwareVersion: string;
  description: string;
}

const INITIAL_FORM: DeviceFormFields = {
  name: '',
  deviceId: '',
  type: '',
  firmwareVersion: '',
  description: '',
};

const DRAFT_KEY = 'device-provisioning-draft';

const DEVICE_TYPES = ['sensor', 'gateway', 'actuator', 'controller'] as const;

export interface DeviceProvisioningFormProps {
  onSubmit?: (data: DeviceFormFields) => Promise<void>;
}

export function DeviceProvisioningForm({ onSubmit }: DeviceProvisioningFormProps) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const { values, updateField, pendingDraft, restoreDraft, discardDraft, clearDraft } =
    useAutoSaveDraft(DRAFT_KEY, INITIAL_FORM);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit?.(values);
      clearDraft();
      setSubmitSuccess(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitSuccess) {
    return (
      <div className="rounded-lg border border-green-700 bg-gray-900 p-6 text-center">
        <p className="mb-4 text-green-400">Device registered successfully.</p>
        <button
          onClick={() => setSubmitSuccess(false)}
          className="rounded bg-gray-700 px-4 py-2 text-sm text-gray-200 hover:bg-gray-600"
        >
          Register another device
        </button>
      </div>
    );
  }

  const savedAt = pendingDraft?.savedAt;

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 p-6">
      <h3 className="mb-4 text-lg font-semibold text-green-400">Register Device</h3>

      {pendingDraft && (
        <div
          role="alert"
          className="mb-4 flex items-start justify-between rounded border border-yellow-700 bg-yellow-950 p-3 text-sm"
        >
          <p className="text-yellow-300">
            Unsaved draft from {savedAt ? new Date(savedAt).toLocaleString() : 'a previous session'}
            .
          </p>
          <div className="ml-4 flex shrink-0 gap-2">
            <button
              type="button"
              onClick={restoreDraft}
              className="rounded bg-yellow-700 px-2 py-1 text-xs font-medium text-yellow-100 hover:bg-yellow-600"
            >
              Restore draft
            </button>
            <button
              type="button"
              onClick={discardDraft}
              className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="device-name" className="mb-1 block text-sm text-gray-300">
            Device name <span aria-hidden="true">*</span>
          </label>
          <input
            id="device-name"
            type="text"
            required
            value={values.name}
            onChange={(e) => updateField('name', e.target.value)}
            placeholder="e.g. Rooftop sensor A1"
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-green-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="device-id" className="mb-1 block text-sm text-gray-300">
            Device ID <span aria-hidden="true">*</span>
          </label>
          <input
            id="device-id"
            type="text"
            required
            value={values.deviceId}
            onChange={(e) => updateField('deviceId', e.target.value)}
            placeholder="e.g. DEV-0042"
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-green-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="device-type" className="mb-1 block text-sm text-gray-300">
            Device type <span aria-hidden="true">*</span>
          </label>
          <select
            id="device-type"
            required
            value={values.type}
            onChange={(e) => updateField('type', e.target.value)}
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-green-500 focus:outline-none"
          >
            <option value="" disabled>
              Select a type
            </option>
            {DEVICE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="firmware-version" className="mb-1 block text-sm text-gray-300">
            Firmware version
          </label>
          <input
            id="firmware-version"
            type="text"
            value={values.firmwareVersion}
            onChange={(e) => updateField('firmwareVersion', e.target.value)}
            placeholder="e.g. 1.4.2"
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-green-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="device-description" className="mb-1 block text-sm text-gray-300">
            Description
          </label>
          <textarea
            id="device-description"
            rows={3}
            value={values.description}
            onChange={(e) => updateField('description', e.target.value)}
            placeholder="Optional notes about this device"
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-green-500 focus:outline-none"
          />
        </div>

        {submitError && (
          <p role="alert" className="text-sm text-red-400">
            {submitError}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Registering…' : 'Register device'}
        </button>
      </form>
    </div>
  );
}
