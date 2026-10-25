import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

export interface IndexEntry {
  id: string;
  familyID?: string;
  name: string;
  version: string;
  language: string;
  contentType: 'pageImages' | 'text' | 'publication' | 'audio';
  contentRating?: string;
  releaseTrack?: string;
  status?: string;
  manifest: { path: string; sha256: string };
  icon: { path: string; sha256: string };
  slug?: string;
}

export interface ModuleManifest {
  contractVersion: number;
  id: string;
  familyID: string;
  name: string;
  version: string;
  minimumAppVersion: string;
  contentType: string;
  contentRating: string;
  releaseTrack: string;
  capabilities: string[];
  baseURL: string;
  universalURLs?: string[];
  entry: { path: string; sha256: string };
  icon: { path: string; sha256: string };
  hosts: string[];
  attribution?: {
    author?: string;
    website?: string;
    sourceCode?: string;
  };
}

let cachedIndex: { schemaVersion: number; modules: IndexEntry[] } | null = null;

export async function getIndexData() {
  if (!cachedIndex) {
    const raw = await fs.readFile(path.join(root, 'index.json'), 'utf8');
    cachedIndex = JSON.parse(raw);
    if (cachedIndex && Array.isArray(cachedIndex.modules)) {
      cachedIndex.modules = cachedIndex.modules.map(m => ({
        ...m,
        slug: m.manifest.path.split('/')[1] || m.id,
      }));
    }
  }
  return cachedIndex;
}

