import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import type { AssetlibConfig, AssetMime, AssetRef, ClientOptions, ClientStatus, ManifestPayload, RefreshResult, ResolvedAsset, ResolveOptions, SignedManifest } from './types.js';
export type * from './types.js';
import { selectAssetCandidates, supportedFormats, targetPixels, validRenditionHeader, validateRenditions, type AssetCandidate } from './renditions.js';
export { selectAssetCandidates } from './renditions.js';
import { validateAccessibility } from './accessibility.js';
export { resolveAccessibilityDescription, validateAccessibility } from './accessibility.js';

export const SDK_LIMITS = Object.freeze({ manifestBytes: 256 * 1024, assetBytes: 8 * 1024 * 1024, slots: 100, retainedReleases: 8, stateBytes: 3 * 1024 * 1024, cacheBytes: 50 * 1024 * 1024, cacheEntries: 100 });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const validKey = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(value);
const fail = (message: string): never => { throw new Error(message); };
export const hashBytes = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

function publicKeyBytes(pem: string): Uint8Array {
  const match = /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PUBLIC KEY-----\r?\n?$/.exec(pem);
  if (!match) return fail('Expected an Ed25519 SPKI public key in PEM format.');
  const der = base64.decode(match[1].replace(/[\r\n]/g, ''));
  if (der.length !== 44 || bytesToHex(der.subarray(0, 12)) !== '302a300506032b6570032100') return fail('The pinned key must be Ed25519.');
  return der.subarray(12);
}

export function parsePublicConfig(input: unknown, options: { allowInsecureLoopback?: boolean } = {}): AssetlibConfig {
  if (!record(input) || input.schemaVersion !== 1 || input.environment !== 'production' || typeof input.orgId !== 'string' || !uuid.test(input.orgId) || typeof input.appId !== 'string' || !uuid.test(input.appId) || typeof input.manifestUrl !== 'string' || typeof input.pinnedPublicKey !== 'string' || input.pinnedPublicKey.length > 256) return fail('Invalid Assetlib public configuration.');
  const url = new URL(input.manifestUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(options.allowInsecureLoopback === true && loopback && url.protocol === 'http:')) return fail('Assetlib requires HTTPS; only explicitly enabled loopback development may use HTTP.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== `/api/delivery/${input.orgId}/${input.appId}/manifest`) return fail('Manifest URL does not match this app.');
  publicKeyBytes(input.pinnedPublicKey);
  const keyId = hashBytes(utf8ToBytes(input.pinnedPublicKey)).slice(0, 16);
  if (input.keyId !== undefined && input.keyId !== keyId) return fail('Signing key ID does not match the pinned key.');
  return { schemaVersion: 1, orgId: input.orgId, appId: input.appId, environment: 'production', manifestUrl: url.href, pinnedPublicKey: input.pinnedPublicKey, keyId };
}

export function verifySignedManifest(input: unknown, config: AssetlibConfig): { envelope: SignedManifest; payload: ManifestPayload } {
  if (!record(input) || input.algorithm !== 'Ed25519' || input.publicKey !== config.pinnedPublicKey || input.keyId !== hashBytes(utf8ToBytes(config.pinnedPublicKey)).slice(0, 16) || typeof input.payload !== 'string' || utf8ToBytes(input.payload).length > SDK_LIMITS.manifestBytes || typeof input.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(input.signature)) return fail('Invalid signed manifest envelope.');
  if (!ed25519.verify(base64.decode(input.signature), utf8ToBytes(input.payload), publicKeyBytes(config.pinnedPublicKey), { zip215: false })) return fail('Manifest signature verification failed.');
  const payload: unknown = JSON.parse(input.payload);
  if (!record(payload) || payload.schemaVersion !== 1 || payload.orgId !== config.orgId || payload.appId !== config.appId || payload.environment !== config.environment || !integer(payload.sequence, 1, 2_147_483_647) || typeof payload.createdAt !== 'string' || !Number.isFinite(Date.parse(payload.createdAt)) || !Array.isArray(payload.slots) || payload.slots.length < 1 || payload.slots.length > SDK_LIMITS.slots) return fail('Unsupported or cross-app manifest payload.');
  const keys = new Set<string>();
  for (const value of payload.slots) {
    if (!record(value) || !validKey(value.key) || keys.has(value.key) || typeof value.screen !== 'string' || value.screen.length > 120 || !integer(value.width, 1, 8192) || !integer(value.height, 1, 8192) || typeof value.assetId !== 'string' || !uuid.test(value.assetId) || typeof value.sha256 !== 'string' || !hashPattern.test(value.sha256) || value.mime !== 'image/webp' || !integer(value.bytes, 1, SDK_LIMITS.assetBytes) || typeof value.url !== 'string') return fail('Invalid or unsupported placement in manifest.');
    const url = new URL(value.url, config.manifestUrl);
    if (url.origin !== new URL(config.manifestUrl).origin || url.username || url.password || url.search || url.hash || url.pathname !== `/api/delivery/${config.orgId}/${config.appId}/assets/${value.assetId}`) return fail('Asset URL is outside the configured app.');
    validateRenditions(payload, value, config);
    if ('accessibility' in value) validateAccessibility(value.accessibility);
    keys.add(value.key);
  }
  return { envelope: input as SignedManifest, payload: payload as ManifestPayload };
}

async function fetchBounded(fetcher: typeof fetch, url: string, maxBytes: number, timeoutMs: number, accept = 'image/webp'): Promise<Uint8Array> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('Assetlib request timed out.')); }, timeoutMs); });
  const request = async () => {
    const response = await fetcher(url, { method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal, headers: { Accept: url.endsWith('/manifest') ? 'application/json' : accept } });
    if (!response.ok || response.redirected) throw new Error(`Assetlib delivery returned ${response.status}.`);
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error('Response exceeds the SDK byte limit.');
    if (!response.body?.getReader) throw new Error('This fetch implementation does not support bounded streaming; use expo/fetch.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (controller.signal.aborted) throw new Error('Assetlib request timed out.');
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) throw new Error('Response exceeds the SDK byte limit.');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  };
  try { return await Promise.race([request(), deadline]); }
  finally { if (timeout) clearTimeout(timeout); controller.abort(); }
}

