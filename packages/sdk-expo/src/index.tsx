import { useEffect, useMemo, useRef, useState } from 'react';
import { PixelRatio, useColorScheme } from 'react-native';
import { Image, type ImageProps } from 'expo-image';
import { createAssetClient, parsePublicConfig, resolveAccessibilityDescription, type AssetAccessibility, type AssetClient, type AssetlibConfig, type AssetRef, type AssetStatus, type CachePolicy, type ClientOptions, type DynamicAssetRef, type ResolvedAsset, type StateSetRef } from '@assetlib/sdk-core';
import { createPlatformStorage, imageUri, platformFetch, vectorRenderingSupported } from './platform';
import type { ImageUri } from './shared';
import { expoTelemetry, flushOnBackground } from './telemetry';
export { resolveAccessibilityDescription } from '@assetlib/sdk-core';
export type { AssetAccessibility, AssetClient, AssetlibConfig, AssetRef, AssetRendering, AssetStatus, CachePolicy, ClientStatus, DynamicAssetRef, RefreshResult, StateSetRef, TelemetryOptions } from '@assetlib/sdk-core';

export function createExpoAssetClient(config: AssetlibConfig, options: { allowInsecureLoopback?: boolean; timeoutMs?: number; decisionTimeoutMs?: number; allowVector?: boolean; cachePolicy?: CachePolicy; decide?: ClientOptions['decide']; telemetry?: ClientOptions['telemetry'] } = {}): AssetClient {
  const validated = parsePublicConfig(config, options);
  if (options.allowVector && !vectorRenderingSupported) throw new Error('SVG delivery is supported only by the browser adapter.');
  const telemetry = expoTelemetry(options.telemetry);
  const client = createAssetClient(validated, { ...options, telemetry, formats: options.allowVector ? ['image/webp', 'image/png', 'image/svg+xml'] : ['image/webp', 'image/png'], storage: createPlatformStorage(validated), fetch: platformFetch });
  if (telemetry?.enabled) flushOnBackground(client);
  return client;
}

type ImageSource = NonNullable<ImageProps['source']>;
type DeliveryImageProps = Omit<ImageProps, 'source' | 'cachePolicy'> & {
  client: AssetClient;
  revision?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  /** Assetlib retention policy. The renderer's independent cache stays disabled. */
  cachePolicy?: CachePolicy;
  /** Follow the system appearance by default; an unknown system appearance means no preference. */
  appearance?: 'light' | 'dark' | 'system';
  /** Opt in per usage. Native accessibilityLabel remains an explicit app override. */
  accessibilityMode?: 'description' | 'decorative';
  accessibilityLocale?: string;
  onStatus?: (status: AssetStatus) => void;
};
/** A tintable icon reference requires the app's tint color for its remote and bundled artwork. */
type TemplateTint<R> = R extends { readonly rendering: 'template' } ? { tintColor: string } : unknown;
export type AssetlibImageProps<R extends AssetRef = AssetRef> = DeliveryImageProps & { asset: R; arm?: string; fallback: ImageSource; fallbackDark?: ImageSource; fallbackAccessibility?: AssetAccessibility } & TemplateTint<R>;
export type AssetlibDynamicImageProps = DeliveryImageProps & { asset: DynamicAssetRef; fallback: ImageSource; fallbackDark?: ImageSource; fallbackAccessibility?: AssetAccessibility };
export type AssetlibStateImageProps<R extends StateSetRef = StateSetRef> = DeliveryImageProps & { asset: R; arm?: string; state: string; fallbacks: Readonly<Record<string, ImageSource>>; fallbacksDark?: Readonly<Record<string, ImageSource>>; fallbackAccessibility?: Readonly<Record<string, AssetAccessibility>> } & TemplateTint<R>;

function useEffectiveAppearance(appearance: 'light' | 'dark' | 'system') {
  const systemAppearance = useColorScheme();
  if (appearance !== 'system') return appearance;
  return systemAppearance === 'light' || systemAppearance === 'dark' ? systemAppearance : undefined;
}