export async function getModuleManifest(slug: string): Promise<ModuleManifest | null> {
  try {
    const raw = await fs.readFile(path.join(root, 'modules', slug, 'manifest.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getModuleCode(slug: string): Promise<string> {
  return await fs.readFile(path.join(root, 'modules', slug, 'index.js'), 'utf8');
}

export async function getModuleFixtures(slug: string): Promise<string[]> {
  try {
    const dir = path.join(root, 'modules', slug, 'fixtures');
    const files = await fs.readdir(dir);
    return files;
  } catch {
    return [];
  }
}

function createCookieJar(host: string) {
  return { host: String(host || '').toLowerCase(), values: new Map<string, string>() };
}

function updateCookieJar(response: Response, requestURL: URL, jar: { host: string; values: Map<string, string> }) {
  if (!jar || !requestURL || requestURL.hostname.toLowerCase() !== jar.host) return;
  // @ts-ignore
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const setCookie of setCookies) {
    const pair = String(setCookie).split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name) continue;
    if (/max-age\s*=\s*0/i.test(setCookie)) jar.values.delete(name);
    else jar.values.set(name, value);
  }
}

async function networkResponse(url: string, headers: Record<string, string> = {}, method = 'GET', body: any = null, options: any = {}) {
  const started = Date.now();
  const requestURL = new URL(url);
  const requestHeaders = new Headers(headers || {});

  if (!requestHeaders.has('User-Agent')) {
    requestHeaders.set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  }

  if (
    options.implicitCookies !== false &&
    options.cookieJar &&
    requestURL.hostname.toLowerCase() === options.cookieJar.host &&
    !requestHeaders.has('Cookie')
  ) {
    const cookieHeader = [...options.cookieJar.values.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    if (cookieHeader) requestHeaders.set('Cookie', cookieHeader);
  }

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: body ? (typeof body === 'object' && !(body instanceof Uint8Array) ? JSON.stringify(body) : body) : null,
    redirect: options.followRedirects === false ? 'manual' : 'follow',
    signal: AbortSignal.timeout(Math.max(10_000, Number(options.timeoutMilliseconds) || 25_000)),
  });

  if (options.cookieJar) {
    updateCookieJar(response, requestURL, options.cookieJar);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const limit = Number(options.maxBytesHint) || 16 * 1024 * 1024;
  const dropped = bytes.length > limit;
  const textBody = dropped ? '' : new TextDecoder().decode(bytes);

  return {
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    finalUrl: response.url,
    body: textBody,
    bodyDropped: dropped,
    dropReason: dropped ? 'maxBytesHint' : null,
    bodyBytes: bytes.length,
    bodyMagicHex: Buffer.from(bytes.slice(0, 16)).toString('hex'),
    contentType: response.headers.get('content-type') || '',
    error: null,
    durationMs: Date.now() - started,
    text: async () => textBody,
    json: async () => JSON.parse(textBody),
  };
}

function fixtureResponse(body: string, status = 200, finalUrl = 'https://fixture.invalid/') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    finalUrl,
    body,
    bodyDropped: false,
    dropReason: null,
    bodyBytes: Buffer.byteLength(body),
    contentType: 'text/html',
    error: null,
    durationMs: 0,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

export async function createRuntime(slug: string, mode: 'live' | 'fixtures' = 'live') {
  const source = await getModuleCode(slug);
  const calls: Array<{ kind: string; url: string; durationMs?: number; status?: number }> = [];
  const lifecycle: any[] = [];
  let bridges: any;

  if (mode === 'fixtures') {
    const fixture = async (name: string) => {
      try {
        return await fs.readFile(path.join(root, 'modules', slug, 'fixtures', name), 'utf8');
      } catch {
        return null;
      }
    };

    const home =
      (await fixture('home.html')) ||
      (await fixture('search.html')) ||
      (await fixture('home.json')) ||
      (await fixture('search.json'));
    const details = (await fixture('details.html')) || (await fixture('details.json'));
    const chapters = (await fixture('chapters.html')) || (await fixture('chapters.json'));
    const images =
      (await fixture('chapter.html')) ||
      (await fixture('images.html')) ||
      (await fixture('images.json')) ||
      (await fixture('pages.json')) ||
      (await fixture('chapter.json')) ||
      (await fixture('chapter-1.html'));

    bridges = {
      fetchv2: async (url: string, headers: any, method: string, body: any, options: any) => {
        calls.push({ kind: 'fetchv2', url: String(url) });
        const u = String(url);
        if (u.includes('chapter') || u.includes('image') || u.includes('page')) {
          if (images) return fixtureResponse(images);
        }
        if (u.includes('details') || u.includes('/series/') || u.includes('/manga/')) {
          if (details) return fixtureResponse(details);
        }
        if (u.includes('chapter') || u.includes('/chapters')) {
          if (chapters) return fixtureResponse(chapters);
        }
        if (home) return fixtureResponse(home);
        if (details) return fixtureResponse(details);
        throw new Error(`No fixture matched for ${u}`);
      },
      pagev2: async (task: any) => {
        calls.push({ kind: 'pagev2', url: String(task && task.url) });
        if (home) {
          return {
            finalURL: task.url,
            title: '',
            html: home,
            events: [],
            cookies: {},
            evaluatedData: home,
          };
        }
        throw new Error('Fixture mode does not implement pagev2 for this module.');
      },
      reportProgress: async (payload: any) => {
        lifecycle.push({ at: Date.now(), kind: 'reportProgress', payload: payload ?? null });
        return { ok: true };
      },
    };
  } else {
    const cookieJar = createCookieJar('mangaball.net');
    bridges = {
      fetchv2: async (url: string, headers: any, method: string, body: any, options: any = {}) => {
        const start = Date.now();
        calls.push({ kind: 'fetchv2', url: String(url) });
        const res = await networkResponse(url, headers, method, body, {
          ...options,
          cookieJar,
          implicitCookies: false,
        });
        const lastCall = calls[calls.length - 1];
        if (lastCall) {
          lastCall.durationMs = Date.now() - start;
          lastCall.status = res.status;
        }
        return res;
      },
      pagev2: async (task: any) => {
        const start = Date.now();
        calls.push({ kind: 'pagev2', url: String(task && task.url) });
        const response = await networkResponse(task.url, task.headers || {}, 'GET', null, {
          followRedirects: true,
          maxBytesHint: task.maxResponseCharacters || 1_000_000,
          timeoutMilliseconds: task.timeoutMilliseconds,
        });
        const lastCall = calls[calls.length - 1];
        if (lastCall) {
          lastCall.durationMs = Date.now() - start;
          lastCall.status = response.status;
        }
        if (!response.ok || response.bodyDropped) {
          throw new Error(`pagev2 failed for ${task.url}`);
        }
        return {
          finalURL: response.finalUrl,
          title: '',
          html: task.includeHTML ? response.body : null,
          events: [],
          cookies: {},
          evaluatedData: response.body,
        };
      },
      reportProgress: async (payload: any) => {
        lifecycle.push({ at: Date.now(), kind: 'reportProgress', payload: payload ?? null });
        return { ok: true };
      },
    };
  }

  const context: any = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    ...bridges,
  });
  context.globalThis = context;
  new vm.Script(source, { filename: `modules/${slug}/index.js` }).runInContext(context);

  if (typeof context.SynthetiqModule !== 'object') {
    throw new Error(`${slug} did not export SynthetiqModule`);
  }

  return { module: context.SynthetiqModule, calls, lifecycle };
}

