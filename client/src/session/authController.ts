import type { IncomingMessage, OutgoingMessage } from '../network/protocol';

export type AuthPolicy = {
  usernameMinLength: number;
  usernameMaxLength: number;
  passwordMinLength: number;
  passwordMaxLength: number;
};

type AuthMode = 'login' | 'register';

type AuthDom = {
  loginView: HTMLElement;
  registerView: HTMLElement;
  authUsername: HTMLInputElement;
  authPassword: HTMLInputElement;
  registerUsername: HTMLInputElement;
  registerPassword: HTMLInputElement;
  registerPasswordConfirm: HTMLInputElement;
  registerEmail: HTMLInputElement;
  authPolicyHintRegister: HTMLParagraphElement;
  authSessionView: HTMLElement;
  authSessionText: HTMLParagraphElement;
  authModeSeparator: HTMLElement;
  showRegisterButton: HTMLButtonElement;
  connectButton: HTMLButtonElement;
  logoutButton: HTMLButtonElement;
};

type AuthControllerDeps = {
  dom: AuthDom;
  authPolicyStorageKey: string;
  authSessionCookieSetUrl: string;
  authSessionCookieClearUrl: string;
  authSessionCookieClientHeader: string;
  initialAuthUsername: string;
  isRunning: () => boolean;
  isMuted: () => boolean;
  isConnecting: () => boolean;
  setConnecting: (value: boolean) => void;
  applyMuteToTrack: (muted: boolean) => void;
  signalingSend: (message: OutgoingMessage) => void;
  disconnect: () => void;
  saveAuthUsername: (username: string) => void;
  setConnectionStatus: (message: string) => void;
  updateStatus: (message: string) => void;
  pushChatMessage: (message: string) => void;
  onServerAdminMenuActions: (actions: Array<{ id: string; label: string; tooltip?: string }> | null | undefined) => void;
};

type AuthUiDeps = {
  connect: () => Promise<void>;
};

type WelcomeAuth = Extract<IncomingMessage, { type: 'welcome' }>['auth'];

/**
 * Creates the auth/session controller used by the pre-connect UI and auth packet flow.
 */
