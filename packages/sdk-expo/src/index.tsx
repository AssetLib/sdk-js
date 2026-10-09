import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, type ImageProps } from 'expo-image';
import { createAssetClient, parsePublicConfig, resolveAccessibilityDescription, type AssetAccessibility, type AssetClient, type AssetlibConfig, type AssetRef, type AssetStatus, type CachePolicy, type DynamicAssetRef, type ResolvedAsset, type StateSetRef } from '@assetlib/sdk-core';
import { createPlatformStorage, imageUri, platformFetch, vectorRenderingSupported } from './platform';
import type { ImageUri } from './shared';
export { resolveAccessibilityDescription } from '@assetlib/sdk-core';
export type { AssetAccessibility, AssetClient, AssetlibConfig, AssetRef, AssetStatus, CachePolicy, ClientStatus, DynamicAssetRef, RefreshResult, StateSetRef } from '@assetlib/sdk-core';

export function createExpoAssetClient(config: AssetlibConfig, options: { allowInsecureLoopback?: boolean; timeoutMs?: number; allowVector?: boolean; cachePolicy?: CachePolicy } = {}): AssetClient {
  const validated = parsePublicConfig(config, options);
  if (options.allowVector && !vectorRenderingSupported) throw new Error('SVG delivery is supported only by the browser adapter.');
  return createAssetClient(validated, { ...options, formats: options.allowVector ? ['image/webp', 'image/png', 'image/svg+xml'] : ['image/webp', 'image/png'], storage: createPlatformStorage(validated), fetch: platformFetch });
}

type ImageSource = NonNullable<ImageProps['source']>;
type DeliveryImageProps = Omit<ImageProps, 'source' | 'cachePolicy'> & {
  client: AssetClient;
  revision?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  /** Assetlib retention policy. The renderer's independent cache stays disabled. */
  cachePolicy?: CachePolicy;
  /** Opt in per usage. Native accessibilityLabel remains an explicit app override. */
  accessibilityMode?: 'description' | 'decorative';
  accessibilityLocale?: string;
  onStatus?: (status: AssetStatus) => void;
};
export type AssetlibImageProps = DeliveryImageProps & { asset: AssetRef; fallback: ImageSource; fallbackAccessibility?: AssetAccessibility };
export type AssetlibDynamicImageProps = DeliveryImageProps & { asset: DynamicAssetRef; fallback: ImageSource; fallbackAccessibility?: AssetAccessibility };
export type AssetlibStateImageProps = DeliveryImageProps & { asset: StateSetRef; state: string; fallbacks: Readonly<Record<string, ImageSource>>; fallbackAccessibility?: Readonly<Record<string, AssetAccessibility>> };

const bundled = (message: string): AssetStatus => ({ source: 'bundle', sequence: null, message });
function assetStatus(result: ResolvedAsset): AssetStatus {
  return { source: result.source, sequence: result.sequence, message: result.message, ...(result.sha256 ? { sha256: result.sha256 } : {}), ...(result.assetId ? { assetId: result.assetId } : {}) };
}

function accessibilityProps(props: ImageProps, mode: DeliveryImageProps['accessibilityMode'], metadata?: AssetAccessibility, locale?: string): Partial<ImageProps> {
  if (mode === 'decorative') return { accessible: false, accessibilityLabel: undefined, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', 'aria-hidden': true };
  if (mode !== 'description') return {};
  const label = props.accessibilityLabel ?? resolveAccessibilityDescription(metadata, locale);
  return { accessibilityLabel: label, accessible: props.accessible ?? !!label };
}

/** A request token hides the previous asset immediately when a recycled view changes identity. */
function useResolvedImage(client: AssetClient, request: object, resolve: (signal: AbortSignal) => Promise<ResolvedAsset>, fallback: ImageSource, fallbackAccessibility: AssetAccessibility | undefined, requireDescription: boolean, onStatus?: (status: AssetStatus) => void) {
  const [resolved, setResolved] = useState<{ request: object; image: ImageUri; accessibility?: AssetAccessibility } | null>(null);
  const callbacks = useRef({ resolve, onStatus });
  callbacks.current = { resolve, onStatus };
  const currentUri = useRef<ImageUri | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let localUri: ImageUri | null = null;
    setResolved(null);
    callbacks.current.onStatus?.(bundled('Bundled artwork is ready while the image resolves.'));
    callbacks.current.resolve(controller.signal).then(async result => {
      if (controller.signal.aborted) return;
      if (result.bytes) {
        if (requireDescription && !result.accessibility) {
          callbacks.current.onStatus?.(bundled('Using bundled artwork because the verified image has no accessibility description.'));
          return;
        }
        localUri = await imageUri(client.config, result);
        if (controller.signal.aborted) { localUri.release(); return; }
        currentUri.current = localUri;
        setResolved({ request, image: localUri, accessibility: result.accessibility });
      }
      callbacks.current.onStatus?.(assetStatus(result));
    }).catch(() => {
      if (controller.signal.aborted) return;
      setResolved(null);
      callbacks.current.onStatus?.(bundled('Using bundled artwork because the verified image could not be loaded.'));
    });
    return () => {
      controller.abort();
      localUri?.release();
      if (currentUri.current === localUri) currentUri.current = null;
    };
  }, [client, request]);
  return {
    source: resolved?.request === request ? { uri: resolved.image.uri } : fallback,
    accessibility: resolved?.request === request ? resolved.accessibility : fallbackAccessibility,
    fail() {
      setResolved(null);
      currentUri.current?.release(); currentUri.current = null;
      callbacks.current.onStatus?.(bundled('The image could not be displayed. Using bundled artwork.'));
    },
  };
}

