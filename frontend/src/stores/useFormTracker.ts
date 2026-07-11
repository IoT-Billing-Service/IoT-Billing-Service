import { create } from 'zustand';

interface FormTrackerState {
  dirtyForms: Set<string>;
  markDirty: (formId: string) => void;
  markClean: (formId: string) => void;
  hasDirtyForms: () => boolean;
}

export const useFormTracker = create<FormTrackerState>((set, get) => ({
  dirtyForms: new Set(),

  markDirty(formId) {
    set((state) => ({
      dirtyForms: new Set(state.dirtyForms).add(formId),
    }));
  },

  markClean(formId) {
    set((state) => {
      const newDirtyForms = new Set(state.dirtyForms);
      newDirtyForms.delete(formId);
      return { dirtyForms: newDirtyForms };
    });
  },

  hasDirtyForms() {
    return get().dirtyForms.size > 0;
  },
}));
