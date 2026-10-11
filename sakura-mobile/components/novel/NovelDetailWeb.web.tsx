import React, { useMemo, useState } from 'react';
import CoverImage from '@/components/ui/CoverImage';
import { isActiveReadingProgress } from '@/lib/reader-progress';
import type { NovelDetailWebProps } from './NovelDetailWeb';
import './novel-detail.web.css';

function Icon({ name, size = 18 }: { name: 'back' | 'save' | 'check' | 'share' | 'arrow' | 'download' | 'search' | 'book'; size?: number }) {
  const paths = { back: 'm14 6-6 6 6 6', save: 'M6 3h12v18l-6-4-6 4V3Z', check: 'm5 12 4 4L19 6', share: 'M12 16V3m-4 4 4-4 4 4M5 13v7h14v-7', arrow: 'M4 12h16m-6-6 6 6-6 6', download: 'M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4', search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 6 6', book: 'M12 5.5C8.5 3.5 5.5 3.5 2.5 5v15c3-1.5 6-1.5 9.5.5 3.5-2 6.5-2 9.5-.5V5c-3-1.5-6-1.5-9.5.5ZM12 5.5v15' };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
const PAGE_SIZE = 40;

export default function NovelDetailWeb(props: NovelDetailWebProps) {
  const { detail, loading, error, saved, original, progress, offline, batchDownloading, batchPaused, batchProgress, toast, onBack, onRetry, onSave, onShare, onOpen, onDownload, onDownloadAll } = props;
  const [query, setQuery] = useState('');
  const [descending, setDescending] = useState(false);
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const chapters = useMemo(() => [...(detail?.chapters || [])].sort((a, b) => a.chapterNumber - b.chapterNumber), [detail?.chapters]);
  const resumeChapter = progress && isActiveReadingProgress(progress.progress) ? chapters.find(chapter => chapter.path === progress.path) : undefined;
  const firstChapter = resumeChapter || chapters[0];
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const result = normalized ? chapters.filter(chapter => String(chapter.chapterNumber).includes(normalized) || chapter.name.toLowerCase().includes(normalized)) : chapters;
    return descending ? [...result].reverse() : result;
  }, [chapters, query, descending]);
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const resumeIndex = resumeChapter ? filtered.findIndex(chapter => chapter.path === resumeChapter.path) : 0;
  const page = Math.max(0, Math.min(pageCount - 1, selectedPage ?? (query ? 0 : Math.floor(Math.max(0, resumeIndex) / PAGE_SIZE))));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const progressValue = Math.min(100, Math.max(0, Math.round((progress?.progress || 0) * 100)));

  return <main className="novel-detail-web"><div className="nd-shell"><nav className="nd-nav" aria-label="Novel navigation"><button onClick={onBack}><Icon name="back" />Novels</button><span>SAKURA / READ</span><div><button aria-label="Share novel" onClick={onShare} disabled={!detail}><Icon name="share" /></button><button aria-label={saved ? 'Remove novel from library' : 'Save novel to library'} aria-pressed={saved} onClick={onSave} disabled={!detail}><Icon name={saved ? 'check' : 'save'} /></button></div></nav>
    {loading ? <div className="nd-loading" aria-busy="true" aria-label="Loading novel"><div className="nd-loading-cover" /><div><span /><span /><span /></div></div> : !detail || error ? <section className="nd-empty"><Icon name="book" size={36} /><h1>This novel could not be loaded.</h1><p>{error || 'The title may be unavailable right now.'}</p><button className="nd-primary" onClick={onRetry}>Try again</button></section> : <>
      <section className="nd-introduction" aria-labelledby="nd-title"><div className="nd-book"><CoverImage source={{ uri: detail.cover || '' }} style={{ width: '100%', height: '100%' }} contentFit="cover" priority="high" thumbnailWidth={512} accessibilityLabel={detail.name} /></div><div className="nd-copy"><p className="nd-eyebrow">{original ? 'Sakura Original' : 'Web novel'}</p><h1 id="nd-title">{detail.name}</h1>{detail.author && <p className="nd-author">by {detail.author}</p>}<div className="nd-meta">{detail.status && <span>{detail.status}</span>}<span>{chapters.length.toLocaleString()} chapters</span>{detail.rating != null && <span>★ {detail.rating.toFixed(1)} / 10</span>}</div>{detail.genres && <p className="nd-genres">{detail.genres.split(',').map(value => value.trim()).filter(Boolean).join(' · ')}</p>}
        {firstChapter && <div className="nd-reading-action"><button className="nd-primary" onClick={() => onOpen(firstChapter, !!resumeChapter)}><Icon name="book" size={17} />{resumeChapter ? 'Continue reading' : 'Start reading'}<Icon name="arrow" size={16} /></button><button className="nd-download-all" onClick={onDownloadAll}><Icon name="download" size={16} />{batchPaused ? 'Resume download' : batchDownloading ? `Pause${batchProgress ? ` · ${batchProgress.done}/${batchProgress.total}` : ''}` : `Download ${Math.min(chapters.length, 30)} chapters`}</button></div>}
        {resumeChapter && <div className="nd-resume"><p>{resumeChapter.name} <span>{progressValue}% read</span></p><div role="progressbar" aria-label="Chapter reading progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressValue}><span style={{ width: `${progressValue}%` }} /></div></div>}
      </div></section>
      {detail.summary && <section className="nd-synopsis"><h2>About this book</h2><div><p className={expanded ? 'is-expanded' : ''}>{detail.summary}</p><button aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Read less' : 'Read more'}</button></div></section>}
      <section className="nd-chapters" aria-labelledby="nd-chapters-title"><div className="nd-chapter-heading"><div><p className="nd-eyebrow">Contents</p><h2 id="nd-chapters-title">Chapters <span>{chapters.length.toLocaleString()}</span></h2></div><div className="nd-chapter-controls"><label className="nd-search"><Icon name="search" size={16} /><input type="search" aria-label="Find a chapter by title or number" placeholder="Find a chapter" value={query} onChange={event => { setQuery(event.target.value); setSelectedPage(0); }} /></label><select aria-label="Chapter order" value={descending ? 'newest' : 'oldest'} onChange={event => { setDescending(event.target.value === 'newest'); setSelectedPage(0); }}><option value="oldest">Oldest first</option><option value="newest">Newest first</option></select></div></div>
        {visible.length ? <div className="nd-chapter-list">{visible.map(chapter => { const download = offline[chapter.path]; const current = chapter.path === resumeChapter?.path; return <article key={chapter.path} className="nd-chapter-row" data-current={current}><button className="nd-open-chapter" onClick={() => onOpen(chapter, current)}><span className="nd-chapter-number">{String(chapter.chapterNumber).padStart(2, '0')}</span><span className="nd-chapter-copy"><strong>{chapter.name || `Chapter ${chapter.chapterNumber}`}</strong>{current ? <small>Continue · {progressValue}% read</small> : download?.status === 'ready' ? <small>Available offline</small> : chapter.releaseTime ? <small>{chapter.releaseTime}</small> : null}</span><Icon name="arrow" size={15} /></button><button className="nd-download" aria-label={download?.status === 'ready' ? `Chapter ${chapter.chapterNumber} downloaded` : `Download chapter ${chapter.chapterNumber}`} title={download?.status === 'ready' ? 'Available offline' : 'Download chapter'} onClick={() => onDownload(chapter)} disabled={download?.status === 'downloading' || download?.status === 'ready'}>{download?.status === 'downloading' ? `${Math.round(download.progress * 100)}%` : <Icon name={download?.status === 'ready' ? 'check' : 'download'} size={16} />}</button></article>; })}</div> : <div className="nd-no-chapters"><p>{query ? 'No chapters match your search.' : 'No chapters have been published yet.'}</p>{query && <button onClick={() => setQuery('')}>Clear search</button>}</div>}
        {pageCount > 1 && <div className="nd-pagination"><button onClick={() => setSelectedPage(page - 1)} disabled={page === 0}>Previous</button><label><span>Chapter range</span><select value={page} onChange={event => setSelectedPage(Number(event.target.value))} aria-label="Chapter range">{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{filtered[index * PAGE_SIZE].chapterNumber}–{filtered[Math.min(filtered.length - 1, (index + 1) * PAGE_SIZE - 1)].chapterNumber}</option>)}</select></label><button onClick={() => setSelectedPage(page + 1)} disabled={page + 1 === pageCount}>Next</button></div>}
      </section>
    </>}
    {toast && <div className="nd-toast" role="status">{toast}</div>}
  </div></main>;
}
