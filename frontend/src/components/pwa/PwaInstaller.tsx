'use client';

import { useState, useEffect, useCallback } from 'react';
import { useFormTracker } from '@/stores/useFormTracker';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches;
}

export function PwaInstaller() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(isStandalone);
  const [isDismissed, setIsDismissed] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const { hasDirtyForms } = useFormTracker();

  const scheduleDeferredReload = useCallback(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('pendingReload', 'true');
    }
  }, []);

  useEffect(() => {
    if (isInstalled) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handler);
    window.addEventListener('appinstalled', () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
      if (hasDirtyForms()) {
        setShowConfirmDialog(true);
      } else {
        location.reload();
      }
    });

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
    };
  }, [isInstalled, hasDirtyForms]);

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setDeferredPrompt(null);
    }
  }, [deferredPrompt]);

  const handleConfirmContinue = useCallback(() => {
    setShowConfirmDialog(false);
    location.reload();
  }, []);

  const handleConfirmDefer = useCallback(() => {
    setShowConfirmDialog(false);
    scheduleDeferredReload();
  }, [scheduleDeferredReload]);

  if (showConfirmDialog) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80">
        <div className="w-full max-w-md rounded-lg border border-red-700 bg-gray-900 p-6">
          <h3 className="text-lg font-semibold text-red-400">Unsaved Changes</h3>
          <p className="mt-2 text-sm text-gray-300">
            Installing the app will refresh the page. You have unsaved form data that will be lost.
          </p>
          <div className="mt-5 flex gap-2">
            <button
              onClick={handleConfirmDefer}
              className="flex-1 rounded bg-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-600"
            >
              Save First
            </button>
            <button
              onClick={handleConfirmContinue}
              className="flex-1 rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
            >
              Continue Anyway
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!deferredPrompt || isInstalled || isDismissed) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md rounded-lg border border-green-700 bg-gray-900 p-4 shadow-lg">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-green-400">Install IoT Billing</h3>
          <p className="mt-1 text-xs text-gray-400">
            Install this app on your device for offline access and faster loading.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => setIsDismissed(true)}
            className="rounded px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
            type="button"
          >
            Dismiss
          </button>
          <button
            onClick={handleInstall}
            className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500"
            type="button"
          >
            Install
          </button>
        </div>
      </div>
    </div>
  );
}
