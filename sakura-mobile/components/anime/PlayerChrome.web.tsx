import React, { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type Hls from 'hls.js';
import type { SubtitleMode } from '@/lib/anime-playback-overrides';
import type { PlayerChromeOptions } from './player-types';
import PlayerIcon, { type PlayerIconName } from './PlayerIcon.web';
import { readPlayerPreferences, savePlayerPreferences } from './player-preferences';
import { playerStyles } from './player-styles';

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  hlsRef: RefObject<Hls | null>;
  uri: string;
  options: PlayerChromeOptions;
  onCaptionModeChange: (mode: SubtitleMode) => void;
};
type Menu = 'speed' | 'quality' | 'captions' | null;
type MediaState = {
  time: number; duration: number; buffered: number; paused: boolean; ended: boolean;
  volume: number; muted: boolean; speed: number; quality: number;
  levels: Array<{ index: number; label: string }>;
  captions: Array<{ index: number; label: string; selected: boolean }>;
};
const INITIAL: MediaState = { time: 0, duration: 0, buffered: 0, paused: true, ended: false, volume: 1, muted: false, speed: 1, quality: -1, levels: [], captions: [] };
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
export function playerTime(seconds: number): string {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(value / 3600), m = Math.floor(value % 3600 / 60), s = value % 60;
  return `${h ? `${h}:` : ''}${h ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`;
}
function IconButton({ icon, label, onClick, active, disabled, className = '' }: {
  icon: PlayerIconName; label: string; onClick: () => void; active?: boolean; disabled?: boolean; className?: string;
}) {
  return <button type="button" className={`sc-button ${className}`} onClick={onClick} aria-label={label} title={label}
    aria-pressed={active} disabled={disabled}><PlayerIcon name={icon} /></button>;
}

