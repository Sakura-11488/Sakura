import React, { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type Hls from 'hls.js';
import type { SubtitleMode } from '@/lib/anime-playback-overrides';
import type { PlayerChromeOptions } from './player-types';
import PlayerIcon, { type PlayerIconName } from './PlayerIcon.web';
import { readPlayerPreferences, savePlayerPreferences, type PlayerPreferences, type QualityPreference, type SubtitleLanguage } from './player-preferences';
import { qualityLimit } from './player-media-preferences';
import { playerStyles } from './player-styles';
import useUpNext from './useUpNext.web';

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  hlsRef: RefObject<Hls | null>;
  uri: string;
  options: PlayerChromeOptions;
  onCaptionModeChange: (mode: SubtitleMode, language?: SubtitleLanguage) => void;
  onQualityChange: (choice: QualityPreference | number) => void;
};
type Menu = 'speed' | 'quality' | 'captions' | null;
type MediaState = {
  time: number; duration: number; buffered: number; paused: boolean; ended: boolean;
  volume: number; muted: boolean; speed: number; quality: number;
  levels: Array<{ index: number; label: string; height: number }>;
  qualityManaged: boolean;
  captions: Array<{ index: number; label: string; language: string; selected: boolean }>;
};
const INITIAL: MediaState = { time: 0, duration: 0, buffered: 0, paused: true, ended: false, volume: 1, muted: false, speed: 1, quality: -1, levels: [], qualityManaged: false, captions: [] };
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

