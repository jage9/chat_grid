import { describe, expect, it, vi } from 'vitest';
import { createAuthController } from './authController';

describe('microphone permission reapplication', () => {
  it.each([
    { permissions: ['voice.send'], muted: false, expectedMuted: false },
    { permissions: ['voice.send'], muted: true, expectedMuted: true },
    { permissions: [], muted: false, expectedMuted: true },
  ])('restores the current voice/mute policy: $expectedMuted', ({ permissions, muted, expectedMuted }) => {
    const applyMuteToTrack = vi.fn();
    const controller = createAuthController({
      // These authorization operations do not access the pre-connect form.
      dom: {} as Parameters<typeof createAuthController>[0]['dom'],
      authPolicyStorageKey: 'test',
      authSessionCookieSetUrl: '/session',
      authSessionCookieClearUrl: '/session',
      authSessionCookieClientHeader: 'test',
      initialAuthUsername: '',
      isRunning: () => true,
      isMuted: () => muted,
      isConnecting: () => false,
      setConnecting: vi.fn(),
      applyMuteToTrack,
      signalingSend: vi.fn(),
      disconnect: vi.fn(),
      saveAuthUsername: vi.fn(),
      setConnectionStatus: vi.fn(),
      updateStatus: vi.fn(),
      pushChatMessage: vi.fn(),
      onServerAdminMenuActions: vi.fn(),
    });
    controller.handleAuthPermissions({ type: 'auth_permissions', role: 'user', permissions });
    applyMuteToTrack.mockClear();

    // Microphone replacement needs the existing policy applied to the new track.
    controller.applyVoiceSendPermission();

    expect(applyMuteToTrack).toHaveBeenCalledOnce();
    expect(applyMuteToTrack).toHaveBeenCalledWith(expectedMuted);
  });
});