export function createAuthController(deps: AuthControllerDeps): {
  initializeUi: () => void;
  setupUiHandlers: (uiDeps: AuthUiDeps) => void;
  updateConnectAvailability: () => void;
  hasPermission: (key: string) => boolean;
  getVoiceSendAllowed: () => boolean;
  getAuthUserId: () => string;
  sendAuthRequest: () => void;
  setAuthMode: (mode: AuthMode) => void;
  handleAuthRequired: (message: Extract<IncomingMessage, { type: 'auth_required' }>) => void;
  handleAuthResult: (message: Extract<IncomingMessage, { type: 'auth_result' }>) => Promise<void>;
  handleAuthPermissions: (message: Extract<IncomingMessage, { type: 'auth_permissions' }>) => void;
  applyWelcomeAuth: (
    auth: WelcomeAuth,
    adminMenuActions: Array<{ id: string; label: string; tooltip?: string }> | null | undefined,
  ) => void;
  logOutAccount: () => void;
} {
  let authMode: AuthMode = 'login';
  let authUsername = deps.initialAuthUsername;
  let authUserId = '';
  let authPolicy: AuthPolicy | null = null;
  let authPermissions = new Set<string>();
  let voiceSendAllowed = true;
  let pendingAuthRequest = false;

  function sanitizeAuthUsername(value: string): string {
    const maxLength = authPolicy?.usernameMaxLength ?? 128;
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, Math.max(1, maxLength));
  }

  function applyVoiceSendPermission(): void {
    voiceSendAllowed = authPermissions.has('voice.send');
    if (voiceSendAllowed) {
      deps.applyMuteToTrack(deps.isMuted());
      return;
    }
    deps.applyMuteToTrack(true);
  }

  function applyAuthPermissions(role: string | null | undefined, permissions: string[] | null | undefined): void {
    void role;
    authPermissions = new Set((permissions || []).map((value) => String(value).trim()).filter((value) => value.length > 0));
    applyVoiceSendPermission();
  }

  function applyAuthPolicy(policy: unknown): void {
    if (!policy || typeof policy !== 'object') return;
    const raw = policy as Partial<AuthPolicy>;
    const usernameMin = Number(raw.usernameMinLength);
    const usernameMax = Number(raw.usernameMaxLength);
    const passwordMin = Number(raw.passwordMinLength);
    const passwordMax = Number(raw.passwordMaxLength);
    if (
      !Number.isInteger(usernameMin) ||
      !Number.isInteger(usernameMax) ||
      !Number.isInteger(passwordMin) ||
      !Number.isInteger(passwordMax)
    ) {
      return;
    }
    if (usernameMin < 1 || usernameMax < usernameMin || passwordMin < 1 || passwordMax < passwordMin) {
      return;
    }
    authPolicy = {
      usernameMinLength: usernameMin,
      usernameMaxLength: usernameMax,
      passwordMinLength: passwordMin,
      passwordMaxLength: passwordMax,
    };
    localStorage.setItem(deps.authPolicyStorageKey, JSON.stringify(authPolicy));
    deps.dom.authPolicyHintRegister.textContent = `Username, ${usernameMin}-${usernameMax} characters. Password, ${passwordMin}-${passwordMax} characters.`;
    deps.dom.authUsername.minLength = usernameMin;
    deps.dom.authUsername.maxLength = usernameMax;
    deps.dom.registerUsername.minLength = usernameMin;
    deps.dom.registerUsername.maxLength = usernameMax;
    deps.dom.authPassword.minLength = passwordMin;
    deps.dom.authPassword.maxLength = passwordMax;
    deps.dom.registerPassword.minLength = passwordMin;
    deps.dom.registerPassword.maxLength = passwordMax;
    deps.dom.registerPasswordConfirm.minLength = passwordMin;
    deps.dom.registerPasswordConfirm.maxLength = passwordMax;
    updateConnectAvailability();
  }

  function loadPersistedAuthPolicy(): void {
    const raw = localStorage.getItem(deps.authPolicyStorageKey);
    if (!raw) return;
    try {
      applyAuthPolicy(JSON.parse(raw));
    } catch {
      // Ignore malformed persisted policy and keep live server policy source of truth.
    }
  }

  function resetSavedSessionHint(): void {
    authUserId = '';
    authUsername = '';
    deps.saveAuthUsername('');
    deps.dom.authUsername.value = '';
    deps.dom.registerUsername.value = '';
  }

  function updateConnectAvailability(): void {
    const hasSavedSessionHint = sanitizeAuthUsername(authUsername).length > 0;
    const showLogout = deps.isRunning() || hasSavedSessionHint;
    deps.dom.logoutButton.classList.toggle('hidden', !showLogout);
    deps.dom.logoutButton.disabled = !showLogout;
    if (deps.isRunning()) {
      deps.dom.connectButton.textContent = 'Connect';
      deps.dom.connectButton.disabled = true;
      deps.dom.loginView.classList.add('hidden');
      deps.dom.registerView.classList.add('hidden');
      deps.dom.authSessionView.classList.add('hidden');
      return;
    }
    if (hasSavedSessionHint) {
      deps.dom.authSessionText.textContent = `Logged in as ${sanitizeAuthUsername(authUsername)}.`;
      deps.dom.showRegisterButton.classList.add('hidden');
      deps.dom.authModeSeparator.classList.add('hidden');
      deps.dom.loginView.classList.add('hidden');
      deps.dom.registerView.classList.add('hidden');
      deps.dom.authSessionView.classList.remove('hidden');
    } else {
      deps.dom.showRegisterButton.classList.remove('hidden');
      deps.dom.authModeSeparator.classList.remove('hidden');
      deps.dom.showRegisterButton.textContent = authMode === 'login' ? 'Register' : 'Login';
      deps.dom.loginView.classList.toggle('hidden', authMode !== 'login');
      deps.dom.registerView.classList.toggle('hidden', authMode !== 'register');
      deps.dom.authSessionView.classList.add('hidden');
    }
    const usernameMin = authPolicy?.usernameMinLength ?? 1;
    const passwordMin = authPolicy?.passwordMinLength ?? 1;
    const hasLoginCredentials =
      sanitizeAuthUsername(deps.dom.authUsername.value).length >= usernameMin &&
      deps.dom.authPassword.value.trim().length >= passwordMin;
    const hasRegisterCredentials =
      sanitizeAuthUsername(deps.dom.registerUsername.value).length >= usernameMin &&
      deps.dom.registerPassword.value.trim().length >= passwordMin &&
      deps.dom.registerPassword.value === deps.dom.registerPasswordConfirm.value;
    const authReady = authMode === 'login' ? true : hasRegisterCredentials;
    deps.dom.connectButton.textContent = hasSavedSessionHint
      ? 'Connect'
      : authMode === 'register'
        ? 'Register & Connect'
        : hasLoginCredentials
          ? 'Log In & Connect'
          : 'Connect';
    deps.dom.connectButton.disabled = deps.isConnecting() || !authReady;
  }

  function setAuthMode(mode: AuthMode): void {
    authMode = mode;
    deps.dom.loginView.classList.toggle('hidden', mode !== 'login');
    deps.dom.registerView.classList.toggle('hidden', mode !== 'register');
    updateConnectAvailability();
  }

  function buildAuthRequestPacket(): OutgoingMessage | null {
    if (authMode === 'register') {
      const username = sanitizeAuthUsername(deps.dom.registerUsername.value);
      const password = deps.dom.registerPassword.value;
      const email = deps.dom.registerEmail.value.trim();
      if (!username || !password || password !== deps.dom.registerPasswordConfirm.value) return null;
      return { type: 'auth_register', username, password, ...(email ? { email } : {}) };
    }
    const username = sanitizeAuthUsername(deps.dom.authUsername.value);
    const password = deps.dom.authPassword.value;
    if (!username || !password) return null;
    return { type: 'auth_login', username, password };
  }

  function sendAuthRequest(): void {
    const packet = buildAuthRequestPacket();
    if (!packet) {
      pendingAuthRequest = false;
      deps.setConnectionStatus('Attempting saved session...');
      deps.setConnecting(false);
      updateConnectAvailability();
      return;
    }
    pendingAuthRequest = true;
    deps.setConnectionStatus('Authenticating...');
    deps.signalingSend(packet);
  }

  function handleAuthRequired(message: Extract<IncomingMessage, { type: 'auth_required' }>): void {
    const hadPendingRequest = pendingAuthRequest;
    pendingAuthRequest = false;
    authUserId = '';
    applyAuthPolicy(message.authPolicy);
    applyAuthPermissions('user', []);
    deps.onServerAdminMenuActions([]);
    deps.setConnectionStatus('Authentication required.');
    deps.updateStatus(message.message);
    if (!hadPendingRequest) {
      const packet = buildAuthRequestPacket();
      if (packet) {
        pendingAuthRequest = true;
        deps.setConnectionStatus('Authenticating...');
        deps.signalingSend(packet);
        return;
      }
      if (sanitizeAuthUsername(authUsername).length > 0) {
        resetSavedSessionHint();
        setAuthMode('login');
      }
      deps.setConnecting(false);
      updateConnectAvailability();
    }
  }

  async function persistHttpOnlySessionCookie(sessionToken: string): Promise<void> {
    const token = sessionToken.trim();
    if (!token) return;
    try {
      const response = await fetch(deps.authSessionCookieSetUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${token}`,
          [deps.authSessionCookieClientHeader]: '1',
        },
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn('Unable to persist auth cookie.', error);
      deps.pushChatMessage('Session save failed. You may need to log in again after refresh.');
    }
  }

  async function clearHttpOnlySessionCookie(): Promise<void> {
    try {
      const response = await fetch(deps.authSessionCookieClearUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          [deps.authSessionCookieClientHeader]: '1',
        },
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn('Unable to clear auth cookie.', error);
      deps.pushChatMessage('Session clear failed. Your browser may retain an old login cookie.');
    }
  }

  async function handleAuthResult(message: Extract<IncomingMessage, { type: 'auth_result' }>): Promise<void> {
    pendingAuthRequest = false;
    applyAuthPolicy(message.authPolicy);
    if (!message.ok) {
      authUserId = '';
      deps.dom.authPassword.value = '';
      deps.dom.registerPassword.value = '';
      deps.dom.registerPasswordConfirm.value = '';
      if (message.message.toLowerCase().includes('session')) {
        resetSavedSessionHint();
        void clearHttpOnlySessionCookie();
      }
      applyAuthPermissions('user', []);
      deps.onServerAdminMenuActions([]);
      deps.setConnectionStatus(message.message);
      deps.setConnecting(false);
      updateConnectAvailability();
      deps.disconnect();
      return;
    }

    if (message.sessionToken) {
      void persistHttpOnlySessionCookie(message.sessionToken);
    }
    if (message.username) {
      authUsername = message.username;
      deps.saveAuthUsername(message.username);
      deps.dom.authUsername.value = message.username;
      deps.dom.registerUsername.value = message.username;
    }
    applyAuthPermissions(message.role, message.permissions);
    deps.onServerAdminMenuActions(message.adminMenuActions);
    deps.dom.authPassword.value = '';
    deps.dom.registerPassword.value = '';
    deps.dom.registerPasswordConfirm.value = '';
    deps.setConnectionStatus('Authenticated. Joining world...');
  }

  function handleAuthPermissions(message: Extract<IncomingMessage, { type: 'auth_permissions' }>): void {
    const hadVoiceSend = voiceSendAllowed;
    applyAuthPermissions(message.role, message.permissions);
    deps.onServerAdminMenuActions(message.adminMenuActions);
    if (hadVoiceSend && !voiceSendAllowed) {
      deps.updateStatus('Voice send permission revoked.');
    }
    if (!hadVoiceSend && voiceSendAllowed) {
      deps.updateStatus('Voice send permission granted.');
    }
  }

  function applyWelcomeAuth(
    auth: WelcomeAuth,
    adminMenuActions: Array<{ id: string; label: string; tooltip?: string }> | null | undefined,
  ): void {
    authUserId = String(auth?.userId || '').trim();
    applyAuthPolicy(auth?.policy);
    applyAuthPermissions(auth?.role, auth?.permissions);
    deps.onServerAdminMenuActions(adminMenuActions);
  }

  function logOutAccount(): void {
    authUserId = '';
    authUsername = '';
    void clearHttpOnlySessionCookie();
    deps.saveAuthUsername('');
    applyAuthPermissions('user', []);
    deps.onServerAdminMenuActions([]);
    if (deps.isRunning()) {
      deps.signalingSend({ type: 'auth_logout' });
      deps.disconnect();
    }
    setAuthMode('login');
    deps.updateStatus('Logged out.');
    updateConnectAvailability();
  }

  function setupUiHandlers(uiDeps: AuthUiDeps): void {
    deps.dom.showRegisterButton.addEventListener('click', () => {
      if (authMode === 'login') {
        setAuthMode('register');
        deps.dom.registerUsername.focus();
      } else {
        setAuthMode('login');
        deps.dom.authUsername.focus();
      }
    });
    deps.dom.logoutButton.addEventListener('click', () => {
      logOutAccount();
    });
    deps.dom.authUsername.addEventListener('input', () => {
      deps.dom.authUsername.value = sanitizeAuthUsername(deps.dom.authUsername.value);
      updateConnectAvailability();
    });
    deps.dom.authPassword.addEventListener('input', () => {
      updateConnectAvailability();
    });
    deps.dom.registerUsername.addEventListener('input', () => {
      deps.dom.registerUsername.value = sanitizeAuthUsername(deps.dom.registerUsername.value);
      updateConnectAvailability();
    });
    deps.dom.registerPassword.addEventListener('input', () => {
      updateConnectAvailability();
    });
    deps.dom.registerPasswordConfirm.addEventListener('input', () => {
      updateConnectAvailability();
    });
    deps.dom.registerEmail.addEventListener('input', () => {
      updateConnectAvailability();
    });

    const submitAuthOnEnter = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter') return;
      if (deps.dom.connectButton.disabled) return;
      event.preventDefault();
      void uiDeps.connect();
    };
    deps.dom.authUsername.addEventListener('keydown', submitAuthOnEnter);
    deps.dom.authPassword.addEventListener('keydown', submitAuthOnEnter);
    deps.dom.registerUsername.addEventListener('keydown', submitAuthOnEnter);
    deps.dom.registerPassword.addEventListener('keydown', submitAuthOnEnter);
    deps.dom.registerPasswordConfirm.addEventListener('keydown', submitAuthOnEnter);
    deps.dom.registerEmail.addEventListener('keydown', submitAuthOnEnter);
  }

  function initializeUi(): void {
    deps.dom.authUsername.value = sanitizeAuthUsername(authUsername);
    deps.dom.registerUsername.value = sanitizeAuthUsername(authUsername);
    loadPersistedAuthPolicy();
    setAuthMode('login');
    updateConnectAvailability();
  }

  return {
    initializeUi,
    setupUiHandlers,
    updateConnectAvailability,
    hasPermission: (key: string) => authPermissions.has(key),
    getVoiceSendAllowed: () => voiceSendAllowed,
    getAuthUserId: () => authUserId,
    sendAuthRequest,
    setAuthMode,
    handleAuthRequired,
    handleAuthResult,
    handleAuthPermissions,
    applyWelcomeAuth,
    applyVoiceSendPermission,
    logOutAccount,
  };
}
