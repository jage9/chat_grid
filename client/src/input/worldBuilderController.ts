import { handleListControlKey } from './listController';
import { nearbyWalls } from '../state/structureGeometry';
import type { GameState, StructurePreset, WallStructure } from '../state/gameState';
import type { OutgoingMessage } from '../network/protocol';
import { getEditSessionAction } from './editSession';
import { formatSteppedNumber, snapNumberToStep } from './numeric';

type MenuEntry<T extends string = string> = { id: T; label: string; tooltip: string };

type WorldBuilderDeps = {
  state: GameState;
  hasPermission: (key: string) => boolean;
  send: (message: OutgoingMessage) => void;
  updateStatus: (message: string) => void;
  announceMenuEntry: (menu: string, option: string) => void;
  blip: () => void;
  confirm: () => void;
  cancel: () => void;
  applyTextInputEdit: (code: string, key: string, maxLength: number, ctrlKey?: boolean, allowReplaceOnNextType?: boolean) => void;
  setReplaceTextOnNextType: (value: boolean) => void;
};

const ROOT_ACTIONS = [
  { id: 'add', label: 'Add wall', tooltip: 'Create a one-square wall beside your current position.' },
  { id: 'edit', label: 'Edit walls', tooltip: 'Choose a wall on this floor to resize, edit, or delete.' },
] as const;
const DIRECTIONS = [
  { id: 'north', label: 'North', tooltip: 'Place the wall along the north edge of your current square.' },
  { id: 'south', label: 'South', tooltip: 'Place the wall along the south edge of your current square.' },
  { id: 'east', label: 'East', tooltip: 'Place the wall along the east edge of your current square.' },
  { id: 'west', label: 'West', tooltip: 'Place the wall along the west edge of your current square.' },
] as const;
const WALL_ACTIONS = [
  { id: 'properties', label: 'Edit properties', tooltip: 'Change the wall type or edit its sound properties.' },
  { id: 'extendStart', label: 'Extend start', tooltip: 'Add one square at the wall run’s starting end.' },
  { id: 'shortenStart', label: 'Shorten start', tooltip: 'Remove one square from the wall run’s starting end.' },
  { id: 'extendEnd', label: 'Extend end', tooltip: 'Add one square at the wall run’s ending end.' },
  { id: 'shortenEnd', label: 'Shorten end', tooltip: 'Remove one square from the wall run’s ending end.' },
  { id: 'delete', label: 'Delete wall', tooltip: 'Delete this entire wall run.' },
] as const;
const PROPERTY_ACTIONS = [
  { id: 'preset', label: 'Type', tooltip: 'Choose a wall type and reset all wall properties to that preset’s defaults.' },
  { id: 'soundTransmission', label: 'Sound transmission', tooltip: 'Set gain from 0, silent, to 1, unchanged. Use Left or Right for 0.05 steps and Page Up or Page Down for 0.5.' },
  { id: 'occlusionLowpassHz', label: 'Occlusion low-pass', tooltip: 'Set the highest transmitted frequency from 20 to 20000 hertz. Use Left or Right for 100 hertz and Page Up or Page Down for 1000.' },
  { id: 'contactSound', label: 'Contact sound', tooltip: 'Set the sound URL played when someone hits or passes through this wall.' },
] as const;
const DELETE_CHOICES = [
  { id: 'no', label: 'No', tooltip: 'Keep this wall.' },
  { id: 'yes', label: 'Yes', tooltip: 'Permanently delete this entire wall run.' },
] as const;
type PropertyId = typeof PROPERTY_ACTIONS[number]['id'];
type EditablePropertyId = Exclude<PropertyId, 'preset'>;

const NUMERIC_PROPERTIES = {
  soundTransmission: { min: 0, max: 1, step: 0.05, anchor: 0 },
  occlusionLowpassHz: { min: 20, max: 20_000, step: 100, anchor: 0 },
} as const;

