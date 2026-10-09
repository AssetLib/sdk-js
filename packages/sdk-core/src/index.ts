import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import type { AssetlibConfig, AssetMime, AssetRef, AssetStatus, AssetPage, AssetPageOptions, AssetPagePayload, ArmSource, CachePolicy, StorageMime, CatalogAsset, DynamicAssetRef, FallbackReason, StateSetRef, ResolvedStateSet, ManifestSlot, ClientOptions, ClientStatus, ManifestPayload, RefreshResult, ResolvedAsset, ResolvedAnimation, ResolveOptions, SignedManifest } from './types.js';
import { ObservationReporter } from './telemetry.js';
export type * from './types.js';
import { selectAssetCandidates, supportedFormats, targetPixels, validRenditionHeader, validateRenditions, type AssetCandidate } from './renditions.js';
export { selectAssetCandidates } from './renditions.js';
import { validateAnimationExtension, verifiedAnimationData } from './animations.js';
export { validateLottie, validateLottieMetadata, LOTTIE_LIMITS } from './lottie.js';
export type { LottieMetadata, ValidatedLottie } from './lottie.js';
export { selectCatalogReferences } from './catalog.js';
import { assetIdPattern, catalogForSequence, validateAssetPage, validateDeliveryExtensions, validStateRef } from './delivery.js';
import { validateAccessibility } from './accessibility.js';
export { resolveAccessibilityDescription, validateAccessibility } from './accessibility.js';

export const SDK_LIMITS = Object.freeze({ configBytes: 4096, pinnedKeys: 16, publicKeyBytes: 256, manifestBytes: 256 * 1024, assetBytes: 8 * 1024 * 1024, slots: 100, retainedReleases: 8, stateBytes: 3 * 1024 * 1024, cacheBytes: 50 * 1024 * 1024, cacheEntries: 100 });
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
  let serialized: string | undefined;
  try { serialized = typeof input === 'string' ? input : JSON.stringify(input); }
  catch { return fail('Invalid Assetlib public configuration JSON.'); }
  if (serialized === undefined) return fail('Invalid Assetlib public configuration JSON.');
  if (utf8ToBytes(serialized).length > SDK_LIMITS.configBytes) return fail('Assetlib public configuration exceeds 4096 UTF-8 bytes.');
  // Validate the same JSON whose size was measured, including for object input.
  try { input = JSON.parse(serialized); }
  catch { return fail('Invalid Assetlib public configuration JSON.'); }
  if (!record(input) || input.schemaVersion !== 1 || (input.environment !== 'staging' && input.environment !== 'production') || typeof input.orgId !== 'string' || !uuid.test(input.orgId) || typeof input.appId !== 'string' || !uuid.test(input.appId) || typeof input.manifestUrl !== 'string') return fail('Invalid Assetlib public configuration.');
  const url = new URL(input.manifestUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(options.allowInsecureLoopback === true && loopback && url.protocol === 'http:')) return fail('Assetlib requires HTTPS; only explicitly enabled loopback development may use HTTP.');
  const deliveryPath = `/api/delivery/${input.orgId}/${input.appId}`;
  const environmentPath = `${deliveryPath}/environments/${input.environment}/manifest`;
  const legacyProductionPath = input.environment === 'production' && url.pathname === `${deliveryPath}/manifest`;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== environmentPath && !legacyProductionPath)) return fail('Manifest URL does not match this app.');
  const pinnedPublicKey = input.pinnedPublicKey;
  if (pinnedPublicKey !== undefined && (typeof pinnedPublicKey !== 'string' || utf8ToBytes(pinnedPublicKey).length > SDK_LIMITS.publicKeyBytes)) return fail('Invalid Assetlib public configuration.');
  if (input.pinnedPublicKeys !== undefined && (!Array.isArray(input.pinnedPublicKeys) || input.pinnedPublicKeys.length === 0 || input.pinnedPublicKeys.length > SDK_LIMITS.pinnedKeys)) return fail('Expected 1–16 distinct pinned public keys.');
  const pinnedPublicKeys: string[] = [];
  for (const key of input.pinnedPublicKeys ?? (pinnedPublicKey === undefined ? [] : [pinnedPublicKey])) {
    if (typeof key !== 'string' || utf8ToBytes(key).length > SDK_LIMITS.publicKeyBytes) return fail('Invalid pinned public key.');
    if (pinnedPublicKeys.includes(key)) return fail('Pinned public keys must be distinct exact PEM strings.');
    publicKeyBytes(key);
    pinnedPublicKeys.push(key);
  }
  if (!pinnedPublicKeys.length) return fail('A pinned public key or key set is required.');
  if (pinnedPublicKey !== undefined && !pinnedPublicKeys.includes(pinnedPublicKey)) return fail('The single pinned public key must be in the pinned key set.');
  const keyId = pinnedPublicKey === undefined ? undefined : hashBytes(utf8ToBytes(pinnedPublicKey)).slice(0, 16);
  if (input.keyId !== undefined && (pinnedPublicKey === undefined || input.keyId !== keyId)) return fail('Signing key ID requires and must match an explicit single pinned key.');
  const keyIds = pinnedPublicKeys.map(key => hashBytes(utf8ToBytes(key)).slice(0, 16));
  if (input.keyIds !== undefined && (!Array.isArray(input.keyIds) || input.keyIds.length !== keyIds.length || keyIds.some((id, index) => id !== (input.keyIds as unknown[])[index]))) return fail('Signing key IDs do not match the pinned key set.');
  const config: AssetlibConfig = { schemaVersion: 1, orgId: input.orgId, appId: input.appId, environment: input.environment, manifestUrl: url.href,
    ...(pinnedPublicKey !== undefined ? { pinnedPublicKey, keyId } : {}),
    ...(input.pinnedPublicKeys !== undefined ? { pinnedPublicKeys } : {}),
    ...(input.pinnedPublicKeys !== undefined || input.keyIds !== undefined ? { keyIds } : {}),
  };
  // Derived IDs are optional metadata. Do not let adding them make a valid
  // configuration too large to pass to a client or parse again.
  for (const field of ['keyIds', 'keyId'] as const) {
    if (input[field] === undefined && utf8ToBytes(JSON.stringify(config)).length > SDK_LIMITS.configBytes) delete config[field];
  }
  return config;
}

