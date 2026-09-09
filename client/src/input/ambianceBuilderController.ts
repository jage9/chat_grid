import { handleListControlKey } from './listController';
import { getEditSessionAction } from './editSession';
import { formatSteppedNumber } from './numeric';
import {
  adjustPropertyValue,
  describePropertyHelp,
  getPropertyOptions,
  validateNumericPropertyInput,
  type PropertyControlMetadata,
} from './propertyControls';
import type { AmbianceRegion, AmbianceType } from '../state/gameState';
import type { WorldBuilderDeps } from './worldBuilderController';

type MenuEntry<T extends string = string> = { id: T; label: string; tooltip?: string };
type AmbianceProperty = 'name' | 'volume' | 'fadeDistance';
type AmbianceEdgeAction = 'startX' | 'startY' | 'endX' | 'endY';
type AmbianceSlideAction = 'slideX' | 'slideY';
type AmbianceAction =
  | 'type'
  | AmbianceProperty
  | AmbianceEdgeAction
  | AmbianceSlideAction
  | 'delete';

const AMBIANCE_PERMISSION = 'world.structure.edit';
const AMBIANCE_NAME_MAX_LENGTH = 100;

const AMBIANCE_ACTIONS: readonly MenuEntry<AmbianceAction>[] = [
  { id: 'type', label: 'Type', tooltip: 'Choose the looping sound used by this ambiance.' },
  { id: 'name', label: 'Name', tooltip: 'Edit the name announced for this ambiance.' },
  { id: 'startX', label: 'Start X', tooltip: 'Use Left or Right to move the west edge by one square.' },
  { id: 'startY', label: 'Start Y', tooltip: 'Use Left or Right to move the south edge by one square.' },
  { id: 'endX', label: 'End X', tooltip: 'Use Left or Right to move the east edge by one square.' },
  { id: 'endY', label: 'End Y', tooltip: 'Use Left or Right to move the north edge by one square.' },
  { id: 'slideX', label: 'Slide X', tooltip: 'Use Left or Right to move the whole rectangle along X by one square.' },
  { id: 'slideY', label: 'Slide Y', tooltip: 'Use Left or Right to move the whole rectangle along Y by one square.' },
  { id: 'volume', label: 'Volume', tooltip: 'Set the volume from 0 to 100 percent in steps of 5.' },
  { id: 'fadeDistance', label: 'Fade distance', tooltip: 'Set the fade distance from 0 to 100 squares in steps of 1.' },
  { id: 'delete', label: 'Delete ambiance', tooltip: 'Delete this entire ambiance region.' },
];

const EDGE_FOR_ACTION: Record<AmbianceEdgeAction, 'west' | 'east' | 'south' | 'north'> = {
  startX: 'west',
  endX: 'east',
  startY: 'south',
  endY: 'north',
};

const VOLUME_METADATA: PropertyControlMetadata = {
  valueType: 'number',
  tooltip: 'Set the ambiance volume from silent to full volume.',
  range: { min: 0, max: 100, step: 5, anchor: 0 },
};

const FADE_DISTANCE_METADATA: PropertyControlMetadata = {
  valueType: 'number',
  tooltip: 'Set how far the ambiance fades outside its rectangle.',
  range: { min: 0, max: 100, step: 1, anchor: 0 },
};

const EDGE_METADATA: Record<AmbianceEdgeAction, PropertyControlMetadata> = {
  startX: { valueType: 'number', tooltip: 'Move the west edge by one square with Left or Right.' },
  startY: { valueType: 'number', tooltip: 'Move the south edge by one square with Left or Right.' },
  endX: { valueType: 'number', tooltip: 'Move the east edge by one square with Left or Right.' },
  endY: { valueType: 'number', tooltip: 'Move the north edge by one square with Left or Right.' },
};

const SLIDE_METADATA: Record<AmbianceSlideAction, PropertyControlMetadata> = {
  slideX: { valueType: 'number', tooltip: 'Move the whole rectangle along X by one square with Left or Right.' },
  slideY: { valueType: 'number', tooltip: 'Move the whole rectangle along Y by one square with Left or Right.' },
};

function typeMetadata(types: AmbianceType[]): PropertyControlMetadata {
  return {
    valueType: 'list',
    tooltip: 'Choose the looping sound used by this ambiance.',
    options: types.map((type) => ({ id: type.id, label: type.title })),
  };
}

