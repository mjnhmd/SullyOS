import nosManifest from './nosAssetManifest.json';

const ASSETS: Record<string, string> = (nosManifest as any).assets || {};
const BUILD_PREFIXES: Record<string, string> = (nosManifest as any).buildPrefixes || {};

/**
 * Look up the NOS CDN URL for a given local pathname (e.g. "/room3d/kit.glb" or "room3d/kit.glb").
 */
export function resolveNosCdnUrl(rawPath: string): string | undefined {
  if (!rawPath || typeof rawPath !== 'string') return undefined;
  let path = rawPath.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path);
      if (typeof location !== 'undefined' && u.origin !== location.origin) return undefined;
      path = u.pathname;
    } catch {
      return undefined;
    }
  }
  path = path.split('?')[0].split('#')[0];
  if (!path.startsWith('/')) path = `/${path}`;
  if (ASSETS[path]) return ASSETS[path];

  if (path.startsWith('/assets/build/')) {
    const file = path.slice('/assets/build/'.length);
    for (const [prefix, cdnUrl] of Object.entries(BUILD_PREFIXES)) {
      if (file.startsWith(prefix)) return cdnUrl;
    }
  }
  return undefined;
}

let installed = false;

/**
 * Install transparent NOS CDN fallback for offloaded static assets on Capacitor / first-load before SW control.
 */
export function installNosAssetRuntimeFallback(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // 1. Wrap window.fetch so fetch("/room3d/...") or GLTFLoader.loadAsync seamlessly redirects to NOS CDN
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input?.url || '';
      const cdnUrl = resolveNosCdnUrl(rawUrl);
      if (cdnUrl) {
        return nativeFetch(cdnUrl, {
          ...init,
          mode: 'cors',
          credentials: 'omit',
        });
      }
    } catch {
      // Fall back to native fetch
    }
    return nativeFetch(input as any, init);
  };

  // 2. Wrap XMLHttpRequest.prototype.open for legacy three.js / FileLoader callers
  if (typeof XMLHttpRequest !== 'undefined') {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      let targetUrl: string | URL = url;
      try {
        const raw = typeof url === 'string' ? url : url?.href || '';
        const cdnUrl = resolveNosCdnUrl(raw);
        if (cdnUrl) targetUrl = cdnUrl;
      } catch {}
      return origOpen.call(this, method, targetUrl as any, async ?? true, username, password);
    };
  }

  // 3. Intercept HTMLImageElement src setter + error fallback for offloaded portrait/room images
  if (typeof HTMLImageElement !== 'undefined') {
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (desc?.set && desc?.get) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        enumerable: true,
        get() {
          return desc.get!.call(this);
        },
        set(val: string) {
          const cdnUrl = resolveNosCdnUrl(String(val || ''));
          if (cdnUrl) {
            if (!this.getAttribute('crossorigin')) {
              this.setAttribute('crossorigin', 'anonymous');
            }
            desc.set!.call(this, cdnUrl);
            return;
          }
          desc.set!.call(this, val);
        },
      });
    }
    window.addEventListener('error', (event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement && !target.dataset.nosRetried) {
        const currentSrc = target.getAttribute('src') || target.src || '';
        const cdnUrl = resolveNosCdnUrl(currentSrc);
        if (cdnUrl && currentSrc !== cdnUrl) {
          target.dataset.nosRetried = '1';
          target.crossOrigin = 'anonymous';
          target.src = cdnUrl;
        }
      }
    }, true);
  }
}
