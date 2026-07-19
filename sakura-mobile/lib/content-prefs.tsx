import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { AppSettings } from './settings';

/**
 * Global content preferences that other screens must react to live.
 *
 * Currently just the "Allow 18+ content" toggle: the home screen shows/hides
 * the 18+ category tab based on it, so a plain read-on-mount (Pattern B) isn't
 * enough — it needs a context provider like ThemeProvider so flipping the
 * toggle in Settings re-renders consumers immediately.
 *
 * Persisted via SecureStore (AppSettings), default OFF.
 */

interface ContentPrefsCtx {
  allowAdult: boolean;
  setAllowAdult: (v: boolean) => void;
}

const ContentPrefsContext = createContext<ContentPrefsCtx>({
  allowAdult: false,
  setAllowAdult: () => {},
});

export function ContentPrefsProvider({ children }: { children: React.ReactNode }) {
  const [allowAdult, setAllowAdultState] = useState(false);

  useEffect(() => {
    (async () => {
      const saved = await AppSettings.getAllowAdult();
      setAllowAdultState(saved);
    })();
  }, []);

  const setAllowAdult = useCallback((v: boolean) => {
    setAllowAdultState(v);
    void AppSettings.setAllowAdult(v);
  }, []);

  return (
    <ContentPrefsContext.Provider value={{ allowAdult, setAllowAdult }}>
      {children}
    </ContentPrefsContext.Provider>
  );
}

export function useContentPrefs() {
  return useContext(ContentPrefsContext);
}
