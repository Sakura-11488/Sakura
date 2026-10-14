import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, type Href } from 'expo-router';
import { useTheme } from '@/lib/theme';
import CoverImage from '@/components/ui/CoverImage';
import { formatReleaseDate } from '@/lib/format-release-date';
import { chapterReadPercent, isNewChapter } from '@/lib/chapter-progress';
import type { MangaRelatedTitle } from '@/lib/manga';
import { hoverMangaTitle, leaveMangaTitle, prefetchMangaTitle } from '@/lib/manga-prefetch';
import type { MangaDetailWebLink, MangaDetailWebProps } from './MangaDetailWeb';
import './manga-detail.web.css';

type Chapter = MangaDetailWebProps['chapters'][number];
type OfflineEntry = MangaDetailWebProps['offline'][string] | undefined;
type Filter = NonNullable<MangaDetailWebProps['filter']>;

const PAGE_SIZE = 50;

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

/**
 * Mark read / unread / previous as read for one chapter. Opened from the row's
 * ⋯ button, a right click, or a long press (mobile browsers fire contextmenu
 * for it). Closes on Escape, on a click elsewhere, and after an action.
 */
function ChapterMenu({ chapter, read, hasPrevious, onClose, onMarkRead, onMarkPrevious }: {
  chapter: Chapter;
  read: boolean;
  hasPrevious: boolean;
  onClose: (refocus: boolean) => void;
  onMarkRead: (chapter: Chapter, read: boolean) => void;
  onMarkPrevious: (chapter: Chapter) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(true); } };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const name = chapter.title || `Chapter ${chapter.number}`;
  return <div className="md-menu" role="menu" aria-label={`Options for ${name}`} ref={ref}>
    <button role="menuitem" onClick={() => { onMarkRead(chapter, !read); onClose(true); }}>{read ? 'Mark as unread' : 'Mark as read'}</button>
    {hasPrevious && <button role="menuitem" onClick={() => { onMarkPrevious(chapter); onClose(true); }}>Mark previous as read</button>}
  </div>;
}

function RelatedRail({ title, items }: { title: string; items: MangaRelatedTitle[] }) {
  return <section className="md-related" aria-label={title}>
    <h2>{title}<span>.</span></h2>
    <div className="md-rail">{items.map(item => {
      const ref = { id: item.id, type: 'manga', title: item.title, cover: item.cover };
      return <Link key={item.id} href={{ pathname: '/manga/[id]', params: { id: item.id } } as Href} asChild>
        <a className="md-rail-card" onPointerEnter={() => hoverMangaTitle(ref)} onPointerLeave={() => leaveMangaTitle(ref)} onFocus={() => prefetchMangaTitle(ref, 'intent')}>
          <div><CoverImage source={{ uri: item.cover }} style={{ width: '100%', height: '100%' }} contentFit="cover" loading="lazy" thumbnailWidth={256} accessibilityLabel="" />{typeof item.rating === 'number' && <span className="md-rail-rating">★ {item.rating.toFixed(1)}</span>}</div>
          <h3>{item.title}</h3>
          <p>{[item.relation, item.type].filter(Boolean).join(' · ') || 'Manga'}</p>
        </a>
      </Link>;
    })}</div>
  </section>;
}

