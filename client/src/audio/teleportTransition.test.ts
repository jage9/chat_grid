import { describe, expect, it, vi } from 'vitest';
import {
  TeleportTransitionController,
  type TeleportTransitionEvent,
} from './teleportTransition';

const startEvent: TeleportTransitionEvent = {
  phase: 'start',
  x: 20,
  y: 30,
  z: 2,
  durationMs: 2000,
};

const arriveEvent: TeleportTransitionEvent = {
  ...startEvent,
  phase: 'arrive',
};

const completeEvent: TeleportTransitionEvent = {
  ...startEvent,
  phase: 'complete',
};

describe('TeleportTransitionController', () => {
  it('fades out for half the server duration and starts the cue', () => {
    const setGain = vi.fn();
    const onStart = vi.fn();
    const controller = new TeleportTransitionController({
      setWorldTransitionGain: setGain,
      onStart,
    });

    controller.handle(startEvent);

    expect(controller.isActive()).toBe(true);
    expect(setGain).toHaveBeenCalledWith(0, 1000);
    expect(onStart).toHaveBeenCalledWith(startEvent);
  });

  it('pins a quiet origin to silence before loading and fading the destination in', () => {
    const calls: string[] = [];
    const controller = new TeleportTransitionController({
      setWorldTransitionGain: (gain, duration) => calls.push(`gain:${gain}:${duration}`),
      onArrive: () => calls.push('arrive'),
    });

    controller.handle(startEvent);
    calls.length = 0;
    controller.handle(arriveEvent);

    expect(controller.isActive()).toBe(true);
    expect(calls).toEqual(['gain:0:0', 'arrive', 'gain:1:1000']);
  });

  it('restores gain and invokes completion after the fade-in phase', () => {
    const setGain = vi.fn();
    const onComplete = vi.fn();
    const controller = new TeleportTransitionController({
      setWorldTransitionGain: setGain,
      onComplete,
    });

    controller.handle(startEvent);
    controller.handle(arriveEvent);
    controller.handle(completeEvent);

    expect(controller.isActive()).toBe(false);
    expect(setGain).toHaveBeenLastCalledWith(1, 0);
    expect(onComplete).toHaveBeenCalledWith(completeEvent);
  });

  it('restores gain and invokes cancellation without accepting stale terminal phases', () => {
    const setGain = vi.fn();
    const onCancel = vi.fn();
    const onComplete = vi.fn();
    const controller = new TeleportTransitionController({
      setWorldTransitionGain: setGain,
      onCancel,
      onComplete,
    });

    controller.handle(startEvent);
    controller.handle({ ...startEvent, phase: 'cancel' });
    controller.handle(completeEvent);

    expect(controller.isActive()).toBe(false);
    expect(setGain).toHaveBeenLastCalledWith(1, 0);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('ignores midpoint and terminal phases until a start phase', () => {
    const setGain = vi.fn();
    const onArrive = vi.fn();
    const onComplete = vi.fn();
    const controller = new TeleportTransitionController({
      setWorldTransitionGain: setGain,
      onArrive,
      onComplete,
    });

    controller.handle(arriveEvent);
    controller.handle(completeEvent);

    expect(controller.isActive()).toBe(false);
    expect(setGain).not.toHaveBeenCalled();
    expect(onArrive).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('reset immediately restores gain and clears active state', () => {
    const setGain = vi.fn();
    const controller = new TeleportTransitionController({
      setWorldTransitionGain: setGain,
    });

    controller.handle(startEvent);
    controller.reset();

    expect(controller.isActive()).toBe(false);
    expect(setGain).toHaveBeenLastCalledWith(1, 0);
  });
});