export function AssetlibImage({ client, asset, fallback, fallbackAccessibility = asset.bundledAccessibility, accessibilityMode, accessibilityLocale, revision = 0, pixelWidth, pixelHeight, cachePolicy, onStatus, onError, ...props }: AssetlibImageProps) {
  const requireDescription = accessibilityMode === 'description' && props.accessibilityLabel == null;
  const request = useMemo(() => ({}), [client, asset.key, asset.width, asset.height, revision, pixelWidth, pixelHeight, cachePolicy, requireDescription]);
  const image = useResolvedImage(client, request, signal => client.resolve(asset, { pixelWidth, pixelHeight, cachePolicy, signal }), fallback, fallbackAccessibility, requireDescription, onStatus);
  return <Image {...props} {...accessibilityProps(props, accessibilityMode, image.accessibility, accessibilityLocale)} cachePolicy="none" source={image.source} onError={event => { image.fail(); onError?.(event); }} />;
}

/** Runtime references come from this client's verified collection page, never from an arbitrary URL. */
export function AssetlibDynamicImage({ client, asset, fallback, fallbackAccessibility, accessibilityMode, accessibilityLocale, revision = 0, pixelWidth, pixelHeight, cachePolicy, onStatus, onError, ...props }: AssetlibDynamicImageProps) {
  const requireDescription = accessibilityMode === 'description' && props.accessibilityLabel == null;
  const request = useMemo(() => ({}), [client, asset, revision, pixelWidth, pixelHeight, cachePolicy, requireDescription]);
  const image = useResolvedImage(client, request, signal => client.resolveAsset(asset, { pixelWidth, pixelHeight, cachePolicy, signal }), fallback, fallbackAccessibility, requireDescription, onStatus);
  return <Image {...props} {...accessibilityProps(props, accessibilityMode, image.accessibility, accessibilityLocale)} recyclingKey={props.recyclingKey ?? `${asset.assetId}:${asset.sequence}`} cachePolicy="none" source={image.source} onError={event => { image.fail(); onError?.(event); }} />;
}

/** Resolves a complete visual family once. Changing only `state` selects the pinned result. */
export function AssetlibStateImage({ client, asset, state, fallbacks, fallbackAccessibility = asset.bundledStateAccessibility, accessibilityMode, accessibilityLocale, revision = 0, pixelWidth, pixelHeight, cachePolicy, onStatus, onError, ...props }: AssetlibStateImageProps) {
  const statesKey = JSON.stringify(asset.states);
  const requireDescription = accessibilityMode === 'description' && props.accessibilityLabel == null;
  const request = useMemo(() => ({}), [client, asset.key, asset.width, asset.height, statesKey, revision, pixelWidth, pixelHeight, cachePolicy, requireDescription]);
  const [resolved, setResolved] = useState<{ request: object; images: Record<string, ImageUri>; accessibility: Record<string, AssetAccessibility | undefined> } | null>(null);
  const callbacks = useRef({ onStatus });
  callbacks.current = { onStatus };
  const currentUris = useRef<Record<string, ImageUri> | null>(null);
  if (!asset.states.includes(state)) throw new Error(`Unknown artwork state: ${state}.`);
  if (asset.states.some(name => !Object.prototype.hasOwnProperty.call(fallbacks, name) || fallbacks[name] == null)) throw new Error('Every artwork state requires its own bundled fallback.');
  useEffect(() => {
    const controller = new AbortController();
    const images: Record<string, ImageUri> = Object.create(null);
    const accessibility: Record<string, AssetAccessibility | undefined> = Object.create(null);
    const release = () => { for (const image of Object.values(images)) image.release(); };
    setResolved(null);
    callbacks.current.onStatus?.(bundled('Bundled states are ready while the complete artwork set resolves.'));
    client.resolveStateSet(asset, { pixelWidth, pixelHeight, cachePolicy, signal: controller.signal }).then(async result => {
      if (controller.signal.aborted) return;
      if (result.source === 'bundle') {
        callbacks.current.onStatus?.(bundled(result.message));
        return;
      }
      if (requireDescription && asset.states.some(name => !result.states[name]?.accessibility)) {
        callbacks.current.onStatus?.(bundled('Using bundled states because a verified state has no accessibility description.'));
        return;
      }
      // Commit only after every state can be handed to the renderer.
      for (const name of asset.states) {
        if (!result.states[name]?.bytes) throw new Error('The verified state set is incomplete.');
        images[name] = await imageUri(client.config, result.states[name]);
        accessibility[name] = result.states[name].accessibility;
        if (controller.signal.aborted) { release(); return; }
      }
      currentUris.current = images;
      setResolved({ request, images, accessibility });
      callbacks.current.onStatus?.({ source: result.source, sequence: result.sequence, message: result.message });
    }).catch(() => {
      release();
      if (controller.signal.aborted) return;
      setResolved(null);
      callbacks.current.onStatus?.(bundled('Using the complete bundled state set because verified artwork could not be loaded.'));
    });
    return () => {
      controller.abort(); release();
      if (currentUris.current === images) currentUris.current = null;
    };
  }, [client, request]);
  const selected = resolved?.request === request ? resolved.images[state] : null;
  const metadata = selected ? resolved!.accessibility[state] : fallbackAccessibility?.[state];
  return <Image {...props} {...accessibilityProps(props, accessibilityMode, metadata, accessibilityLocale)} cachePolicy="none" source={selected ? { uri: selected.uri } : fallbacks[state]} onError={event => {
    // A decode failure returns the entire family to bundled artwork for this session.
    setResolved(null);
    if (currentUris.current) for (const image of Object.values(currentUris.current)) image.release();
    currentUris.current = null;
    callbacks.current.onStatus?.(bundled('A state image could not be displayed. Using the complete bundled state set.'));
    onError?.(event);
  }} />;
}
