import React from 'react';

export type PlayerIconName = 'play' | 'pause' | 'back' | 'rewind' | 'forward' | 'volume' | 'muted' | 'captions' | 'settings' | 'fullscreen' | 'collapse' | 'next' | 'check' | 'flower';
const paths: Record<PlayerIconName, React.ReactNode> = {
  play: <path d="m9 5 11 7-11 7z" fill="currentColor" stroke="none" />,
  pause: <><path d="M8 5v14M16 5v14" strokeWidth="4" /></>,
  back: <path d="m14 5-7 7 7 7M7 12h14" />,
  rewind: <><path d="M4 9a8 8 0 1 1 0 7M4 4v5h5" /><text x="12" y="15" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7" fontWeight="700">10</text></>,
  forward: <><path d="M20 9a8 8 0 1 0 0 7M20 4v5h-5" /><text x="12" y="15" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7" fontWeight="700">10</text></>,
  volume: <><path d="m11 5-5 4H3v6h3l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></>,
  muted: <><path d="m11 5-5 4H3v6h3l5 4zM16 9l5 6M21 9l-5 6" /></>,
  captions: <><rect x="2.5" y="5" width="19" height="14" rx="3" /><path d="M10 9H7v6h3M18 9h-3v6h3" /></>,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="currentColor" stroke="none" /><circle cx="15" cy="17" r="3" fill="currentColor" stroke="none" /></>,
  fullscreen: <path d="M9 3H3v6M15 3h6v6M21 15v6h-6M9 21H3v-6" />,
  collapse: <path d="M3 9h6V3M15 3v6h6M21 15h-6v6M9 21v-6H3" />,
  next: <><path d="m5 5 10 7-10 7z" fill="currentColor" stroke="none" /><path d="M19 5v14" /></>,
  check: <path d="m5 12 4 4L20 5" />,
  flower: <path d="M12 11C1 6 7-2 12 6c5-8 11 0 1 5 10-3 12 7 3 5 6 7-4 11-5 2-4 8-12 2-5-3-9 0-6-10 6-4Z" fill="currentColor" stroke="none" />,
};
export default function PlayerIcon({ name }: { name: PlayerIconName }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
