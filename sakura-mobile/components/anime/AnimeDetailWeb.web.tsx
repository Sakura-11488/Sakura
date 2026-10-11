import React, { useMemo, useState } from 'react';
import { Image } from 'expo-image';
import Hls from 'hls.js';
import { canResumeWatchProgress, isWatchProgressComplete, resumePosition } from '@/lib/watch-progress';
import type { AnimeDetailWebProps, AnimeDetailWebPlaceholderProps } from './AnimeDetailWeb';

const PAGE_SIZE = 24;

function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function Icon({ name, size = 18 }: { name: 'play' | 'back' | 'save' | 'check' | 'share' | 'download' | 'search' | 'restart' | 'pause'; size?: number }) {
  const paths = {
    play: 'm8 5 11 7-11 7V5Z', back: 'm14 6-6 6 6 6',
    save: 'M6 4h12v17l-6-4-6 4V4Z', check: 'm5 12 4 4L19 6',
    share: 'M12 16V3m-4 4 4-4 4 4M5 13v7h14v-7',
    download: 'M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4',
    search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    restart: 'M3 10a9 9 0 1 1 2 8M3 4v6h6',
    pause: 'M9 7v10M15 7v10',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={name === 'play' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

const styles = `
.sakura-detail{--sd-accent:#ff626b;--sd-text:#f4f3f5;--sd-muted:#aaa8b2;--sd-line:rgba(255,255,255,.10);box-sizing:border-box;flex:1;min-height:0;overflow:auto;overscroll-behavior-y:contain;background:#0b0b0f;color:var(--sd-text);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:dark}
.sakura-detail *{box-sizing:border-box}.sakura-detail button,.sakura-detail input,.sakura-detail select{font:inherit}.sakura-detail button{cursor:pointer}.sakura-detail button:disabled{cursor:default;opacity:.5}.sakura-detail button:focus-visible,.sakura-detail input:focus-visible,.sakura-detail select:focus-visible{outline:2px solid var(--sd-accent);outline-offset:4px}.sakura-detail button{color:inherit}.sakura-detail h1,.sakura-detail h2,.sakura-detail p{margin:0}.sakura-detail svg{flex-shrink:0}
.sd-shell{max-width:1400px;margin:0 auto;padding:0 clamp(20px,3.5vw,56px) 100px}.sd-nav{height:72px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--sd-line)}.sd-back{display:flex;align-items:center;gap:7px;color:var(--sd-muted)!important;background:none;border:0;padding:10px 0;font-size:13px!important}.sd-brand{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase}.sd-brand i{width:7px;height:7px;border-radius:50%;background:var(--sd-accent);box-shadow:0 0 16px #ff626b77}.sd-nav-actions{display:flex;gap:8px}.sd-icon-button{width:38px;height:38px;border:1px solid var(--sd-line);border-radius:50%;background:#ffffff05;display:grid;place-items:center}.sd-icon-button:hover{background:#ffffff12}.sd-icon-button[aria-pressed=true]{color:var(--sd-accent);border-color:#ff626b66}
.sd-hero{position:relative;isolation:isolate;min-height:440px;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(210px,.75fr);align-items:center;gap:24px;padding:38px 0 36px}.sd-art{position:absolute;inset:0 0 0 25%;z-index:-2;overflow:hidden;opacity:.32;mask-image:linear-gradient(90deg,transparent,#000 45%);-webkit-mask-image:linear-gradient(90deg,transparent,#000 45%)}.sd-art:after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,#0b0b0f 0%,transparent 40%,#0b0b0f 100%),linear-gradient(90deg,#0b0b0f,transparent 90%)}.sd-copy{padding:8px 0;max-width:680px}.sd-eyebrow{display:flex;align-items:center;gap:8px;color:var(--sd-accent);font-size:10px;font-weight:750;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:14px}.sd-eyebrow:before{content:"";width:20px;height:1px;background:currentColor}.sd-title{font-size:clamp(32px,3.7vw,56px);line-height:1.07;font-weight:800;letter-spacing:-1.8px;overflow-wrap:anywhere;text-wrap:balance;max-width:760px}.sd-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:18px 0 0;color:#c1bfc8;font-size:12px}.sd-meta span+span:before{content:"·";margin-right:12px;color:#66636f}.sd-score{color:#efc578}.sd-genres{font-size:11px;color:#8b8896;letter-spacing:.25px;margin:12px 0 0!important;line-height:1.7}.sd-description{color:var(--sd-muted);font-size:13px;line-height:1.8;margin-top:17px!important;max-width:620px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.sd-description.expanded{display:block}.sd-text-button{border:0;background:none;padding:7px 0;color:#d2cfd8!important;font-size:11px!important;text-decoration:underline;text-underline-offset:3px}.sd-poster-wrap{display:flex;align-items:center;justify-content:center;align-self:stretch;padding:10px 4px 14px}.sd-poster{position:relative;width:clamp(175px,19vw,255px);aspect-ratio:2/3;border-radius:9px;overflow:hidden;box-shadow:0 22px 60px #0009,0 0 0 1px #ffffff16;transform:rotate(2deg);background:#202028}.sd-poster:after{content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;box-shadow:inset 0 0 0 1px #ffffff12}
.sd-playback{margin-top:24px;max-width:480px}.sd-playing-label{font-size:10px;color:var(--sd-accent);text-transform:uppercase;letter-spacing:1.7px;font-weight:750;margin-bottom:7px}.sd-playing-title{font-size:13px;font-weight:600;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sd-watch-clock{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:#aaa6b2;margin-top:9px;font-variant-numeric:tabular-nums}.sd-progress{height:3px;border-radius:3px;background:#ffffff17;overflow:hidden;margin-top:8px}.sd-progress>span{display:block;height:100%;background:var(--sd-accent);border-radius:inherit}.sd-cta-row{display:flex;align-items:center;gap:12px;margin-top:16px;flex-wrap:wrap}.sd-primary{min-height:46px;display:inline-flex;align-items:center;justify-content:center;gap:10px;background:var(--sd-accent);border:0;border-radius:6px;padding:0 24px;color:#160a0c!important;font-size:13px!important;font-weight:750!important;box-shadow:0 5px 22px #ff626b12}.sd-primary:hover{background:#ff7a81}.sd-secondary{display:inline-flex;gap:7px;align-items:center;justify-content:center;padding:11px 5px;border:0;background:transparent;color:#b4b0bd!important;font-size:11px!important}.sd-secondary:hover{color:#fff!important}.sd-unavailable{font-size:13px;color:var(--sd-muted);margin-top:20px!important}
.sd-sections{display:flex;gap:28px;border-bottom:1px solid var(--sd-line);margin-bottom:22px;overflow-x:auto;scrollbar-width:none}.sd-section-button{white-space:nowrap;position:relative;border:0;background:transparent;padding:17px 0 15px;font-size:13px!important;color:#8b8795!important;font-weight:650!important}.sd-section-button[aria-pressed=true]{color:#f4f3f5!important}.sd-section-button[aria-pressed=true]:after{content:"";position:absolute;height:2px;bottom:0;left:0;right:0;background:var(--sd-accent)}.sd-section-count{font-size:10px;color:#8b8795;margin-left:7px}.sd-list-top{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:17px}.sd-list-title h2{font-size:17px;letter-spacing:-.3px;font-weight:700}.sd-list-title p{font-size:11px;color:#827e8e;margin-top:5px}.sd-filters{display:flex;align-items:center;gap:9px}.sd-search{height:36px;width:185px;display:flex;align-items:center;gap:8px;border:1px solid var(--sd-line);padding:0 10px;border-radius:5px;color:#847e90;background:#ffffff03}.sd-search input{background:none;border:0;outline:0;color:var(--sd-text);font-size:11px;min-width:0;width:100%;height:100%}.sd-select{max-width:150px;height:36px;background:#15141b;color:#c8c4d0;border:1px solid var(--sd-line);border-radius:5px;padding:0 9px;font-size:11px!important}.sd-episode-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.sd-episode{position:relative;min-width:0;border:1px solid var(--sd-line);border-radius:7px;background:#131218;display:flex;align-items:center;overflow:hidden;transition:border-color .15s,background .15s}.sd-episode:hover{background:#1b1820;border-color:#ffffff29}.sd-episode[data-current=true]{border-color:#ff626b5c;background:#ff626b08}.sd-episode-play{background:none;border:0;display:flex;align-items:center;gap:13px;padding:10px;text-align:left;min-width:0;flex:1}.sd-thumb{position:relative;flex:0 0 116px;aspect-ratio:16/10;background:linear-gradient(135deg,#2b2431,#141319);border-radius:4px;overflow:hidden}.sd-thumb:after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,#0008,transparent 60%)}.sd-thumb-number{position:absolute;bottom:7px;left:8px;font-size:10px;color:#fff;z-index:1;font-weight:700;letter-spacing:1px}.sd-thumb-play{position:absolute;inset:0;display:grid;place-items:center;z-index:1;opacity:0;transition:opacity .15s;background:#0002}.sd-episode:hover .sd-thumb-play,.sd-episode-play:focus-visible .sd-thumb-play{opacity:1}.sd-episode-copy{flex:1;min-width:0}.sd-episode-kicker{font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:#7d7789;margin-bottom:6px}.sd-episode[data-current=true] .sd-episode-kicker{color:var(--sd-accent)}.sd-episode-title{font-size:12px;font-weight:600;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.sd-episode-status{font-size:10px;color:#888292;margin-top:6px;line-height:1.3}.sd-episode-bar{position:absolute;bottom:0;left:0;height:2px;background:var(--sd-accent);pointer-events:none}.sd-download{position:relative;flex-shrink:0;width:32px;height:36px;display:grid;place-items:center;background:none;border:0;color:#aaa4b6!important;margin-right:6px}.sd-download[data-state=downloading],.sd-download[data-state=paused]{color:#f4f3f5!important}.sd-download-ring{position:absolute;left:50%;top:50%;width:30px;height:30px;transform:translate(-50%,-50%);pointer-events:none}.sd-download-ring circle{fill:none;stroke-width:2}.sd-download-ring .track{stroke:#ffffff1c}.sd-download-ring .fill{stroke:var(--sd-accent);stroke-linecap:round;transition:stroke-dasharray .3s}.sd-episode-status[data-tone=error]{color:#ff8a90}.sd-episode-status[data-tone=ready]{color:#7fd6a0}.sd-notice{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;padding:11px 14px;border:1px solid #ff626b40;border-radius:7px;background:#ff626b0d;font-size:12px;color:#e6e1ea;line-height:1.5}.sd-notice button{flex-shrink:0;border:1px solid var(--sd-line);border-radius:5px;background:#ffffff08;padding:7px 11px;font-size:11px!important}.sd-empty{border:1px dashed var(--sd-line);border-radius:8px;padding:32px;text-align:center;color:var(--sd-muted);font-size:13px;line-height:1.7}.sd-empty strong{display:block;color:#eeeaf5;font-weight:600;margin-bottom:7px}.sd-pagination{display:flex;align-items:center;justify-content:center;gap:18px;margin-top:22px;font-size:11px;color:#928b9f}.sd-pagination button{background:#18151e;border:1px solid var(--sd-line);border-radius:5px;padding:9px 13px}.sd-details{display:grid;grid-template-columns:2fr 1fr;gap:40px;font-size:13px;color:var(--sd-muted);line-height:1.9}.sd-details h2{font-size:16px;color:var(--sd-text);margin-bottom:12px}.sd-details dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:9px 24px;font-size:12px}.sd-details dt{color:#7d7689}.sd-details dd{margin:0;color:#d5cfdf}.sd-discussion{max-width:860px}.sd-loading{display:grid;grid-template-columns:1.5fr 1fr;gap:40px;align-items:center;min-height:450px}.sd-skeleton{border-radius:6px;background:linear-gradient(100deg,#19171f,#23202a,#19171f);background-size:200% 100%;animation:sd-shimmer 1.8s ease infinite}.sd-loading-lines{display:flex;flex-direction:column;gap:18px}.sd-error{padding:80px 0;text-align:center;max-width:500px;margin:auto}.sd-error h1{font-size:28px;margin-bottom:15px}.sd-error p{color:var(--sd-muted);font-size:13px;line-height:1.8;margin-bottom:24px}.sd-error .sd-primary{margin:auto}@keyframes sd-shimmer{to{background-position:-200% 0}}
@media(min-width:1600px){.sd-title{font-size:58px}.sd-hero{min-height:470px}}
@media(max-width:1100px){.sd-hero{grid-template-columns:minmax(0,1.25fr) minmax(170px,.75fr);gap:18px}.sd-poster{width:190px}.sd-title{font-size:38px}.sd-thumb{flex-basis:94px}.sd-episode-play{gap:10px}.sd-episode-title{font-size:11px}}
@media(max-width:700px){.sd-shell{padding:0 20px 110px}.sd-nav{height:60px}.sd-brand{font-size:9px;letter-spacing:1.5px}.sd-nav-actions{gap:6px}.sd-icon-button{height:34px;width:34px}.sd-back{font-size:0!important;gap:0;min-width:34px}.sd-back svg{width:20px;height:20px}.sd-hero{grid-template-columns:minmax(0,1fr);padding:30px 0 28px;min-height:0;gap:0}.sd-copy{max-width:none;position:relative;padding:0}.sd-art{inset:0 -20px 0 20%;opacity:.35;mask-image:linear-gradient(90deg,transparent,#000);-webkit-mask-image:linear-gradient(90deg,transparent,#000)}.sd-title{font-size:clamp(30px,7vw,42px);letter-spacing:-1.2px;max-width:85%;min-height:60px;padding-right:4px}.sd-eyebrow{font-size:9px;margin-bottom:13px}.sd-poster-wrap{position:absolute;right:0;top:29px;z-index:-1;opacity:.28;padding:0;align-self:auto;mask-image:linear-gradient(90deg,transparent,#000);-webkit-mask-image:linear-gradient(90deg,transparent,#000)}.sd-poster{width:100px;transform:none;box-shadow:none;aspect-ratio:2/3}.sd-meta{font-size:10px;gap:7px 9px;margin-top:15px;max-width:90%}.sd-meta span+span:before{margin-right:9px}.sd-genres{font-size:10px;margin-top:10px!important}.sd-description{font-size:12px;line-height:1.8;margin-top:13px!important;-webkit-line-clamp:2}.sd-playback{max-width:none;margin-top:22px}.sd-playing-label{font-size:9px}.sd-playing-title{font-size:12px}.sd-primary{min-height:44px;padding:0 22px;font-size:12px!important}.sd-cta-row{margin-top:15px}.sd-sections{gap:24px;margin-bottom:20px}.sd-section-button{font-size:12px!important;padding:13px 0}.sd-list-top{align-items:flex-start;gap:14px;flex-direction:column}.sd-list-title h2{font-size:16px}.sd-filters{width:100%}.sd-search{flex:1;width:auto;max-width:none}.sd-select{max-width:140px}.sd-episode-grid{grid-template-columns:minmax(0,1fr);gap:8px}.sd-episode-play{gap:12px;padding:9px}.sd-thumb{flex-basis:105px}.sd-episode-title{font-size:12px}.sd-episode-kicker{font-size:9px;margin-bottom:5px}.sd-episode-status{font-size:10px;margin-top:5px}.sd-details{grid-template-columns:1fr;gap:24px}.sd-loading{grid-template-columns:1fr;min-height:350px;gap:20px}.sd-loading-art{display:none}}
@media(max-width:360px){.sd-art{right:-15px}.sd-shell{padding-left:15px;padding-right:15px}.sd-thumb{flex-basis:88px}.sd-episode-play{gap:9px}.sd-sections{gap:20px}.sd-primary{padding:0 17px}.sd-cta-row{gap:9px}}
@media(prefers-reduced-motion:reduce){.sd-skeleton{animation:none}.sd-episode,.sd-thumb-play{transition:none}}
`;

export function AnimeDetailWebPlaceholder({ onBack, error, onRetry }: AnimeDetailWebPlaceholderProps) {
  return <main className="sakura-detail"><style>{styles}</style><div className="sd-shell">
    <nav className="sd-nav"><button className="sd-back" onClick={onBack} aria-label="Go back"><Icon name="back" />Back</button><span className="sd-brand"><i />Sakura Anime</span><span /></nav>
    {error ? <div className="sd-error" role="alert"><h1>Could not load this title</h1><p>{error}</p><button className="sd-primary" onClick={onRetry}>Try again</button></div> : <div className="sd-loading" role="status" aria-label="Loading anime details"><div className="sd-loading-lines"><div className="sd-skeleton" style={{ height: 12, width: '25%' }} /><div className="sd-skeleton" style={{ height: 50, width: '90%' }} /><div className="sd-skeleton" style={{ height: 14, width: '55%' }} /><div className="sd-skeleton" style={{ height: 62, width: '100%' }} /><div className="sd-skeleton" style={{ height: 44, width: 190 }} /></div><div className="sd-skeleton sd-loading-art" style={{ height: 310, maxWidth: 210, width: '100%', justifySelf: 'center' }} /></div>}
  </div></main>;
}

/** Whether hls.js can play here; WebVideoPlayer.web.tsx makes the same call when it plays the copy. */
function browserPlaysHls(): boolean {
  try {
    return Hls.isSupported();
  } catch {
    return false;
  }
}

function downloadStatus(download: AnimeDetailWebProps['offline'][string] | undefined): { text: string; tone?: 'error' | 'ready' } | null {
  if (!download) return null;
  const pct = Math.round((download.progress || 0) * 100);
  switch (download.status) {
    case 'ready': return { text: `Downloaded${download.quality ? ` · ${download.quality}` : ''}`, tone: 'ready' };
    case 'downloading': return { text: download.totalSegments ? `Downloading ${pct}%` : 'Preparing download…' };
    case 'paused': return { text: `Download paused at ${pct}%` };
    default: return { text: download.error ? `Download failed: ${download.error}` : 'Download failed', tone: 'error' };
  }
}

export default function AnimeDetailWeb({ anime, progress, saved, offline, downloadable, downloadsNeedHls, notice, onBack, onSave, onShare, onPlay, onDownload, discussion, creator }: AnimeDetailWebProps) {
  const [section, setSection] = useState('episodes');
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  const hlsPlayable = useMemo(browserPlaysHls, []);
  const canDownload = downloadable && (!downloadsNeedHls || hlsPlayable);
  const episodes = anime.episodes;
  const savedEpisode = progress?.animeId === anime.id ? episodes.find(ep => ep.id === progress.episodeId) : undefined;
  const bookmark = savedEpisode ? progress : null;
  const resumable = canResumeWatchProgress(bookmark);
  const finished = !!bookmark && isWatchProgressComplete(bookmark);
  const playEpisode = savedEpisode || episodes[0];
  const position = resumePosition(bookmark);
  const duration = bookmark?.durationSeconds && Number.isFinite(bookmark.durationSeconds) ? bookmark.durationSeconds : 0;
  const ratio = finished ? 1 : bookmark ? Math.min(1, Math.max(0, duration > 0 ? position / duration : bookmark.progress || 0)) : 0;
  const hasExactPosition = typeof bookmark?.positionSeconds === 'number' && Number.isFinite(bookmark.positionSeconds);
  const hasClock = hasExactPosition || duration > 0;
  const timeLabel = hasClock ? `${hasExactPosition ? '' : 'About '}${clock(position)}${duration > 0 ? ` / ${clock(duration)}` : ''}` : `Saved progress · ${Math.round(ratio * 100)}%`;
  const remainingLabel = duration > 0 ? `${hasExactPosition ? '' : 'About '}${clock(Math.max(0, duration - position))} left` : 'Your place is saved';
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    return value ? episodes.filter(ep => String(ep.number).includes(value) || ep.title.toLowerCase().includes(value)) : episodes;
  }, [episodes, query]);
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const defaultPage = query ? 0 : Math.max(0, Math.floor(episodes.findIndex(ep => ep.id === savedEpisode?.id) / PAGE_SIZE));
  const page = Math.min(Math.max(0, pageCount - 1), selectedPage ?? defaultPage);
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const artwork = anime.localCover || { uri: anime.cover || anime.image };
  const hasArtwork = !!(anime.localCover || anime.cover || anime.image);
  const imageStyle = { position: 'absolute' as const, width: '100%' as const, height: '100%' as const, inset: 0 };

  return <main className="sakura-detail" data-anime-detail={anime.id}>
    <style>{styles}</style>
    <div className="sd-shell">
      <nav className="sd-nav" aria-label="Anime navigation">
        <button className="sd-back" onClick={onBack} aria-label="Go back"><Icon name="back" />Browse anime</button>
        <span className="sd-brand"><i />Sakura Anime</span>
        <div className="sd-nav-actions">
          <button className="sd-icon-button" onClick={onShare} aria-label="Share this anime" title="Share"><Icon name="share" /></button>
          <button className="sd-icon-button" onClick={onSave} aria-label={saved ? 'Remove from library' : 'Add to library'} aria-pressed={saved} title={saved ? 'Saved to library' : 'Add to library'}><Icon name={saved ? 'check' : 'save'} /></button>
        </div>
      </nav>

      {notice && <div className="sd-notice" role="status"><span>{notice.text}</span>{notice.actionLabel && notice.onAction && <button onClick={notice.onAction}>{notice.actionLabel}</button>}</div>}

      <section className="sd-hero" aria-labelledby="sd-title">
        {hasArtwork && <div className="sd-art" aria-hidden="true"><Image source={artwork} style={imageStyle} contentFit="cover" contentPosition="center" /></div>}
        <div className="sd-copy">
          <div className="sd-eyebrow">{creator ? 'Sakura Original' : 'Find your next story'}</div>
          <h1 id="sd-title" className="sd-title">{anime.title}</h1>
          <div className="sd-meta">
            {anime.score != null && <span className="sd-score">★ {anime.score} / 10</span>}
            {anime.year ? <span>{anime.year}</span> : null}
            {anime.type && <span>{anime.type}</span>}
            {episodes.length > 0 && <span>{episodes.length} episode{episodes.length === 1 ? '' : 's'}</span>}
            {anime.status && <span>{anime.status}</span>}
          </div>
          {!!anime.genres?.length && <p className="sd-genres">{anime.genres.join('  /  ')}</p>}
          {anime.description && <><p className={`sd-description${expanded ? ' expanded' : ''}`}>{anime.description}</p><button className="sd-text-button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? 'Show less' : 'Read synopsis'}</button></>}
          {playEpisode ? <div className="sd-playback">
            <div className="sd-playing-label">{resumable ? 'Continue watching' : finished ? 'Watch it again' : savedEpisode ? 'Up next' : 'Start watching'}</div>
            <p className="sd-playing-title">Episode {playEpisode.number}{playEpisode.title && playEpisode.title !== `Episode ${playEpisode.number}` ? ` · ${playEpisode.title}` : ''}</p>
            {resumable && <><div className="sd-watch-clock"><span>{timeLabel}</span><span>{remainingLabel}</span></div><div className="sd-progress" role="progressbar" aria-label="Episode progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}><span style={{ width: `${ratio * 100}%` }} /></div></>}
            <div className="sd-cta-row">
              <button className="sd-primary" onClick={() => onPlay(playEpisode, finished)}><Icon name="play" size={18} />{resumable ? 'Continue watching' : finished ? 'Watch again' : `Watch episode ${playEpisode.number}`}</button>
              {resumable && <button className="sd-secondary" onClick={() => onPlay(playEpisode, true)}><Icon name="restart" size={15} />Start over</button>}
              {offline[playEpisode.id]?.status === 'ready' && <span className="sd-episode-status">Downloaded</span>}
            </div>
          </div> : <p className="sd-unavailable">Episodes are not available yet.</p>}
        </div>
        {hasArtwork && <div className="sd-poster-wrap" aria-hidden="true"><div className="sd-poster"><Image source={artwork} style={imageStyle} contentFit="cover" /></div></div>}
      </section>

      <nav className="sd-sections" aria-label="Title sections">
        {[['episodes', 'Episodes'], ['details', 'Details'], ['discussion', 'Discussion'], ...(creator ? [['creator', 'Creator']] : [])].map(([key, label]) => <button key={key} className="sd-section-button" aria-pressed={section === key} onClick={() => setSection(key)}>{label}{key === 'episodes' && <span className="sd-section-count">{episodes.length}</span>}</button>)}
      </nav>

      {section === 'episodes' && <section aria-labelledby="sd-episodes-heading">
        <div className="sd-list-top">
          <div className="sd-list-title"><h2 id="sd-episodes-heading">All episodes</h2><p>{query ? `${filtered.length} result${filtered.length === 1 ? '' : 's'}` : savedEpisode ? `Your place: episode ${savedEpisode.number}` : 'A new story starts here.'}</p></div>
          {episodes.length > 0 && <div className="sd-filters"><label className="sd-search"><Icon name="search" size={14} /><input aria-label="Find an episode" placeholder="Find an episode" type="search" value={query} onChange={event => { setQuery(event.target.value); setSelectedPage(0); }} /></label>{pageCount > 1 && <select className="sd-select" aria-label="Episode range" value={page} onChange={event => setSelectedPage(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>Episodes {filtered[index * PAGE_SIZE].number}–{filtered[Math.min((index + 1) * PAGE_SIZE, filtered.length) - 1].number}</option>)}</select>}</div>}
        </div>
        {visible.length ? <div className="sd-episode-grid">{visible.map(ep => {
          const current = ep.id === savedEpisode?.id;
          const download = offline[ep.id];
          const status = downloadStatus(download);
          const pct = Math.round((download?.progress || 0) * 100);
          const downloadLabel = download?.status === 'ready' ? 'Downloaded' : download?.status === 'downloading' ? `Pause download (${pct}%)` : download?.status === 'paused' ? `Resume download (${pct}%)` : download?.status === 'error' ? 'Retry download' : 'Download episode';
          return <article key={ep.id} className="sd-episode" data-current={current || undefined}>
            <button className="sd-episode-play" onClick={() => onPlay(ep, current && finished)} aria-label={`${current && resumable ? 'Continue' : current && finished ? 'Replay' : 'Watch'} episode ${ep.number}: ${ep.title}`}>
              <div className="sd-thumb">{(ep.thumbnail || hasArtwork) && <Image source={ep.thumbnail ? { uri: ep.thumbnail } : artwork} style={imageStyle} contentFit="cover" />}<span className="sd-thumb-number">{String(ep.number).padStart(2, '0')}</span><span className="sd-thumb-play"><Icon name="play" size={22} /></span></div>
              <div className="sd-episode-copy"><div className="sd-episode-kicker">{current ? resumable ? 'Continue watching' : finished ? 'Watched' : 'Up next' : `Episode ${ep.number}`}</div><div className="sd-episode-title">{ep.title || `Episode ${ep.number}`}</div>{current && resumable && <div className="sd-episode-status">{hasClock ? `Resume ${hasExactPosition ? 'at' : 'near'} ${clock(position)}` : `${Math.round(ratio * 100)}% watched`}{duration > 0 ? ` · ${remainingLabel}` : ''}</div>}{status && (canDownload || download?.status === 'ready') && <div className="sd-episode-status" data-tone={status.tone} aria-live={download?.status === 'downloading' ? 'off' : 'polite'}>{status.text}</div>}</div>
            </button>
            {canDownload && <button className="sd-download" data-state={download?.status} aria-label={`${downloadLabel}: episode ${ep.number}`} title={downloadLabel} disabled={download?.status === 'ready'} onClick={() => onDownload(ep)}>
              {(download?.status === 'downloading' || download?.status === 'paused') && <svg className="sd-download-ring" viewBox="0 0 36 36" aria-hidden="true"><circle className="track" cx="18" cy="18" r="15" /><circle className="fill" cx="18" cy="18" r="15" pathLength={100} strokeDasharray={`${pct} 100`} transform="rotate(-90 18 18)" /></svg>}
              <Icon name={download?.status === 'ready' ? 'check' : download?.status === 'downloading' ? 'pause' : download?.status === 'error' ? 'restart' : 'download'} size={download?.status === 'downloading' || download?.status === 'paused' ? 13 : 16} />
            </button>}
            {current && ratio > 0 && <span className="sd-episode-bar" style={{ width: `${ratio * 100}%` }} />}
          </article>;
        })}</div> : <div className="sd-empty"><strong>{episodes.length ? 'No matching episodes' : 'No streaming source found'}</strong>{episodes.length ? 'Try an episode number or a different title.' : anime.episodeLoadError || 'Please check back later.'}</div>}
        {pageCount > 1 && <div className="sd-pagination"><button disabled={page === 0} onClick={() => setSelectedPage(page - 1)}>Previous</button><span>{page + 1} / {pageCount}</span><button disabled={page + 1 >= pageCount} onClick={() => setSelectedPage(page + 1)}>Next</button></div>}
      </section>}

      {section === 'details' && <section className="sd-details" aria-label="Anime details"><div><h2>The story</h2><p>{anime.description || 'A synopsis is not available for this title yet.'}</p></div><dl>{[['Format', anime.type], ['Status', anime.status], ['Released', anime.year], ['Episodes', episodes.length || undefined], ['Genres', anime.genres?.join(', ')], ['Score', anime.score != null ? `${anime.score} / 10` : undefined]].map(([label, value]) => value != null && value !== '' ? <React.Fragment key={String(label)}><dt>{label}</dt><dd>{value}</dd></React.Fragment> : null)}</dl></section>}
      {section === 'discussion' && <section className="sd-discussion" aria-label="Discussion">{discussion}</section>}
      {section === 'creator' && creator && <section aria-label="Creator">{creator}</section>}
    </div>
  </main>;
}