function verifyEnvelope(input: unknown, config: AssetlibConfig): { envelope: SignedManifest; payload: unknown } {
  const pinnedPublicKeys = config.pinnedPublicKeys ?? (config.pinnedPublicKey === undefined ? [] : [config.pinnedPublicKey]);
  if (!record(input) || input.algorithm !== 'Ed25519' || typeof input.publicKey !== 'string' || !pinnedPublicKeys.includes(input.publicKey) || input.keyId !== hashBytes(utf8ToBytes(input.publicKey)).slice(0, 16) || typeof input.payload !== 'string' || utf8ToBytes(input.payload).length > SDK_LIMITS.manifestBytes || typeof input.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(input.signature)) return fail('Invalid signed manifest envelope.');
  if (!ed25519.verify(base64.decode(input.signature), utf8ToBytes(input.payload), publicKeyBytes(input.publicKey), { zip215: false })) return fail('Manifest signature verification failed.');
  return { envelope: input as SignedManifest, payload: JSON.parse(input.payload) };
}

export function verifySignedAssetPage(input: unknown, config: AssetlibConfig): { envelope: SignedManifest; payload: AssetPagePayload } {
  const { envelope, payload } = verifyEnvelope(input, config);
  return { envelope, payload: validateAssetPage(payload, config) };
}

export function verifySignedManifest(input: unknown, config: AssetlibConfig): { envelope: SignedManifest; payload: ManifestPayload } {
  const { envelope, payload } = verifyEnvelope(input, config);
  if (!record(payload) || payload.schemaVersion !== 1 || payload.orgId !== config.orgId || payload.appId !== config.appId || payload.environment !== config.environment || !integer(payload.sequence, 1, 2_147_483_647) || typeof payload.createdAt !== 'string' || !Number.isFinite(Date.parse(payload.createdAt)) || !Array.isArray(payload.slots) || payload.slots.length > SDK_LIMITS.slots) return fail('Unsupported or cross-app manifest payload.');
  const keys = new Set<string>();
  for (const value of payload.slots) {
    if (!record(value) || !validKey(value.key) || keys.has(value.key) || typeof value.screen !== 'string' || value.screen.length > 120 || !integer(value.width, 1, 8192) || !integer(value.height, 1, 8192) || typeof value.assetId !== 'string' || !uuid.test(value.assetId) || typeof value.sha256 !== 'string' || !hashPattern.test(value.sha256) || value.mime !== 'image/webp' || !integer(value.bytes, 1, SDK_LIMITS.assetBytes) || typeof value.url !== 'string') return fail('Invalid or unsupported placement in manifest.');
    const url = new URL(value.url, config.manifestUrl);
    if (url.origin !== new URL(config.manifestUrl).origin || url.username || url.password || url.search || url.hash || url.pathname !== `/api/delivery/${config.orgId}/${config.appId}/assets/${value.assetId}`) return fail('Asset URL is outside the configured app.');
    validateRenditions(payload, value, config);
    validateAnimationExtension(payload, value, config);
    if ('accessibility' in value) validateAccessibility(value.accessibility);
    keys.add(value.key);
  }
  validateDeliveryExtensions(payload, config);
  if (!payload.slots.length && !(record(payload.catalog) && Number(payload.catalog.count) > 0)) return fail('A release must contain placements or catalog images.');
  return { envelope, payload: payload as ManifestPayload };
}

