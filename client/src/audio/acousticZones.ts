import type { WorldItem } from '../state/gameState';
import { resolveWorldItemSourcePosition } from './worldItemPosition';

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

/** Locate a held sound in its carrier's acoustic zone and a placed sound at its nearest emitting height. */
export function worldItemAcousticZoneId(item: WorldItem, state: {
  player: { id: string | null; z: number; acousticZoneId: string };
  peers: ReadonlyMap<string, { acousticZoneId: string }>;
}): string {
  if (item.carrierId) {
    const carrier = item.carrierId === state.player.id ? state.player : state.peers.get(item.carrierId);
    if (carrier) return carrier.acousticZoneId;
  }
  return floorAcousticZoneId(resolveWorldItemSourcePosition(item, state.player.z).z);
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
    return this.zoneGain(listenerZoneId, items, nowMs) * this.zoneGain(sourceZoneId, items, nowMs);
  }

  private zoneGain(zoneId: string, items: Map<string, WorldItem>, nowMs: number): number {
    if (zoneId.startsWith('floor:')) return 1;
    const item = this.cabin(zoneId, items);
    return item ? this.doorTransmission(item, nowMs) : 0;
  }

  /** Admit one-shots as doors begin opening, even when the initial gain is zero. */
  canTransmit(listenerZoneId: string, sourceZoneId: string, items: Map<string, WorldItem>): boolean {
    return listenerZoneId === sourceZoneId
      || (this.zoneConnects(listenerZoneId, items, false) && this.zoneConnects(sourceZoneId, items, false));
  }

  /** Preload sources near a parked car so opening the doors can reveal them immediately. */
  couldConnect(listenerZoneId: string, sourceZoneId: string, items: Map<string, WorldItem>): boolean {
    return listenerZoneId === sourceZoneId
      || (this.zoneConnects(listenerZoneId, items, true) && this.zoneConnects(sourceZoneId, items, true));
  }

  private zoneConnects(zoneId: string, items: Map<string, WorldItem>, preload: boolean): boolean {
    if (zoneId.startsWith('floor:')) return true;
    const cabin = this.cabin(zoneId, items);
    if (!cabin) return false;
    const state = String(cabin.params.state ?? 'idle');
    return preload ? state !== 'moving' : ['opening', 'arriving', 'door_open', 'closing'].includes(state);
  }

  private cabin(zoneId: string, items: Map<string, WorldItem>): WorldItem | undefined {
    const id = parseElevatorZone(zoneId);
    const item = id ? items.get(id) : undefined;
    return item?.type === 'elevator' ? item : undefined;
  }
}
