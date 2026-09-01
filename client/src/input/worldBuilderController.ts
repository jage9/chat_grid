import { handleListControlKey } from './listController';
import { nearbyWalls, wallEdgeAnchor } from '../state/structureGeometry';
import type { GameState, StructurePreset, WallStructure } from '../state/gameState';
import type { OutgoingMessage } from '../network/protocol';
import { getEditSessionAction } from './editSession';
import { formatSteppedNumber } from './numeric';
import type { OptionSelectorRequest } from './optionSelector';
import type { ConfirmationRequest } from './confirmationController';
import {
  adjustPropertyValue,
  describePropertyHelp,
  getPropertyOptions,
  validateNumericPropertyInput,
  type PropertyControlMetadata,
} from './propertyControls';

type MenuEntry<T extends string = string> = { id: T; label: string; tooltip?: string };

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
  openOptionSelector: (request: OptionSelectorRequest) => void;
  openConfirmation: (request: ConfirmationRequest) => void;
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
  { id: 'type', label: 'Type', tooltip: 'Choose a wall type and reset all wall properties to that type’s defaults.' },
  { id: 'orientation', label: 'Orientation', tooltip: 'Choose horizontal or vertical. Rotation keeps the start coordinate fixed and succeeds only if the run fits.' },
  { id: 'setStart', label: 'Set start edge', tooltip: 'Use Left or Right to decrease or increase the first occupied edge coordinate by one square.' },
  { id: 'setEnd', label: 'Set end edge', tooltip: 'Use Left or Right to decrease or increase the last occupied edge coordinate by one square.' },
  { id: 'slide', label: 'Slide', tooltip: 'Use Left or Right to move the complete wall perpendicular to its run by one square.' },
  { id: 'properties', label: 'Edit properties', tooltip: 'Edit the wall’s sound transmission, filtering, or contact sound.' },
  { id: 'delete', label: 'Delete wall', tooltip: 'Delete this entire wall run.' },
] as const;
const PROPERTY_ACTIONS = [
  { id: 'soundTransmission', label: 'Sound transmission' },
  { id: 'occlusionLowpassHz', label: 'Occlusion low-pass' },
  { id: 'contactSound', label: 'Contact sound' },
] as const;
type PropertyId = typeof PROPERTY_ACTIONS[number]['id'];

const NUMERIC_PROPERTIES = {
  soundTransmission: { min: 0, max: 1, step: 0.05, anchor: 0 },
  occlusionLowpassHz: { min: 20, max: 20_000, step: 100, anchor: 0 },
} as const;
const ORIENTATION_METADATA: PropertyControlMetadata = {
  valueType: 'list',
  tooltip: 'Set the wall run direction. Rotation keeps the start coordinate fixed and succeeds only if the run fits.',
  options: [
    { id: 'horizontal', label: 'Horizontal' },
    { id: 'vertical', label: 'Vertical' },
  ],
};

function typeMetadata(presets: StructurePreset[]): PropertyControlMetadata {
  return {
    valueType: 'list',
    tooltip: 'Choose a wall type and reset all wall properties to that type’s defaults.',
    options: presets.map((preset) => ({ id: preset.id, label: preset.title })),
  };
}

function propertyMetadata(property: PropertyId): PropertyControlMetadata {
  if (property === 'soundTransmission') {
    return {
      valueType: 'number',
      tooltip: 'Set how much sound passes through the wall, from silent to unchanged.',
      range: NUMERIC_PROPERTIES.soundTransmission,
    };
  }
  if (property === 'occlusionLowpassHz') {
    return {
      valueType: 'number',
      tooltip: 'Set the highest frequency that passes through the wall.',
      range: NUMERIC_PROPERTIES.occlusionLowpassHz,
    };
  }
  return {
    valueType: 'sound',
    tooltip: 'Set the sound played when someone hits or passes through the wall.',
    maxLength: 200,
  };
}