const throwIfAborted = (signal?: AbortSignal): void => { if (signal?.aborted) throw new Error('Assetlib request cancelled.'); };
const cachePolicy = (policy: unknown): CachePolicy => { if (policy !== 'disk' && policy !== 'memory' && policy !== 'none') throw new Error('Unknown image cache policy.'); return policy; };
const validateAppearance = (appearance: unknown): void => { if (appearance !== undefined && appearance !== 'light' && appearance !== 'dark') throw new Error('Unknown artwork appearance.'); };
const validateArm = (arm: unknown): void => { if (arm !== undefined && typeof arm !== 'string') throw new Error('Artwork arm must be a string.'); };

function variantSlot(slot: ManifestSlot, arm: string | undefined, appearance: ResolveOptions['appearance']): { slot: ManifestSlot; arm: string | null; appearance?: ResolveOptions['appearance'] } {
  const find = (selectedArm: string | undefined, selectedAppearance: ResolveOptions['appearance']) => slot.cells?.find(value => value.arm === selectedArm && value.appearance === selectedAppearance);
  const cell = (arm !== undefined ? find(arm, appearance) ?? find(arm, undefined) : undefined)
    ?? (appearance !== undefined ? find(undefined, appearance) : undefined);
  // Project a fresh descriptor so optional metadata never leaks from Control/Any.
  return cell ? { slot: { ...cell, key: slot.key, screen: slot.screen, width: slot.width, height: slot.height }, arm: cell.arm ?? null, ...(cell.appearance ? { appearance: cell.appearance } : {}) } : { slot, arm: null };
}

type ArmDecision = { arm?: string; armSource: ArmSource; reason?: string };
const decisionMessage = (message: string, decision: ArmDecision): string => decision.reason ? `${message} ${decision.reason}` : message;

class DeliveryError extends Error {
  constructor(message: string, readonly reason: FallbackReason) { super(message); }
}
const failureReason = (error: unknown): FallbackReason => error instanceof DeliveryError ? error.reason : 'other';

async function fetchBounded(fetcher: typeof fetch, url: string, maxBytes: number, timeoutMs: number, accept = 'image/webp', signal?: AbortSignal, noStore = false): Promise<Uint8Array> {
  throwIfAborted(signal);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new DeliveryError('Assetlib request timed out.', 'offline')); }, timeoutMs); });
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => { abort = () => { controller.abort(); reject(new Error('Assetlib request cancelled.')); }; signal?.addEventListener('abort', abort, { once: true }); });
  const request = async () => {
    let response: Response;
    try { response = await fetcher(url, { method: 'GET', credentials: 'omit', redirect: 'error', ...(noStore ? { cache: 'no-store' as const } : {}), signal: controller.signal, headers: { Accept: url.endsWith('/manifest') ? 'application/json' : accept } }); }
    catch (error) { throw new DeliveryError(error instanceof Error ? error.message : 'Assetlib delivery is unavailable.', 'offline'); }
    if (!response.ok || response.redirected) throw new DeliveryError(`Assetlib delivery returned ${response.status}.`, response.redirected ? 'verification' : response.status === 404 ? 'missing' : 'other');
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new DeliveryError('Response exceeds the SDK byte limit.', 'verification');
    if (!response.body?.getReader) throw new Error('This fetch implementation does not support bounded streaming; use expo/fetch.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (controller.signal.aborted) throw new DeliveryError('Assetlib request timed out.', 'offline');
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) throw new DeliveryError('Response exceeds the SDK byte limit.', 'verification');
        chunks.push(next.value);
      }
    } catch (error) { throw error instanceof DeliveryError ? error : new DeliveryError(error instanceof Error ? error.message : 'Artwork transfer failed.', 'offline'); }
    finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  };
  try { return await Promise.race([request(), deadline, cancelled]); }
  finally { if (timeout) clearTimeout(timeout); if (abort) signal?.removeEventListener('abort', abort); controller.abort(); }
}

type State = { version: 1; highestSequence: number; history: SignedManifest[] };

/** Durable replay identity survives authorized route and signing-key changes. */
export function storageNamespace(config: AssetlibConfig): string {
  return hashBytes(utf8ToBytes(JSON.stringify([new URL(config.manifestUrl).origin, config.orgId, config.appId, config.environment]))).slice(0, 32);
}

/** Use the same verification for normal state loads and legacy namespace migration. */
export function verifyStoredState(serialized: string, config: AssetlibConfig): State {
  if (utf8ToBytes(serialized).length > SDK_LIMITS.stateBytes) throw new Error('Stored SDK state exceeds its bound.');
  const state: unknown = JSON.parse(serialized);
  if (!record(state) || state.version !== 1 || !integer(state.highestSequence, 1, 2_147_483_647) || !Array.isArray(state.history) || state.history.length < 1 || state.history.length > SDK_LIMITS.retainedReleases) throw new Error('Stored SDK state is invalid.');
  let previous = state.highestSequence + 1;
  for (const [index, entry] of state.history.entries()) {
    const { payload } = verifySignedManifest(entry, config);
    if (payload.sequence >= previous) throw new Error('Stored release order is invalid.');
    if (index === 0 && payload.sequence !== state.highestSequence) throw new Error('Stored sequence does not match its signed manifest.');
    previous = payload.sequence;
  }
  return state as State;
}

