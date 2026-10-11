import React, { useLayoutEffect, useState, type CSSProperties, type PropsWithChildren } from 'react';

type Viewport = {
  width: number;
  height: number;
  left: number;
  top: number;
  mobile: boolean;
};

type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape') => Promise<void>;
};

type OrientationClaim = { id: number; active: boolean; orientation: LockableOrientation };
// Orientation is document-wide. A late result from an old route must never
// unlock a newer route's acquired (or still pending) orientation request.
let nextClaimId = 0;
let lockedClaim: OrientationClaim | null = null;
const pendingClaims = new Set<number>();

function releaseInactiveLock(): void {
  if (!lockedClaim || lockedClaim.active) return;
  for (const pending of pendingClaims) if (pending > lockedClaim.id) return;
  const previous = lockedClaim;
  lockedClaim = null;
  try { previous.orientation.unlock(); } catch { /* CSS remains the fallback. */ }
}

const MOBILE_POINTER = '(pointer: coarse) and (hover: none)';

function hasEditableFocus(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable || /^(TEXTAREA|SELECT)$/.test(active.tagName)) return true;
  // Timeline/volume ranges keep focus after scrubbing but never open a keyboard.
  return active instanceof HTMLInputElement && /^(text|search|email|url|tel|password|number)$/.test(active.type);
}

function readViewport(): Viewport {
  if (typeof window === 'undefined') return { width: 0, height: 0, left: 0, top: 0, mobile: false };
  const visible = window.visualViewport;
  // A pinch changes the visual viewport, not the intended player layout.
  const useVisible = !!visible && Math.abs(visible.scale - 1) < 0.01 && !hasEditableFocus();
  const width = Math.max(1, useVisible ? visible.width : document.documentElement.clientWidth || window.innerWidth);
  const height = Math.max(1, useVisible ? visible.height : document.documentElement.clientHeight || window.innerHeight);
  return {
    width,
    height,
    left: useVisible ? visible.offsetLeft : 0,
    top: useVisible ? visible.offsetTop : 0,
    mobile: window.matchMedia(MOBILE_POINTER).matches && Math.min(width, height) <= 900,
  };
}