export default function PlayerChrome({ videoRef, hlsRef, uri, options, onCaptionModeChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<Menu>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const touchRef = useRef(false);
  const captionCallback = useRef(onCaptionModeChange);
  const [media, setMedia] = useState<MediaState>(INITIAL);
  const [visible, setVisible] = useState(true);
  const [menu, setMenu] = useState<Menu>(null);
  const [waiting, setWaiting] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => { captionCallback.current = onCaptionModeChange; }, [onCaptionModeChange]);
  const closeMenu = useCallback(() => {
    setMenu(null);
    menuTriggerRef.current?.focus();
  }, []);
  const toggleMenu = (next: Exclude<Menu, null>, trigger: HTMLButtonElement) => {
    if (menu === next) { closeMenu(); return; }
    menuTriggerRef.current = trigger;
    setMenu(next);
  };

  const reveal = useCallback(() => {
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      const focused = document.activeElement;
      const keyboardFocus = focused instanceof HTMLElement && rootRef.current?.contains(focused) && focused.matches(':focus-visible');
      if (!videoRef.current?.paused && !menuRef.current && !keyboardFocus) setVisible(false);
    }, 2800);
  }, [videoRef]);
  const seek = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const next = Math.min(Math.max(0, seconds), video.duration);
    video.currentTime = next;
    setMedia(previous => ({ ...previous, time: next }));
    reveal();
  }, [videoRef, reveal]);
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) void video.play().catch(() => { setVisible(true); });
    else video.pause();
    reveal();
  }, [videoRef, reveal]);
  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (video) { video.muted = !video.muted; reveal(); }
  }, [videoRef, reveal]);
  const toggleFullscreen = useCallback(() => {
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitExitFullscreen?: () => void; webkitDisplayingFullscreen?: boolean }) | null;
    if (!video) return;
    const host = rootRef.current?.closest<HTMLElement>('[data-watch-viewport]') ?? rootRef.current?.parentElement;
    const legacyHost = host as (HTMLElement & { webkitRequestFullscreen?: () => void }) | null;
    const legacyDocument = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const fallback = () => {
      try {
        if (video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return; }
        setNotice('Fullscreen is unavailable in this browser.');
      } catch { setNotice('Fullscreen is unavailable in this browser.'); }
    };
    try {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else if (legacyDocument.webkitFullscreenElement) legacyDocument.webkitExitFullscreen?.();
      else if (video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
      else if (host?.requestFullscreen) void host.requestFullscreen().catch(fallback);
      else if (legacyHost?.webkitRequestFullscreen) legacyHost.webkitRequestFullscreen();
      else fallback();
    } catch { fallback(); }
    reveal();
  }, [videoRef, reveal]);

  useEffect(() => { menuRef.current = menu; reveal(); }, [menu, reveal]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false, metadataSeen = false;
    const preferences = readPlayerPreferences();
    video.volume = preferences.volume;
    video.muted = preferences.muted;
    video.playbackRate = preferences.speed;
    setResumedAt(null);
    setMenu(null);
    setWaiting(true);
    const update = () => {
      if (disposed) return;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      let buffered = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime + 0.5) buffered = video.buffered.end(i);
      }
      const hls = hlsRef.current;
      setMedia({ time: video.currentTime, duration, buffered, paused: video.paused, ended: video.ended,
        volume: video.volume, muted: video.muted, speed: video.playbackRate,
        quality: hls?.autoLevelEnabled === false ? hls.currentLevel : -1,
        levels: (hls?.levels ?? []).map((level, index) => ({ index, label: level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)} kbps` })),
        captions: Array.from(video.textTracks).filter(track => track.kind === 'subtitles' || track.kind === 'captions')
          .map(track => ({ index: Array.from(video.textTracks).indexOf(track), label: track.label || track.language || 'Subtitles', selected: track.mode === 'showing' })),
      });
    };
    const onMetadata = () => {
      // The engine applies its bookmark in its own metadata listener first.
      queueMicrotask(() => {
        if (disposed) return;
        video.playbackRate = preferences.speed;
        if (!metadataSeen && video.currentTime > 1) {
          setResumedAt(video.currentTime);
          if (toastTimer.current) clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(() => setResumedAt(null), 6500);
        }
        metadataSeen = true;
        update();
      });
    };
    const onPlaying = () => { setWaiting(false); update(); reveal(); };
    const onPause = () => { update(); setVisible(true); };
    const onWaiting = () => { if (!video.paused) setWaiting(true); };
    const onVolume = () => { update(); savePlayerPreferences({ volume: video.volume, muted: video.muted }); };
    const onRate = () => { update(); if (metadataSeen) savePlayerPreferences({ speed: video.playbackRate }); };
    const fullscreenChanged = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element };
      setFullscreen(!!(doc.fullscreenElement || doc.webkitFullscreenElement || (video as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen));
      reveal();
    };
    for (const event of ['timeupdate', 'progress', 'durationchange', 'seeked', 'ended', 'loadeddata']) video.addEventListener(event, update);
    video.addEventListener('loadedmetadata', onMetadata);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('play', onPlaying);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('ratechange', onRate);
    video.textTracks.addEventListener('addtrack', update);
    video.textTracks.addEventListener('change', update);
    document.addEventListener('fullscreenchange', fullscreenChanged);
    document.addEventListener('webkitfullscreenchange', fullscreenChanged);
    video.addEventListener('webkitbeginfullscreen', fullscreenChanged);
    video.addEventListener('webkitendfullscreen', fullscreenChanged);
    update(); reveal();
    return () => {
      disposed = true;
      for (const event of ['timeupdate', 'progress', 'durationchange', 'seeked', 'ended', 'loadeddata']) video.removeEventListener(event, update);
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('play', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('volumechange', onVolume);
      video.removeEventListener('ratechange', onRate);
      video.textTracks.removeEventListener('addtrack', update);
      video.textTracks.removeEventListener('change', update);
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      document.removeEventListener('webkitfullscreenchange', fullscreenChanged);
      video.removeEventListener('webkitbeginfullscreen', fullscreenChanged);
      video.removeEventListener('webkitendfullscreen', fullscreenChanged);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [uri, videoRef, hlsRef, reveal]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, button, a, [role="dialog"]'))) return;
      const video = videoRef.current;
      if (!video) return;
      switch (event.key.toLowerCase()) {
        case ' ': case 'k': event.preventDefault(); togglePlay(); break;
        case 'arrowleft': event.preventDefault(); seek(video.currentTime - 10); break;
        case 'arrowright': event.preventDefault(); seek(video.currentTime + 10); break;
        case 'm': event.preventDefault(); toggleMute(); break;
        case 'f': event.preventDefault(); toggleFullscreen(); break;
        case 'escape': closeMenu(); break;
        default: return;
      }
      reveal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [videoRef, seek, togglePlay, toggleMute, toggleFullscreen, reveal, closeMenu]);

  const changeCaptions = (index: number) => {
    const video = videoRef.current;
    if (!video) return;
    const mode = index < 0 ? 'off' : 'auto';
    captionCallback.current(mode);
    savePlayerPreferences({ captions: mode });
    if (hlsRef.current) hlsRef.current.subtitleDisplay = index >= 0;
    Array.from(video.textTracks).forEach((track, at) => { track.mode = at === index ? 'showing' : 'disabled'; });
    setMedia(previous => ({ ...previous, captions: previous.captions.map(track => ({ ...track, selected: track.index === index })) }));
  };
  const changeQuality = (index: number) => {
    if (hlsRef.current) hlsRef.current.currentLevel = index;
    setMedia(previous => ({ ...previous, quality: index }));
  };
  const captionsOn = media.captions.some(track => track.selected);
  const selectedQuality = media.levels.find(level => level.index === media.quality)?.label ?? 'Auto';
  const fraction = media.duration > 0 ? Math.min(100, media.time / media.duration * 100) : 0;
  const bufferedFraction = media.duration > 0 ? Math.min(100, media.buffered / media.duration * 100) : 0;
  const validMarker = (marker: { start: number; end: number } | undefined) => marker && Number.isFinite(marker.start) && Number.isFinite(marker.end)
    && marker.start >= 0 && marker.end > marker.start && media.time >= marker.start && media.time < marker.end - 0.25 && marker.end <= media.duration;
  const skip = validMarker(options.intro) ? { label: 'Skip Opening', end: options.intro!.end }
    : validMarker(options.outro) ? { label: 'Skip Ending', end: options.outro!.end } : null;
  const showChrome = visible || media.paused || !!menu;

  return <div className="sc-player" ref={rootRef} data-sakura-player="" data-chrome-visible={showChrome ? 'true' : 'false'}
    onPointerMove={event => { if (event.pointerType !== 'touch') reveal(); }} onFocus={reveal}
    onKeyDown={event => { if (event.key === 'Escape' && menu) { event.stopPropagation(); closeMenu(); } }}>
    <style>{playerStyles}</style>
    <button type="button" className="sc-surface" aria-label="Show playback controls" tabIndex={showChrome ? -1 : 0}
      onPointerDown={event => { touchRef.current = event.pointerType === 'touch'; }}
      onClick={() => { if (menu) { closeMenu(); reveal(); } else if (touchRef.current) reveal(); else togglePlay(); }} onDoubleClick={() => { if (!touchRef.current) toggleFullscreen(); }} />
    <div className="sc-shade" aria-hidden="true" />
    <div className="sc-top sc-chrome" inert={!showChrome}>
      {options.onBack && <IconButton icon="back" label="Back to episodes" onClick={options.onBack} />}
      <div className="sc-title"><strong>{options.title || 'Sakura'}</strong><span>{options.episodeLabel || (options.episodeNumber ? `Episode ${options.episodeNumber}` : 'Now playing')}</span></div>
      <div className="sc-brand" aria-label="Sakura"><PlayerIcon name="flower" /><span>SAKURA</span></div>
      {options.category && options.onToggleCategory && (options.availableCategories?.length ?? 0) > 1 &&
        <button type="button" className="sc-category" onClick={options.onToggleCategory} aria-label={`Audio: ${options.category.toUpperCase()}. Switch to ${options.category === 'sub' ? 'DUB' : 'SUB'}`}>{options.category.toUpperCase()}</button>}
    </div>
    <div className="sc-center sc-chrome" inert={!showChrome}>
      <IconButton icon="rewind" label="Seek backward 10 seconds" onClick={() => seek(media.time - 10)} />
      <IconButton icon={media.paused || media.ended ? 'play' : 'pause'} label={media.ended ? 'Replay' : media.paused ? 'Play' : 'Pause'} onClick={togglePlay} className="sc-main-play" />
      <IconButton icon="forward" label="Seek forward 10 seconds" onClick={() => seek(media.time + 10)} />
    </div>
    {waiting && !media.paused && <div className="sc-buffering" role="status" aria-label="Buffering" />}
    {skip && <button type="button" className="sc-skip" onClick={() => seek(skip.end)}>{skip.label}<PlayerIcon name="next" /></button>}
    {resumedAt !== null && <div className="sc-resume" role="status"><span>Resumed at {playerTime(resumedAt)}</span><button type="button" onClick={() => { seek(0); setResumedAt(null); }}>Restart</button></div>}
    {notice && <div className="sc-notice" role="status">{notice}</div>}
    <div className="sc-bottom sc-chrome" inert={!showChrome}>
      <input className="sc-timeline" type="range" min="0" max={media.duration || 1} step="0.1" value={Math.min(media.time, media.duration || 1)} disabled={!media.duration}
        aria-label="Playback position" aria-valuetext={`${playerTime(media.time)} of ${playerTime(media.duration)}`}
        style={{ '--sc-played': `${fraction}%`, '--sc-buffered': `${Math.max(fraction, bufferedFraction)}%` } as React.CSSProperties}
        onChange={event => seek(Number(event.target.value))} />
      <div className="sc-footer">
        <IconButton icon={media.paused ? 'play' : 'pause'} label={media.paused ? 'Play' : 'Pause'} onClick={togglePlay} className="sc-footer-play" />
        <div className="sc-audio"><IconButton icon={media.muted || media.volume === 0 ? 'muted' : 'volume'} label={media.muted ? 'Unmute' : 'Mute'} onClick={toggleMute} />
          <input className="sc-volume" type="range" min="0" max="1" step="0.05" value={media.muted ? 0 : media.volume} aria-label="Volume" aria-valuetext={`${Math.round((media.muted ? 0 : media.volume) * 100)} percent`}
            onChange={event => { const video = videoRef.current; if (video) { video.volume = Number(event.target.value); video.muted = video.volume === 0; } }} />
        </div>
        <span className="sc-clock">{playerTime(media.time)}<span> / {playerTime(media.duration)}</span></span>
        <div className="sc-footer-space" />
        {options.nextEpisode && <button type="button" className="sc-button sc-next" onClick={options.nextEpisode.onPlay} aria-label={`Next episode: ${options.nextEpisode.label}`} title={`Next episode: ${options.nextEpisode.label}`}><PlayerIcon name="next" /><span>{options.nextEpisode.label}</span></button>}
        <button type="button" className="sc-button sc-speed" onClick={event => toggleMenu('speed', event.currentTarget)} aria-label="Playback speed" aria-expanded={menu === 'speed'}>{media.speed}×</button>
        <button type="button" className={`sc-button${captionsOn ? ' sc-active' : ''}`} onClick={event => toggleMenu('captions', event.currentTarget)} aria-label="Captions" aria-expanded={menu === 'captions'} disabled={!media.captions.length}><PlayerIcon name="captions" /></button>
        <button type="button" className="sc-button" onClick={event => toggleMenu('quality', event.currentTarget)} aria-label="Playback settings" aria-expanded={!!menu}><PlayerIcon name="settings" /></button>
        <IconButton icon={fullscreen ? 'collapse' : 'fullscreen'} label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen} />
      </div>
    </div>
    {menu && <div className="sc-menu" role="dialog" aria-label="Playback settings" onPointerDown={event => event.stopPropagation()}>
      <div className="sc-menu-heading"><span>Make it yours</span><button type="button" aria-label="Close playback settings" onClick={closeMenu}>×</button></div>
      <div className="sc-tabs">{(['speed', 'quality', 'captions'] as const).map(tab => <button type="button" key={tab} aria-pressed={menu === tab} onClick={() => setMenu(tab)}>{tab === 'speed' ? 'Speed' : tab === 'quality' ? 'Quality' : 'Captions'}</button>)}</div>
      <div className="sc-menu-options">
        {menu === 'speed' && SPEEDS.map(speed => <button type="button" key={speed} aria-pressed={media.speed === speed} onClick={() => { if (videoRef.current) { videoRef.current.playbackRate = speed; savePlayerPreferences({ speed }); } }}><span>{speed === 1 ? 'Normal' : `${speed}×`}</span>{media.speed === speed && <PlayerIcon name="check" />}</button>)}
        {menu === 'quality' && <>
          <button type="button" aria-pressed={media.quality === -1} onClick={() => changeQuality(-1)}><span>Auto <small>Recommended</small></span>{media.quality === -1 && <PlayerIcon name="check" />}</button>
          {media.levels.map(level => <button type="button" key={level.index} aria-pressed={media.quality === level.index} onClick={() => changeQuality(level.index)}><span>{level.label}</span>{media.quality === level.index && <PlayerIcon name="check" />}</button>)}
          {!media.levels.length && <p>Your browser manages stream quality.</p>}
        </>}
        {menu === 'captions' && <>
          <button type="button" aria-pressed={!captionsOn} onClick={() => changeCaptions(-1)}><span>Off</span>{!captionsOn && <PlayerIcon name="check" />}</button>
          {media.captions.map(track => <button type="button" key={track.index} aria-pressed={track.selected} onClick={() => changeCaptions(track.index)}><span>{track.label}</span>{track.selected && <PlayerIcon name="check" />}</button>)}
          {!media.captions.length && <p>No captions for this source.</p>}
        </>}
      </div>
      <div className="sc-menu-foot">{menu === 'quality' ? `${selectedQuality} quality` : 'Saved for your next episode'}</div>
    </div>}
  </div>;
}