export default function MangaDetailWeb(props: MangaDetailWebProps) {
  const { isDark } = useTheme();
  const [query, setQuery] = useState(''); const [page, setPage] = useState(0); const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false); const [actionError, setActionError] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** A row to scroll to once the page holding it has rendered (Jump to current). */
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const chaptersRef = useRef<HTMLElement>(null);
  const readIds = props.readIds;
  const readEnabled = !!props.readEnabled && !!readIds;
  const filtered = useMemo(() => props.chapters.filter(chapter => `${chapter.number} ${chapter.title}`.toLowerCase().includes(query.trim().toLowerCase())), [props.chapters, query]);
  const count = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); const currentPage = Math.min(page, count - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const turnPage = (next: number) => { setPage(next); chaptersRef.current?.scrollIntoView({block:'start',behavior:'auto'}); };
  const save = async () => { setSaving(true); setActionError(''); try { await props.onSave(); } catch { setActionError('Could not update your library. Please try again.'); } finally { setSaving(false); } };
  // Ascending order for "previous" lookups, whatever the display order.
  const firstChapterId = useMemo(() => {
    let first: Chapter | null = null;
    for (const c of props.chapters) if (!first || c.number < first.number) first = c;
    return first?.id ?? null;
  }, [props.chapters]);
  const currentIndex = props.currentChapterId ? filtered.findIndex(c => c.id === props.currentChapterId) : -1;

  /**
   * Open on the page holding the chapter you are on, once per title. The list
   * used to open at chapter 0, so someone on chapter 280 of 281 paged through
   * six pages of chapters to get back to it.
   */
  const openedOnCurrent = useRef<string | null>(null);
  const titleId = props.manga?.id ?? '';
  useEffect(() => {
    if (!titleId || openedOnCurrent.current === titleId || currentIndex < 0 || query) return;
    openedOnCurrent.current = titleId;
    setPage(Math.floor(currentIndex / PAGE_SIZE));
  }, [titleId, currentIndex, query]);

  const jumpToCurrent = () => {
    if (!props.currentChapterId) return;
    if (currentIndex < 0) {
      // Hidden by the search or the filter: clear them first.
      setQuery('');
      if (props.filter && props.filter !== 'all') props.onFilter?.('all');
    } else {
      setPage(Math.floor(currentIndex / PAGE_SIZE));
    }
    setScrollTo(props.currentChapterId);
  };
  // Runs after the commit that applied the jump (cleared search, filter,
  // page), so the row is in the DOM by now, or the chapter is not listed.
  useEffect(() => {
    if (!scrollTo) return;
    if (currentIndex < 0) { setScrollTo(null); return; }
    const targetPage = Math.floor(currentIndex / PAGE_SIZE);
    if (targetPage !== currentPage) { setPage(targetPage); return; }
    const row = chaptersRef.current?.querySelector<HTMLElement>(`[data-chapter-id="${CSS.escape(scrollTo)}"]`);
    setScrollTo(null);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    row.querySelector<HTMLButtonElement>('.md-chapter-open')?.focus({ preventScroll: true });
  }, [scrollTo, currentIndex, currentPage]);

  const closeMenu = React.useCallback((refocus: boolean) => {
    setMenuFor(previous => {
      if (refocus && previous) {
        requestAnimationFrame(() => chaptersRef.current?.querySelector<HTMLButtonElement>(`[data-chapter-id="${CSS.escape(previous)}"] .md-more`)?.focus());
      }
      return null;
    });
  }, []);

  // From the downloaded copy the play target can be a later chapter (the first
  // one downloaded), so say which rather than promising the start, as native
  // does. `chapters` arrives in display order, so the first is at either end.
  const first = props.sort === 'oldest' ? props.chapters[0] : props.chapters[props.chapters.length - 1];
  const playLabel = !props.playChapter ? '' : props.resumeKind === 'start' && first && props.playChapter.id === first.id ? 'Start reading' : props.playLabel || (props.resume ? 'Continue reading' : first && props.playChapter.id !== first.id ? `Read ${props.playChapter.title || `Chapter ${props.playChapter.number}`}` : 'Start reading');
  const manga = props.manga;
  const total = props.totalChapters ?? props.chapters.length;
  const filter: Filter = props.filter ?? 'all';
  const filters: [Filter, string][] = [
    ['all', 'All'],
    ...(readEnabled ? [['unread', `Unread${props.unreadCount ? ` ${props.unreadCount.toLocaleString()}` : ''}`] as [Filter, string]] : []),
    ...(props.downloadedCount ? [['downloaded', `Downloaded ${props.downloadedCount}`] as [Filter, string]] : []),
  ];
  const meta = manga ? [
    manga.type || 'Manga',
    manga.status,
    typeof manga.rating === 'number' ? `★ ${manga.rating.toFixed(1)}` : '',
    manga.views ? `${manga.views} views` : '',
    manga.year ? String(manga.year) : '',
  ].filter(Boolean) : [];
  const hasMoreInfo = !!(manga?.altTitles?.length || manga?.tags?.length);

  return <main className={`manga-detail-web ${isDark ? '' : 'md-light'}`}><div className="md-shell">
    <nav className="md-topbar" aria-label="Series navigation"><button onClick={props.onBack}>← <span>Back to browsing</span></button><span>{props.sourceLabel || 'Manga'} library</span><button onClick={props.onShare} disabled={!props.manga}>Share ↗</button></nav>
    {props.loading ? <div className="md-loading" role="status"><div/><section><span/><span/><p>Loading series…</p></section></div> : !manga ? <div className="md-empty" role="alert"><h1>Couldn’t open this series</h1><p>{props.error || 'The source is taking a moment. Please try again.'}</p><button onClick={props.onRetry}>Try again</button><Links links={props.errorLinks}/></div> : <>
      {props.notice && <div className="md-notice" role="status"><span>{props.notice.text}</span>{props.notice.actionLabel && props.notice.onAction && <button onClick={props.notice.onAction}>{props.notice.actionLabel}</button>}</div>}
      <section className="md-hero"><div className="md-cover"><CoverImage source={{uri:manga.cover}} placeholder={props.placeholderCover ? {uri:props.placeholderCover} : undefined} style={{width:'100%',height:'100%'}} loading="eager" priority="high" thumbnailWidth={512} contentFit="cover" accessibilityLabel="" /></div><div className="md-copy" aria-busy={!!props.detailPending}>
        <div className="md-meta">{meta.map(part => <span key={part}>{part}</span>)}</div>
        <h1>{manga.title}</h1>
        {props.credits && <p className="md-credits">{props.credits}</p>}
        <div className="md-tags">{manga.genres.slice(0,6).map(genre => props.browsableGenre?.(genre) && props.onBrowseGenre
          ? <button key={genre} className="md-genre-link" onClick={() => props.onBrowseGenre!(genre)} aria-label={`Browse ${genre}`}>{genre}</button>
          : <span key={genre}>{genre}</span>)}</div>
        {props.detailPending && <div className="md-pending-copy" aria-hidden="true"><i/><i/><i/></div>}
        {(manga.description || hasMoreInfo) && <>
          {manga.description && <p className={`md-description ${expanded ? 'expanded' : ''}`}>{manga.description}</p>}
          {expanded && hasMoreInfo && <div className="md-more-info">
            {!!manga.altTitles?.length && <p><b>Also known as</b> {manga.altTitles.join(' · ')}</p>}
            {!!manga.tags?.length && <div className="md-tag-cloud">{manga.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
          </div>}
          <button className="md-expand" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded ? 'Less' : manga.description ? 'Read synopsis' : 'More info'} {expanded ? '−' : '+'}</button>
        </>}
        <div className="md-actions">{!props.playChapter && props.chaptersPending && <button className="md-primary" disabled aria-busy="true"><span>Loading chapters…</span></button>}{props.playChapter && <button className="md-primary" data-kind={props.resumeKind} onClick={()=>props.onOpen(props.playChapter!,props.resume)}><span>{playLabel}</span> <span aria-hidden="true">→</span></button>}{props.canSave && <button className="md-save" aria-pressed={props.saved} disabled={saving} onClick={save}>{saving ? 'Saving…' : props.saved ? '✓ In your library' : '+ Save to library'}</button>}{props.batch && <BatchDownload {...props.batch}/>}</div>
        {props.resume && props.progress && <div className="md-progress"><p>{props.progress.chapterLabel} <span>Page {props.progress.page} of {props.progress.totalPages}</span></p><div><i style={{width:`${Math.max(0,Math.min(1,props.progress.progress))*100}%`}}/></div></div>}
        {actionError && <p role="alert" className="md-action-error">{actionError}</p>}
      </div></section>
      <section className="md-chapters" ref={chaptersRef}>
        <header>
          <div><h2>Chapters<span>.</span></h2><p>{props.chaptersPending ? 'Loading chapters…' : props.latestSummary ? `${total.toLocaleString()} chapters · ${props.latestSummary}` : `${total.toLocaleString()} available`}</p></div>
          <div className="md-chapter-tools">
            <input aria-label="Find a chapter" type="search" placeholder="Find chapter…" value={query} onChange={event=>{setQuery(event.target.value);setPage(0)}}/>
            {props.currentChapterId && <button onClick={jumpToCurrent}>Jump to current</button>}
            <button onClick={()=>{props.onSort();setPage(0)}} aria-label={`Chapter order: ${props.sort === 'oldest' ? 'oldest first' : 'newest first'}. Change order`}>{props.sort === 'oldest' ? 'Oldest first' : 'Newest first'} ↕</button>
          </div>
        </header>
        {filters.length > 1 && props.onFilter && <div className="md-filters" role="group" aria-label="Show chapters">{filters.map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => { props.onFilter!(value); setPage(0); }}>{label}</button>)}</div>}
        {props.chaptersError && <div className="md-empty" role="alert"><p>{props.chaptersError}</p><button onClick={props.onRetry}>Retry chapters</button><Links links={props.chaptersErrorLinks}/></div>}
        <div className="md-chapter-list">{visible.map(chapter=>{
          const entry = props.offline[chapter.id];
          // Hidden, as on native, wherever a tap could not work: offline, or a
          // pass-locked chapter without a pass.
          const canDownload = props.canDownload && (props.canDownloadChapter?.(chapter.id) ?? true);
          const unavailable = !!props.downloadsOnly && entry?.status !== 'ready';
          const status = chapterStatus(entry, unavailable, canDownload);
          const read = readEnabled && readIds!.has(chapter.id);
          const percent = readEnabled ? chapterReadPercent(chapter, props.progress) : null;
          const fresh = !read && isNewChapter(chapter);
          const current = props.currentChapterId === chapter.id;
          const sub = props.gated.has(chapter.id) ? 'Sakura Pass' : percent ? `${percent}% read · continue where you left off` : current && props.resumeKind === 'next' ? 'Up next' : read ? 'Read' : chapter.pageCount > 0 ? `${chapter.pageCount} pages` : 'Read chapter';
          return <div
            className={`md-chapter ${current ? 'current' : ''} ${unavailable ? 'unavailable' : ''} ${read ? 'read' : ''}`}
            key={chapter.id}
            data-chapter-id={chapter.id}
            onContextMenu={readEnabled && props.onMarkRead ? event => { event.preventDefault(); setMenuFor(chapter.id); } : undefined}
          >
            <button className="md-chapter-open" onClick={()=>props.onOpen(chapter)} aria-label={`${chapter.title || `Chapter ${chapter.number}`}${percent ? `, ${percent}% read` : read ? ', read' : fresh ? ', new' : ''}`}>
              <span className="md-number">{read ? <span className="md-check" aria-hidden="true">✓</span> : chapter.number}</span>
              <span className="md-chapter-title">{chapter.title || `Chapter ${chapter.number}`}{fresh && <em className="md-new">New</em>}<small data-progress={percent ? '' : undefined}>{sub}</small>{percent ? <span className="md-row-progress" aria-hidden="true"><i style={{ width: `${percent}%` }}/></span> : null}{status && <small className="md-chapter-status" data-tone={status.tone}>{status.text}</small>}</span>
              <time>{formatReleaseDate(chapter.createdAt)}</time><span aria-hidden="true">↗</span>
            </button>
            {readEnabled && props.onMarkRead && <div className="md-more-wrap">
              <button className="md-more" aria-label={`Options for ${chapter.title || `Chapter ${chapter.number}`}`} aria-haspopup="menu" aria-expanded={menuFor === chapter.id} onClick={() => setMenuFor(menuFor === chapter.id ? null : chapter.id)}>⋯</button>
              {menuFor === chapter.id && <ChapterMenu chapter={chapter} read={read} hasPrevious={chapter.id !== firstChapterId} onClose={closeMenu} onMarkRead={props.onMarkRead} onMarkPrevious={c => props.onMarkPrevious?.(c)}/>}
            </div>}
            {canDownload && <ChapterDownload chapter={chapter} entry={entry} onDownload={()=>{setActionError('');void props.onDownload(chapter).catch(()=>setActionError('Download failed. Please try again.'))}}/>}
          </div>;
        })}</div>
        {props.chaptersPending && !visible.length && <div className="md-chapter-list md-pending-list" role="status" aria-label="Loading chapters">{Array.from({length:6},(_,i)=><div key={i} className="md-chapter"><i/></div>)}</div>}
        {!props.chaptersError && !props.chaptersPending && !visible.length && <div className="md-empty"><h3>{query ? 'No matching chapter' : filter === 'unread' ? 'All caught up' : filter === 'downloaded' ? 'Nothing downloaded' : 'No chapters yet'}</h3>{query ? <button onClick={()=>setQuery('')}>Clear search</button> : filter !== 'all' && props.onFilter ? <button onClick={() => props.onFilter!('all')}>Show all chapters</button> : null}</div>}
        {count > 1 && <nav className="md-pagination" aria-label="Chapter pages"><button disabled={currentPage===0} onClick={()=>turnPage(currentPage-1)}>← Previous</button><span>{currentPage*PAGE_SIZE+1}–{Math.min((currentPage+1)*PAGE_SIZE,filtered.length)} of {filtered.length}</span><button disabled={currentPage===count-1} onClick={()=>turnPage(currentPage+1)}>Next →</button></nav>}
      </section>
      {props.showRelated && !!manga.related?.length && <RelatedRail title="Related" items={manga.related}/>}
      {props.showRelated && !!manga.similar?.length && <RelatedRail title="More like this" items={manga.similar}/>}
      <section className="md-discussion">{props.discussion}</section>
    </>}{props.feedback}
  </div></main>;
}