/** Template masks are rasters: without an explicit target, request logical size × display scale. */
function pixelTarget(asset: AssetRef, pixelWidth?: number, pixelHeight?: number): { pixelWidth?: number; pixelHeight?: number } {
  if (asset.rendering !== 'template' || pixelWidth !== undefined || pixelHeight !== undefined) return { pixelWidth, pixelHeight };
  const ratio = PixelRatio.get();
  const scale = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return { pixelWidth: Math.min(8192, Math.ceil(asset.width * scale)), pixelHeight: Math.min(8192, Math.ceil(asset.height * scale)) };
}

const tintWarnings = new Set<string>();
function useTemplateTintWarning(asset: AssetRef, tintColor: unknown) {
  const missing = asset.rendering === 'template' && tintColor == null;
  useEffect(() => {
    if (!missing || typeof __DEV__ === 'undefined' || !__DEV__ || tintWarnings.has(asset.key)) return;
    tintWarnings.add(asset.key);
    console.warn(`Assetlib: ${asset.key} is a tintable icon. Pass tintColor so its remote and bundled artwork are drawn in your app's color.`);
  }, [missing, asset.key]);
}

const bundled = (message: string): AssetStatus => ({ source: 'bundle', sequence: null, message, arm: null, armSource: 'control' });
function assetStatus(result: AssetStatus): AssetStatus {
  return { source: result.source, sequence: result.sequence, message: result.message, arm: result.arm, armSource: result.armSource, ...(result.appearance ? { appearance: result.appearance } : {}), ...(result.sha256 ? { sha256: result.sha256 } : {}), ...(result.assetId ? { assetId: result.assetId } : {}) };
}