/** Create the accessible menu controller for live wall editing. */
export function createWorldBuilderController(deps: WorldBuilderDeps) {
  let presets: StructurePreset[] = [];
  let index = 0;
  let selectedPreset: StructurePreset | null = null;
  let walls: WallStructure[] = [];
  let selectedWallId: string | null = null;
  let editingProperty: EditablePropertyId | null = null;

  function selectedWall(): WallStructure | null {
    return selectedWallId ? deps.state.structures.get(selectedWallId) ?? null : null;
  }

  function wallLabel(wall: WallStructure): string {
    return `${wall.title}, ${wall.length} squares, ${wall.orientation}, start ${wall.startX}, ${wall.startY}`;
  }

  function propertyEntries(wall: WallStructure | null): MenuEntry<PropertyId>[] {
    return PROPERTY_ACTIONS.map((entry) => {
      if (!wall) return entry;
      if (entry.id === 'preset') {
        const typeTitle = presets.find((preset) => preset.id === wall.preset)?.title ?? wall.title;
        return { ...entry, label: `${entry.label}: ${typeTitle}` };
      }
      if (entry.id === 'soundTransmission') {
        return { ...entry, label: `${entry.label}: ${formatSteppedNumber(wall.soundTransmission, 0.05)}` };
      }
      if (entry.id === 'occlusionLowpassHz') {
        return { ...entry, label: `${entry.label}: ${wall.occlusionLowpassHz} hertz` };
      }
      return { ...entry, label: `${entry.label}: ${wall.contactSound || 'none'}` };
    });
  }

  function open(): void {
    if (!deps.hasPermission('world.structure.edit')) {
      deps.updateStatus('World Builder permission required.');
      deps.cancel();
      return;
    }
    index = 0;
    deps.state.mode = 'worldBuilder';
    deps.announceMenuEntry('World Builder', ROOT_ACTIONS[index].label);
  }

  function handleList<T extends string>(
    code: string,
    key: string,
    entries: readonly MenuEntry<T>[],
    onSelect: (entry: T) => void,
    menu: string,
    onCancel: () => void,
  ): void {
    const control = handleListControlKey(code, key, entries, index, (entry) => entry.label);
    if (control.type === 'move') {
      index = control.index;
      deps.updateStatus(entries[index].label);
      deps.blip();
    } else if (control.type === 'select') {
      onSelect(entries[index].id);
    } else if (control.type === 'cancel') {
      onCancel();
      deps.cancel();
    } else if (code === 'Space') {
      deps.updateStatus(entries[index].tooltip);
    }
  }

  function handleRoot(code: string, key: string): void {
    handleList(code, key, ROOT_ACTIONS, (entry) => {
      if (entry === 'add') {
        if (presets.length === 0) {
          deps.updateStatus('No wall presets are configured.');
          deps.cancel();
          return;
        }
        index = 0;
        deps.state.mode = 'worldBuilderPreset';
        deps.announceMenuEntry('Wall presets', presets[0].title);
        return;
      }
      walls = nearbyWalls(deps.state.structures.values(), deps.state.player.x, deps.state.player.y, deps.state.player.z);
      if (walls.length === 0) {
        deps.updateStatus('No walls on this floor.');
        deps.cancel();
        return;
      }
      index = 0;
      deps.state.mode = 'worldBuilderWallList';
      deps.announceMenuEntry('Walls', wallLabel(walls[0]));
    }, 'World Builder', () => { deps.state.mode = 'normal'; });
  }

  function handlePreset(code: string, key: string): void {
    const entries = presets.map((preset) => ({
      id: preset.id,
      label: preset.title,
      tooltip: `${preset.title}: ${preset.movementBlocked ? 'blocks movement' : 'can be passed through'}, ${Math.round(preset.soundTransmission * 100)} percent sound transmission, ${preset.occlusionLowpassHz} hertz low-pass.`,
    }));
    handleList(code, key, entries, (_entry) => {
      selectedPreset = presets[index];
      index = 0;
      deps.state.mode = 'worldBuilderDirection';
      deps.announceMenuEntry('Wall side', DIRECTIONS[0].label);
    }, 'Wall presets', () => open());
  }

  function handleDirection(code: string, key: string): void {
    handleList(code, key, DIRECTIONS, (direction) => {
      if (!selectedPreset) return;
      deps.send({ type: 'structure_add_wall', preset: selectedPreset.id, direction });
      deps.state.mode = 'normal';
    }, 'Wall side', () => {
      index = 0;
      deps.state.mode = 'worldBuilderPreset';
      deps.announceMenuEntry('Wall presets', presets[0]?.title ?? 'No presets');
    });
  }

  function handleWallList(code: string, key: string): void {
    const entries = walls.map((wall) => ({ id: wall.id, label: wallLabel(wall), tooltip: `${wallLabel(wall)}. ${Math.round(wall.soundTransmission * 100)} percent sound transmission, ${wall.occlusionLowpassHz} hertz low-pass.` }));
    handleList(code, key, entries, () => {
      const wall = walls[index];
      selectedWallId = wall.id;
      index = 0;
      deps.state.mode = 'worldBuilderWallActions';
      deps.announceMenuEntry(wall.title, WALL_ACTIONS[0].label);
    }, 'Walls', () => open());
  }

  function handleWallActions(code: string, key: string): void {
    handleList(code, key, WALL_ACTIONS, (action) => {
      const wall = selectedWall();
      if (!wall) {
        deps.updateStatus('Wall no longer exists.');
        deps.state.mode = 'normal';
        deps.cancel();
        return;
      }
      if (action === 'properties') {
        index = 0;
        deps.state.mode = 'worldBuilderPropertyList';
        deps.announceMenuEntry(`${wall.title} properties`, PROPERTY_ACTIONS[0].label);
        return;
      }
      if (action === 'delete') {
        index = 0;
        deps.state.mode = 'worldBuilderDeleteConfirm';
        deps.announceMenuEntry(`Delete ${wall.title}?`, DELETE_CHOICES[0].label);
        return;
      }
      const resize = {
        extendStart: { endpoint: 'start' as const, delta: -1 as const },
        shortenStart: { endpoint: 'start' as const, delta: 1 as const },
        extendEnd: { endpoint: 'end' as const, delta: 1 as const },
        shortenEnd: { endpoint: 'end' as const, delta: -1 as const },
      }[action];
      deps.send({ type: 'structure_resize_wall', structureId: wall.id, ...resize });
    }, 'Wall actions', () => {
      index = 0;
      deps.state.mode = 'worldBuilderWallList';
      deps.announceMenuEntry('Walls', wallLabel(walls[0]));
    });
  }

  function handlePropertyList(code: string, key: string): void {
    const entries = propertyEntries(selectedWall());
    const property = PROPERTY_ACTIONS[index]?.id;
    const numeric = property === 'soundTransmission' || property === 'occlusionLowpassHz'
      ? NUMERIC_PROPERTIES[property]
      : null;
    if (
      numeric
      && (property === 'soundTransmission' || property === 'occlusionLowpassHz')
      && ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(code)
    ) {
      const wall = selectedWall();
      if (!wall) return;
      const currentValue = property === 'soundTransmission'
        ? wall.soundTransmission
        : wall.occlusionLowpassHz;
      const multiplier = code === 'PageUp' || code === 'PageDown' ? 10 : 1;
      const delta = (code === 'ArrowRight' || code === 'PageUp' ? numeric.step : -numeric.step) * multiplier;
      const attempted = snapNumberToStep(currentValue + delta, numeric.step, numeric.anchor);
      const nextValue = Math.max(numeric.min, Math.min(numeric.max, attempted));
      deps.state.structures.set(wall.id, { ...wall, [property]: nextValue });
      deps.send({ type: 'structure_update_wall', structureId: wall.id, [property]: nextValue });
      deps.updateStatus(formatSteppedNumber(nextValue, numeric.step));
      if (Math.abs(nextValue - currentValue) < 1e-9) deps.cancel();
      else deps.blip();
      return;
    }
    handleList(code, key, entries, (property) => {
      const wall = selectedWall();
      if (!wall) return;
      if (property === 'preset') {
        if (presets.length === 0) {
          deps.updateStatus('No wall presets are configured.');
          deps.cancel();
          return;
        }
        const currentIndex = presets.findIndex((preset) => preset.id === wall.preset);
        index = currentIndex >= 0 ? currentIndex : 0;
        deps.state.mode = 'worldBuilderTypeSelect';
        deps.announceMenuEntry('Wall type', presets[index].title);
        return;
      }
      editingProperty = property;
      deps.state.nicknameInput = String(wall[property]);
      deps.state.cursorPos = deps.state.nicknameInput.length;
      deps.setReplaceTextOnNextType(true);
      deps.state.mode = 'worldBuilderPropertyEdit';
      deps.updateStatus(`Edit ${PROPERTY_ACTIONS[index].label}: ${deps.state.nicknameInput}`);
    }, 'Wall properties', () => {
      index = 0;
      deps.state.mode = 'worldBuilderWallActions';
      deps.announceMenuEntry('Wall actions', WALL_ACTIONS[0].label);
    });
  }

  function handleTypeSelect(code: string, key: string): void {
    const entries = presets.map((preset) => ({
      id: preset.id,
      label: preset.title,
      tooltip: `Reset this wall to the complete ${preset.title} preset, including movement, height, sound transmission, low-pass, and contact sound.`,
    }));
    handleList(code, key, entries, (preset) => {
      const wall = selectedWall();
      if (!wall) return;
      deps.send({ type: 'structure_update_wall', structureId: wall.id, preset });
      index = 0;
      deps.state.mode = 'worldBuilderPropertyList';
      deps.updateStatus(`Resetting wall to ${entries.find((entry) => entry.id === preset)?.label ?? preset}.`);
    }, 'Wall type', () => {
      index = 0;
      deps.state.mode = 'worldBuilderPropertyList';
      deps.announceMenuEntry('Wall properties', PROPERTY_ACTIONS[0].label);
    });
  }

  function handlePropertyEdit(code: string, key: string, ctrlKey = false): void {
    if (
      editingProperty
      && editingProperty !== 'contactSound'
      && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(code)
    ) {
      const numeric = NUMERIC_PROPERTIES[editingProperty];
      const wall = selectedWall();
      if (!wall) return;
      const rawCurrent = Number(deps.state.nicknameInput.trim());
      const currentValue = Number.isFinite(rawCurrent) ? rawCurrent : wall[editingProperty];
      const multiplier = code === 'PageUp' || code === 'PageDown' ? 10 : 1;
      const delta = (code === 'ArrowUp' || code === 'PageUp' ? numeric.step : -numeric.step) * multiplier;
      const attempted = snapNumberToStep(currentValue + delta, numeric.step, numeric.anchor);
      const nextValue = Math.max(numeric.min, Math.min(numeric.max, attempted));
      deps.state.nicknameInput = formatSteppedNumber(nextValue, numeric.step);
      deps.state.cursorPos = deps.state.nicknameInput.length;
      deps.setReplaceTextOnNextType(false);
      deps.updateStatus(deps.state.nicknameInput);
      if (Math.abs(nextValue - currentValue) < 1e-9) deps.cancel();
      else deps.blip();
      return;
    }
    const action = getEditSessionAction(code);
    if (action === 'cancel') {
      index = 0;
      deps.state.mode = 'worldBuilderPropertyList';
      deps.announceMenuEntry('Wall properties', PROPERTY_ACTIONS[0].label);
      deps.cancel();
      return;
    }
    if (action === 'submit') {
      const wall = selectedWall();
      if (!wall || !editingProperty) return;
      const raw = deps.state.nicknameInput.trim();
      let value: number | string = raw;
      if (editingProperty === 'soundTransmission') {
        value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          deps.updateStatus('Sound transmission must be between 0 and 1.');
          deps.cancel();
          return;
        }
      } else if (editingProperty === 'occlusionLowpassHz') {
        value = Number(raw);
        if (!Number.isInteger(value) || value < 20 || value > 20_000) {
          deps.updateStatus('Occlusion low-pass must be a whole number from 20 to 20000 hertz.');
          deps.cancel();
          return;
        }
      }
      deps.send({ type: 'structure_update_wall', structureId: wall.id, [editingProperty]: value });
      deps.state.mode = 'worldBuilderPropertyList';
      deps.updateStatus(`Updating ${PROPERTY_ACTIONS.find((entry) => entry.id === editingProperty)?.label ?? 'property'}.`);
      return;
    }
    deps.applyTextInputEdit(code, key, editingProperty === 'contactSound' ? 200 : 10, ctrlKey, true);
  }

  function handleDeleteConfirm(code: string, key: string): void {
    handleList(code, key, DELETE_CHOICES, (choice) => {
      const wall = selectedWall();
      if (choice === 'yes' && wall) {
        deps.send({ type: 'structure_delete', structureId: wall.id });
        deps.state.mode = 'normal';
        return;
      }
      index = 0;
      deps.state.mode = 'worldBuilderWallActions';
      deps.announceMenuEntry('Wall actions', WALL_ACTIONS[0].label);
      deps.cancel();
    }, 'Delete wall?', () => {
      index = 0;
      deps.state.mode = 'worldBuilderWallActions';
      deps.announceMenuEntry('Wall actions', WALL_ACTIONS[0].label);
    });
  }

  return {
    setPresets(next: StructurePreset[]) {
      presets = [...next];
    },
    getEditingPropertyLabel() {
      return PROPERTY_ACTIONS.find((entry) => entry.id === editingProperty)?.label ?? 'Wall property';
    },
    open,
    handleRoot,
    handlePreset,
    handleDirection,
    handleWallList,
    handleWallActions,
    handlePropertyList,
    handleTypeSelect,
    handlePropertyEdit,
    handleDeleteConfirm,
    handleActionResult(message: { ok: boolean; message: string }) {
      deps.updateStatus(message.message);
      if (message.ok) deps.confirm();
      else deps.cancel();
    },
  };
}
