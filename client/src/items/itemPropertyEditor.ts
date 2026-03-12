import { handleListControlKey } from '../input/listController';
import { getEditSessionAction } from '../input/editSession';
import { formatSteppedNumber, snapNumberToStep } from '../input/numeric';
import { type WorldItem } from '../state/gameState';

/**
 * Dependencies required to drive item property inspect/edit flows.
 */
type EditorDeps = {
  state: {
    mode: string;
    selectedItemId: string | null;
    editingPropertyKey: string | null;
    itemPropertyOptionValues: string[];
    itemPropertyOptionIndex: number;
    itemPropertyKeys: string[];
    itemPropertyIndex: number;
    nicknameInput: string;
    cursorPos: number;
    items: Map<string, WorldItem>;
  };
  signalingSend: (message: unknown) => void;
  getItemPropertyValue: (item: WorldItem, key: string) => string;
  itemPropertyLabel: (key: string) => string;
  isItemPropertyEditable: (item: WorldItem, key: string) => boolean;
  getItemPropertyOptionValues: (itemType: WorldItem['type'], key: string) => string[] | undefined;
  openItemPropertyOptionSelect: (item: WorldItem, key: string) => void;
  describeItemPropertyHelp: (item: WorldItem, key: string) => string;
  getItemPropertyMetadata: (
    itemType: WorldItem['type'],
    key: string,
  ) => {
    valueType?: string;
    maxLength?: number;
    range?: { min: number; max: number; step?: number };
  } | undefined;
  validateNumericItemPropertyInput: (
    item: WorldItem,
    key: string,
    rawValue: string,
    requireInteger: boolean,
  ) => { ok: true; value: number } | { ok: false; message: string };
  applyTextInputEdit: (code: string, key: string, maxLength: number, ctrlKey?: boolean, allowReplaceOnNextType?: boolean) => void;
  setReplaceTextOnNextType: (value: boolean) => void;
  suppressItemPropertyEchoMs: (ms: number) => void;
  onPreviewPropertyChange?: (item: WorldItem, key: string, value: unknown) => void;
  updateStatus: (message: string) => void;
  sfxUiBlip: () => void;
  sfxUiCancel: () => void;
  openSoundPropertyPicker?: (item: WorldItem, key: string) => void;
  previewSound?: (soundPath: string) => void;
};

/**
 * Creates item property mode handlers so main input dispatch can stay lean.
 */
