const APP_BASE_PATH = import.meta.env.BASE_URL ?? '/';

/** Returns whether the URL already points at the local media proxy. */
function isLocalMediaProxyUrl(parsed: URL): boolean {
  return parsed.origin === window.location.origin && parsed.pathname.toLowerCase().endsWith('/media_proxy.php');
}

/** Returns whether a direct radio stream URL should use the same-origin media proxy. */
export function shouldProxyRadioStreamUrl(streamUrl: string): boolean {
  try {
    const parsed = new URL(streamUrl);
    if (isLocalMediaProxyUrl(parsed)) return false;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.origin !== window.location.origin;
  } catch {
    return false;
  }
}

/** Returns whether an arbitrary external media URL should be proxied before Web Audio playback. */
export function shouldProxyExternalMediaUrl(streamUrl: string): boolean {
  try {
    const parsed = new URL(streamUrl);
    if (isLocalMediaProxyUrl(parsed)) {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return parsed.origin !== window.location.origin;
  } catch {
    return false;
  }
}

/** Builds the same-origin proxy URL for one remote media URL. */
export function getProxyUrlForMedia(streamUrl: string): string {
  const normalizedBase = APP_BASE_PATH.endsWith('/') ? APP_BASE_PATH : `${APP_BASE_PATH}/`;
  const proxy = new URL(`${normalizedBase}media_proxy.php`, window.location.origin);
  proxy.searchParams.set('url', streamUrl);
  return proxy.toString();
}

/** Appends a cache-buster to a radio playback URL to avoid stale stream sessions. */
export function freshRadioPlaybackUrl(streamUrl: string): string {
  const playbackSource = shouldProxyRadioStreamUrl(streamUrl) ? getProxyUrlForMedia(streamUrl) : streamUrl;
  try {
    const parsed = new URL(playbackSource);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname.endsWith('dropbox.com') || hostname.endsWith('dropboxusercontent.com')) {
      return playbackSource;
    }
  } catch {
    // Leave non-URL strings to the generic cache-buster behavior below.
  }
  const separator = playbackSource.includes('?') ? '&' : '?';
  return `${playbackSource}${separator}chgrid_start=${Date.now()}`;
}
