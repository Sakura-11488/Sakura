import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { checkForAppUpdate, dismissAppUpdate, type AppUpdateInfo } from '@/lib/app-update';
import AppUpdateModal from '@/components/AppUpdateModal';

/**
 * Checks the hosted release manifest on launch and on resume, and shows the
 * "new version available" prompt when a newer APK has shipped. Native only —
 * the web build ships a no-op variant (AppUpdateBridge.web.tsx).
 */
export default function AppUpdateBridge() {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  // Once we've surfaced (or the user acted on) a prompt this session, don't
  // pop it again on every resume. Cross-launch suppression of "Maybe later"
  // lives in SecureStore via dismissAppUpdate().
  const handledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (handledRef.current) return;
      const update = await checkForAppUpdate();
      if (cancelled || !update) return;
      handledRef.current = true;
      setInfo(update);
    };

    run();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  const handleLater = () => {
    if (info) void dismissAppUpdate(info.version);
    setInfo(null);
  };

  return <AppUpdateModal info={info} onUpdate={() => setInfo(null)} onLater={handleLater} />;
}
