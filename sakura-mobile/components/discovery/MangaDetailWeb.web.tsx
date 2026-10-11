import React, { useMemo, useRef, useState } from 'react';
import { useTheme } from '@/lib/theme';
import CoverImage from '@/components/ui/CoverImage';
import { formatReleaseDate } from '@/lib/format-release-date';
import type { MangaDetailWebProps } from './MangaDetailWeb';
import './manga-detail.web.css';

function ChapterDownload({ chapter, entry, onDownload }: {
  chapter: MangaDetailWebProps['chapters'][number];
  entry: MangaDetailWebProps['offline'][string] | undefined;
  onDownload: () => void;
}) {
  const ready = entry?.status === 'ready';
  const active = entry?.status === 'downloading';
  const paused = entry?.status === 'paused';
  const action = ready ? 'Downloaded' : active ? 'Pause download' : paused ? 'Resume download' : entry?.status === 'error' ? 'Retry download' : 'Download';
  const progress = Math.round(Math.max(0, Math.min(1, entry?.progress || 0)) * 100);
  return <button className="md-download" disabled={ready} aria-label={`${action}: ${chapter.title || `Chapter ${chapter.number}`}${active || paused ? `, ${progress}%` : ''}`} onClick={onDownload}>
    <span aria-hidden="true">{ready ? '✓' : active ? 'Ⅱ' : paused ? '↻' : '↓'}</span>
    {(active || paused) && <small>{progress}%</small>}
  </button>;
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
  return <main className={`manga-detail-web ${isDark ? '' : 'md-light'}`}><div className="md-shell">
    <nav className="md-topbar" aria-label="Series navigation"><button onClick={props.onBack}>← <span>Back to browsing</span></button><span>Manga library</span><button onClick={props.onShare} disabled={!props.manga}>Share ↗</button></nav>
    {props.loading ? <div className="md-loading" role="status"><div/><section><span/><span/><p>Loading series…</p></section></div> : !props.manga ? <div className="md-empty" role="alert"><h1>Couldn’t open this series</h1><p>{props.error || 'The source is taking a moment. Please try again.'}</p><button onClick={props.onRetry}>Try again</button></div> : <>
      <section className="md-hero"><div className="md-cover"><CoverImage source={{uri:props.manga.cover}} style={{width:'100%',height:'100%'}} loading="eager" priority="high" thumbnailWidth={512} contentFit="cover" accessibilityLabel="" /></div><div className="md-copy"><div className="md-meta"><span>{props.manga.type || 'Manga'}</span>{props.manga.status && <span>{props.manga.status}</span>}{props.manga.rating != null && <span>★ {props.manga.rating.toFixed(1)}</span>}</div><h1>{props.manga.title}</h1><div className="md-tags">{props.manga.genres.slice(0,6).map(genre=><span key={genre}>{genre}</span>)}</div>{props.manga.description && <><p className={`md-description ${expanded ? 'expanded' : ''}`}>{props.manga.description}</p><button className="md-expand" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded ? 'Less' : 'Read synopsis'} {expanded ? '−' : '+'}</button></>}<div className="md-actions">{props.playChapter && <button className="md-primary" onClick={()=>props.onOpen(props.playChapter!,props.resume)}>{props.resume ? 'Continue reading' : 'Start reading'} <span>→</span></button>}{props.canSave && <button className="md-save" aria-pressed={props.saved} disabled={saving} onClick={save}>{saving ? 'Saving…' : props.saved ? '✓ In your library' : '+ Save to library'}</button>}</div>{props.resume && props.progress && <div className="md-progress"><p>{props.progress.chapterLabel} <span>Page {props.progress.page} of {props.progress.totalPages}</span></p><div><i style={{width:`${Math.max(0,Math.min(1,props.progress.progress))*100}%`}}/></div></div>}{actionError && <p role="alert" className="md-action-error">{actionError}</p>}</div></section>
      <section className="md-chapters" ref={chaptersRef}><header><div><h2>Chapters<span>.</span></h2><p>{props.chapters.length.toLocaleString()} available</p></div><div className="md-chapter-tools"><input aria-label="Find a chapter" type="search" placeholder="Find chapter…" value={query} onChange={event=>{setQuery(event.target.value);setPage(0)}}/><button onClick={()=>{props.onSort();setPage(0)}} aria-label="Change chapter order">{props.sort === 'oldest' ? 'Oldest first' : 'Newest first'} ↕</button></div></header>
      {props.chaptersError && <div className="md-empty" role="alert"><p>{props.chaptersError}</p><button onClick={props.onRetry}>Retry chapters</button></div>}
      <div className="md-chapter-list">{visible.map(chapter=><div className={`md-chapter ${props.resume && props.progress?.chapterId === chapter.id ? 'current' : ''}`} key={chapter.id}><button className="md-chapter-open" onClick={()=>props.onOpen(chapter)}><span className="md-number">{chapter.number}</span><span className="md-chapter-title">{chapter.title || `Chapter ${chapter.number}`}<small>{props.gated.has(chapter.id) ? 'Sakura Pass' : props.progress?.chapterId === chapter.id && props.resume ? 'Continue where you left off' : chapter.pageCount > 0 ? `${chapter.pageCount} pages` : 'Read chapter'}</small></span><time>{formatReleaseDate(chapter.createdAt)}</time><span aria-hidden="true">↗</span></button>{props.canDownload && <ChapterDownload chapter={chapter} entry={props.offline[chapter.id]} onDownload={()=>{setActionError('');void props.onDownload(chapter).catch(()=>setActionError('Download failed. Please try again.'))}}/>}</div>)}</div>
      {!props.chaptersError && !visible.length && <div className="md-empty"><h3>{query ? 'No matching chapter' : 'No chapters yet'}</h3>{query && <button onClick={()=>setQuery('')}>Clear search</button>}</div>}
      {count > 1 && <nav className="md-pagination" aria-label="Chapter pages"><button disabled={currentPage===0} onClick={()=>turnPage(currentPage-1)}>← Previous</button><span>{currentPage*50+1}–{Math.min((currentPage+1)*50,filtered.length)} of {filtered.length}</span><button disabled={currentPage===count-1} onClick={()=>turnPage(currentPage+1)}>Next →</button></nav>}</section>
      <section className="md-discussion">{props.discussion}</section>
    </>}{props.feedback}
  </div></main>;
}
