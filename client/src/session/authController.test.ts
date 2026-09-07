// @vitest-environment jsdom

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

it.each([false, true])('logs out and cancels recovery while disconnected, connecting=%s', (connecting) => {
  const controller = new AbortController();
  const disconnect = vi.fn(() => controller.abort());
  const signalingSend = vi.fn();
  const dom = Object.fromEntries([
    'loginView', 'registerView', 'authUsername', 'authPassword', 'registerUsername',
    'registerPassword', 'registerPasswordConfirm', 'registerEmail', 'authPolicyHintRegister',
    'authSessionView', 'authSessionText', 'authModeSeparator', 'showRegisterButton',
    'connectButton', 'logoutButton',
  ].map((key) => [key, document.createElement('input')])) as unknown as Parameters<typeof createAuthController>[0]['dom'];
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  try {
    const auth = createAuthController({
      dom,
      authPolicyStorageKey: 'test',
      authSessionCookieSetUrl: '/session',
      authSessionCookieClearUrl: '/session',
      authSessionCookieClientHeader: 'test',
      initialAuthUsername: 'user',
      isRunning: () => false,
      isMuted: () => false,
      isConnecting: () => connecting,
      setConnecting: vi.fn(),
      applyMuteToTrack: vi.fn(),
      signalingSend,
      disconnect,
      saveAuthUsername: vi.fn(),
      setConnectionStatus: vi.fn(),
      updateStatus: vi.fn(),
      pushChatMessage: vi.fn(),
      onServerAdminMenuActions: vi.fn(),
    });
    auth.logOutAccount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
    expect(signalingSend).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