export default function WatchViewport({ children }: PropsWithChildren) {
  const [viewport, setViewport] = useState(readViewport);
  const rotated = viewport.mobile && viewport.height > viewport.width;

  useLayoutEffect(() => {
    const pointer = window.matchMedia(MOBILE_POINTER);
    const visible = window.visualViewport;
    const orientation = window.screen.orientation as LockableOrientation | undefined;
    let disposed = false;
    let eligible = false;
    let claim: OrientationClaim | null = null;
    let frame = 0;
    let layoutWidth = document.documentElement.clientWidth;
    let layoutHeight = document.documentElement.clientHeight;

    const releaseLock = () => {
      if (!claim) return;
      claim.active = false;
      claim = null;
      releaseInactiveLock();
    };

    const requestLandscape = () => {
      if (disposed || !eligible || claim || !orientation?.lock) return;
      const request: OrientationClaim = { id: ++nextClaimId, active: true, orientation };
      claim = request;
      pendingClaims.add(request.id);
      const failed = () => {
        pendingClaims.delete(request.id);
        request.active = false;
        if (claim === request) claim = null;
        releaseInactiveLock();
      };
      try {
        void Promise.resolve(orientation.lock('landscape')).then(() => {
          pendingClaims.delete(request.id);
          if (!lockedClaim || request.id > lockedClaim.id) lockedClaim = request;
          // The request can settle after navigation or a pointer-mode change.
          if (disposed || !eligible || claim !== request) request.active = false;
          releaseInactiveLock();
        }, failed);
      } catch {
        failed();
      }
    };

    const update = () => {
      frame = 0;
      if (disposed) return;
      // A pinch keeps the layout viewport unchanged. A real resize can also
      // change browser scale briefly, so measure that using layout dimensions.
      if (hasEditableFocus()) return;
      const nextLayoutWidth = document.documentElement.clientWidth;
      const nextLayoutHeight = document.documentElement.clientHeight;
      const layoutChanged = nextLayoutWidth !== layoutWidth || nextLayoutHeight !== layoutHeight;
      if (visible && Math.abs(visible.scale - 1) >= 0.01 && !layoutChanged) return;
      const next = readViewport();
      layoutWidth = nextLayoutWidth;
      layoutHeight = nextLayoutHeight;
      const becameEligible = next.mobile && !eligible;
      eligible = next.mobile;
      if (!eligible) releaseLock();
      setViewport(previous => (
        previous.width === next.width && previous.height === next.height &&
        previous.left === next.left && previous.top === next.top && previous.mobile === next.mobile
          ? previous : next
      ));
      if (becameEligible) requestLandscape();
    };

    const scheduleUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const onFullscreenChange = () => {
      if (frame) window.cancelAnimationFrame(frame);
      // Browsers may release their orientation lock on fullscreen exit.
      const fullscreenDocument = document as Document & { webkitFullscreenElement?: Element | null };
      const fullscreen = document.fullscreenElement || fullscreenDocument.webkitFullscreenElement;
      if (!fullscreen) releaseLock();
      update();
      if (fullscreen) requestLandscape();
    };

    update();
    window.addEventListener('resize', scheduleUpdate);
    visible?.addEventListener('resize', scheduleUpdate);
    visible?.addEventListener('scroll', scheduleUpdate, { passive: true });
    document.addEventListener('focusin', scheduleUpdate);
    document.addEventListener('focusout', scheduleUpdate);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    if (pointer.addEventListener) pointer.addEventListener('change', scheduleUpdate);
    else pointer.addListener(scheduleUpdate);

    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleUpdate);
      visible?.removeEventListener('resize', scheduleUpdate);
      visible?.removeEventListener('scroll', scheduleUpdate);
      document.removeEventListener('focusin', scheduleUpdate);
      document.removeEventListener('focusout', scheduleUpdate);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      if (pointer.removeEventListener) pointer.removeEventListener('change', scheduleUpdate);
      else pointer.removeListener(scheduleUpdate);
      releaseLock();
    };
  }, []);

  const outerStyle: CSSProperties = {
    ...shellStyle,
    left: viewport.left,
    top: viewport.top,
    width: viewport.width || '100vw',
    height: viewport.height || '100dvh',
  };
  const innerStyle: CSSProperties = {
    ...contentStyle,
    width: rotated ? viewport.height : '100%',
    height: rotated ? viewport.width : '100%',
    transform: rotated ? `translateX(${viewport.width}px) rotate(90deg)` : undefined,
    // After a clockwise rotation, each logical edge faces the next screen edge.
    paddingTop: `env(safe-area-inset-${rotated ? 'right' : 'top'}, 0px)`,
    paddingRight: `env(safe-area-inset-${rotated ? 'bottom' : 'right'}, 0px)`,
    paddingBottom: `env(safe-area-inset-${rotated ? 'left' : 'bottom'}, 0px)`,
    paddingLeft: `env(safe-area-inset-${rotated ? 'top' : 'left'}, 0px)`,
  };

  return (
    <>
      <style>{pageScrollGuard}</style>
      <div data-watch-viewport="" data-rotated={rotated ? 'true' : 'false'} style={outerStyle}>
        <div data-watch-viewport-content="" style={innerStyle}>{children}</div>
      </div>
    </>
  );
}

// The rule and its selector disappear with the player; no previous page's
// inline styles or zoom settings need to be changed or restored.
const pageScrollGuard = `
  html:has([data-watch-viewport]), body:has([data-watch-viewport]) {
    overflow: hidden;
    overscroll-behavior: none;
  }
`;

const shellStyle: CSSProperties = {
  position: 'fixed',
  overflow: 'hidden',
  background: '#000',
  overscrollBehavior: 'contain',
};

const contentStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  transformOrigin: 'top left',
};
