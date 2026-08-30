import { isItemOnFloor, type WorldItem } from '../state/gameState';

const ELEVATOR_OPEN_SECONDS = 2.563107;
const ELEVATOR_CLOSE_SECONDS = 3.765601;

type Transition = {
  state: string;
  startedAtMs: number;
};

/** Returns the acoustic zone occupied by a user standing on a floor. */
export function floorAcousticZoneId(z: number): string {
  return `floor:${z}`;
}

/** Returns the acoustic zone occupied by a passenger in an elevator cabin. */
export function elevatorAcousticZoneId(itemId: string): string {
  return `elevator:${itemId}`;
}

/** Resolve a floor-bound item source against the listener's connected landing. */
export function worldItemAcousticZoneId(
  item: WorldItem,
  listenerZoneId: string,
  items: Map<string, WorldItem>,
): string {
  const listenerFloor = parseFloorZone(listenerZoneId);
  const listenerElevatorId = parseElevatorZone(listenerZoneId);
  const elevator = listenerElevatorId ? items.get(listenerElevatorId) : null;
  const connectedFloor = listenerFloor
    ?? (elevator?.type === 'elevator' ? Number(elevator.params.currentZ) : null);
  if (connectedFloor !== null && Number.isInteger(connectedFloor) && isItemOnFloor(item, connectedFloor)) {
    return floorAcousticZoneId(connectedFloor);
  }
  return floorAcousticZoneId(item.z);
}

function parseFloorZone(zoneId: string): number | null {
  if (!zoneId.startsWith('floor:')) return null;
  const z = Number(zoneId.slice('floor:'.length));
  return Number.isInteger(z) ? z : null;
}

function parseElevatorZone(zoneId: string): string | null {
  return zoneId.startsWith('elevator:') ? zoneId.slice('elevator:'.length) || null : null;
}

/** Tracks local door progress and resolves transmission between acoustic zones. */
export class AcousticZoneRuntime {
  private readonly transitions = new Map<string, Transition>();

  sync(items: Iterable<WorldItem>, nowMs = performance.now()): void {
    const validIds = new Set<string>();
    for (const item of items) {
      if (item.type !== 'elevator') continue;
      validIds.add(item.id);
      const state = String(item.params.state ?? 'idle');
      const previous = this.transitions.get(item.id);
      if (!previous || previous.state !== state) {
        this.transitions.set(item.id, { state, startedAtMs: nowMs });
      }
    }
    for (const itemId of this.transitions.keys()) {
      if (!validIds.has(itemId)) this.transitions.delete(itemId);
    }
  }

  doorTransmission(item: WorldItem, nowMs = performance.now()): number {
    const state = String(item.params.state ?? 'idle');
    if (state === 'door_open') return 1;
    const transition = this.transitions.get(item.id);
    const elapsedSeconds = Math.max(0, (nowMs - (transition?.startedAtMs ?? nowMs)) / 1000);
    if (state === 'opening' || state === 'arriving') {
      return Math.min(1, elapsedSeconds / ELEVATOR_OPEN_SECONDS);
    }
    if (state === 'closing') {
      return Math.max(0, 1 - elapsedSeconds / ELEVATOR_CLOSE_SECONDS);
    }
    return 0;
  }

  transmission(
    listenerZoneId: string,
    sourceZoneId: string,
    items: Map<string, WorldItem>,
    nowMs = performance.now(),
  ): number {
    if (listenerZoneId === sourceZoneId) return 1;
    const listenerFloor = parseFloorZone(listenerZoneId);
    const sourceFloor = parseFloorZone(sourceZoneId);
    const elevatorId = parseElevatorZone(listenerZoneId) ?? parseElevatorZone(sourceZoneId);
    const floorZ = listenerFloor ?? sourceFloor;
    if (!elevatorId || floorZ === null) return 0;
    const elevator = items.get(elevatorId);
    if (!elevator || elevator.type !== 'elevator' || Number(elevator.params.currentZ) !== floorZ) return 0;
    return this.doorTransmission(elevator, nowMs);
  }

  couldConnect(listenerZoneId: string, sourceZoneId: string, items: Map<string, WorldItem>): boolean {
    if (listenerZoneId === sourceZoneId) return true;
    const listenerFloor = parseFloorZone(listenerZoneId);
    const sourceFloor = parseFloorZone(sourceZoneId);
    const elevatorId = parseElevatorZone(listenerZoneId) ?? parseElevatorZone(sourceZoneId);
    const floorZ = listenerFloor ?? sourceFloor;
    if (!elevatorId || floorZ === null) return false;
    const elevator = items.get(elevatorId);
    if (!elevator || elevator.type !== 'elevator' || Number(elevator.params.currentZ) !== floorZ) return false;
    return String(elevator.params.state ?? 'idle') !== 'moving';
  }
}
