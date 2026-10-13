import React, { useMemo, useRef, useState } from 'react';
import { useTheme } from '@/lib/theme';
import CoverImage from '@/components/ui/CoverImage';
import { formatReleaseDate } from '@/lib/format-release-date';
import type { MangaDetailWebLink, MangaDetailWebProps } from './MangaDetailWeb';
import './manga-detail.web.css';

type Chapter = MangaDetailWebProps['chapters'][number];
type OfflineEntry = MangaDetailWebProps['offline'][string] | undefined;

// Accessible names follow native's ChapterRow ("Download Chapter 1", "Pause
// download of Chapter 1"), so one browser flow can drive either layout.
function ChapterDownload({ chapter, entry, onDownload }: {
  chapter: Chapter;
  entry: OfflineEntry;
  onDownload: () => void;
}) {
  const ready = entry?.status === 'ready';
  const active = entry?.status === 'downloading';
  const paused = entry?.status === 'paused';
  const name = chapter.title || `Chapter ${chapter.number}`;
  const progress = Math.round(Math.max(0, Math.min(1, entry?.progress || 0)) * 100);
  const label = ready ? `${name} downloaded` : active ? `Pause download of ${name}, ${progress}%` : paused ? `Resume download of ${name}, ${progress}%` : entry?.status === 'error' ? `Retry download of ${name}` : `Download ${name}`;
  return <button className="md-download" disabled={ready} aria-label={label} onClick={onDownload}>
    <span aria-hidden="true">{ready ? '✓' : active ? 'Ⅱ' : paused ? '↻' : '↓'}</span>
    {(active || paused) && <small>{progress}%</small>}
  </button>;
}

/**
 * The row's download line, as native's ChapterRow has it. Downloading and
 * paused are already on the button as a percentage, so they add no line here.
 * Offline, a chapter that is not downloaded says why it will not open rather
 * than looking like any other row.
 */
function chapterStatus(entry: OfflineEntry, unavailable: boolean, canRetry: boolean): { text: string; tone?: 'ready' | 'error' } | null {
  if (unavailable) return { text: 'Not downloaded · needs a connection' };
  if (entry?.status === 'ready') return { text: 'Downloaded', tone: 'ready' };
  if (entry?.status === 'error') return { text: canRetry ? 'Download failed · tap ↓ to retry' : 'Download failed', tone: 'error' };
  return null;
}

/**
 * Download all, then Pause / Resume while that batch is under way. It runs a
 * chapter at a time, so progress counts chapters, as on native.
 */
function BatchDownload({ state, progress, onPress }: NonNullable<MangaDetailWebProps['batch']>) {
  const counted = state !== 'idle' && progress && progress.total > 0 ? progress : null;
  const label = state === 'paused' ? 'Resume' : state === 'running' ? 'Pause' : 'Download all';
  const name = state === 'idle' ? undefined : `${label} downloading all chapters${counted ? `, ${counted.done} of ${counted.total} done` : ''}`;
  return <button className="md-batch" data-state={state} aria-label={name} onClick={onPress}>
    <span aria-hidden="true">{state === 'paused' ? '↻' : state === 'running' ? 'Ⅱ' : '↓'}</span>
    <span>{label}</span>
    {counted && <small aria-hidden="true">{counted.done}/{counted.total}</small>}
    {counted && <i aria-hidden="true" style={{width:`${Math.min(1, counted.done / counted.total) * 100}%`}}/>}
  </button>;
}

function Links({ links }: { links?: MangaDetailWebLink[] }) {
  return links?.length ? <div className="md-links">{links.map(link => <button key={link.label} onClick={link.onPress}>{link.label}</button>)}</div> : null;
}

