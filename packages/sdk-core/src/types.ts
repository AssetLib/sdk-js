export type AssetlibConfig = { schemaVersion: 1; orgId: string; appId: string; environment: 'production'; manifestUrl: string; pinnedPublicKey: string; keyId?: string };
export type AssetRef = { readonly key: string; readonly width: number; readonly height: number };
export type AssetStatus = { source: 'bundle' | 'cache' | 'remote'; sequence: number | null; message: string; sha256?: string; assetId?: string };
export type ResolvedAsset = AssetStatus & { bytes?: Uint8Array; mime?: 'image/webp' };
export type ClientStatus = { initialized: boolean; sequence: number; lastError: string | null };
export type RefreshResult = { updated: boolean; sequence: number; error?: string };
export type SignedManifest = { algorithm: 'Ed25519'; keyId: string; publicKey: string; payload: string; signature: string };
export type ManifestSlot = { key: string; screen: string; width: number; height: number; assetId: string; sha256: string; url: string; mime: 'image/webp'; bytes: number };
export type ManifestPayload = { schemaVersion: 1; orgId: string; appId: string; environment: 'production'; sequence: number; createdAt: string; slots: ManifestSlot[] };
export type AssetStorage = {
  loadState(): Promise<string | null>;
  /** Atomically replace durable state; reject a lower highestSequence than already stored. */
  saveState(serialized: string): Promise<void>;
  getAsset(sha256: string): Promise<Uint8Array | null>;
  putAsset(sha256: string, bytes: Uint8Array): Promise<void>;
};
export type ClientOptions = { storage: AssetStorage; fetch?: typeof globalThis.fetch; allowInsecureLoopback?: boolean; timeoutMs?: number };
