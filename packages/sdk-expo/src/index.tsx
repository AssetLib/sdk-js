import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, type ImageProps } from 'expo-image';
import { createAssetClient, parsePublicConfig, resolveAccessibilityDescription, type AssetAccessibility, type AssetClient, type AssetlibConfig, type AssetRef, type AssetStatus } from '@assetlib/sdk-core';
import { createPlatformStorage, imageUri, platformFetch, vectorRenderingSupported } from './platform';
import type { ImageUri } from './shared';
export { resolveAccessibilityDescription } from '@assetlib/sdk-core';
export type { AssetAccessibility, AssetClient, AssetlibConfig, AssetRef, AssetStatus, ClientStatus, RefreshResult } from '@assetlib/sdk-core';

export function createExpoAssetClient(config: AssetlibConfig, options: { allowInsecureLoopback?: boolean; timeoutMs?: number; allowVector?: boolean } = {}): AssetClient {
  const validated = parsePublicConfig(config, options);
  if (options.allowVector && !vectorRenderingSupported) throw new Error('SVG delivery is supported only by the browser adapter.');
  return createAssetClient(validated, { ...options, formats: options.allowVector ? ['image/webp', 'image/png', 'image/svg+xml'] : ['image/webp', 'image/png'], storage: createPlatformStorage(validated), fetch: platformFetch });
}

export type AssetlibImageProps = Omit<ImageProps, 'source'> & {
  client: AssetClient;
  asset: AssetRef;
  fallback: NonNullable<ImageProps['source']>;
  fallbackAccessibility?: AssetAccessibility;
  /** Opt in per usage. Native accessibilityLabel remains an explicit app override. */
  accessibilityMode?: 'description' | 'decorative';
  accessibilityLocale?: string;
  revision?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  onStatus?: (status: AssetStatus) => void;
};

function accessibilityProps(props: ImageProps, mode: AssetlibImageProps['accessibilityMode'], metadata?: AssetAccessibility, locale?: string): Partial<ImageProps> {
  if (mode === 'decorative') return { accessible: false, accessibilityLabel: undefined, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', 'aria-hidden': true };
  if (mode !== 'description') return {};
  const label = props.accessibilityLabel ?? resolveAccessibilityDescription(metadata, locale);
  return { accessibilityLabel: label, accessible: props.accessible ?? !!label };
}

export function AssetlibImage({ client, asset, fallback, fallbackAccessibility = asset.bundledAccessibility, accessibilityMode, accessibilityLocale, revision = 0, pixelWidth, pixelHeight, onStatus, onError, ...props }: AssetlibImageProps) {
  const requireDescription = accessibilityMode === 'description' && props.accessibilityLabel == null;
  const request = useMemo(() => ({}), [client, asset.key, asset.width, asset.height, fallback, revision, pixelWidth, pixelHeight, requireDescription]);
  const [resolved, setResolved] = useState<{ request: object; image: ImageUri; accessibility?: AssetAccessibility } | null>(null);
  const currentRequest = useRef(request);
  currentRequest.current = request;
  const callbacks = useRef({ onStatus, onError });
  callbacks.current = { onStatus, onError };
  const currentUri = useRef<ImageUri | null>(null);
  useEffect(() => {
    let active = true;
    let localUri: ImageUri | null = null;
    // The request token keeps the rendered image and its description paired immediately.
    setResolved(null);
    callbacks.current.onStatus?.({ source: 'bundle', sequence: null, message: 'Bundled artwork is ready while the placement resolves.' });
    client.resolve(asset, pixelWidth === undefined && pixelHeight === undefined ? {} : { pixelWidth, pixelHeight }).then(async result => {
      if (!active || currentRequest.current !== request) return;
      if (result.bytes) {
        if (requireDescription && !result.accessibility) {
          callbacks.current.onStatus?.({ source: 'bundle', sequence: null, message: 'Using bundled artwork because the verified image has no accessibility description.' });
          return;
        }
        localUri = await imageUri(client.config, result);
        if (!active || currentRequest.current !== request) { localUri.release(); return; }
        currentUri.current = localUri;
        setResolved({ request, image: localUri, accessibility: result.accessibility });
      }
      const { bytes: _bytes, mime: _mime, accessibility: _accessibility, ...status } = result;
      callbacks.current.onStatus?.(status);
    }).catch(() => {
      if (!active || currentRequest.current !== request) return;
      setResolved(null);
      callbacks.current.onStatus?.({ source: 'bundle', sequence: null, message: 'Using bundled artwork because the verified image could not be loaded.' });
    });
    return () => { active = false; localUri?.release(); if (currentUri.current === localUri) currentUri.current = null; };
  }, [client, request]);

  const selected = resolved?.request === request ? resolved : null;
  const metadata = selected ? selected.accessibility : fallbackAccessibility;
  return <Image {...props} {...accessibilityProps(props, accessibilityMode, metadata, accessibilityLocale)} cachePolicy="none" source={selected ? { uri: selected.image.uri } : fallback} onError={event => {
    if (currentRequest.current !== request) return;
    setResolved(null);
    currentUri.current?.release(); currentUri.current = null;
    callbacks.current.onStatus?.({ source: 'bundle', sequence: null, message: 'The image could not be displayed. Using bundled artwork.' });
    callbacks.current.onError?.(event);
  }} />;
}
