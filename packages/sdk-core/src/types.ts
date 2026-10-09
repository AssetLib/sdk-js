export type AssetlibConfig = { schemaVersion: 1; orgId: string; appId: string; environment: 'staging' | 'production'; manifestUrl: string; pinnedPublicKey?: string; keyId?: string; pinnedPublicKeys?: string[]; keyIds?: string[] };
export type AssetAccessibility = { readonly defaultLocale: string; readonly descriptions: Readonly<Record<string, string>> };
export type Appearance = 'light' | 'dark';
export type AssetVariants = { readonly appearance?: readonly Appearance[]; readonly arm?: readonly string[] };
export type AssetRef = { readonly key: string; readonly width: number; readonly height: number; readonly variants?: AssetVariants; readonly bundledAccessibility?: AssetAccessibility };
export type StateSetRef = AssetRef & { readonly states: readonly string[]; readonly bundledStateAccessibility?: Readonly<Record<string, AssetAccessibility>> };
export type CachePolicy = 'disk' | 'memory' | 'none';
/** Issued by this client's verified asset page; plain objects are not trusted handles. */
export type DynamicAssetRef = { readonly kind: 'dynamic'; readonly assetId: string; readonly width: number; readonly height: number; readonly sequence: number; readonly name?: string };
export type ArmSource = 'explicit' | 'decision' | 'control' | 'invalid-decision';
export type AssetStatus = { source: 'bundle' | 'cache' | 'remote'; sequence: number | null; message: string; /** Arm of the selected artwork; null for control or bundled fallback. */ arm: string | null; armSource: ArmSource; /** Effective selected cell; omitted for Any or bundled artwork. */ appearance?: Appearance; /** Why bundled artwork was selected. Never includes exception text in observations. */ fallbackReason?: FallbackReason; sha256?: string; assetId?: string };
export type AssetMime = 'image/webp' | 'image/png' | 'image/svg+xml';
/** Cache transport MIME types; animation is never an image format candidate. */
export type StorageMime = AssetMime | 'application/json';
export type ResolvedAsset = AssetStatus & { bytes?: Uint8Array; mime?: AssetMime; pixelWidth?: number; pixelHeight?: number; cachePolicy?: CachePolicy; /** Storage identity, including requested arm and appearance; sha256 remains the content hash. */ cacheKey?: string; accessibility?: AssetAccessibility };
export type ResolvedStateSet = AssetStatus & { states: Readonly<Record<string, ResolvedAsset>> };
export type AnimationDescriptor = { format: 'lottie'; profile: 'vector-v1'; mime: 'application/json'; sha256: string; url: string; bytes: number; width: number; height: number; frameRate: number; inPoint: number; outPoint: number };
export type ResolvedAnimation = { source: 'poster'; sequence: null; message: string } | {
  source: 'cache' | 'remote'; sequence: number; message: string; sha256: string; assetId: string;
  mime: 'application/json'; bytes: Uint8Array; data: Record<string, unknown>;
  width: number; height: number; frameRate: number; inPoint: number; outPoint: number;
};
export type ResolveOptions = { pixelWidth?: number; pixelHeight?: number; cachePolicy?: CachePolicy; signal?: AbortSignal; appearance?: Appearance; arm?: string };
export type AssetPageOptions = { cursor?: string; limit?: number; sequence?: number; signal?: AbortSignal };
export type AssetPage = { items: readonly DynamicAssetRef[]; nextCursor: string | null; sequence: number };
export type ClientStatus = { initialized: boolean; sequence: number; lastError: string | null };
export type RefreshResult = { updated: boolean; sequence: number; error?: string };
export type SignedManifest = { algorithm: 'Ed25519'; keyId: string; publicKey: string; payload: string; signature: string };
export type AssetRendition = { sha256: string; url: string; mime: AssetMime; bytes: number; width: number; height: number };
export type AssetDescriptor = { assetId: string; sha256: string; url: string; mime: 'image/webp'; bytes: number; renditions?: AssetRendition[]; accessibility?: AssetAccessibility };
export type ManifestCell = AssetDescriptor & { appearance?: Appearance; arm?: string; states?: Record<string, AssetDescriptor> };
export type ManifestSlot = AssetDescriptor & { key: string; screen: string; width: number; height: number; animation?: AnimationDescriptor; states?: Record<string, AssetDescriptor>; defaultState?: string; variants?: AssetVariants; cells?: ManifestCell[] };
export type CatalogAsset = AssetDescriptor & { width: number; height: number; name?: string };
export type AssetPagePayload = { kind: 'asset-page'; schemaVersion: 1; renditionSchemaVersion?: 1; orgId: string; appId: string; environment: 'staging' | 'production'; sequence: number; createdAt: string; assets: CatalogAsset[]; cursor: string | null; nextCursor: string | null };
export type ManifestPayload = { schemaVersion: 1; renditionSchemaVersion?: 1; animationSchemaVersion?: 1; stateSchemaVersion?: 1; catalogSchemaVersion?: 1; variantSchemaVersion?: 1; orgId: string; appId: string; environment: 'staging' | 'production'; sequence: number; createdAt: string; slots: ManifestSlot[]; catalog?: { url: string; count: number } };
export type AssetStorage = {
  /** Atomically read or create an opaque install ID under this dedicated metadata key.
   * Keep it outside the evictable image cache and signed replay state. Optional for
   * existing adapters; telemetry needs this method unless installId is supplied. */
  getOrCreateInstallId?(key: string, create: () => string): Promise<string>;
  loadState(): Promise<string | null>;
  /** Atomically replace durable state; reject a lower highestSequence than already stored. */
  saveState(serialized: string): Promise<void>;
  /** Opaque 64-hex identity; arm/appearance-scoped keys are not the content SHA-256. */
  getAsset(cacheKey: string): Promise<Uint8Array | null>;
  putAsset(cacheKey: string, bytes: Uint8Array, mime?: StorageMime): Promise<void>;
};
export type FallbackReason = 'offline' | 'verification' | 'decode' | 'missing' | 'other';
export type TelemetryBuild = { platform: 'ios' | 'android' | 'web' | 'expo'; appVersion: string; buildNumber: string };
export type TelemetryOptions = { enabled: boolean; /** An opaque, random per-install identifier, never a device or user identifier. */ installId?: string; flushIntervalMs?: number; maxBatch?: number; build?: TelemetryBuild; sdk?: { name: string; version: string } };
export type ClientOptions = { storage: AssetStorage; fetch?: typeof globalThis.fetch; allowInsecureLoopback?: boolean; timeoutMs?: number; cachePolicy?: CachePolicy; maxConcurrentDownloads?: number; telemetry?: TelemetryOptions; /** Assignment only; the app's experiment tool logs exposure after rendering. */ decide?: (request: { key: string; arms: readonly string[]; appearance?: Appearance }) => string | undefined | Promise<string | undefined>; /** SVG is opt-in and requires a renderer suitable for normalized SVG image data. */ formats?: readonly AssetMime[] };