export function createItemPropertyEditor(deps: EditorDeps): {
  handleItemPropertiesModeInput: (code: string, key: string) => void;
  handleItemPropertyEditModeInput: (code: string, key: string, ctrlKey: boolean) => void;
  handleItemPropertyOptionSelectModeInput: (code: string, key: string) => void;
} {
  function handleItemPropertiesModeInput(code: string, key: string): void {
    const itemId = deps.state.selectedItemId;
    if (!itemId) {
      deps.state.mode = 'normal';
      deps.state.editingPropertyKey = null;
      deps.state.itemPropertyOptionValues = [];
      deps.state.itemPropertyOptionIndex = 0;
      return;
    }
    const item = deps.state.items.get(itemId);
    if (!item) {
      deps.state.mode = 'normal';
      deps.state.editingPropertyKey = null;
      deps.state.itemPropertyOptionValues = [];
      deps.state.itemPropertyOptionIndex = 0;
      deps.updateStatus('Item no longer exists.');
      deps.sfxUiCancel();
      return;
    }
    const control = handleListControlKey(code, key, deps.state.itemPropertyKeys, deps.state.itemPropertyIndex, (propertyKey) => propertyKey);
    if (control.type === 'move') {
      deps.state.itemPropertyIndex = control.index;
      const selectedKey = deps.state.itemPropertyKeys[deps.state.itemPropertyIndex];
      const value = deps.getItemPropertyValue(item, selectedKey);
      deps.updateStatus(`${deps.itemPropertyLabel(selectedKey)}: ${value}`);
      deps.sfxUiBlip();
      return;
    }
    if (code === 'Space') {
      const selectedKey = deps.state.itemPropertyKeys[deps.state.itemPropertyIndex];
      deps.updateStatus(deps.describeItemPropertyHelp(item, selectedKey));
      deps.sfxUiBlip();
      return;
    }
    if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'PageUp' || code === 'PageDown') {
      const selectedKey = deps.state.itemPropertyKeys[deps.state.itemPropertyIndex];
      if (!deps.isItemPropertyEditable(item, selectedKey)) {
        deps.updateStatus(`${deps.itemPropertyLabel(selectedKey)} is not editable.`);
        deps.sfxUiCancel();
        return;
      }
      const options = deps.getItemPropertyOptionValues(item.type, selectedKey);
      if (options && options.length > 0) {
        const currentRaw = String(item.params[selectedKey] ?? '').trim().toLowerCase();
        const currentIndex = Math.max(
          0,
          options.findIndex((option) => option.toLowerCase() === currentRaw),
        );
        const pageJump = Math.min(10, Math.max(1, options.length - 1));
        const delta =
          code === 'ArrowRight'
            ? 1
            : code === 'ArrowLeft'
              ? -1
              : code === 'PageDown'
                ? pageJump
                : -pageJump;
        const nextIndex = (currentIndex + delta + options.length) % options.length;
        const nextValue = options[nextIndex];
        deps.suppressItemPropertyEchoMs(600);
        deps.signalingSend({ type: 'item_update', itemId, params: { [selectedKey]: nextValue } });
        deps.onPreviewPropertyChange?.(item, selectedKey, nextValue);
        deps.updateStatus(nextValue);
        deps.sfxUiBlip();
        return;
      }
      const metadata = deps.getItemPropertyMetadata(item.type, selectedKey);
      if (metadata?.valueType === 'boolean') {
        const current = deps.getItemPropertyValue(item, selectedKey).toLowerCase() === 'on';
        const nextValue = !current;
        deps.suppressItemPropertyEchoMs(600);
        deps.signalingSend({ type: 'item_update', itemId, params: { [selectedKey]: nextValue } });
        deps.onPreviewPropertyChange?.(item, selectedKey, nextValue);
        deps.updateStatus(nextValue ? 'on' : 'off');
        deps.sfxUiBlip();
        return;
      }
      if (metadata?.valueType === 'number') {
        const range = metadata.range;
        const step = range?.step && range.step > 0 ? range.step : 1;
        const min = range?.min;
        const max = range?.max;
        const currentRaw = Number(item.params[selectedKey]);
        const currentValue = Number.isFinite(currentRaw)
          ? currentRaw
          : Number.isFinite(min)
            ? min
            : 0;
        const multiplier = code === 'PageUp' || code === 'PageDown' ? 10 : 1;
        const delta = (code === 'ArrowRight' || code === 'PageUp' ? step : -step) * multiplier;
        const anchor = Number.isFinite(min) ? min : 0;
        const attempted = snapNumberToStep(currentValue + delta, step, anchor);
        let nextValue = attempted;
        if (Number.isFinite(min)) nextValue = Math.max(min, nextValue);
        if (Number.isFinite(max)) nextValue = Math.min(max, nextValue);
        deps.suppressItemPropertyEchoMs(600);
        deps.signalingSend({ type: 'item_update', itemId, params: { [selectedKey]: nextValue } });
        deps.onPreviewPropertyChange?.(item, selectedKey, nextValue);
        deps.updateStatus(formatSteppedNumber(nextValue, step));
        if (Math.abs(nextValue - currentValue) < 1e-9 || Math.abs(nextValue - attempted) > 1e-9) {
          deps.sfxUiCancel();
        } else {
          deps.sfxUiBlip();
        }
        return;
      }
      deps.sfxUiCancel();
      return;
    }
    if (control.type === 'select') {
      const selectedKey = deps.state.itemPropertyKeys[deps.state.itemPropertyIndex];
      if (!deps.isItemPropertyEditable(item, selectedKey)) {
        deps.updateStatus(`${deps.itemPropertyLabel(selectedKey)} is not editable.`);
        deps.sfxUiCancel();
        return;
      }
      const metadata = deps.getItemPropertyMetadata(item.type, selectedKey);
      if (metadata?.valueType === 'boolean') {
        const current = deps.getItemPropertyValue(item, selectedKey).toLowerCase() === 'on';
        const nextValue = !current;
        deps.signalingSend({ type: 'item_update', itemId, params: { [selectedKey]: nextValue } });
        deps.onPreviewPropertyChange?.(item, selectedKey, nextValue);
        deps.updateStatus(`${deps.itemPropertyLabel(selectedKey)}: ${nextValue ? 'on' : 'off'}`);
        deps.sfxUiBlip();
        return;
      }
      if (deps.getItemPropertyOptionValues(item.type, selectedKey)) {
        deps.openItemPropertyOptionSelect(item, selectedKey);
        return;
      }
      if (metadata?.valueType === 'sound' && deps.openSoundPropertyPicker) {
        deps.openSoundPropertyPicker(item, selectedKey);
        return;
      }
      deps.state.mode = 'itemPropertyEdit';
      deps.state.editingPropertyKey = selectedKey;
      const selectedMetadata = metadata;
      deps.state.nicknameInput =
        selectedKey === 'title'
          ? item.title
          : selectedMetadata?.valueType === 'boolean'
            ? deps.getItemPropertyValue(item, selectedKey).toLowerCase() === 'on'
              ? 'on'
              : 'off'
            : String(item.params[selectedKey] ?? '');
      deps.state.cursorPos = deps.state.nicknameInput.length;
      deps.setReplaceTextOnNextType(true);
      deps.updateStatus(`Edit ${deps.itemPropertyLabel(selectedKey)}: ${deps.state.nicknameInput}`);
      deps.sfxUiBlip();
      return;
    }
    if (control.type === 'cancel') {
      deps.state.mode = 'normal';
      deps.state.selectedItemId = null;
      deps.state.itemPropertyKeys = [];
      deps.state.itemPropertyIndex = 0;
      deps.state.editingPropertyKey = null;
      deps.state.itemPropertyOptionValues = [];
      deps.state.itemPropertyOptionIndex = 0;
      deps.updateStatus('Closed item properties.');
      deps.sfxUiCancel();
    }
  }

  function handleItemPropertyEditModeInput(code: string, key: string, ctrlKey: boolean): void {
    const itemId = deps.state.selectedItemId;
    const propertyKey = deps.state.editingPropertyKey;
    if (!itemId || !propertyKey) {
      deps.state.mode = 'normal';
      return;
    }
    const item = deps.state.items.get(itemId);
    if (!item) {
      deps.state.mode = 'normal';
      deps.state.editingPropertyKey = null;
      deps.updateStatus('Item no longer exists.');
      deps.sfxUiCancel();
      return;
    }
    if (code === 'ArrowUp' || code === 'ArrowDown' || code === 'PageUp' || code === 'PageDown') {
      const metadata = deps.getItemPropertyMetadata(item.type, propertyKey);
      if (metadata?.valueType === 'number') {
        const range = metadata.range;
        const step = range?.step && range.step > 0 ? range.step : 1;
        const min = range?.min;
        const max = range?.max;
        const rawCurrent = Number(deps.state.nicknameInput.trim());
        const paramCurrent = Number(item.params[propertyKey]);
        const currentValue = Number.isFinite(rawCurrent)
          ? rawCurrent
          : Number.isFinite(paramCurrent)
            ? paramCurrent
            : Number.isFinite(min)
              ? min
              : 0;
        const multiplier = code === 'PageUp' || code === 'PageDown' ? 10 : 1;
        const delta = (code === 'ArrowUp' || code === 'PageUp' ? step : -step) * multiplier;
        const anchor = Number.isFinite(min) ? min : 0;
        const attempted = snapNumberToStep(currentValue + delta, step, anchor);
        let nextValue = attempted;
        if (Number.isFinite(min)) nextValue = Math.max(min, nextValue);
        if (Number.isFinite(max)) nextValue = Math.min(max, nextValue);
        deps.state.nicknameInput = formatSteppedNumber(nextValue, step);
        deps.state.cursorPos = deps.state.nicknameInput.length;
        deps.setReplaceTextOnNextType(false);
        deps.onPreviewPropertyChange?.(item, propertyKey, nextValue);
        deps.updateStatus(deps.state.nicknameInput);
        if (Math.abs(nextValue - currentValue) < 1e-9 || Math.abs(nextValue - attempted) > 1e-9) {
          deps.sfxUiCancel();
        } else {
          deps.sfxUiBlip();
        }
        return;
      }
    }
    const editAction = getEditSessionAction(code);
    if (editAction === 'submit') {
      const value = deps.state.nicknameInput.trim();
      const metadata = deps.getItemPropertyMetadata(item.type, propertyKey);
      const valueType = metadata?.valueType;
      const sendItemParams = (params: Record<string, unknown>): void => {
        deps.signalingSend({ type: 'item_update', itemId, params });
        for (const [key, nextValue] of Object.entries(params)) {
          deps.onPreviewPropertyChange?.(item, key, nextValue);
        }
      };
      const parseToggleValue = (raw: string, field: string): { ok: true; value: boolean } | { ok: false } => {
        const normalized = raw.toLowerCase();
        if (!['on', 'off', 'true', 'false', '1', '0', 'yes', 'no'].includes(normalized)) {
          deps.updateStatus(`${field} must be on or off.`);
          deps.sfxUiCancel();
          return { ok: false };
        }
        return { ok: true, value: ['on', 'true', '1', 'yes'].includes(normalized) };
      };
      const submitNumericParam = (targetKey: string): boolean => {
        const parsed = deps.validateNumericItemPropertyInput(item, targetKey, value, false);
        if (!parsed.ok) {
          deps.updateStatus(parsed.message);
          deps.sfxUiCancel();
          return false;
        }
        sendItemParams({ [targetKey]: parsed.value });
        return true;
      };
      if (propertyKey === 'title') {
        if (!value) {
          deps.updateStatus('Value is required.');
          deps.sfxUiCancel();
          return;
        }
        deps.signalingSend({ type: 'item_update', itemId, title: value });
      } else if (valueType === 'boolean') {
        const toggle = parseToggleValue(value, propertyKey);
        if (!toggle.ok) return;
        sendItemParams({ [propertyKey]: toggle.value });
      } else if (valueType === 'number') {
        if (!submitNumericParam(propertyKey)) return;
      } else if (valueType === 'list') {
        const options = deps.getItemPropertyOptionValues(item.type, propertyKey) ?? [];
        if (options.length === 0) {
          deps.updateStatus(`${deps.itemPropertyLabel(propertyKey)} has no options.`);
          deps.sfxUiCancel();
          return;
        }
        const normalized = value.toLowerCase();
        const matched = options.find((option) => option.toLowerCase() === normalized);
        if (!matched) {
          deps.updateStatus(`${deps.itemPropertyLabel(propertyKey)} must be one of: ${options.join(', ')}.`);
          deps.sfxUiCancel();
          return;
        }
        sendItemParams({ [propertyKey]: matched });
      } else {
        if (metadata?.maxLength !== undefined && value.length > metadata.maxLength) {
          deps.updateStatus(`${deps.itemPropertyLabel(propertyKey)} must be ${metadata.maxLength} characters or less.`);
          deps.sfxUiCancel();
          return;
        }
        sendItemParams({ [propertyKey]: value });
      }
      deps.state.mode = 'itemProperties';
      deps.state.editingPropertyKey = null;
      deps.setReplaceTextOnNextType(false);
      return;
    }
    if (editAction === 'cancel') {
      deps.state.mode = 'itemProperties';
      deps.state.editingPropertyKey = null;
      deps.setReplaceTextOnNextType(false);
      deps.updateStatus('Cancelled.');
      deps.sfxUiCancel();
      return;
    }
    const maxLength = deps.getItemPropertyMetadata(item.type, propertyKey)?.maxLength ?? 500;
    deps.applyTextInputEdit(code, key, maxLength, ctrlKey, true);
  }

  function handleItemPropertyOptionSelectModeInput(code: string, key: string): void {
    const itemId = deps.state.selectedItemId;
    const propertyKey = deps.state.editingPropertyKey;
    if (!itemId || !propertyKey || deps.state.itemPropertyOptionValues.length === 0) {
      deps.state.mode = 'itemProperties';
      deps.state.editingPropertyKey = null;
      deps.state.itemPropertyOptionValues = [];
      deps.state.itemPropertyOptionIndex = 0;
      return;
    }

    if (code === 'PageUp' || code === 'PageDown') {
      const length = deps.state.itemPropertyOptionValues.length;
      const jump = Math.min(10, Math.max(1, length - 1));
      const delta = code === 'PageUp' ? -jump : jump;
      const nextIndex = (deps.state.itemPropertyOptionIndex + delta + length * 1000) % length;
      deps.state.itemPropertyOptionIndex = nextIndex;
      deps.updateStatus(deps.state.itemPropertyOptionValues[nextIndex]);
      const pageItem = deps.state.items.get(itemId!);
      if (pageItem) {
        const pageMeta = deps.getItemPropertyMetadata(pageItem.type, propertyKey);
        if (pageMeta?.valueType === 'sound') {
          deps.previewSound?.(deps.state.itemPropertyOptionValues[nextIndex]);
        }
      }
      deps.sfxUiBlip();
      return;
    }

    const control = handleListControlKey(
      code,
      key,
      deps.state.itemPropertyOptionValues,
      deps.state.itemPropertyOptionIndex,
      (value) => value,
    );
    if (control.type === 'move') {
      deps.state.itemPropertyOptionIndex = control.index;
      deps.updateStatus(deps.state.itemPropertyOptionValues[deps.state.itemPropertyOptionIndex]);
      const moveItem = deps.state.items.get(itemId!);
      if (moveItem) {
        const moveMeta = deps.getItemPropertyMetadata(moveItem.type, propertyKey);
        if (moveMeta?.valueType === 'sound') {
          deps.previewSound?.(deps.state.itemPropertyOptionValues[deps.state.itemPropertyOptionIndex]);
        }
      }
      deps.sfxUiBlip();
      return;
    }

    if (control.type === 'select') {
      const selectedValue = deps.state.itemPropertyOptionValues[deps.state.itemPropertyOptionIndex];
      deps.signalingSend({ type: 'item_update', itemId, params: { [propertyKey]: selectedValue } });
      const item = deps.state.items.get(itemId);
      if (item) {
        deps.onPreviewPropertyChange?.(item, propertyKey, selectedValue);
      }
      deps.state.mode = 'itemProperties';
      deps.state.editingPropertyKey = null;
      deps.state.itemPropertyOptionValues = [];
      deps.state.itemPropertyOptionIndex = 0;
      return;
    }

    if (control.type === 'cancel') {
      deps.state.mode = 'itemProperties';
      deps.state.editingPropertyKey = null;
      deps.state.itemPropertyOptionValues = [];
      deps.state.itemPropertyOptionIndex = 0;
      deps.updateStatus('Cancelled.');
      deps.sfxUiCancel();
    }
  }

  return {
    handleItemPropertiesModeInput,
    handleItemPropertyEditModeInput,
    handleItemPropertyOptionSelectModeInput,
  };
}
