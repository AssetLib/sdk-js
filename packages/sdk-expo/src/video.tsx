import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useVideoPlayer, VideoView, type VideoContentFit } from 'expo-video';
import type { AssetRef } from '@assetlib/sdk-core';
import { AssetlibImage, type AssetlibImageProps } from './index';
import { videoUri } from './platform';
import type { ImageUri } from './shared';

export type AssetlibVideoProps<R extends AssetRef = AssetRef> = AssetlibImageProps<R> & {
  /** Show the poster instead of playing, for example while the view is off screen. */
  paused?: boolean;
};

/** At most two clips play at once across every AssetlibVideo; the others show their poster until a slot frees. */
const maxPlaying = 2;
let playing = 0;
const waiting: (() => void)[] = [];
function acquirePlaybackSlot(granted: () => void): () => void {
  let state: 'waiting' | 'playing' | 'released' = 'waiting';
  const start = () => { state = 'playing'; playing++; granted(); };
  if (playing < maxPlaying) start(); else waiting.push(start);
  return () => {
    if (state === 'waiting') waiting.splice(waiting.indexOf(start), 1);
    else if (state === 'playing') { playing--; while (playing < maxPlaying && waiting.length) waiting.shift()!(); }
    state = 'released';
  };
}

/** Unknown counts as reduced: no clip plays until the system says motion is allowed. */
function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', enabled => setReduced(enabled !== false));
    AccessibilityInfo.isReduceMotionEnabled().then(enabled => { if (mounted) setReduced(value => value ?? enabled !== false); }, () => { if (mounted) setReduced(value => value ?? true); });
    return () => { mounted = false; subscription?.remove(); };
  }, []);
  return reduced !== false;
}

function useAppActive(): boolean {
  const [state, setState] = useState<string | null | undefined>(() => AppState.currentState);
  useEffect(() => {
    try { const subscription = AppState.addEventListener('change', setState); return () => subscription.remove(); }
    catch { return undefined; }
  }, []);
  return state !== 'background' && state !== 'inactive';
}

const videoFit = (fit: AssetlibImageProps['contentFit']): VideoContentFit => fit === 'contain' || fit === 'fill' ? fit : fit === 'none' || fit === 'scale-down' ? 'contain' : 'cover';
type PlayableElement = { play?: () => Promise<void> | void };

function LoopingClip({ uri, contentFit, onFirstFrame, onFailure }: { uri: string; contentFit: VideoContentFit; onFirstFrame: () => void; onFailure: () => void }) {
  const view = useRef<VideoView>(null);
  const callbacks = useRef({ onFirstFrame, onFailure });
  callbacks.current = { onFirstFrame, onFailure };
  const player = useVideoPlayer(uri, created => { created.loop = true; created.muted = true; created.keepScreenOnWhilePlaying = false; });
  useEffect(() => {
    let mounted = true;
    const fail = () => { if (mounted) callbacks.current.onFailure(); };
    const subscription = player.addListener('statusChange', ({ status }) => { if (status === 'error') fail(); });
    try {
      if (player.status === 'error') fail();
      // On web, VideoView exposes its <video> element, whose play() promise rejects when autoplay is blocked.
      const element = (view.current as unknown as { nativeRef?: { current?: PlayableElement | null } } | null)?.nativeRef?.current;
      if (typeof element?.play === 'function') Promise.resolve(element.play()).catch(fail);
      else player.play();
    } catch { fail(); }
    return () => { mounted = false; subscription.remove(); };
  }, [player]);
  return <VideoView ref={view} player={player} nativeControls={false} contentFit={contentFit} allowsPictureInPicture={false} playsInline style={StyleSheet.absoluteFill} onFirstFrameRender={() => callbacks.current.onFirstFrame()} />;
}

/**
 * The placement's poster (an AssetlibImage, bundled fallback first) with its signed short looping clip over it.
 * The clip resolves and plays only while motion is allowed, the app is active, `paused` is false and this view
 * holds one of the two playback slots. It plays muted and looping with no controls; any failure shows the poster
 * until the request (client, asset, revision or cache policy) changes. `style` sizes the container.
 */
export function AssetlibVideo<R extends AssetRef>({ paused = false, ...props }: AssetlibVideoProps<R>) {
  const { client, asset, cachePolicy, revision = 0, style, contentFit } = props;
  const reduceMotion = useReduceMotion();
  const active = useAppActive();
  const request = useMemo(() => ({}), [client, asset.key, asset.width, asset.height, revision, cachePolicy]);
  const [failed, setFailed] = useState<object | null>(null);
  const wantsSlot = !paused && !reduceMotion && active && failed !== request;
  const [slot, setSlot] = useState(false);
  useEffect(() => {
    if (!wantsSlot) return;
    const release = acquirePlaybackSlot(() => setSlot(true));
    return () => { release(); setSlot(false); };
  }, [wantsSlot]);
  const [clip, setClip] = useState<{ request: object; media: ImageUri } | null>(null);
  useEffect(() => () => clip?.media.release(), [clip]);
  useEffect(() => {
    if (clip && clip.request !== request) { setClip(null); return; }
    if (clip || !wantsSlot || !slot) return;
    const controller = new AbortController();
    client.resolveVideo(asset, { cachePolicy, signal: controller.signal }).then(async result => {
      if (controller.signal.aborted) return;
      if (result.source === 'poster') { setFailed(request); return; }
      const media = await videoUri(client.config, result);
      if (controller.signal.aborted) { media.release(); return; }
      setClip({ request, media });
    }).catch(() => { if (!controller.signal.aborted) setFailed(request); });
    return () => controller.abort();
  }, [client, request, wantsSlot, slot, clip]);
  const play = wantsSlot && slot && clip?.request === request;
  const [frame, setFrame] = useState(false);
  useEffect(() => { if (!play) setFrame(false); }, [play]);
  const poster = { ...props, style: [StyleSheet.absoluteFill, { opacity: play && frame ? 0 : 1 }] } as AssetlibImageProps<R>;
  return (
    <View style={[{ overflow: 'hidden' }, style as StyleProp<ViewStyle>]}>
      {play && <LoopingClip uri={clip!.media.uri} contentFit={videoFit(contentFit)} onFirstFrame={() => setFrame(true)} onFailure={() => { setFailed(request); setClip(null); }} />}
      <AssetlibImage<R> {...poster} />
    </View>
  );
}