export class AssetClient {
  readonly config: AssetlibConfig;
  private state: State = { version: 1, highestSequence: 0, history: [] };
  private initialized = false;
  private storageFailure: string | null = null;
  private lastError: string | null = null;
  private lastRefreshReason: FallbackReason = 'missing';
  private reporter?: ObservationReporter;
  private queue: Promise<unknown> = Promise.resolve();
  private timeoutMs: number;
  private decisionTimeoutMs: number;
  private fetcher: typeof fetch;
  private formats: readonly AssetMime[];
  private policy: CachePolicy;
  private memory = new Map<string, Uint8Array>();
  private handles = new WeakMap<DynamicAssetRef, { descriptor: CatalogAsset; sequence: number }>();
  private activeTransfers = 0;
  private transferQueue: (() => void)[] = [];
  private concurrency: number;
  constructor(config: AssetlibConfig, private options: ClientOptions) {
    this.config = parsePublicConfig(config, options);
    this.formats = supportedFormats(options.formats);
    this.policy = cachePolicy(options.cachePolicy ?? 'disk');
    this.concurrency = options.maxConcurrentDownloads ?? 4;
    if (!integer(this.concurrency, 1, 8)) fail('maxConcurrentDownloads must be between 1 and 8.');
    this.timeoutMs = options.timeoutMs ?? 8000;
    if (!integer(this.timeoutMs, 20, 30000)) fail('timeoutMs must be between 20 and 30000.');
    this.decisionTimeoutMs = options.decisionTimeoutMs === undefined ? 1500 : options.decisionTimeoutMs;
    if (!integer(this.decisionTimeoutMs, 100, 10000)) fail('decisionTimeoutMs must be between 100 and 10000.');
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (options.telemetry?.enabled === true) {
      try { this.reporter = new ObservationReporter(this.config, options.storage, this.fetcher, options.telemetry); }
      catch { /* Invalid optional telemetry must not disable asset delivery. */ }
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
  getStatus(): ClientStatus { return { initialized: this.initialized, sequence: this.state.highestSequence, lastError: this.lastError }; }
  /** Best-effort: one bounded batch, retained for a later flush on failure. */
  flush(): Promise<void> { return this.reporter?.flush() ?? Promise.resolve(); }
  /** The adapter calls this after a verified image decodes and attaches. */
  reportDisplay(ref: AssetRef | DynamicAssetRef, resolved: ResolvedAsset): void { this.reporter?.record('display', ref, resolved); }
  /** The adapter reports a renderer fallback separately from resolution. */
  reportFallback(ref: AssetRef | DynamicAssetRef, resolved: ResolvedAsset, reason: FallbackReason): void { this.reporter?.record('fallback', ref, resolved, reason); }
  /** Stop observations and discard unsent events; artwork resolution remains usable. */
  dispose(): void { this.reporter?.dispose(); }
  private observed<T extends AssetStatus>(ref: AssetRef, result: T): T {
    this.reporter?.record(result.source === 'bundle' ? 'fallback' : 'resolve', ref, result, result.fallbackReason ?? 'other');
    return result;
  }
  initialize(): Promise<ClientStatus> { return this.serial(async () => { await this.load(); return this.getStatus(); }); }
  private async load(): Promise<void> {
    this.initialized = true;
    if (this.storageFailure) return;
    try {
      const raw = await this.options.storage.loadState();
      if (raw === null) {
        if (this.state.highestSequence) throw new Error('Stored release state disappeared.');
        return;
      }
      const next = verifyStoredState(raw, this.config);
      if (next.highestSequence < this.state.highestSequence) throw new Error('Stored release state moved backwards.');
      const accepted = new Map(this.state.history.map(entry => [verifySignedManifest(entry, this.config).payload.sequence, entry.payload]));
      for (const entry of next.history) {
        const previous = accepted.get(verifySignedManifest(entry, this.config).payload.sequence);
        if (previous !== undefined && previous !== entry.payload) throw new Error('Stored release state conflicts with an accepted release.');
      }
      this.state = next;
    } catch {
      this.storageFailure = 'Stored release state could not be verified. Using bundled assets; repair or explicitly reset app data before reconnecting.';
      this.lastError = this.storageFailure;
      this.lastRefreshReason = 'verification';
    }
  }
  refresh(): Promise<RefreshResult> {
    void this.flush();
    return this.serial(async () => {
      await this.load();
      try {
        if (this.storageFailure) throw new DeliveryError(this.storageFailure, 'verification');
        const bytes = await fetchBounded(this.fetcher, this.config.manifestUrl, SDK_LIMITS.manifestBytes, this.timeoutMs);
        let verified: ReturnType<typeof verifySignedManifest>;
        try { verified = verifySignedManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), this.config); }
        catch (error) { throw new DeliveryError(error instanceof Error ? error.message : 'Manifest verification failed.', 'verification'); }
        const { envelope, payload } = verified;
        if (payload.sequence < this.state.highestSequence) throw new DeliveryError('An older release was rejected.', 'verification');
        if (payload.sequence === this.state.highestSequence) {
          if (envelope.payload !== this.state.history[0]?.payload) throw new DeliveryError('Conflicting content reused an existing release sequence.', 'verification');
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
        this.lastRefreshReason = failureReason(error);
        return { updated: false, sequence: this.state.highestSequence, error: message };
      }
    });
  }
  /** Only metadata transitions use the serial queue. Image transfers are bounded and concurrent. */
  private snapshot(): Promise<{ payload: ManifestPayload }[]> {
    return this.serial(async () => { await this.load(); return this.storageFailure ? [] : this.state.history.map(entry => ({ payload: verifySignedManifest(entry, this.config).payload })); });
  }
  private withTransfer<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    return new Promise<T>((resolve, reject) => {
      const cancel = () => { this.transferQueue = this.transferQueue.filter(item => item !== start); reject(new Error('Assetlib request cancelled.')); };
      const start = () => {
        signal?.removeEventListener('abort', cancel);
        if (signal?.aborted) { reject(new Error('Assetlib request cancelled.')); return; }
        this.activeTransfers++;
        Promise.resolve().then(work).then(resolve, reject).finally(() => {
          this.activeTransfers--;
          while (this.activeTransfers < this.concurrency && this.transferQueue.length) this.transferQueue.shift()!();
        });
      };
      if (this.activeTransfers < this.concurrency) start();
      else { this.transferQueue.push(start); signal?.addEventListener('abort', cancel, { once: true }); }
    });
  }
  private async cached(hash: string, policy: CachePolicy): Promise<Uint8Array | null> {
    if (policy === 'none') return null;
    if (policy === 'disk') return this.options.storage.getAsset(hash);
    const value = this.memory.get(hash);
    if (!value) return null;
    this.memory.delete(hash); this.memory.set(hash, value);
    return value.slice();
  }
  private async retain(hash: string, bytes: Uint8Array, mime: StorageMime, policy: CachePolicy): Promise<void> {
    if (policy === 'none') return;
    if (policy === 'disk') { await this.options.storage.putAsset(hash, bytes, mime); return; }
    this.memory.delete(hash); this.memory.set(hash, bytes.slice());
    while (this.memory.size > SDK_LIMITS.cacheEntries || [...this.memory.values()].reduce((sum, value) => sum + value.byteLength, 0) > SDK_LIMITS.cacheBytes) this.memory.delete(this.memory.keys().next().value!);
  }
  clearMemoryCache(): void { this.memory.clear(); }
  private async decideArm(ref: AssetRef, slot: ManifestSlot | undefined, options: ResolveOptions): Promise<ArmDecision> {
    if (options.arm !== undefined) return { arm: options.arm === 'control' ? undefined : options.arm, armSource: 'explicit' };
    if (!slot?.variants?.arm?.length || !this.options.decide) return { armSource: 'control' };
    const decide = this.options.decide;
    const request = { key: ref.key, arms: Object.freeze([...slot.variants.arm]), ...(options.appearance !== undefined ? { appearance: options.appearance } : {}) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('decision-timeout');
    try {
      const deadline = new Promise<typeof timedOut>(resolve => { timer = setTimeout(() => resolve(timedOut), this.decisionTimeoutMs); });
      const arm = await Promise.race([Promise.resolve().then(() => decide(request)), deadline]);
      if (arm === timedOut) return { armSource: 'invalid-decision', reason: 'Decision callback timed out; using control.' };
      // Declarations are checked against the release reloaded after this callback.
      if (typeof arm === 'string') return { arm, armSource: 'decision' };
      return { armSource: 'invalid-decision', reason: arm === undefined ? 'Decision returned no arm; using control.' : 'Decision returned an undeclared arm; using control.' };
    } catch {
      return { armSource: 'invalid-decision', reason: 'Decision callback threw; using control.' };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  private async decisionSnapshot(ref: AssetRef, options: ResolveOptions) {
    const matches = (item: ManifestSlot) => item.key === ref.key && item.width === ref.width && item.height === ref.height;
    const initial = await this.snapshot();
    let decision = await this.decideArm(ref, initial[0]?.payload.slots.find(matches), options);
    throwIfAborted(options.signal);
    // Application callbacks never own the operation queue. Reacquire it and
    // verify durable state before using any release or arm after a callback.
    const history = decision.armSource === 'explicit' || decision.armSource === 'control' ? initial : await this.snapshot();
    if (decision.armSource === 'decision' && !history[0]?.payload.slots.find(matches)?.variants?.arm?.includes(decision.arm!)) {
      decision = { armSource: 'invalid-decision', reason: 'Decision returned an undeclared arm; using control.' };
    }
    return { history, decision, matches };
  }
  private async resolveDescriptor(slot: ManifestSlot, sequence: number, download: boolean, options: ResolveOptions): Promise<ResolvedAsset> {
    validateAppearance(options.appearance);
    const policy = cachePolicy(options.cachePolicy ?? this.policy);
    const target = targetPixels(slot, options);
    let message = 'No compatible image bytes are available.';
    let fallbackReason: FallbackReason = 'missing';
    for (const candidate of selectAssetCandidates(slot, target, this.formats)) {
      throwIfAborted(options.signal);
      // Preserve existing control keys; isolate every requested non-control arm and appearance.
      const cacheKey = options.arm !== undefined && options.arm !== 'control'
        ? hashBytes(utf8ToBytes(JSON.stringify(['arm', options.arm, options.appearance ?? null, candidate.sha256])))
        : options.appearance === undefined ? candidate.sha256 : hashBytes(utf8ToBytes(`appearance:${options.appearance}:${candidate.sha256}`));
      const identity = { arm: null, armSource: 'control' as const, mime: candidate.mime, sha256: candidate.sha256, cacheKey, assetId: slot.assetId, cachePolicy: policy,
        ...(slot.accessibility ? { accessibility: Object.freeze({ defaultLocale: slot.accessibility.defaultLocale, descriptions: Object.freeze({ ...slot.accessibility.descriptions }) }) } : {}),
        ...(candidate.isRendition ? { pixelWidth: candidate.width, pixelHeight: candidate.height } : {}) };
      try {
        const cached = await this.cached(cacheKey, policy);
        throwIfAborted(options.signal);
        if (cached && this.validBytes(cached, candidate)) return { source: 'cache', sequence, message: 'Verified artwork loaded from cache.', bytes: cached, ...identity };
        if (cached) { message = 'Cached asset bytes do not match the signed descriptor.'; fallbackReason = 'verification'; }
        if (!download) continue;
        const bytes = await this.withTransfer(() => fetchBounded(this.fetcher, new URL(candidate.url, this.config.manifestUrl).href, candidate.bytes, this.timeoutMs, candidate.mime, options.signal, policy !== 'disk'), options.signal);
        throwIfAborted(options.signal);
        if (!this.validBytes(bytes, candidate)) throw new DeliveryError('Asset bytes do not match the signed descriptor.', 'verification');
        await this.retain(cacheKey, bytes, candidate.mime, policy);
        throwIfAborted(options.signal);
        return { source: 'remote', sequence, message: 'Downloaded and verified artwork.', bytes, ...identity };
      } catch (error) { throwIfAborted(options.signal); message = error instanceof Error ? error.message : 'Artwork could not be loaded.'; fallbackReason = failureReason(error); }
    }
    return { source: 'bundle', sequence: null, arm: null, armSource: 'control', cachePolicy: policy, message, fallbackReason };
  }
  async resolve(ref: AssetRef, options: ResolveOptions = {}): Promise<ResolvedAsset> {
    if (!validKey(ref.key) || !integer(ref.width, 1, 8192) || !integer(ref.height, 1, 8192)) throw new Error('Invalid generated asset reference.');
    if (ref.bundledAccessibility !== undefined) validateAccessibility(ref.bundledAccessibility);
    validateAppearance(options.appearance);
    validateArm(options.arm);
    targetPixels(ref, options); cachePolicy(options.cachePolicy ?? this.policy); throwIfAborted(options.signal);
    const { history, decision, matches } = await this.decisionSnapshot(ref, options);
    throwIfAborted(options.signal);
    const resolvedOptions = { ...options, arm: decision.arm };
    let message = this.storageFailure ?? 'No compatible published artwork is available.';
    let reason: FallbackReason = this.storageFailure ? 'verification' : !history.length && this.lastError ? this.lastRefreshReason : 'missing';
    for (const [index, { payload }] of history.entries()) {
      const slot = payload.slots.find(matches);
      if (!slot) continue;
      const selected = variantSlot(slot, decision.arm, options.appearance);
      const result = await this.resolveDescriptor(selected.slot, payload.sequence, index === 0, resolvedOptions);
      if (result.source !== 'bundle') return this.observed(ref, { ...result, arm: selected.arm, ...(selected.appearance ? { appearance: selected.appearance } : {}), armSource: decision.armSource, message: decisionMessage(index ? `Using verified artwork from release ${payload.sequence}. ${message}` : result.message, decision) });
      if (index === 0 || reason === 'missing') reason = result.fallbackReason ?? 'other';
      message = result.message;
    }
    throwIfAborted(options.signal);
    return this.observed(ref, { source: 'bundle', sequence: null, arm: null, armSource: decision.armSource, fallbackReason: reason, message: decisionMessage(`Using bundled artwork. ${message}`, decision), ...(ref.bundledAccessibility ? { accessibility: ref.bundledAccessibility } : {}) });
  }
  async resolveStateSet(ref: StateSetRef, options: ResolveOptions = {}): Promise<ResolvedStateSet> {
    if (!validKey(ref.key) || !integer(ref.width, 1, 8192) || !integer(ref.height, 1, 8192) || !validStateRef(ref.states)) throw new Error('Invalid state set reference.');
    validateAppearance(options.appearance);
    validateArm(options.arm);
    targetPixels(ref, options); cachePolicy(options.cachePolicy ?? this.policy); throwIfAborted(options.signal);
    const { history, decision, matches } = await this.decisionSnapshot(ref, options);
    throwIfAborted(options.signal);
    const resolvedOptions = { ...options, arm: decision.arm };
    let reason: FallbackReason = this.storageFailure ? 'verification' : !history.length && this.lastError ? this.lastRefreshReason : 'missing';
    for (const [index, { payload }] of history.entries()) {
      const placement = payload.slots.find(matches);
      const selected = placement && variantSlot(placement, decision.arm, options.appearance);
      const slot = selected?.slot;
      if (!slot?.states || Object.keys(slot.states).length !== ref.states.length || ref.states.some(name => !Object.hasOwn(slot.states!, name))) continue;
      const entries = await Promise.all(ref.states.map(async name => {
        // Optional metadata and renditions belong to this state, never to the default image.
        const result = await this.resolveDescriptor({ ...slot.states![name], key: slot.key, screen: slot.screen, width: slot.width, height: slot.height }, payload.sequence, index === 0, resolvedOptions);
        return [name, { ...result, arm: selected!.arm, ...(selected!.appearance ? { appearance: selected!.appearance } : {}), armSource: decision.armSource, message: decisionMessage(result.message, decision) }] as const;
      }));
      throwIfAborted(options.signal);
      const failed = entries.find(([, value]) => value.source === 'bundle');
      if (failed) { if (index === 0 || reason === 'missing') reason = failed[1].fallbackReason ?? 'other'; continue; }
      if (entries.reduce((sum, [, value]) => sum + (value.bytes?.byteLength ?? 0), 0) > SDK_LIMITS.cacheBytes) { reason = 'other'; continue; }
      // Only the committed family is an outcome; discarded partial downloads
      // are not observations. Each state's asset retains its actual source.
      for (const [, value] of entries) this.observed(ref, value);
      return { source: entries.some(([, value]) => value.source === 'remote') ? 'remote' : 'cache', sequence: payload.sequence,
        arm: selected!.arm, ...(selected!.appearance ? { appearance: selected!.appearance } : {}), armSource: decision.armSource, message: decisionMessage('Complete state set pinned to one release.', decision), states: Object.freeze(Object.fromEntries(entries)) };
    }
    throwIfAborted(options.signal);
    return this.observed(ref, { source: 'bundle', sequence: null, arm: null, armSource: decision.armSource, fallbackReason: reason, message: decisionMessage('Using the complete bundled state set.', decision), states: Object.freeze({}) });
  }
  async loadAssetPage(options: AssetPageOptions = {}): Promise<AssetPage> {
    const limit = options.limit ?? 20;
    if (!integer(limit, 1, 50) || (options.cursor !== undefined && !assetIdPattern.test(options.cursor)) || (options.sequence !== undefined && !integer(options.sequence, 1, 2_147_483_647))) throw new Error('Invalid asset page request.');
    throwIfAborted(options.signal);
    const history = await this.snapshot();
    if (this.storageFailure) throw new Error(this.storageFailure);
    const manifest = catalogForSequence(history, options.sequence);
    if (options.sequence !== undefined && !manifest) throw new Error('This catalog release is no longer retained. Restart pagination.');
    if (!manifest?.catalog || !manifest.catalog.count) return { items: [], nextCursor: null, sequence: manifest?.sequence ?? 0 };
    const url = new URL(manifest.catalog.url, this.config.manifestUrl);
    url.searchParams.set('limit', String(limit));
    if (options.cursor) url.searchParams.set('cursor', options.cursor);
    const bytes = await this.withTransfer(() => fetchBounded(this.fetcher, url.href, SDK_LIMITS.manifestBytes, this.timeoutMs, 'application/json', options.signal, true), options.signal);
    throwIfAborted(options.signal);
    const { payload } = verifySignedAssetPage(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), this.config);
    if (payload.sequence !== manifest.sequence || payload.cursor !== (options.cursor ?? null) || payload.assets.length > limit || payload.assets.length > manifest.catalog.count || (options.cursor && payload.assets.some(asset => asset.assetId <= options.cursor!))) throw new Error('Asset page does not match the requested release or cursor.');
    const items = payload.assets.map(descriptor => {
      const ref: DynamicAssetRef = Object.freeze({ kind: 'dynamic', assetId: descriptor.assetId, width: descriptor.width, height: descriptor.height, sequence: payload.sequence, ...(descriptor.name !== undefined ? { name: descriptor.name } : {}) });
      this.handles.set(ref, { descriptor, sequence: payload.sequence });
      return ref;
    });
    return { items: Object.freeze(items), nextCursor: payload.nextCursor, sequence: payload.sequence };
  }
  async resolveAsset(ref: DynamicAssetRef, options: ResolveOptions = {}): Promise<ResolvedAsset> {
    const entry = this.handles.get(ref);
    if (!entry) throw new Error("Use an image reference returned by this client's verified catalog.");
    // Immutable, verified page handles pin their content revision for the feed's lifetime.
    return this.resolveDescriptor({ ...entry.descriptor, key: entry.descriptor.assetId, screen: '' }, entry.sequence, true, options);
  }
  /** Explicit opt-in. Image resolution never downloads an animation. */
  async resolveAnimation(ref: AssetRef, options: ResolveOptions = {}): Promise<ResolvedAnimation> {
      const history = await this.snapshot();
      const policy = cachePolicy(options.cachePolicy ?? this.policy);
      throwIfAborted(options.signal);
      if (!validKey(ref.key) || !integer(ref.width, 1, 8192) || !integer(ref.height, 1, 8192)) throw new Error('Invalid generated asset reference.');
      let message = this.storageFailure ?? 'No compatible published animation is available.';
      for (let index = 0; index < history.length; index++) {
        const { payload } = history[index];
        const slot = payload.slots.find(item => item.key === ref.key && item.width === ref.width && item.height === ref.height);
        const animation = slot?.animation;
        // Removing animation is intentional publication state, not a failed download.
        if (index === 0 && !animation) return { source: 'poster', sequence: null, message: 'The current release has no compatible animation. Use the still poster.' };
        if (!slot || !animation) continue;
        const parse = (bytes: Uint8Array) => {
          if (bytes.byteLength !== animation.bytes || hashBytes(bytes) !== animation.sha256) throw new Error('Animation bytes do not match the signed manifest.');
          return verifiedAnimationData(bytes, animation);
        };
        const result = (source: 'cache' | 'remote', bytes: Uint8Array, parsed: ReturnType<typeof parse>): ResolvedAnimation => ({
          source, sequence: payload.sequence, message: index ? `Using verified animation from release ${payload.sequence}. ${message}` : source === 'cache' ? 'Verified animation loaded from the local cache.' : 'Downloaded animation; signature, hash and vector profile verified.',
          sha256: animation.sha256, assetId: slot.assetId, mime: 'application/json', bytes, ...parsed,
        });
        try {
          const cached = await this.cached(animation.sha256, policy);
          throwIfAborted(options.signal);
          if (cached) {
            try { return result('cache', cached, parse(cached)); }
            catch (error) { message = error instanceof Error ? error.message : 'Cached animation is invalid.'; }
          }
          // Older releases may be used only when already cached and reverified.
          if (index !== 0) continue;
          const bytes = await this.withTransfer(() => fetchBounded(this.fetcher, new URL(animation.url, this.config.manifestUrl).href, animation.bytes, this.timeoutMs, animation.mime, options.signal, policy !== 'disk'), options.signal);
          throwIfAborted(options.signal);
          const parsed = parse(bytes);
          await this.retain(animation.sha256, bytes, animation.mime, policy);
          throwIfAborted(options.signal);
          return result('remote', bytes, parsed);
        } catch (error) { throwIfAborted(options.signal); message = error instanceof Error ? error.message : 'Animation could not be loaded.'; }
      }
      return { source: 'poster', sequence: null, message: `Use the still poster. ${message}` };
  }
  private validBytes(bytes: Uint8Array, candidate: AssetCandidate): boolean {
    return bytes.byteLength === candidate.bytes && bytes.byteLength <= SDK_LIMITS.assetBytes && hashBytes(bytes) === candidate.sha256 && validRenditionHeader(bytes, candidate);
  }
}

export function createAssetClient(config: AssetlibConfig, options: ClientOptions): AssetClient { return new AssetClient(config, options); }

/** Bounded test/ephemeral adapter. Apps should use a durable platform adapter. */
export function createMemoryStorage() {
  let state: string | null = null;
  const installIds = new Map<string, string>();
  const assets = new Map<string, Uint8Array>();
  return {
    async getOrCreateInstallId(key: string, create: () => string) { let id = installIds.get(key); if (id === undefined) { id = create(); installIds.set(key, id); } return id; },
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
