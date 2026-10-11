import React from 'react';
import WebAppShell from './WebAppShell';
import type { WebRouteFrameProps } from './WebRouteFrame';
// Reading, playback and creative canvases keep their distraction-free surfaces.
const immersive = new Set(['(tabs)', 'index', 'welcome', 'anime/watch', 'chapter/[id]', 'novel/read', 'ai', 'pose-studio', 'fan-art', 'trade', 'swap-xp']);
const compact = new Set(['reading-history', 'downloads', 'creator-feed', 'creator-profile', 'creator-upload', 'work/[id]', 'edit-profile']);
export default function WebRouteFrame({ routeName, children }: WebRouteFrameProps) {
  if (immersive.has(routeName)) return <>{children}</>;
  return <WebAppShell><div className="ss-route-frame" data-route={routeName} data-compact={compact.has(routeName)}><style>{`.ss-route-frame{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;width:100%}.ss-route-frame>div{min-width:0}@media(min-width:1000px){.ss-route-frame[data-compact=true]{max-width:960px;margin-inline:auto;padding:24px 28px;box-sizing:border-box}}`}</style>{children}</div></WebAppShell>;
}
