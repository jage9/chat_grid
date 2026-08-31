import { handleListControlKey } from './listController';
import { nearbyWalls } from '../state/structureGeometry';
import type { GameState, StructurePreset, WallStructure } from '../state/gameState';
import type { OutgoingMessage } from '../network/protocol';

type WorldBuilderDeps = {
  state: GameState;
  hasPermission: (key: string) => boolean;
  send: (message: OutgoingMessage) => void;
  updateStatus: (message: string) => void;
  announceMenuEntry: (menu: string, option: string) => void;
  blip: () => void;
  confirm: () => void;
  cancel: () => void;
};

const ROOT_ACTIONS = ['Add wall', 'Manage walls'] as const;
const DIRECTIONS = ['north', 'south', 'east', 'west'] as const;
const WALL_ACTIONS = [
  'Extend start',
  'Shorten start',
  'Extend end',
  'Shorten end',
  'Delete wall',
] as const;
const DELETE_CHOICES = ['No', 'Yes'] as const;

/** Create the accessible menu controller for live wall editing. */
export function createWorldBuilderController(deps: WorldBuilderDeps) {
  let presets: StructurePreset[] = [];
  let index = 0;
  let selectedPreset: StructurePreset | null = null;
  let walls: WallStructure[] = [];
  let selectedWallId: string | null = null;

  function selectedWall(): WallStructure | null {
    return selectedWallId ? deps.state.structures.get(selectedWallId) ?? null : null;
  }

  function wallLabel(wall: WallStructure): string {
    return `${wall.title}, ${wall.length} squares, ${wall.orientation}, start ${wall.startX}, ${wall.startY}`;
  }

  function open(): void {
    if (!deps.hasPermission('world.structure.edit')) {
      deps.updateStatus('World Builder permission required.');
      deps.cancel();
      return;
    }
    index = 0;
    deps.state.mode = 'worldBuilder';
    deps.announceMenuEntry('World Builder', ROOT_ACTIONS[index]);
  }

  function handleList<T extends string>(
    code: string,
    key: string,
    entries: readonly T[],
    onSelect: (entry: T) => void,
    menu: string,
    onCancel: () => void,
  ): void {
    const control = handleListControlKey(code, key, entries, index, (entry) => entry);
    if (control.type === 'move') {
      index = control.index;
      deps.updateStatus(entries[index]);
      deps.blip();
    } else if (control.type === 'select') {
      onSelect(entries[index]);
    } else if (control.type === 'cancel') {
      onCancel();
      deps.cancel();
    } else if (code === 'Space') {
      deps.announceMenuEntry(menu, entries[index]);
    }
  }

  function handleRoot(code: string, key: string): void {
    handleList(code, key, ROOT_ACTIONS, (entry) => {
      if (entry === 'Add wall') {
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
    const labels = presets.map((preset) => preset.title);
    handleList(code, key, labels, (_entry) => {
      selectedPreset = presets[index];
      index = 0;
      deps.state.mode = 'worldBuilderDirection';
      deps.announceMenuEntry('Wall side', DIRECTIONS[0]);
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
    const labels = walls.map(wallLabel);
    handleList(code, key, labels, () => {
      const wall = walls[index];
      selectedWallId = wall.id;
      index = 0;
      deps.state.mode = 'worldBuilderWallActions';
      deps.announceMenuEntry(wall.title, WALL_ACTIONS[0]);
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
      if (action === 'Delete wall') {
        index = 0;
        deps.state.mode = 'worldBuilderDeleteConfirm';
        deps.announceMenuEntry(`Delete ${wall.title}?`, DELETE_CHOICES[0]);
        return;
      }
      const resize = {
        'Extend start': { endpoint: 'start' as const, delta: -1 as const },
        'Shorten start': { endpoint: 'start' as const, delta: 1 as const },
        'Extend end': { endpoint: 'end' as const, delta: 1 as const },
        'Shorten end': { endpoint: 'end' as const, delta: -1 as const },
      }[action];
      deps.send({ type: 'structure_resize_wall', structureId: wall.id, ...resize });
    }, 'Wall actions', () => {
      index = 0;
      deps.state.mode = 'worldBuilderWallList';
      deps.announceMenuEntry('Walls', wallLabel(walls[0]));
    });
  }

  function handleDeleteConfirm(code: string, key: string): void {
    handleList(code, key, DELETE_CHOICES, (choice) => {
      const wall = selectedWall();
      if (choice === 'Yes' && wall) {
        deps.send({ type: 'structure_delete', structureId: wall.id });
        deps.state.mode = 'normal';
        return;
      }
      index = 0;
      deps.state.mode = 'worldBuilderWallActions';
      deps.announceMenuEntry('Wall actions', WALL_ACTIONS[0]);
      deps.cancel();
    }, 'Delete wall?', () => {
      index = 0;
      deps.state.mode = 'worldBuilderWallActions';
      deps.announceMenuEntry('Wall actions', WALL_ACTIONS[0]);
    });
  }

  return {
    setPresets(next: StructurePreset[]) {
      presets = [...next];
    },
    open,
    handleRoot,
    handlePreset,
    handleDirection,
    handleWallList,
    handleWallActions,
    handleDeleteConfirm,
    handleActionResult(message: { ok: boolean; message: string }) {
      deps.updateStatus(message.message);
      if (message.ok) deps.confirm();
      else deps.cancel();
    },
  };
}
