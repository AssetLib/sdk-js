import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { AssetlibConfig, AssetRef, AssetStatus, AssetStorage, DynamicAssetRef, FallbackReason, TelemetryOptions } from './types.js';

type Observation = { kind: 'resolve' | 'display' | 'fallback'; key: string; source: AssetStatus['source']; assetId?: string; sequence?: number; reason?: FallbackReason; arm?: string; appearance?: 'light' | 'dark'; count: number };
const version = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(value) && !/\s/.test(value);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length >= 8 && value.length <= 64;
const reasons: readonly FallbackReason[] = ['offline', 'verification', 'decode', 'missing', 'other'];
const MAX_COORDINATES = 2000;
const MAX_BODY_BYTES = 64 * 1024;
const boundedInteger = (value: number | undefined, fallback: number, max: number) => Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, max) : fallback;

/** Best-effort observations are isolated from the resolution and replay queues. */
export class ObservationReporter {
  private pending = new Map<string, Observation>();
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private identity?: Promise<string | null>;
  private controller?: AbortController;
  private disposed = false;
  private readonly interval: number;
  private readonly maxBatch: number;
  private readonly sdk: { name: string; version: string };
  private readonly build: NonNullable<TelemetryOptions['build']>;
  private readonly endpoint: string;
  private readonly installKey: string;
  private readonly environment: AssetlibConfig['environment'];
  private readonly suppliedInstallId?: string;
  constructor(config: AssetlibConfig, private storage: AssetStorage, private fetcher: typeof fetch, options: TelemetryOptions) {
    this.interval = boundedInteger(options.flushIntervalMs, 60_000, 2_147_483_647);
    this.maxBatch = boundedInteger(options.maxBatch, 200, 200);
    const sdk = options.sdk ?? { name: 'sdk-core', version: '0.4.1-preview.1' };
    const build = options.build ?? { platform: 'web', appVersion: 'unknown', buildNumber: 'unknown' };
    if (!version(sdk.name) || !version(sdk.version) || !['ios', 'android', 'web', 'expo'].includes(build.platform) || !version(build.appVersion) || !version(build.buildNumber) || (options.installId !== undefined && !validId(options.installId))) throw new Error('Invalid observation configuration.');
    // Copy only the contract fields, never arbitrary caller-supplied metadata.
    this.sdk = { name: sdk.name, version: sdk.version };
    this.build = { platform: build.platform, appVersion: build.appVersion, buildNumber: build.buildNumber };
    this.suppliedInstallId = options.installId;
    this.environment = config.environment;
    const origin = new URL(config.manifestUrl).origin;
    this.endpoint = `${origin}/api/delivery/${config.orgId}/${config.appId}/observations`;
    this.installKey = `assetlib:telemetry:install:v1:${origin}:${config.orgId}:${config.appId}`;
  }
  record(kind: Observation['kind'], ref: AssetRef | DynamicAssetRef, result: AssetStatus, reason?: FallbackReason): void {
    try {
      if (this.disposed || !['remote', 'cache', 'bundle'].includes(result.source) || (kind === 'display' && result.source === 'bundle')) return;
      // Catalog handles are not placements and cannot contribute placement usage.
      if (!('key' in ref) || ('kind' in ref && ref.kind === 'dynamic')) return;
      if (result.source === 'bundle' && kind !== 'fallback') return;
      const key = ref.key;
      if (typeof key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(key) || /\s/.test(key)) return;
      const event: Observation = { kind, key, source: result.source, count: 1 };
      if (result.source !== 'bundle') {
        if (typeof result.assetId === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(result.assetId)) event.assetId = result.assetId;
        if (Number.isSafeInteger(result.sequence) && result.sequence! > 0 && result.sequence! <= 2_147_483_647) event.sequence = result.sequence!;
      }
      if (kind !== 'fallback' && result.source !== 'bundle' && (!event.assetId || !event.sequence)) return;
      if (typeof result.arm === 'string' && /^[a-z][a-z0-9_-]{0,19}$/.test(result.arm) && !['control', 'any', 'constructor', 'prototype', '__proto__'].includes(result.arm) && !/\s/.test(result.arm)) event.arm = result.arm;
      if (result.appearance === 'light' || result.appearance === 'dark') event.appearance = result.appearance;
      if (kind === 'fallback') event.reason = reasons.includes(reason!) ? reason : 'other';
      const coordinate = JSON.stringify(event);
      const previous = this.pending.get(coordinate);
      if (previous) previous.count = Math.min(Number.MAX_SAFE_INTEGER, previous.count + 1);
      else if (this.pending.size < MAX_COORDINATES) this.pending.set(coordinate, event);
      this.schedule();
    } catch { /* Observation errors must never affect the app's renderer. */ }
  }
  private schedule(): void {
    if (this.disposed || this.timer !== undefined || this.inFlight || !this.pending.size) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.interval);
    // An optional telemetry timer should not keep a Node process alive.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
  private installId(): Promise<string | null> {
    if (!this.identity) {
      this.identity = Promise.resolve().then(async () => {
        if (this.suppliedInstallId !== undefined) return this.suppliedInstallId;
        const value = await this.storage.getOrCreateInstallId?.(this.installKey, () => bytesToHex(randomBytes(16)));
        return validId(value) ? value : null;
      }).catch(() => null);
      void this.identity.then(value => { if (value === null) this.identity = undefined; });
    }
    return this.identity;
  }
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.disposed || !this.pending.size) return Promise.resolve();
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    this.inFlight = this.send().catch(() => {}).finally(() => { this.inFlight = undefined; this.schedule(); });
    return this.inFlight;
  }
  private async send(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('Observation timeout.')); }, 5000); });
    const request = async () => {
      const installId = await this.installId();
      if (!installId || controller.signal.aborted || this.disposed) return;
      const selected = [...this.pending].slice(0, this.maxBatch).map(([key, event]) => [key, { ...event, count: Math.min(event.count, 10_000) }] as const);
      const batch = { schemaVersion: 1, environment: this.environment, sdk: this.sdk, build: this.build, installId, sentAt: new Date().toISOString(), events: selected.map(([, event]) => event) };
      let body = JSON.stringify(batch);
      while (utf8ToBytes(body).length > MAX_BODY_BYTES && selected.length) {
        selected.pop(); batch.events.pop(); body = JSON.stringify(batch);
      }
      if (!selected.length) return;
      const response = await this.fetcher(this.endpoint, { method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body });
      // A response after timeout is not an acknowledgement for this attempt.
      if (controller.signal.aborted || this.disposed) return;
      if (response.status !== 202 || response.redirected) throw new Error('Observation batch was not accepted.');
      for (const [key, sent] of selected) {
        const current = this.pending.get(key);
        if (!current) continue;
        current.count -= sent.count;
        if (current.count <= 0) this.pending.delete(key);
      }
    };
    try { await Promise.race([request(), deadline]); }
    finally { if (timeout !== undefined) clearTimeout(timeout); controller.abort(); if (this.controller === controller) this.controller = undefined; }
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.pending.clear();
  }
}
