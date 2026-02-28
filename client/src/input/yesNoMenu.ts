import { handleListControlKey, type ListControlResult } from './listController';

export type YesNoOption = {
  id: 'no' | 'yes';
  label: 'No' | 'Yes';
};

export const YES_NO_OPTIONS: readonly YesNoOption[] = [
  { id: 'no', label: 'No' },
  { id: 'yes', label: 'Yes' },
];

/**
 * Handles standardized yes/no menu key input using shared list controls.
 */
export function handleYesNoMenuInput(code: string, key: string, currentIndex: number): ListControlResult {
  return handleListControlKey(code, key, YES_NO_OPTIONS, currentIndex, (entry) => entry.label);
}