function accessibilityProps(props: ImageProps, mode: DeliveryImageProps['accessibilityMode'], metadata?: AssetAccessibility, locale?: string): Partial<ImageProps> {
  if (mode === 'decorative') return { accessible: false, accessibilityLabel: undefined, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', 'aria-hidden': true };
  if (mode !== 'description') return {};
  const label = props.accessibilityLabel ?? resolveAccessibilityDescription(metadata, locale);
  return { accessibilityLabel: label, accessible: props.accessible ?? !!label };
}

/** Expo dispatches native events through current props; remount on source changes. */
function useRendererKey(request: object, source: unknown, state?: string): number {
  const generation = useRef(0);
  return useMemo(() => ++generation.current, [request, source, state]);
}

function matchesLoadedSource(event: Parameters<NonNullable<ImageProps['onLoad']>>[0], uri: string): boolean {
  return event?.source?.url === undefined || event.source.url === uri;
}

/** A request token hides the previous asset immediately when a recycled view changes identity. */
function useResolvedImage(client: AssetClient, asset: AssetRef | DynamicAssetRef, request: object, resolve: (signal: AbortSignal) => Promise<ResolvedAsset>, fallback: ImageSource, fallbackAccessibility: AssetAccessibility | undefined, requireDescription: boolean, onStatus?: (status: AssetStatus) => void) {
  const [resolved, setResolved] = useState<{ request: object; image: ImageUri; result: ResolvedAsset; accessibility?: AssetAccessibility } | null>(null);
  const callbacks = useRef({ resolve, onStatus });
  callbacks.current = { resolve, onStatus };
  const currentUri = useRef<ImageUri | null>(null);
  const currentRequest = useRef(request);
  currentRequest.current = request;
  const displayed = useRef(false);
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
        setResolved({ request, image: localUri, result, accessibility: result.accessibility });
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
  const isCurrent = () => resolved?.request === request && currentRequest.current === request && currentUri.current === resolved.image;
  const selected = resolved?.request === request ? resolved : null;
  const rendererKey = useRendererKey(request, selected?.image ?? fallback);
  return {
    rendererKey,
    source: resolved?.request === request ? { uri: resolved.image.uri } : fallback,
    accessibility: resolved?.request === request ? resolved.accessibility : fallbackAccessibility,
    loaded(event: Parameters<NonNullable<ImageProps['onLoad']>>[0]) {
      if (!isCurrent() || displayed.current || resolved!.result.source === 'bundle' || !matchesLoadedSource(event, resolved!.image.uri)) return;
      displayed.current = true;
      client.reportDisplay(asset, resolved!.result);
    },
    fail() {
      if (!isCurrent()) return;
      client.reportFallback(asset, resolved!.result, 'decode');
      setResolved(null);
      currentUri.current?.release(); currentUri.current = null;
      callbacks.current.onStatus?.(bundled('The image could not be displayed. Using bundled artwork.'));
    },
  };
}

export function AssetlibImage<R extends AssetRef>({ client, asset, arm, fallback, fallbackDark, appearance = 'system', fallbackAccessibility = asset.bundledAccessibility, accessibilityMode, accessibilityLocale, revision = 0, pixelWidth: requestedPixelWidth, pixelHeight: requestedPixelHeight, cachePolicy, onStatus, onError, onLoad, ...rest }: AssetlibImageProps<R>) {
  const props: Omit<ImageProps, 'source' | 'cachePolicy'> = rest;
  const effectiveAppearance = useEffectiveAppearance(appearance);
  const { pixelWidth, pixelHeight } = pixelTarget(asset, requestedPixelWidth, requestedPixelHeight);
  useTemplateTintWarning(asset, props.tintColor);
  const requireDescription = accessibilityMode === 'description' && props.accessibilityLabel == null;
  const request = useMemo(() => ({}), [client, asset.key, asset.width, asset.height, asset.rendering, arm, revision, pixelWidth, pixelHeight, cachePolicy, requireDescription, effectiveAppearance]);
  const image = useResolvedImage(client, asset, request, signal => client.resolve(asset, { pixelWidth, pixelHeight, cachePolicy, appearance: effectiveAppearance, arm, signal }), effectiveAppearance === 'dark' ? fallbackDark ?? fallback : fallback, fallbackAccessibility, requireDescription, onStatus);
  return <Image {...props} key={image.rendererKey} {...accessibilityProps(props, accessibilityMode, image.accessibility, accessibilityLocale)} cachePolicy="none" source={image.source} onLoad={event => { image.loaded(event); onLoad?.(event); }} onError={event => { image.fail(); onError?.(event); }} />;
}

/** Runtime references come from this client's verified collection page, never from an arbitrary URL. */
export function AssetlibDynamicImage({ client, asset, fallback, fallbackDark, appearance = 'system', fallbackAccessibility, accessibilityMode, accessibilityLocale, revision = 0, pixelWidth, pixelHeight, cachePolicy, onStatus, onError, onLoad, ...props }: AssetlibDynamicImageProps) {
  const effectiveAppearance = useEffectiveAppearance(appearance);
  const requireDescription = accessibilityMode === 'description' && props.accessibilityLabel == null;
  const request = useMemo(() => ({}), [client, asset, revision, pixelWidth, pixelHeight, cachePolicy, requireDescription, effectiveAppearance]);
  const image = useResolvedImage(client, asset, request, signal => client.resolveAsset(asset, { pixelWidth, pixelHeight, cachePolicy, appearance: effectiveAppearance, signal }), effectiveAppearance === 'dark' ? fallbackDark ?? fallback : fallback, fallbackAccessibility, requireDescription, onStatus);
  return <Image {...props} key={image.rendererKey} {...accessibilityProps(props, accessibilityMode, image.accessibility, accessibilityLocale)} recyclingKey={props.recyclingKey ?? `${asset.assetId}:${asset.sequence}`} cachePolicy="none" source={image.source} onLoad={event => { image.loaded(event); onLoad?.(event); }} onError={event => { image.fail(); onError?.(event); }} />;
}

/** Resolves a complete visual family once. Changing only `state` selects the pinned result. */
export function AssetlibStateImage<R extends StateSetRef>({ client, asset, arm, state, fallbacks, fallbacksDark, appearance = 'system', fallbackAccessibility = asset.bundledStateAccessibility, accessibilityMode, accessibilityLocale, revision = 0, pixelWidth: requestedPixelWidth, pixelHeight: requestedPixelHeight, cachePolicy, onStatus, onError, onLoad, ...rest }: AssetlibStateImageProps<R>) {
  const props: Omit<ImageProps, 'source' | 'cachePolicy'> = rest;
  const effectiveAppearance = useEffectiveAppearance(appearance);
  const { pixelWidth, pixelHeight } = pixelTarget(asset, requestedPixelWidth, requestedPixelHeight);
  useTemplateTintWarning(asset, props.tintColor);
  const statesKey = JSON.stringify(asset.states);
  const requireDescription = accessibilityMode === 'description' && props.accessibilityLabel == null;
  const request = useMemo(() => ({}), [client, asset.key, asset.width, asset.height, asset.rendering, statesKey, arm, revision, pixelWidth, pixelHeight, cachePolicy, requireDescription, effectiveAppearance]);
  const [resolved, setResolved] = useState<{ request: object; images: Record<string, ImageUri>; results: Readonly<Record<string, ResolvedAsset>>; accessibility: Record<string, AssetAccessibility | undefined> } | null>(null);
  const callbacks = useRef({ onStatus });
  callbacks.current = { onStatus };
  const currentUris = useRef<Record<string, ImageUri> | null>(null);
  const currentSelection = useRef({ request, state });
  currentSelection.current = { request, state };
  const displayed = useRef(false);
  if (!asset.states.includes(state)) throw new Error(`Unknown artwork state: ${state}.`);
  if (asset.states.some(name => !Object.prototype.hasOwnProperty.call(fallbacks, name) || fallbacks[name] == null)) throw new Error('Every artwork state requires its own bundled fallback.');
  if (fallbacksDark && asset.states.some(name => !Object.prototype.hasOwnProperty.call(fallbacksDark, name) || fallbacksDark[name] == null)) throw new Error('Every artwork state requires its own dark bundled fallback when fallbacksDark is supplied.');
  useEffect(() => {
    const controller = new AbortController();
    const images: Record<string, ImageUri> = Object.create(null);
    const accessibility: Record<string, AssetAccessibility | undefined> = Object.create(null);
    const release = () => { for (const image of Object.values(images)) image.release(); };
    setResolved(null);
    callbacks.current.onStatus?.(bundled('Bundled states are ready while the complete artwork set resolves.'));
    client.resolveStateSet(asset, { pixelWidth, pixelHeight, cachePolicy, appearance: effectiveAppearance, arm, signal: controller.signal }).then(async result => {
      if (controller.signal.aborted) return;
      if (result.source === 'bundle') {
        callbacks.current.onStatus?.(assetStatus(result));
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
      setResolved({ request, images, results: result.states, accessibility });
      callbacks.current.onStatus?.(assetStatus(result));
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
  const fallback = (effectiveAppearance === 'dark' ? fallbacksDark ?? fallbacks : fallbacks)[state];
  const rendererKey = useRendererKey(request, selected ?? fallback, state);
  const isCurrent = () => selected && currentSelection.current.request === request && currentSelection.current.state === state && currentUris.current === resolved?.images;
  return <Image {...props} key={rendererKey} {...accessibilityProps(props, accessibilityMode, metadata, accessibilityLocale)} cachePolicy="none" source={selected ? { uri: selected.uri } : fallback} onLoad={event => {
    if (isCurrent() && !displayed.current && resolved!.results[state].source !== 'bundle' && matchesLoadedSource(event, selected!.uri)) {
      displayed.current = true;
      client.reportDisplay(asset, resolved!.results[state]);
    }
    onLoad?.(event);
  }} onError={event => {
    if (isCurrent()) {
      client.reportFallback(asset, resolved!.results[state], 'decode');
      // A decode failure returns the entire family to bundled artwork for this session.
      setResolved(null);
      if (currentUris.current) for (const image of Object.values(currentUris.current)) image.release();
      currentUris.current = null;
      callbacks.current.onStatus?.(bundled('A state image could not be displayed. Using the complete bundled state set.'));
    }
    onError?.(event);
  }} />;
}
