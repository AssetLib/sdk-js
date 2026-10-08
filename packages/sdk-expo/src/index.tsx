import { useEffect, useRef, useState } from 'react';
import { Image, type ImageProps } from 'expo-image';
import { createAssetClient, parsePublicConfig, type AssetClient, type AssetlibConfig, type AssetRef, type AssetStatus } from '@assetlib/sdk-core';
import { createPlatformStorage, imageUri, platformFetch, vectorRenderingSupported } from './platform';
import type { ImageUri } from './shared';
export type { AssetClient, AssetlibConfig, AssetRef, AssetStatus, ClientStatus, RefreshResult } from '@assetlib/sdk-core';

export function createExpoAssetClient(config: AssetlibConfig, options: { allowInsecureLoopback?: boolean; timeoutMs?: number; allowVector?: boolean } = {}): AssetClient {
  const validated = parsePublicConfig(config, options);
  if (options.allowVector && !vectorRenderingSupported) throw new Error('SVG delivery is supported only by the browser adapter.');
  return createAssetClient(validated, { ...options, formats: options.allowVector ? ['image/webp', 'image/png', 'image/svg+xml'] : ['image/webp', 'image/png'], storage: createPlatformStorage(validated), fetch: platformFetch });
}

export type AssetlibImageProps = Omit<ImageProps, 'source'> & { client: AssetClient; asset: AssetRef; fallback: NonNullable<ImageProps['source']>; revision?: number; pixelWidth?: number; pixelHeight?: number; onStatus?: (status: AssetStatus) => void };

export function AssetlibImage({ client, asset, fallback, revision = 0, pixelWidth, pixelHeight, onStatus, onError, ...props }: AssetlibImageProps) {
  const [source, setSource] = useState<NonNullable<ImageProps['source']>>(fallback);
  const callbacks = useRef({ onStatus, onError });
  callbacks.current = { onStatus, onError };
  const currentUri = useRef<ImageUri | null>(null);
  useEffect(() => {
    let active = true;
    let localUri: ImageUri | null = null;
    // Each resolution starts with a guaranteed bundled source, including client switches.
    setSource(fallback);
    callbacks.current.onStatus?.({ source: 'bundle', sequence: null, message: 'Bundled artwork is ready while the placement resolves.' });
    client.resolve(asset, pixelWidth === undefined && pixelHeight === undefined ? {} : { pixelWidth, pixelHeight }).then(async result => {
      if (!active) return;
      if (result.bytes) {
        localUri = await imageUri(client.config, result);
        if (!active) { localUri.release(); return; }
        currentUri.current = localUri;
        setSource({ uri: localUri.uri });
      }
      const { bytes: _bytes, mime: _mime, ...status } = result;
      callbacks.current.onStatus?.(status);
    }).catch(() => {
      if (!active) return;
      setSource(fallback);
      callbacks.current.onStatus?.({ source: 'bundle', sequence: null, message: 'Using bundled artwork because the verified image could not be loaded.' });
    });
    return () => { active = false; localUri?.release(); if (currentUri.current === localUri) currentUri.current = null; };
  }, [client, asset.key, asset.width, asset.height, fallback, revision, pixelWidth, pixelHeight]);

  return <Image {...props} cachePolicy="none" source={source} onError={event => {
    setSource(fallback);
    currentUri.current?.release(); currentUri.current = null;
    callbacks.current.onStatus?.({ source: 'bundle', sequence: null, message: 'The image could not be displayed. Using bundled artwork.' });
    callbacks.current.onError?.(event);
  }} />;
}