export default function PlayerChrome({ videoRef, hlsRef, uri, options, onCaptionModeChange, onQualityChange }: Props) {
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
  const [preferences, setPreferences] = useState(readPlayerPreferences);
  const [qualityOverride, setQualityOverride] = useState<number | null>(null);
  const { upNext, autoplay, toggleAutoplay, playNext, cancelNext, clearNext } = useUpNext(
    videoRef, `${uri}|${options.episodeNumber ?? ''}|${options.title}`, options.nextEpisode,
  );
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
    clearNext();
    const next = Math.min(Math.max(0, seconds), video.duration);
    video.currentTime = next;
    setMedia(previous => ({ ...previous, time: next }));
    reveal();
  }, [videoRef, reveal, clearNext]);
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) { clearNext(); void video.play().catch(() => { setVisible(true); }); }
    else video.pause();
    reveal();
  }, [videoRef, reveal, clearNext]);
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
    const video = videoRef.current;
    if (!video) return;
    video.dataset.captionSize = preferences.captionSize;
    video.dataset.captionBackground = preferences.captionBackground;
  }, [videoRef, preferences.captionSize, preferences.captionBackground]);
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
    setPreferences(preferences);
    setQualityOverride(null);
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
        qualityManaged: !!hls,
        levels: (hls?.levels ?? []).map((level, index) => ({ index, height: level.height, label: level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)} kbps` })),
        captions: Array.from(video.textTracks).filter(track => track.kind === 'subtitles' || track.kind === 'captions')
          .map(track => ({ index: Array.from(video.textTracks).indexOf(track), label: track.label || track.language || 'Subtitles', language: track.language, selected: track.mode === 'showing' })),
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
    for (const event of ['timeupdate', 'progress', 'durationchange', 'seeked', 'ended', 'loadeddata', 'sakura:media-options']) video.addEventListener(event, update);
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
      for (const event of ['timeupdate', 'progress', 'durationchange', 'seeked', 'ended', 'loadeddata', 'sakura:media-options']) video.removeEventListener(event, update);
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
    const track = index >= 0 ? video.textTracks[index] : undefined;
    const language = track ? { code: track.language || undefined, label: track.label || undefined } : undefined;
    const patch = { captions: mode as SubtitleMode, ...(language ? { subtitleLanguage: language } : {}) };
    savePlayerPreferences(patch);
    setPreferences(previous => ({ ...previous, ...patch }));
    captionCallback.current(mode, language);
    setMedia(previous => ({ ...previous, captions: previous.captions.map(track => ({ ...track, selected: track.index === index })) }));
  };
  const changeQuality = (choice: QualityPreference | number) => {
    setQualityOverride(typeof choice === 'number' ? choice : null);
    if (typeof choice !== 'number') {
      savePlayerPreferences({ qualityPreference: choice });
      setPreferences(previous => ({ ...previous, qualityPreference: choice }));
    }
    onQualityChange(choice);
  };
  const changeAppearance = (patch: Partial<Pick<PlayerPreferences, 'captionSize' | 'captionBackground'>>) => {
    savePlayerPreferences(patch);
    setPreferences(previous => ({ ...previous, ...patch }));
  };
  const captionsOn = media.captions.some(track => track.selected);
  const qualityName = { auto: 'Auto', balanced: 'Balanced', 'data-saver': 'Data saver' }[preferences.qualityPreference];
  const cap = qualityLimit(media.levels, preferences.qualityPreference);
  const cappedLevel = media.levels[cap.index];
  const capDescription = cappedLevel ? (cappedLevel.height > (preferences.qualityPreference === 'balanced' ? 720 : 480) ? `lowest available ${cappedLevel.label}` : `up to ${cappedLevel.label}`) : '';
  const selectedQuality = qualityOverride !== null ? `${media.levels.find(level => level.index === qualityOverride)?.label ?? 'Manual'} · this episode`
    : !media.qualityManaged ? 'Browser manages stream quality' : `${qualityName}${capDescription ? ` · ${capDescription}` : ''}`;
  const fraction = media.duration > 0 ? Math.min(100, media.time / media.duration * 100) : 0;
  const bufferedFraction = media.duration > 0 ? Math.min(100, media.buffered / media.duration * 100) : 0;
  const validMarker = (marker: { start: number; end: number } | undefined) => marker && Number.isFinite(marker.start) && Number.isFinite(marker.end)
    && marker.start >= 0 && marker.end > marker.start && media.time >= marker.start && media.time < marker.end - 0.25 && marker.end <= media.duration;
  const skip = validMarker(options.intro) ? { label: 'Skip Opening', end: options.intro!.end }
    : validMarker(options.outro) ? { label: 'Skip Ending', end: options.outro!.end } : null;
  const showChrome = visible || media.paused || !!menu;
  const countdownSeconds = Math.max(1, Math.ceil((upNext?.remainingMs ?? 0) / 1000));
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !showChrome) return;
    const positioned = new Map<VTTCue, { line: VTTCue['line']; snapToLines: boolean; placedLine: number }>();
    const isPositioned = (cue: VTTCue) => cue.line === positioned.get(cue)?.placedLine && !cue.snapToLines;
    const watched = new Set<TextTrack>();
    let placementFrame = 0;
    const placeCues = () => {
      for (const track of watched) for (const item of Array.from(track.activeCues ?? [])) {
        const cue = item as VTTCue;
        // Leave authored placement untouched. Default cues get clear space above
        // the custom controls, then return to the browser's placement on hide.
        if (positioned.has(cue) && !isPositioned(cue)) { positioned.delete(cue); continue; }
        if ((cue.snapToLines && cue.line === 'auto') || positioned.has(cue)) {
          // Percentage positioning also clears the bar at the smallest caption
          // size. Short viewports reserve room for a second caption line.
          const placedLine = video.clientHeight <= 450 ? 60 : 72;
          if (!positioned.has(cue)) positioned.set(cue, { line: cue.line, snapToLines: cue.snapToLines, placedLine });
          else positioned.get(cue)!.placedLine = placedLine;
          cue.snapToLines = false;
          cue.line = placedLine;
        }
      }
    };
    // Chromium commits its default cue layout after cuechange listeners run.
    // Apply placement on the next frame so that layout cannot overwrite it.
    const schedulePlacement = () => {
      cancelAnimationFrame(placementFrame);
      placementFrame = requestAnimationFrame(() => { placementFrame = requestAnimationFrame(placeCues); });
    };
    const watchTracks = () => {
      for (const track of Array.from(video.textTracks)) if (!watched.has(track)) { watched.add(track); track.addEventListener('cuechange', schedulePlacement); }
      schedulePlacement();
    };
    video.textTracks.addEventListener('addtrack', watchTracks);
    const resize = new ResizeObserver(schedulePlacement); resize.observe(video);
    watchTracks();
    return () => {
      video.textTracks.removeEventListener('addtrack', watchTracks);
      resize.disconnect();
      cancelAnimationFrame(placementFrame);
      for (const track of watched) track.removeEventListener('cuechange', schedulePlacement);
      for (const [cue, original] of positioned) if (isPositioned(cue)) {
        cue.snapToLines = original.snapToLines; cue.line = original.line;
      }
    };
  }, [showChrome, uri, videoRef]);


  return <div className="sc-player" ref={rootRef} data-sakura-player="" data-up-next-visible={upNext && options.nextEpisode ? 'true' : 'false'} data-chrome-visible={showChrome ? 'true' : 'false'} data-captions-visible={captionsOn ? 'true' : 'false'}
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
    {upNext && options.nextEpisode && <section className="sc-up-next" aria-label="Up next" data-up-next="">
      <div className="sc-up-next-copy">
        {options.nextEpisode.thumbnail && <img className="sc-up-next-image" src={options.nextEpisode.thumbnail} alt="" referrerPolicy="no-referrer" />}
        <div><span className="sc-up-next-eyebrow">UP NEXT</span><strong>{options.nextEpisode.title || options.nextEpisode.label}</strong>
          <span className="sc-up-next-detail">{options.nextEpisode.title && options.nextEpisode.title !== options.nextEpisode.label ? options.nextEpisode.label : options.title}</span></div>
      </div>
      <div className="sc-up-next-actions">
        <span className="sc-up-next-status" role="status">{upNext.remainingMs === null ? 'Autoplay is off' : upNext.paused ? 'Countdown paused' : `Playing in ${countdownSeconds} ${countdownSeconds === 1 ? 'second' : 'seconds'}`}</span>
        {upNext.remainingMs !== null && <button type="button" className="sc-up-next-cancel" onClick={() => { cancelNext(); rootRef.current?.querySelector<HTMLButtonElement>('.sc-main-play')?.focus(); }} aria-label="Cancel autoplay">Cancel</button>}
        <button type="button" className="sc-up-next-play" onClick={playNext}><PlayerIcon name="play" />Play now</button>
      </div>
      {upNext.remainingMs !== null && <div className="sc-up-next-progress" aria-hidden="true"><span style={{ transform: `scaleX(${upNext.remainingMs / 5000})` }} /></div>}
    </section>}
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
        {options.nextEpisode && <button type="button" className="sc-button sc-next" onClick={playNext} aria-label={`Next episode: ${options.nextEpisode.label}`} title={`Next episode: ${options.nextEpisode.label}`}><PlayerIcon name="next" /><span>{options.nextEpisode.label}</span></button>}
        <button type="button" className="sc-button sc-speed" onClick={event => toggleMenu('speed', event.currentTarget)} aria-label="Playback speed" aria-expanded={menu === 'speed'}>{media.speed}×</button>
        <button type="button" className={`sc-button${captionsOn ? ' sc-active' : ''}`} onClick={event => toggleMenu('captions', event.currentTarget)} aria-label="Captions" aria-expanded={menu === 'captions'}><PlayerIcon name="captions" /></button>
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
          <p className="sc-option-heading">Preferred streaming quality</p>
          {(['auto', 'balanced', 'data-saver'] as const).map(choice => <button type="button" key={choice} aria-pressed={qualityOverride === null && preferences.qualityPreference === choice} onClick={() => changeQuality(choice)}>
            <span>{{ auto: 'Auto', balanced: 'Balanced', 'data-saver': 'Data saver' }[choice]}<small>{{ auto: 'Adapt to connection', balanced: 'Up to 720p', 'data-saver': 'Up to 480p' }[choice]}</small></span>
            {qualityOverride === null && preferences.qualityPreference === choice && <PlayerIcon name="check" />}
          </button>)}
          {!media.qualityManaged && <p>Your browser manages this stream’s quality. Your preference is saved for supported streams.</p>}
          {media.qualityManaged && media.levels.length > 0 && <>
            <p className="sc-option-heading">This episode only</p>
            {media.levels.map(level => <button type="button" key={level.index} aria-pressed={qualityOverride === level.index} onClick={() => changeQuality(level.index)}><span>{level.label}</span>{qualityOverride === level.index && <PlayerIcon name="check" />}</button>)}
            <p>Uses a lower option when needed, or the lowest available if none fits your limit.</p>
          </>}
        </>}
        {menu === 'captions' && <>
          <p className="sc-option-heading">Language</p>
          <button type="button" aria-pressed={!captionsOn} onClick={() => changeCaptions(-1)}><span>Off</span>{!captionsOn && <PlayerIcon name="check" />}</button>
          {media.captions.map(track => <button type="button" key={track.index} aria-pressed={track.selected} onClick={() => changeCaptions(track.index)}><span>{track.label}</span>{track.selected && <PlayerIcon name="check" />}</button>)}
          {!media.captions.length && <p>No captions for this source.</p>}
          {preferences.subtitleLanguage && <p>Preferred: {preferences.subtitleLanguage.label || preferences.subtitleLanguage.code}</p>}
          <fieldset className="sc-caption-options"><legend>Text size</legend><div>{(['small', 'medium', 'large'] as const).map(size => <button type="button" key={size} aria-label={`${size} captions`} aria-pressed={preferences.captionSize === size} onClick={() => changeAppearance({ captionSize: size })}>{size === 'small' ? 'Small' : size === 'medium' ? 'Medium' : 'Large'}</button>)}</div></fieldset>
          <fieldset className="sc-caption-options"><legend>Background</legend><div>{(['none', 'soft', 'solid'] as const).map(background => <button type="button" key={background} aria-label={`${background} caption background`} aria-pressed={preferences.captionBackground === background} onClick={() => changeAppearance({ captionBackground: background })}>{background === 'none' ? 'None' : background === 'soft' ? 'Soft' : 'Solid'}</button>)}</div></fieldset>
          <div className="sc-caption-preview" aria-label="Caption preview" data-size={preferences.captionSize} data-background={preferences.captionBackground}><span>Your next story awaits.</span></div>
        </>}
      </div>
      <button type="button" className="sc-autoplay-toggle" role="switch" aria-label="Autoplay next episode" aria-checked={autoplay} onClick={toggleAutoplay}>
        <span>Autoplay next episode</span><span className="sc-switch-track" aria-hidden="true"><span /></span>
      </button>
      <div className="sc-menu-foot">{menu === 'quality' ? selectedQuality : 'Saved for your next episode'}</div>
    </div>}
  </div>;
}