export async function executeDiscovery(slug: string, feedId?: string) {
  const { module } = await createRuntime(slug, 'live');
  if (feedId && typeof module.discoveryFeed === 'function') {
    return await module.discoveryFeed(feedId);
  }
  if (typeof module.discoveryHome === 'function') {
    return await module.discoveryHome();
  }
  // Fallback to empty discovery
  return { sections: [] };
}

export async function executeSearch(slug: string, query: string, page = 1, filters = {}) {
  const { module } = await createRuntime(slug, 'live');
  if (typeof module.searchResults !== 'function') {
    throw new Error(`Module ${slug} does not support searchResults`);
  }
  const effectiveQuery = Object.keys(filters).length ? { text: query, ...filters } : query;
  return await module.searchResults(effectiveQuery, page);
}

export async function executeDetails(slug: string, id: string) {
  const { module } = await createRuntime(slug, 'live');
  if (typeof module.extractDetails !== 'function') {
    throw new Error(`Module ${slug} does not support extractDetails`);
  }
  return await module.extractDetails(id);
}

export async function executeChapters(slug: string, id: string, paginationContext: any = null) {
  const { module } = await createRuntime(slug, 'live');
  if (typeof module.extractChapters !== 'function') {
    throw new Error(`Module ${slug} does not support extractChapters`);
  }
  return await module.extractChapters(id, paginationContext);
}

export async function executeContent(slug: string, chapterId: string) {
  const { module } = await createRuntime(slug, 'live');
  if (typeof module.extractImages === 'function') {
    const pages = await module.extractImages(chapterId);
    return { type: 'images', pages };
  }
  if (typeof module.extractText === 'function') {
    const text = await module.extractText(chapterId);
    return { type: 'text', data: text };
  }
  if (typeof module.extractResources === 'function') {
    const resources = await module.extractResources(chapterId);
    return { type: 'resources', data: resources };
  }
  if (typeof module.extractAudio === 'function') {
    const audio = await module.extractAudio(chapterId);
    return { type: 'audio', data: audio };
  }
  throw new Error(`Module ${slug} has no content extraction handler`);
}

export const MODULE_DEFAULT_QUERIES: Record<string, string> = {
  atsu: 'one piece',
  weebcentral: 'one piece',
  mangafire: 'one piece',
  mangakatana: 'naruto',
  mgread: 'martial peak',
  'asura-scans': 'solo leveling',
  chikari: 'demon',
  colorizedmanga: 'one piece',
  comix: 'solo',
  mangabuddy: 'solo',
  lnori: 'shadow',
  novelfire: 'shadow',
};