type State = { version: 1; highestSequence: number; history: SignedManifest[] };

export class AssetClient {
  readonly config: AssetlibConfig;
  private state: State = { version: 1, highestSequence: 0, history: [] };
  private initialized = false;
  private storageFailure: string | null = null;
  private lastError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private timeoutMs: number;
  private fetcher: typeof fetch;
  private formats: readonly AssetMime[];
  constructor(config: AssetlibConfig, private options: ClientOptions) {
    this.config = parsePublicConfig(config, options);
    this.formats = supportedFormats(options.formats);
    this.timeoutMs = options.timeoutMs ?? 8000;
    if (!integer(this.timeoutMs, 20, 30000)) fail('timeoutMs must be between 20 and 30000.');
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
  getStatus(): ClientStatus { return { initialized: this.initialized, sequence: this.state.highestSequence, lastError: this.lastError }; }
  initialize(): Promise<ClientStatus> { return this.serial(async () => { await this.load(); return this.getStatus(); }); }
  private async load(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const raw = await this.options.storage.loadState();
      if (raw === null) return;
      if (utf8ToBytes(raw).length > SDK_LIMITS.stateBytes) throw new Error('Stored SDK state exceeds its bound.');
      const state: unknown = JSON.parse(raw);
      if (!record(state) || state.version !== 1 || !integer(state.highestSequence, 1, 2_147_483_647) || !Array.isArray(state.history) || state.history.length < 1 || state.history.length > SDK_LIMITS.retainedReleases) throw new Error('Stored SDK state is invalid.');
      let previous = state.highestSequence + 1;
      for (const entry of state.history) {
        const { payload } = verifySignedManifest(entry, this.config);
        if (payload.sequence >= previous) throw new Error('Stored release order is invalid.');
        previous = payload.sequence;
      }
      if (verifySignedManifest(state.history[0], this.config).payload.sequence !== state.highestSequence) throw new Error('Stored sequence does not match its signed manifest.');
      this.state = state as State;
    } catch {
      this.storageFailure = 'Stored release state could not be verified. Using bundled assets; repair or explicitly reset app data before reconnecting.';
      this.lastError = this.storageFailure;
    }
  }
  refresh(): Promise<RefreshResult> {
    return this.serial(async () => {
      await this.load();
      try {
        if (this.storageFailure) throw new Error(this.storageFailure);
        const bytes = await fetchBounded(this.fetcher, this.config.manifestUrl, SDK_LIMITS.manifestBytes, this.timeoutMs);
        const { envelope, payload } = verifySignedManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), this.config);
        if (payload.sequence < this.state.highestSequence) throw new Error('An older release was rejected.');
        if (payload.sequence === this.state.highestSequence) {
          if (envelope.payload !== this.state.history[0]?.payload) throw new Error('Conflicting content reused an existing release sequence.');
          this.lastError = null;
          return { updated: false, sequence: payload.sequence };
        }
        const next: State = { version: 1, highestSequence: payload.sequence, history: [envelope, ...this.state.history].slice(0, SDK_LIMITS.retainedReleases) };
        const serialized = JSON.stringify(next);
        if (utf8ToBytes(serialized).length > SDK_LIMITS.stateBytes) throw new Error('Release history exceeds the storage bound.');
        await this.options.storage.saveState(serialized);
        this.state = next;
        this.lastError = null;
        return { updated: true, sequence: payload.sequence };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Assetlib refresh failed.';
        this.lastError = message;
        return { updated: false, sequence: this.state.highestSequence, error: message };
      }
    });
  }
  resolve(ref: AssetRef, options: ResolveOptions = {}): Promise<ResolvedAsset> {
    return this.serial(async () => {
      await this.load();
      if (!validKey(ref.key) || !integer(ref.width, 1, 8192) || !integer(ref.height, 1, 8192)) throw new Error('Invalid generated asset reference.');
      if (ref.bundledAccessibility !== undefined) validateAccessibility(ref.bundledAccessibility);
      const target = targetPixels(ref, options);
      let message = this.storageFailure ?? 'No compatible published artwork is available.';
      for (let index = 0; index < this.state.history.length; index++) {
        const { payload } = verifySignedManifest(this.state.history[index], this.config);
        const slot = payload.slots.find(item => item.key === ref.key && item.width === ref.width && item.height === ref.height);
        if (!slot) continue;
        for (const candidate of selectAssetCandidates(slot, target, this.formats)) {
          const identity = { mime: candidate.mime, sha256: candidate.sha256, assetId: slot.assetId,
            ...(slot.accessibility ? { accessibility: Object.freeze({ defaultLocale: slot.accessibility.defaultLocale, descriptions: Object.freeze({ ...slot.accessibility.descriptions }) }) } : {}),
            ...(candidate.isRendition ? { pixelWidth: candidate.width, pixelHeight: candidate.height } : {}) };
          try {
            const cached = await this.options.storage.getAsset(candidate.sha256);
            if (cached && this.validBytes(cached, candidate)) return { source: 'cache', sequence: payload.sequence, message: index ? `Using verified artwork from release ${payload.sequence}. ${message}` : 'Verified artwork loaded from the local cache.', bytes: cached, ...identity };
            // Historical releases never trigger downloads, even if a preferred size is missing.
            if (index !== 0) continue;
            const bytes = await fetchBounded(this.fetcher, new URL(candidate.url, this.config.manifestUrl).href, candidate.bytes, this.timeoutMs, candidate.mime);
            if (!this.validBytes(bytes, candidate)) throw new Error('Asset bytes do not match the signed manifest.');
            await this.options.storage.putAsset(candidate.sha256, bytes, candidate.mime);
            return { source: 'remote', sequence: payload.sequence, message: 'Downloaded artwork; signature and file hash verified.', bytes, ...identity };
          } catch (error) { message = error instanceof Error ? error.message : 'Artwork could not be loaded.'; }
        }
      }
      return { source: 'bundle', sequence: null, message: `Using bundled artwork. ${message}`, ...(ref.bundledAccessibility ? { accessibility: ref.bundledAccessibility } : {}) };
    });
  }
  private validBytes(bytes: Uint8Array, candidate: AssetCandidate): boolean {
    return bytes.byteLength === candidate.bytes && bytes.byteLength <= SDK_LIMITS.assetBytes && hashBytes(bytes) === candidate.sha256 && validRenditionHeader(bytes, candidate);
  }
}

export function createAssetClient(config: AssetlibConfig, options: ClientOptions): AssetClient { return new AssetClient(config, options); }

/** Bounded test/ephemeral adapter. Apps should use a durable platform adapter. */
export function createMemoryStorage() {
  let state: string | null = null;
  const assets = new Map<string, Uint8Array>();
  return {
    async loadState() { return state; },
    async saveState(value: string) { if (state && JSON.parse(value).highestSequence < JSON.parse(state).highestSequence) throw new Error('Stored sequence is newer.'); state = value; },
    async getAsset(hash: string) { return assets.get(hash)?.slice() ?? null; },
    async putAsset(hash: string, bytes: Uint8Array) {
      if (!hashPattern.test(hash) || bytes.length > SDK_LIMITS.assetBytes) throw new Error('Invalid cache entry.');
      assets.delete(hash); assets.set(hash, bytes.slice());
      while (assets.size > SDK_LIMITS.cacheEntries || [...assets.values()].reduce((sum, item) => sum + item.length, 0) > SDK_LIMITS.cacheBytes) assets.delete(assets.keys().next().value!);
    },
  };
}
