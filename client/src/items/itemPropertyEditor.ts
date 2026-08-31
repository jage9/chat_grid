import { handleListControlKey } from '../input/listController';
import { getEditSessionAction } from '../input/editSession';
import { type WorldItem } from '../state/gameState';
import type { OptionSelectorRequest } from '../input/optionSelector';
import { adjustPropertyValue, getPropertyOptions } from '../input/propertyControls';

/**
 * Dependencies required to drive item property inspect/edit flows.
 */
type EditorDeps = {
  state: {
    mode: string;
    selectedItemId: string | null;
    editingPropertyKey: string | null;
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
  openOptionSelector: (request: OptionSelectorRequest) => void;
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
};

/**
 * Creates item property mode handlers so main input dispatch can stay lean.
 */
export function createItemPropertyEditor(deps: EditorDeps): {
  handleItemPropertiesModeInput: (code: string, key: string) => void;
  handleItemPropertyEditModeInput: (code: string, key: string, ctrlKey: boolean) => void;
} {
  function handleItemPropertiesModeInput(code: string, key: string): void {
    const itemId = deps.state.selectedItemId;
    if (!itemId) {
      deps.state.mode = 'normal';
      deps.state.editingPropertyKey = null;
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
      const metadata = {
        ...deps.getItemPropertyMetadata(item.type, selectedKey),
        options: deps.getItemPropertyOptionValues(item.type, selectedKey),
      };
      const currentValue = metadata.valueType === 'boolean'
        ? deps.getItemPropertyValue(item, selectedKey)
        : item.params[selectedKey] ?? deps.getItemPropertyValue(item, selectedKey);
      const adjustment = adjustPropertyValue(code, currentValue, metadata);
      if (!adjustment) {
        deps.sfxUiCancel();
        return;
      }
      deps.suppressItemPropertyEchoMs(600);
      deps.signalingSend({ type: 'item_update', itemId, params: { [selectedKey]: adjustment.value } });
      deps.onPreviewPropertyChange?.(item, selectedKey, adjustment.value);
      deps.updateStatus(adjustment.displayValue);
      if (adjustment.hitBoundary) deps.sfxUiCancel();
      else deps.sfxUiBlip();
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
      const options = getPropertyOptions({
        ...metadata,
        options: deps.getItemPropertyOptionValues(item.type, selectedKey),
      });
      if (options.length > 0) {
        deps.state.editingPropertyKey = selectedKey;
        deps.openOptionSelector({
          title: `Select ${deps.itemPropertyLabel(selectedKey)}`,
          options,
          selectedId: deps.getItemPropertyValue(item, selectedKey),
          onSelect: (selectedValue) => {
            deps.signalingSend({ type: 'item_update', itemId, params: { [selectedKey]: selectedValue } });
            deps.onPreviewPropertyChange?.(item, selectedKey, selectedValue);
            deps.state.mode = 'itemProperties';
            deps.state.editingPropertyKey = null;
          },
          onCancel: () => {
            deps.state.mode = 'itemProperties';
            deps.state.editingPropertyKey = null;
            deps.updateStatus('Cancelled.');
          },
        });
        return;
      }
      deps.state.mode = 'itemPropertyEdit';
      deps.state.editingPropertyKey = selectedKey;
      const selectedMetadata = deps.getItemPropertyMetadata(item.type, selectedKey);
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
        const rawCurrent = Number(deps.state.nicknameInput.trim());
        const paramCurrent = Number(item.params[propertyKey]);
        const currentValue = Number.isFinite(rawCurrent)
          ? rawCurrent
          : Number.isFinite(paramCurrent)
            ? paramCurrent
            : metadata.range?.min ?? 0;
        const adjustment = adjustPropertyValue(code, currentValue, metadata, 'vertical');
        if (adjustment) {
          deps.state.nicknameInput = adjustment.displayValue;
          deps.state.cursorPos = deps.state.nicknameInput.length;
          deps.setReplaceTextOnNextType(false);
          deps.onPreviewPropertyChange?.(item, propertyKey, adjustment.value);
          deps.updateStatus(deps.state.nicknameInput);
          if (adjustment.hitBoundary) deps.sfxUiCancel();
          else deps.sfxUiBlip();
          return;
        }
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

  return {
    handleItemPropertiesModeInput,
    handleItemPropertyEditModeInput,
  };
}
