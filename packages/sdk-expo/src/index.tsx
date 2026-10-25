import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PixelRatio, useColorScheme } from 'react-native';
import { Image, type ImageProps } from 'expo-image';
import { createAssetClient, parsePublicConfig, resolveAccessibilityDescription, type AssetAccessibility, type AssetClient, type AssetlibConfig, type AssetRef, type AssetStatus, type CachePolicy, type ClientOptions, type DynamicAssetRef, type ResolvedAsset, type StateSetRef } from '@assetlib/sdk-core';
import { createPlatformStorage, imageUri, platformFetch, vectorRenderingSupported } from './platform';
import type { ImageUri } from './shared';
import { expoTelemetry, flushOnBackground } from './telemetry';
export { resolveAccessibilityDescription } from '@assetlib/sdk-core';
export type { AssetAccessibility, AssetClient, AssetlibConfig, AssetRef, AssetRendering, AssetStatus, CachePolicy, ClientStatus, DynamicAssetRef, RefreshResult, ResolvedVideo, StateSetRef, TelemetryOptions } from '@assetlib/sdk-core';

export function createExpoAssetClient(config: AssetlibConfig, options: { allowInsecureLoopback?: boolean; timeoutMs?: number; videoTimeoutMs?: number; decisionTimeoutMs?: number; allowVector?: boolean; cachePolicy?: CachePolicy; decide?: ClientOptions['decide']; telemetry?: ClientOptions['telemetry'] } = {}): AssetClient {
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

// The console's rendition tiers (long edge in pixels): artwork, then tintable icon masks.
const ARTWORK_TIERS = [512, 1024, 2048];
const ICON_TIERS = [24, 48, 72, 96, 192, 512];
/** The largest tier measured per placement in this client's session; it seeds new mounts. */
const sessionTiers = new WeakMap<AssetClient, Map<string, number>>();
type MeasuredTier = { client: AssetClient; id: string; tier: number; measured: boolean; laidOut: boolean };

const tiersFor = (asset: AssetRef) => asset.rendering === 'template' ? ICON_TIERS : ARTWORK_TIERS;
function tierFor(asset: AssetRef, longEdge: number): number {
  const tiers = tiersFor(asset);
  // Half a pixel absorbs float layout values, such as 341.333 points at 3x.
  const index = tiers.findIndex(tier => tier + 0.5 >= longEdge);
  return index < 0 ? tiers.length - 1 : index;
}
function displayScale(): number {
  const ratio = PixelRatio.get();
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/**
 * 98% of the tier: core picks the tier's rendition when an integer aspect ratio leaves it a few
 * pixels short, and the next larger one when an unusual ratio leaves it further short.
 */
function tierTarget(asset: AssetRef, tier: number): { pixelWidth: number; pixelHeight: number } {
  const longEdge = Math.floor(tiersFor(asset)[tier] * 0.98);
  const long = Math.max(asset.width, asset.height);
  return { pixelWidth: Math.max(1, Math.ceil(longEdge * asset.width / long)), pixelHeight: Math.max(1, Math.ceil(longEdge * asset.height / long)) };
}

/** The tier a view needs: its layout × display scale, enough to cover the box (or fit it for contain). */
function measuredTier(asset: AssetRef, layout: { width: number; height: number }, ratio: number, contentFit?: ImageProps['contentFit']): number | undefined {
  if (!(layout.width > 0 && layout.height > 0 && Number.isFinite(layout.width) && Number.isFinite(layout.height))) return undefined;
  const fit = contentFit === 'contain' || contentFit === 'scale-down' ? Math.min : Math.max;
  return tierFor(asset, fit(layout.width / asset.width, layout.height / asset.height) * Math.max(asset.width, asset.height) * ratio);
}

/**
 * Without an explicit target, request the measured view × PixelRatio snapped to a tier. A mount starts
 * from the session's tier for this placement; without one it is pending until its first layout, so it
 * resolves once. A first layout without a size uses the reference size × PixelRatio until a sized layout
 * replaces it. Once measured, only this view's own layout changes its tier, and only upward.
 */
function usePixelTarget(client: AssetClient, asset: AssetRef, pixelWidth: number | undefined, pixelHeight: number | undefined, contentFit: ImageProps['contentFit'], onLayout: ImageProps['onLayout']) {
  const explicit = pixelWidth !== undefined || pixelHeight !== undefined;
  const id = `${asset.key}:${asset.width}x${asset.height}:${asset.rendering ?? 'original'}`;
  const tiers = sessionTiers.get(client) ?? new Map<string, number>();
  sessionTiers.set(client, tiers);
  const seed = (): MeasuredTier => {
    const known = tiers.get(id);
    return { client, id, measured: known !== undefined, laidOut: false, tier: known ?? tierFor(asset, Math.max(asset.width, asset.height) * displayScale()) };
  };
  const [stored, setStored] = useState(seed);
  let current = stored;
  if (stored.client !== client || stored.id !== id) setStored(current = seed());
  return {
    ...(explicit ? { pixelWidth, pixelHeight } : tierTarget(asset, current.tier)),
    pending: !explicit && !current.measured && !current.laidOut,
    onLayout(event: Parameters<NonNullable<ImageProps['onLayout']>>[0]) {
      const measured = explicit ? undefined : measuredTier(asset, event.nativeEvent.layout, displayScale(), contentFit);
      if (measured !== undefined) tiers.set(id, Math.max(tiers.get(id) ?? measured, measured));
      if (!explicit) {
        setStored(previous => {
          const base = previous.client === client && previous.id === id ? previous : current;
          if (measured === undefined) return base.measured || base.laidOut ? base : { ...base, laidOut: true };
          const tier = base.measured ? Math.max(base.tier, measured) : measured;
          return base.measured && tier === base.tier ? base : { client, id, measured: true, laidOut: true, tier };
        });
      }
      onLayout?.(event);
    },
  };
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

/** expo-image reports `source.url`; React Native's Image reports `nativeEvent.source.uri`. An event naming another source is stale. */
function matchesLoadedSource(event: Parameters<NonNullable<ImageProps['onLoad']>>[0] | undefined, uri: string): boolean {
  const loaded = event?.source?.url ?? (event as { nativeEvent?: { source?: { uri?: string } } } | undefined)?.nativeEvent?.source?.uri;
  return loaded === undefined || loaded === uri;
}

/** A request token hides the previous asset immediately when a recycled view changes identity. */
function useResolvedImage(client: AssetClient, asset: AssetRef | DynamicAssetRef, request: object, resolve: (signal: AbortSignal) => Promise<ResolvedAsset>, fallback: ImageSource, fallbackAccessibility: AssetAccessibility | undefined, requireDescription: boolean, onStatus?: (status: AssetStatus) => void, pending = false) {
  const [resolved, setResolved] = useState<{ request: object; image: ImageUri; result: ResolvedAsset; accessibility?: AssetAccessibility } | null>(null);
  const callbacks = useRef({ resolve, onStatus });
  callbacks.current = { resolve, onStatus };
  const currentUri = useRef<ImageUri | null>(null);
  const currentRequest = useRef(request);
  currentRequest.current = request;
  const displayed = useRef(false);
  useEffect(() => {
    if (pending) { setResolved(null); return; }
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
  }, [client, request, pending]);
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
  const { pixelWidth, pixelHeight, pending, onLayout } = usePixelTarget(client, asset, requestedPixelWidth, requestedPixelHeight, props.contentFit, props.onLayout);
  useTemplateTintWarning(asset, props.tintColor);
  const requireDescription = accessibilityMode === 'description' && props.accessibilityLabel == null;
  const request = useMemo(() => ({}), [client, asset.key, asset.width, asset.height, asset.rendering, arm, revision, pixelWidth, pixelHeight, cachePolicy, requireDescription, effectiveAppearance]);
  const image = useResolvedImage(client, asset, request, signal => client.resolve(asset, { pixelWidth, pixelHeight, cachePolicy, appearance: effectiveAppearance, arm, signal }), effectiveAppearance === 'dark' ? fallbackDark ?? fallback : fallback, fallbackAccessibility, requireDescription, onStatus, pending);
  return <Image {...props} key={image.rendererKey} {...accessibilityProps(props, accessibilityMode, image.accessibility, accessibilityLocale)} cachePolicy="none" source={image.source} onLayout={onLayout} onLoad={event => { image.loaded(event); onLoad?.(event); }} onError={event => { image.fail(); onError?.(event); }} />;
}

/** What `AssetlibPlacement` hands to its child: the placement's current source and the image callbacks that keep it current. */
export type AssetlibPlacementImage<F extends ImageSource = ImageSource> = {
  /** The verified image once it is ready; before that, and after any failure, the bundled fallback as you passed it. */
  source: F | { uri: string };
  /** Pass to the image your component renders so its display is reported once. */
  onLoad: (event?: unknown) => void;
  /** Pass to the image your component renders so a decode failure returns to the bundled fallback. */
  onError: (event?: unknown) => void;
  /** Pass to the image your component renders so its layout picks the rendition tier; until then the reference size × PixelRatio is requested. */
  onLayout: NonNullable<ImageProps['onLayout']>;
  /** Spread onto the image: with `accessibilityMode="description"` the delivered or bundled description, with `"decorative"` the props that hide it. */
  accessibility: Partial<Pick<ImageProps, 'accessible' | 'accessibilityLabel' | 'accessibilityElementsHidden' | 'importantForAccessibility' | 'aria-hidden'>>;
  /** The placement's `tintColor`, for a tintable icon. */
  tintColor?: string;
};
export type AssetlibPlacementProps<R extends AssetRef = AssetRef, F extends ImageSource = ImageSource> = {
  client: AssetClient; asset: R; arm?: string; fallback: F; fallbackDark?: F; fallbackAccessibility?: AssetAccessibility;
  revision?: number; pixelWidth?: number; pixelHeight?: number; cachePolicy?: CachePolicy; appearance?: 'light' | 'dark' | 'system';
  accessibilityMode?: 'description' | 'decorative'; accessibilityLocale?: string; accessibilityLabel?: string;
  /** How your component fits the image, so a forwarded `onLayout` picks the tier the same way `AssetlibImage` does. */
  contentFit?: ImageProps['contentFit']; tintColor?: string; onStatus?: (status: AssetStatus) => void;
  children: (image: AssetlibPlacementImage<F>) => ReactNode;
} & TemplateTint<R>;

/**
 * A placement rendered by your own image component: the child function receives the current source and callbacks
 * instead of an `Image`. The subtree is not remounted when the source changes (the component may hold a form or a
 * list), so a load event is attributed by the source it names instead.
 */
export function AssetlibPlacement<R extends AssetRef, F extends ImageSource>({ client, asset, arm, fallback, fallbackDark, appearance = 'system', fallbackAccessibility = asset.bundledAccessibility, accessibilityMode, accessibilityLocale, accessibilityLabel, revision = 0, pixelWidth: requestedPixelWidth, pixelHeight: requestedPixelHeight, cachePolicy, contentFit, tintColor, onStatus, children }: AssetlibPlacementProps<R, F>) {
  const effectiveAppearance = useEffectiveAppearance(appearance);
  // The child's layout is seen only when it forwards onLayout, so the request never waits for one.
  const { pixelWidth, pixelHeight, onLayout } = usePixelTarget(client, asset, requestedPixelWidth, requestedPixelHeight, contentFit, undefined);
  useTemplateTintWarning(asset, tintColor);
  const requireDescription = accessibilityMode === 'description' && accessibilityLabel == null;
  const request = useMemo(() => ({}), [client, asset.key, asset.width, asset.height, asset.rendering, arm, revision, pixelWidth, pixelHeight, cachePolicy, requireDescription, effectiveAppearance]);
  const image = useResolvedImage(client, asset, request, signal => client.resolve(asset, { pixelWidth, pixelHeight, cachePolicy, appearance: effectiveAppearance, arm, signal }), effectiveAppearance === 'dark' ? fallbackDark ?? fallback : fallback, fallbackAccessibility, requireDescription, onStatus);
  const accessibility = accessibilityProps({ accessibilityLabel } as ImageProps, accessibilityMode, image.accessibility, accessibilityLocale);
  return <>{children({ source: image.source as F | { uri: string }, onLoad: event => image.loaded(event as Parameters<NonNullable<ImageProps['onLoad']>>[0]), onError: () => image.fail(), onLayout, accessibility, tintColor })}</>;
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
  const { pixelWidth, pixelHeight, pending, onLayout } = usePixelTarget(client, asset, requestedPixelWidth, requestedPixelHeight, props.contentFit, props.onLayout);
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
    if (pending) { setResolved(null); return; }
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
  }, [client, request, pending]);
  const selected = resolved?.request === request ? resolved.images[state] : null;
  const metadata = selected ? resolved!.accessibility[state] : fallbackAccessibility?.[state];
  const fallback = (effectiveAppearance === 'dark' ? fallbacksDark ?? fallbacks : fallbacks)[state];
  const rendererKey = useRendererKey(request, selected ?? fallback, state);
  const isCurrent = () => selected && currentSelection.current.request === request && currentSelection.current.state === state && currentUris.current === resolved?.images;
  return <Image {...props} key={rendererKey} {...accessibilityProps(props, accessibilityMode, metadata, accessibilityLocale)} cachePolicy="none" source={selected ? { uri: selected.uri } : fallback} onLayout={onLayout} onLoad={event => {
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
