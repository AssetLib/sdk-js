export type AssetlibConfig = { schemaVersion: 1; orgId: string; appId: string; environment: 'staging' | 'production'; manifestUrl: string; pinnedPublicKey: string; keyId?: string };
export type AssetAccessibility = { readonly defaultLocale: string; readonly descriptions: Readonly<Record<string, string>> };
export type AssetRef = { readonly key: string; readonly width: number; readonly height: number; readonly bundledAccessibility?: AssetAccessibility };
export type StateSetRef = AssetRef & { readonly states: readonly string[]; readonly bundledStateAccessibility?: Readonly<Record<string, AssetAccessibility>> };
export type CachePolicy = 'disk' | 'memory' | 'none';
/** Issued by this client's verified asset page; plain objects are not trusted handles. */
export type DynamicAssetRef = { readonly kind: 'dynamic'; readonly assetId: string; readonly width: number; readonly height: number; readonly sequence: number; readonly name?: string };
export type AssetStatus = { source: 'bundle' | 'cache' | 'remote'; sequence: number | null; message: string; sha256?: string; assetId?: string };
export type AssetMime = 'image/webp' | 'image/png' | 'image/svg+xml';
/** Cache transport MIME types; animation is never an image format candidate. */
export type StorageMime = AssetMime | 'application/json';
export type ResolvedAsset = AssetStatus & { bytes?: Uint8Array; mime?: AssetMime; pixelWidth?: number; pixelHeight?: number; cachePolicy?: CachePolicy; accessibility?: AssetAccessibility };
export type ResolvedStateSet = AssetStatus & { states: Readonly<Record<string, ResolvedAsset>> };
export type AnimationDescriptor = { format: 'lottie'; profile: 'vector-v1'; mime: 'application/json'; sha256: string; url: string; bytes: number; width: number; height: number; frameRate: number; inPoint: number; outPoint: number };
export type ResolvedAnimation = { source: 'poster'; sequence: null; message: string } | {
  source: 'cache' | 'remote'; sequence: number; message: string; sha256: string; assetId: string;
  mime: 'application/json'; bytes: Uint8Array; data: Record<string, unknown>;
  width: number; height: number; frameRate: number; inPoint: number; outPoint: number;
};
export type ResolveOptions = { pixelWidth?: number; pixelHeight?: number; cachePolicy?: CachePolicy; signal?: AbortSignal };
export type AssetPageOptions = { cursor?: string; limit?: number; sequence?: number; signal?: AbortSignal };
export type AssetPage = { items: readonly DynamicAssetRef[]; nextCursor: string | null; sequence: number };
export type ClientStatus = { initialized: boolean; sequence: number; lastError: string | null };
export type RefreshResult = { updated: boolean; sequence: number; error?: string };
export type SignedManifest = { algorithm: 'Ed25519'; keyId: string; publicKey: string; payload: string; signature: string };
export type AssetRendition = { sha256: string; url: string; mime: AssetMime; bytes: number; width: number; height: number };
export type AssetDescriptor = { assetId: string; sha256: string; url: string; mime: 'image/webp'; bytes: number; renditions?: AssetRendition[]; accessibility?: AssetAccessibility };
export type ManifestSlot = AssetDescriptor & { key: string; screen: string; width: number; height: number; animation?: AnimationDescriptor; states?: Record<string, AssetDescriptor>; defaultState?: string };
export type CatalogAsset = AssetDescriptor & { width: number; height: number; name?: string };
export type AssetPagePayload = { kind: 'asset-page'; schemaVersion: 1; renditionSchemaVersion?: 1; orgId: string; appId: string; environment: 'staging' | 'production'; sequence: number; createdAt: string; assets: CatalogAsset[]; cursor: string | null; nextCursor: string | null };
export type ManifestPayload = { schemaVersion: 1; renditionSchemaVersion?: 1; animationSchemaVersion?: 1; stateSchemaVersion?: 1; catalogSchemaVersion?: 1; orgId: string; appId: string; environment: 'staging' | 'production'; sequence: number; createdAt: string; slots: ManifestSlot[]; catalog?: { url: string; count: number } };
export type AssetStorage = {
  loadState(): Promise<string | null>;
  /** Atomically replace durable state; reject a lower highestSequence than already stored. */
  saveState(serialized: string): Promise<void>;
  getAsset(sha256: string): Promise<Uint8Array | null>;
  putAsset(sha256: string, bytes: Uint8Array, mime?: StorageMime): Promise<void>;
};
export type ClientOptions = { storage: AssetStorage; fetch?: typeof globalThis.fetch; allowInsecureLoopback?: boolean; timeoutMs?: number; cachePolicy?: CachePolicy; maxConcurrentDownloads?: number; /** SVG is opt-in and requires a renderer suitable for normalized SVG image data. */ formats?: readonly AssetMime[] };