export default function MangaDetailWeb(props: MangaDetailWebProps) {
  const { isDark } = useTheme();
  const [query, setQuery] = useState(''); const [page, setPage] = useState(0); const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false); const [actionError, setActionError] = useState('');
  const chaptersRef = useRef<HTMLElement>(null);
  const filtered = useMemo(() => props.chapters.filter(chapter => `${chapter.number} ${chapter.title}`.toLowerCase().includes(query.trim().toLowerCase())), [props.chapters, query]);
  const count = Math.max(1, Math.ceil(filtered.length / 50)); const currentPage = Math.min(page, count - 1);
  const visible = filtered.slice(currentPage * 50, (currentPage + 1) * 50);
  const turnPage = (next: number) => { setPage(next); chaptersRef.current?.scrollIntoView({block:'start',behavior:'auto'}); };
  const save = async () => { setSaving(true); setActionError(''); try { await props.onSave(); } catch { setActionError('Could not update your library. Please try again.'); } finally { setSaving(false); } };
  // From the downloaded copy the play target can be a later chapter (the first
  // one downloaded), so say which rather than promising the start, as native
  // does. `chapters` arrives in display order, so the first is at either end.
  const first = props.sort === 'oldest' ? props.chapters[0] : props.chapters[props.chapters.length - 1];
  const playLabel = !props.playChapter ? '' : props.resume ? 'Continue reading' : first && props.playChapter.id !== first.id ? `Read ${props.playChapter.title || `Chapter ${props.playChapter.number}`}` : 'Start reading';
  return <main className={`manga-detail-web ${isDark ? '' : 'md-light'}`}><div className="md-shell">
    <nav className="md-topbar" aria-label="Series navigation"><button onClick={props.onBack}>← <span>Back to browsing</span></button><span>Manga library</span><button onClick={props.onShare} disabled={!props.manga}>Share ↗</button></nav>
    {props.loading ? <div className="md-loading" role="status"><div/><section><span/><span/><p>Loading series…</p></section></div> : !props.manga ? <div className="md-empty" role="alert"><h1>Couldn’t open this series</h1><p>{props.error || 'The source is taking a moment. Please try again.'}</p><button onClick={props.onRetry}>Try again</button><Links links={props.errorLinks}/></div> : <>
      {props.notice && <div className="md-notice" role="status"><span>{props.notice.text}</span>{props.notice.actionLabel && props.notice.onAction && <button onClick={props.notice.onAction}>{props.notice.actionLabel}</button>}</div>}
      <section className="md-hero"><div className="md-cover"><CoverImage source={{uri:props.manga.cover}} style={{width:'100%',height:'100%'}} loading="eager" priority="high" thumbnailWidth={512} contentFit="cover" accessibilityLabel="" /></div><div className="md-copy"><div className="md-meta"><span>{props.manga.type || 'Manga'}</span>{props.manga.status && <span>{props.manga.status}</span>}{props.manga.rating != null && <span>★ {props.manga.rating.toFixed(1)}</span>}</div><h1>{props.manga.title}</h1><div className="md-tags">{props.manga.genres.slice(0,6).map(genre=><span key={genre}>{genre}</span>)}</div>{props.manga.description && <><p className={`md-description ${expanded ? 'expanded' : ''}`}>{props.manga.description}</p><button className="md-expand" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded ? 'Less' : 'Read synopsis'} {expanded ? '−' : '+'}</button></>}<div className="md-actions">{props.playChapter && <button className="md-primary" onClick={()=>props.onOpen(props.playChapter!,props.resume)}><span>{playLabel}</span> <span aria-hidden="true">→</span></button>}{props.canSave && <button className="md-save" aria-pressed={props.saved} disabled={saving} onClick={save}>{saving ? 'Saving…' : props.saved ? '✓ In your library' : '+ Save to library'}</button>}{props.batch && <BatchDownload {...props.batch}/>}</div>{props.resume && props.progress && <div className="md-progress"><p>{props.progress.chapterLabel} <span>Page {props.progress.page} of {props.progress.totalPages}</span></p><div><i style={{width:`${Math.max(0,Math.min(1,props.progress.progress))*100}%`}}/></div></div>}{actionError && <p role="alert" className="md-action-error">{actionError}</p>}</div></section>
      <section className="md-chapters" ref={chaptersRef}><header><div><h2>Chapters<span>.</span></h2><p>{props.chapters.length.toLocaleString()} available</p></div><div className="md-chapter-tools"><input aria-label="Find a chapter" type="search" placeholder="Find chapter…" value={query} onChange={event=>{setQuery(event.target.value);setPage(0)}}/><button onClick={()=>{props.onSort();setPage(0)}} aria-label="Change chapter order">{props.sort === 'oldest' ? 'Oldest first' : 'Newest first'} ↕</button></div></header>
      {props.chaptersError && <div className="md-empty" role="alert"><p>{props.chaptersError}</p><button onClick={props.onRetry}>Retry chapters</button><Links links={props.chaptersErrorLinks}/></div>}
      <div className="md-chapter-list">{visible.map(chapter=>{
        const entry = props.offline[chapter.id];
        // Hidden, as on native, wherever a tap could not work: offline, or a
        // pass-locked chapter without a pass.
        const canDownload = props.canDownload && (props.canDownloadChapter?.(chapter.id) ?? true);
        const unavailable = !!props.downloadsOnly && entry?.status !== 'ready';
        const status = chapterStatus(entry, unavailable, canDownload);
        return <div className={`md-chapter ${props.resume && props.progress?.chapterId === chapter.id ? 'current' : ''} ${unavailable ? 'unavailable' : ''}`} key={chapter.id}><button className="md-chapter-open" onClick={()=>props.onOpen(chapter)}><span className="md-number">{chapter.number}</span><span className="md-chapter-title">{chapter.title || `Chapter ${chapter.number}`}<small>{props.gated.has(chapter.id) ? 'Sakura Pass' : props.progress?.chapterId === chapter.id && props.resume ? 'Continue where you left off' : chapter.pageCount > 0 ? `${chapter.pageCount} pages` : 'Read chapter'}</small>{status && <small className="md-chapter-status" data-tone={status.tone}>{status.text}</small>}</span><time>{formatReleaseDate(chapter.createdAt)}</time><span aria-hidden="true">↗</span></button>{canDownload && <ChapterDownload chapter={chapter} entry={entry} onDownload={()=>{setActionError('');void props.onDownload(chapter).catch(()=>setActionError('Download failed. Please try again.'))}}/>}</div>;
      })}</div>
      {!props.chaptersError && !visible.length && <div className="md-empty"><h3>{query ? 'No matching chapter' : 'No chapters yet'}</h3>{query && <button onClick={()=>setQuery('')}>Clear search</button>}</div>}
      {count > 1 && <nav className="md-pagination" aria-label="Chapter pages"><button disabled={currentPage===0} onClick={()=>turnPage(currentPage-1)}>← Previous</button><span>{currentPage*50+1}–{Math.min((currentPage+1)*50,filtered.length)} of {filtered.length}</span><button disabled={currentPage===count-1} onClick={()=>turnPage(currentPage+1)}>Next →</button></nav>}</section>
      <section className="md-discussion">{props.discussion}</section>
    </>}{props.feedback}
  </div></main>;
}