/** Create the accessible menu controller for live wall editing. */
export function createWorldBuilderController(deps: WorldBuilderDeps) {
  let presets: StructurePreset[] = [];
  let index = 0;
  let selectedPreset: StructurePreset | null = null;
  let walls: WallStructure[] = [];
  let selectedWallId: string | null = null;
  let editingProperty: PropertyId | null = null;

  function selectedWall(): WallStructure | null {
    return selectedWallId ? deps.state.structures.get(selectedWallId) ?? null : null;
  }

  function wallLabel(wall: WallStructure): string {
    return `${wall.title}, ${wall.length} squares, ${wall.orientation}, start ${wall.startX}, ${wall.startY}`;
  }

  function wallActionEntries(wall: WallStructure | null): MenuEntry<typeof WALL_ACTIONS[number]['id']>[] {
    return WALL_ACTIONS.map((entry) => {
      if (!wall) return entry;
      if (entry.id === 'type') {
        const typeTitle = presets.find((preset) => preset.id === wall.preset)?.title ?? wall.title;
        return { ...entry, label: `${entry.label}: ${typeTitle}` };
      }
      if (entry.id === 'setStart' || entry.id === 'setEnd') {
        const endpoint = entry.id === 'setStart' ? 'start' : 'end';
        return { ...entry, label: `${entry.label}: ${wallEdgeAnchor(wall, endpoint).join(', ')}` };
      }
      if (entry.id === 'slide') {
        const horizontal = wall.orientation === 'horizontal';
        return {
          ...entry,
          label: `Slide ${horizontal ? 'vertically' : 'horizontally'}: ${horizontal ? wall.startY : wall.startX}`,
        };
      }
      if (entry.id === 'orientation') {
        const orientation = wall.orientation === 'horizontal' ? 'Horizontal' : 'Vertical';
        return { ...entry, label: `${entry.label}: ${orientation}` };
      }
      return entry;
    });
  }

  function propertyEntries(wall: WallStructure | null): MenuEntry<PropertyId>[] {
    return PROPERTY_ACTIONS.map((entry) => {
      if (!wall) return entry;
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

  function openWallActions(wall: WallStructure): void {
    selectedWallId = wall.id;
    index = 0;
    deps.state.mode = 'worldBuilderWallActions';
    deps.announceMenuEntry(wall.title, wallActionEntries(wall)[0].label);
  }

  function openWallList(): void {
    walls = nearbyWalls(
      deps.state.structures.values(),
      deps.state.player.x,
      deps.state.player.y,
      deps.state.player.z,
    );
    if (walls.length === 0) {
      open();
      return;
    }
    index = 0;
    deps.state.mode = 'worldBuilderWallList';
    deps.announceMenuEntry('Walls', wallLabel(walls[0]));
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
      deps.updateStatus(entries[index].tooltip ?? 'No tooltip available.');
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
      openWallActions(walls[index]);
    }, 'Walls', () => open());
  }

  function handleWallActions(code: string, key: string): void {
    const wall = selectedWall();
    const entries = wallActionEntries(wall);
    const currentAction = entries[index]?.id;
    if (
      wall
      && (currentAction === 'setStart' || currentAction === 'setEnd')
      && (code === 'ArrowLeft' || code === 'ArrowRight')
    ) {
      deps.send({
        type: 'structure_resize_wall',
        structureId: wall.id,
        endpoint: currentAction === 'setStart' ? 'start' : 'end',
        delta: code === 'ArrowLeft' ? -1 : 1,
      });
      return;
    }
    if (wall && currentAction === 'slide' && (code === 'ArrowLeft' || code === 'ArrowRight')) {
      deps.send({
        type: 'structure_slide_wall',
        structureId: wall.id,
        delta: code === 'ArrowLeft' ? -1 : 1,
      });
      return;
    }
    if (wall && currentAction === 'type') {
      if (code === 'Space') {
        deps.updateStatus(describePropertyHelp('Type', typeMetadata(presets), true));
        return;
      }
      const adjustment = adjustPropertyValue(code, wall.preset, typeMetadata(presets));
      if (adjustment) {
        const nextPreset = presets.find((preset) => preset.id === adjustment.value);
        if (!nextPreset) return;
        deps.state.structures.set(wall.id, { ...wall, ...nextPreset, id: wall.id, preset: nextPreset.id });
        deps.send({ type: 'structure_update_wall', structureId: wall.id, preset: nextPreset.id });
        deps.updateStatus(adjustment.displayValue);
        if (adjustment.hitBoundary) deps.cancel();
        else deps.blip();
        return;
      }
    }
    if (wall && currentAction === 'orientation') {
      if (code === 'Space') {
        deps.updateStatus(describePropertyHelp('Orientation', ORIENTATION_METADATA, true));
        return;
      }
      const adjustment = adjustPropertyValue(code, wall.orientation, ORIENTATION_METADATA);
      if (adjustment) {
        deps.send({
          type: 'structure_rotate_wall',
          structureId: wall.id,
          orientation: adjustment.value as WallStructure['orientation'],
        });
        deps.updateStatus(adjustment.displayValue);
        deps.blip();
        return;
      }
    }
    handleList(code, key, entries, (action) => {
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
      if (action === 'type') {
        if (presets.length === 0) {
          deps.updateStatus('No wall presets are configured.');
          deps.cancel();
          return;
        }
        deps.openOptionSelector({
          title: 'Wall type',
          options: getPropertyOptions(typeMetadata(presets)),
          selectedId: wall.preset,
          onSelect: (preset) => {
            deps.send({ type: 'structure_update_wall', structureId: wall.id, preset });
            deps.state.mode = 'worldBuilderWallActions';
          },
          onCancel: () => {
            deps.state.mode = 'worldBuilderWallActions';
            deps.announceMenuEntry('Wall actions', wallActionEntries(selectedWall())[index].label);
          },
        });
        return;
      }
      if (action === 'delete') {
        deps.openConfirmation({
          prompt: `Delete ${wall.title}?`,
          onConfirm: () => {
            deps.send({ type: 'structure_delete', structureId: wall.id });
            deps.state.mode = 'normal';
          },
          onCancel: () => {
            index = 0;
            deps.state.mode = 'worldBuilderWallActions';
            deps.announceMenuEntry('Wall actions', WALL_ACTIONS[0].label);
          },
        });
        return;
      }
      if (action === 'orientation') {
        deps.openOptionSelector({
          title: 'Orientation',
          options: getPropertyOptions(ORIENTATION_METADATA),
          selectedId: wall.orientation,
          onSelect: (orientation) => {
            deps.send({
              type: 'structure_rotate_wall',
              structureId: wall.id,
              orientation: orientation as WallStructure['orientation'],
            });
            deps.state.mode = 'worldBuilderWallActions';
          },
          onCancel: () => {
            deps.state.mode = 'worldBuilderWallActions';
            deps.announceMenuEntry('Wall actions', wallActionEntries(selectedWall())[index].label);
          },
        });
        return;
      }
      deps.updateStatus(entries[index].tooltip);
    }, 'Wall actions', openWallList);
  }

  function handlePropertyList(code: string, key: string): void {
    const entries = propertyEntries(selectedWall());
    const property = PROPERTY_ACTIONS[index]?.id;
    if (property && ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(code)) {
      const wall = selectedWall();
      if (!wall) return;
      const currentValue = wall[property];
      const adjustment = adjustPropertyValue(code, currentValue, propertyMetadata(property));
      if (adjustment) {
        if (property === 'soundTransmission' || property === 'occlusionLowpassHz') {
          const nextValue = Number(adjustment.value);
          deps.state.structures.set(wall.id, { ...wall, [property]: nextValue });
          deps.send({ type: 'structure_update_wall', structureId: wall.id, [property]: nextValue });
        }
        deps.updateStatus(adjustment.displayValue);
        if (adjustment.hitBoundary) deps.cancel();
        else deps.blip();
        return;
      }
    }
    if (code === 'Space' && property) {
      const action = PROPERTY_ACTIONS[index];
      deps.updateStatus(describePropertyHelp(action.label, propertyMetadata(property), true));
      return;
    }
    handleList(code, key, entries, (property) => {
      const wall = selectedWall();
      if (!wall) return;
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

  function handlePropertyEdit(code: string, key: string, ctrlKey = false): void {
    if (editingProperty && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(code)) {
      const wall = selectedWall();
      if (!wall) return;
      const rawCurrent = Number(deps.state.nicknameInput.trim());
      const currentValue = Number.isFinite(rawCurrent) ? rawCurrent : wall[editingProperty];
      const adjustment = adjustPropertyValue(
        code,
        currentValue,
        propertyMetadata(editingProperty),
        'vertical',
      );
      if (adjustment) {
        deps.state.nicknameInput = adjustment.displayValue;
        deps.state.cursorPos = deps.state.nicknameInput.length;
        deps.setReplaceTextOnNextType(false);
        deps.updateStatus(deps.state.nicknameInput);
        if (adjustment.hitBoundary) deps.cancel();
        else deps.blip();
        return;
      }
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
      if (editingProperty === 'soundTransmission' || editingProperty === 'occlusionLowpassHz') {
        const label = PROPERTY_ACTIONS.find((entry) => entry.id === editingProperty)?.label ?? editingProperty;
        const parsed = validateNumericPropertyInput(
          label,
          raw,
          propertyMetadata(editingProperty),
          editingProperty === 'occlusionLowpassHz',
        );
        if (!parsed.ok) {
          deps.updateStatus(parsed.message);
          deps.cancel();
          return;
        }
        value = parsed.value;
      }
      deps.send({ type: 'structure_update_wall', structureId: wall.id, [editingProperty]: value });
      deps.state.mode = 'worldBuilderPropertyList';
      deps.updateStatus(`Updating ${PROPERTY_ACTIONS.find((entry) => entry.id === editingProperty)?.label ?? 'property'}.`);
      return;
    }
    deps.applyTextInputEdit(code, key, editingProperty === 'contactSound' ? 200 : 10, ctrlKey, true);
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
    handlePropertyEdit,
    handleActionResult(message: {
      ok: boolean;
      action: 'add' | 'resize' | 'slide' | 'rotate' | 'update' | 'delete';
      message: string;
      structureId?: string | null;
    }) {
      deps.updateStatus(message.message);
      if (!message.ok) {
        deps.cancel();
        return;
      }
      deps.confirm();
      if (message.action === 'add' && message.structureId) {
        const wall = deps.state.structures.get(message.structureId);
        if (wall) openWallActions(wall);
      }
    },
  };
}