function propertyMetadata(property: AmbianceProperty): PropertyControlMetadata {
  if (property === 'volume') return VOLUME_METADATA;
  if (property === 'fadeDistance') return FADE_DISTANCE_METADATA;
  return {
    valueType: 'text',
    tooltip: 'Set the name announced for this ambiance.',
    maxLength: AMBIANCE_NAME_MAX_LENGTH,
  };
}

function isAmbianceEdgeAction(action: AmbianceAction | undefined): action is AmbianceEdgeAction {
  return action === 'startX' || action === 'startY' || action === 'endX' || action === 'endY';
}

function isAmbianceSlideAction(action: AmbianceAction | undefined): action is AmbianceSlideAction {
  return action === 'slideX' || action === 'slideY';
}

function ambianceDistanceToPlayer(ambiance: AmbianceRegion, x: number, y: number): number {
  const minX = Math.min(ambiance.startX, ambiance.endX);
  const maxX = Math.max(ambiance.startX, ambiance.endX);
  const minY = Math.min(ambiance.startY, ambiance.endY);
  const maxY = Math.max(ambiance.startY, ambiance.endY);
  const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
  const dy = y < minY ? minY - y : y > maxY ? y - maxY : 0;
  return Math.hypot(dx, dy);
}

/** Create the accessible World Builder controller for server-owned ambiance regions. */
export function createAmbianceBuilderController(deps: WorldBuilderDeps & { onBackToRoot?: () => void }) {
  let types: AmbianceType[] = [];
  let ambiances: AmbianceRegion[] = [];
  let selectedAmbianceId: string | null = null;
  let index = 0;
  let editingProperty: AmbianceProperty | null = null;

  function selectedAmbiance(): AmbianceRegion | null {
    return selectedAmbianceId ? deps.state.ambiances.get(selectedAmbianceId) ?? null : null;
  }

  function ambianceTypeTitle(soundId: string): string {
    return types.find((type) => type.id === soundId)?.title ?? soundId;
  }

  function ambianceLabel(ambiance: AmbianceRegion): string {
    return `${ambiance.name}, ${ambiance.startX}, ${ambiance.startY} to ${ambiance.endX}, ${ambiance.endY}`;
  }

  function sortedAmbiances(): AmbianceRegion[] {
    return Array.from(deps.state.ambiances.values())
      .filter((ambiance) => ambiance.floorZ === deps.state.player.z)
      .sort((left, right) => {
        const distance = ambianceDistanceToPlayer(left, deps.state.player.x, deps.state.player.y)
          - ambianceDistanceToPlayer(right, deps.state.player.x, deps.state.player.y);
        if (distance !== 0) return distance;
        const name = left.name.localeCompare(right.name);
        return name !== 0 ? name : left.id.localeCompare(right.id);
      });
  }

  function actionEntries(ambiance: AmbianceRegion | null): MenuEntry<AmbianceAction>[] {
    return AMBIANCE_ACTIONS.map((entry) => {
      if (!ambiance) return { ...entry };
      if (entry.id === 'type') return { ...entry, label: `${entry.label}: ${ambianceTypeTitle(ambiance.soundId)}` };
      if (entry.id === 'name') return { ...entry, label: `${entry.label}: ${ambiance.name}` };
      if (entry.id === 'startX') return { ...entry, label: `${entry.label}: ${ambiance.startX}` };
      if (entry.id === 'startY') return { ...entry, label: `${entry.label}: ${ambiance.startY}` };
      if (entry.id === 'endX') return { ...entry, label: `${entry.label}: ${ambiance.endX}` };
      if (entry.id === 'endY') return { ...entry, label: `${entry.label}: ${ambiance.endY}` };
      if (entry.id === 'slideX') return { ...entry, label: `${entry.label}: ${ambiance.startX} to ${ambiance.endX}` };
      if (entry.id === 'slideY') return { ...entry, label: `${entry.label}: ${ambiance.startY} to ${ambiance.endY}` };
      if (entry.id === 'volume') return { ...entry, label: `${entry.label}: ${formatSteppedNumber(ambiance.volume, 5)} percent` };
      if (entry.id === 'fadeDistance') return { ...entry, label: `${entry.label}: ${formatSteppedNumber(ambiance.fadeDistance, 1)} squares` };
      return entry;
    });
  }

  function announceCurrentAction(): void {
    const ambiance = selectedAmbiance();
    if (!ambiance) return;
    const entries = actionEntries(ambiance);
    deps.announceMenuEntry(ambiance.name, entries[index]?.label ?? entries[0].label);
  }

  function returnToRoot(): void {
    selectedAmbianceId = null;
    editingProperty = null;
    index = 0;
    if (deps.onBackToRoot) deps.onBackToRoot();
    else deps.state.mode = 'worldBuilder';
  }

  function handleStaleSelection(): void {
    returnToRoot();
    deps.updateStatus('Ambiance no longer exists.');
    deps.cancel();
  }

  function openActions(ambiance: AmbianceRegion): void {
    selectedAmbianceId = ambiance.id;
    editingProperty = null;
    index = 0;
    deps.state.mode = 'worldBuilderAmbianceActions';
    deps.announceMenuEntry(ambiance.name, actionEntries(ambiance)[0].label);
  }

  function hasPermission(): boolean {
    if (deps.hasPermission(AMBIANCE_PERMISSION)) return true;
    deps.updateStatus('World Builder permission required.');
    deps.state.mode = 'normal';
    deps.cancel();
    return false;
  }

  function openList(): void {
    if (!hasPermission()) return;
    ambiances = sortedAmbiances();
    if (ambiances.length === 0) {
      deps.state.mode = 'worldBuilder';
      deps.updateStatus('No ambiances on this floor.');
      deps.cancel();
      return;
    }
    index = 0;
    deps.state.mode = 'worldBuilderAmbianceList';
    deps.announceMenuEntry('Ambiances', ambianceLabel(ambiances[0]));
  }

  function requestAdd(): void {
    if (!hasPermission()) return;
    deps.send({ type: 'ambiance_add' });
    deps.state.mode = 'normal';
  }

  function handleList<T extends string>(
    code: string,
    key: string,
    entries: readonly MenuEntry<T>[],
    onSelect: (entry: T) => void,
    onCancel: () => void,
  ): void {
    if (entries.length === 0) {
      onCancel();
      deps.cancel();
      return;
    }
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

  function sendUpdate(
    ambianceId: string,
    property: 'name' | 'soundId' | 'volume' | 'fadeDistance',
    value: string | number,
  ): boolean {
    const latest = deps.state.ambiances.get(ambianceId);
    if (!latest) {
      handleStaleSelection();
      return false;
    }
    if (property === 'name') {
      deps.send({ type: 'ambiance_update', ambianceId, name: String(value) });
    } else if (property === 'soundId') {
      deps.send({ type: 'ambiance_update', ambianceId, soundId: String(value) });
    } else if (property === 'volume') {
      deps.send({ type: 'ambiance_update', ambianceId, volume: Number(value) });
    } else {
      deps.send({ type: 'ambiance_update', ambianceId, fadeDistance: Number(value) });
    }
    return true;
  }

  function previewNumericValue(ambianceId: string, property: 'volume' | 'fadeDistance', value: number): boolean {
    const latest = deps.state.ambiances.get(ambianceId);
    if (!latest) {
      handleStaleSelection();
      return false;
    }
    deps.state.ambiances.set(ambianceId, { ...latest, [property]: value });
    return sendUpdate(ambianceId, property, value);
  }

  function handleListInput(code: string, key: string): void {
    const entries = ambiances.map((ambiance) => ({
      id: ambiance.id,
      label: ambianceLabel(ambiance),
      tooltip: `${ambianceLabel(ambiance)}. ${ambianceTypeTitle(ambiance.soundId)}, ${ambiance.volume} percent volume, fade distance ${ambiance.fadeDistance}.`,
    }));
    handleList(code, key, entries, (ambianceId) => {
      const ambiance = deps.state.ambiances.get(ambianceId);
      if (!ambiance || ambiance.floorZ !== deps.state.player.z) {
        handleStaleSelection();
        return;
      }
      openActions(ambiance);
    }, () => {
      if (deps.onBackToRoot) deps.onBackToRoot();
      else deps.state.mode = 'worldBuilder';
    });
  }

  function handleActions(code: string, key: string): void {
    const ambiance = selectedAmbiance();
    if (!ambiance) {
      handleStaleSelection();
      return;
    }
    const entries = actionEntries(ambiance);
    const currentAction = entries[index]?.id;

    if (isAmbianceEdgeAction(currentAction) && (code === 'ArrowLeft' || code === 'ArrowRight')) {
      if (!hasPermission()) return;
      deps.send({
        type: 'ambiance_resize',
        ambianceId: ambiance.id,
        edge: EDGE_FOR_ACTION[currentAction],
        delta: code === 'ArrowLeft' ? -1 : 1,
      });
      return;
    }
    if (isAmbianceSlideAction(currentAction) && (code === 'ArrowLeft' || code === 'ArrowRight')) {
      if (!hasPermission()) return;
      deps.send({
        type: 'ambiance_slide',
        ambianceId: ambiance.id,
        axis: currentAction === 'slideX' ? 'x' : 'y',
        delta: code === 'ArrowLeft' ? -1 : 1,
      });
      return;
    }
    if (currentAction === 'type') {
      if (code === 'Space') {
        deps.updateStatus(describePropertyHelp('Type', typeMetadata(types), true));
        return;
      }
      if (types.length === 0 && ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(code)) {
        deps.updateStatus('No ambiance types are configured.');
        deps.cancel();
        return;
      }
      const adjustment = adjustPropertyValue(code, ambiance.soundId, typeMetadata(types));
      if (adjustment) {
        if (!hasPermission()) return;
        const nextSoundId = String(adjustment.value);
        const latest = deps.state.ambiances.get(ambiance.id);
        if (!latest) {
          handleStaleSelection();
          return;
        }
        deps.state.ambiances.set(ambiance.id, { ...latest, soundId: nextSoundId });
        if (!sendUpdate(ambiance.id, 'soundId', nextSoundId)) return;
        deps.updateStatus(adjustment.displayValue);
        deps.blip();
        return;
      }
    }
    if (currentAction === 'volume' || currentAction === 'fadeDistance') {
      if (code === 'Space') {
        deps.updateStatus(describePropertyHelp(
          currentAction === 'volume' ? 'Volume' : 'Fade distance',
          propertyMetadata(currentAction),
          true,
        ));
        return;
      }
      const adjustment = adjustPropertyValue(
        code,
        ambiance[currentAction],
        propertyMetadata(currentAction),
      );
      if (adjustment) {
        if (!hasPermission()) return;
        const value = Number(adjustment.value);
        if (!previewNumericValue(ambiance.id, currentAction, value)) return;
        deps.updateStatus(adjustment.displayValue);
        if (adjustment.hitBoundary) deps.cancel();
        else deps.blip();
        return;
      }
    }
    if (code === 'Space' && isAmbianceEdgeAction(currentAction)) {
      deps.updateStatus(describePropertyHelp(entries[index].label, EDGE_METADATA[currentAction], true));
      return;
    }
    if (code === 'Space' && isAmbianceSlideAction(currentAction)) {
      deps.updateStatus(describePropertyHelp(entries[index].label, SLIDE_METADATA[currentAction], true));
      return;
    }
    if (code === 'Space' && currentAction === 'name') {
      deps.updateStatus(describePropertyHelp('Name', propertyMetadata('name'), true));
      return;
    }

    handleList(code, key, entries, (action) => {
      const current = selectedAmbiance();
      if (!current) {
        handleStaleSelection();
        return;
      }
      if (action === 'type') {
        if (types.length === 0) {
          deps.updateStatus('No ambiance types are configured.');
          deps.cancel();
          return;
        }
        deps.openOptionSelector({
          title: 'Ambiance type',
          options: getPropertyOptions(typeMetadata(types)),
          selectedId: current.soundId,
          onSelect: (soundId) => {
            if (!hasPermission()) return;
            if (!sendUpdate(current.id, 'soundId', soundId)) return;
            deps.state.mode = 'worldBuilderAmbianceActions';
            announceCurrentAction();
          },
          onCancel: () => {
            if (!selectedAmbiance()) {
              handleStaleSelection();
              return;
            }
            deps.state.mode = 'worldBuilderAmbianceActions';
            announceCurrentAction();
          },
        });
        return;
      }
      if (action === 'name' || action === 'volume' || action === 'fadeDistance') {
        editingProperty = action;
        deps.state.nicknameInput = String(current[action]);
        deps.state.cursorPos = deps.state.nicknameInput.length;
        deps.setReplaceTextOnNextType(true);
        deps.state.mode = 'worldBuilderAmbianceEdit';
        deps.updateStatus(`Edit ${action === 'fadeDistance' ? 'Fade distance' : action[0].toUpperCase() + action.slice(1)}: ${deps.state.nicknameInput}`);
        return;
      }
      if (action === 'delete') {
        deps.openConfirmation({
          prompt: `Delete ${current.name}?`,
          onConfirm: () => {
            if (!hasPermission()) return;
            if (!selectedAmbiance()) {
              handleStaleSelection();
              return;
            }
            deps.send({ type: 'ambiance_delete', ambianceId: current.id });
            selectedAmbianceId = null;
            editingProperty = null;
            deps.state.mode = 'normal';
          },
          onCancel: () => {
            if (!selectedAmbiance()) {
              handleStaleSelection();
              return;
            }
            deps.state.mode = 'worldBuilderAmbianceActions';
            announceCurrentAction();
          },
        });
        return;
      }
      deps.updateStatus(entries[index].tooltip ?? 'No tooltip available.');
    }, openList);
  }

  function editingPropertyLabel(property: AmbianceProperty | null): string {
    if (property === 'fadeDistance') return 'Fade distance';
    if (property === 'volume') return 'Volume';
    return 'Name';
  }

  function handleEdit(code: string, key: string, ctrlKey = false): void {
    const ambiance = selectedAmbiance();
    if (!ambiance || !editingProperty) {
      handleStaleSelection();
      return;
    }
    if (editingProperty !== 'name' && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(code)) {
      const rawCurrent = Number(deps.state.nicknameInput.trim());
      const currentValue = Number.isFinite(rawCurrent) ? rawCurrent : ambiance[editingProperty];
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
      editingProperty = null;
      deps.setReplaceTextOnNextType(false);
      deps.state.mode = 'worldBuilderAmbianceActions';
      announceCurrentAction();
      deps.cancel();
      return;
    }
    if (action === 'submit') {
      const property = editingProperty;
      const label = editingPropertyLabel(property);
      const raw = deps.state.nicknameInput.trim();
      if (!hasPermission()) {
        editingProperty = null;
        deps.setReplaceTextOnNextType(false);
        return;
      }
      if (property === 'name') {
        if (!raw) {
          deps.updateStatus('Name is required.');
          deps.cancel();
          return;
        }
        if (raw.length > AMBIANCE_NAME_MAX_LENGTH) {
          deps.updateStatus(`Name must be ${AMBIANCE_NAME_MAX_LENGTH} characters or less.`);
          deps.cancel();
          return;
        }
        if (!sendUpdate(ambiance.id, 'name', raw)) return;
      } else {
        const parsed = validateNumericPropertyInput(
          label,
          raw,
          propertyMetadata(property),
          property === 'volume',
        );
        if (!parsed.ok) {
          deps.updateStatus(parsed.message);
          deps.cancel();
          return;
        }
        if (!sendUpdate(ambiance.id, property, parsed.value)) return;
      }
      editingProperty = null;
      deps.setReplaceTextOnNextType(false);
      deps.state.mode = 'worldBuilderAmbianceActions';
      deps.updateStatus(`Updating ${label}.`);
      return;
    }
    deps.applyTextInputEdit(
      code,
      key,
      editingProperty === 'name' ? AMBIANCE_NAME_MAX_LENGTH : 10,
      ctrlKey,
      true,
    );
  }

  function handleActionResult(message: {
    ok: boolean;
    action: 'add' | 'resize' | 'slide' | 'update' | 'delete';
    message: string;
    ambianceId?: string | null;
  }): void {
    deps.updateStatus(message.message);
    if (!message.ok) {
      deps.cancel();
      return;
    }
    deps.confirm();
    if (message.action === 'add' && message.ambianceId) {
      const ambiance = deps.state.ambiances.get(message.ambianceId);
      if (ambiance) openActions(ambiance);
    }
    if (message.action === 'delete' && message.ambianceId === selectedAmbianceId) {
      selectedAmbianceId = null;
      editingProperty = null;
      deps.state.mode = 'normal';
    }
  }

  return {
    setTypes(next: AmbianceType[]) {
      types = [...next];
    },
    requestAdd,
    openList,
    handleList: handleListInput,
    handleActions,
    handleEdit,
    getEditingPropertyLabel() {
      return editingPropertyLabel(editingProperty);
    },
    handleActionResult,
  };
}

export type AmbianceBuilderController = ReturnType<typeof createAmbianceBuilderController>;
