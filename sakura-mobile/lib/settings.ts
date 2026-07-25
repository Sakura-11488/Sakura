import * as SecureStore from 'expo-secure-store';

const K = {
  DARK_MODE:        'settings_dark_mode',
  PUSH_ENABLED:     'settings_push_enabled',
  PUSH_EPISODES:    'settings_push_episodes',
  PUSH_CHAPTERS:    'settings_push_chapters',
  PUSH_PASS:        'settings_push_pass',
  PUSH_MARKETING:   'settings_push_marketing',
  AUTOPLAY:         'settings_autoplay',
  READ_DIRECTION:   'settings_read_direction',
  READING_MODE:       'settings_reading_mode',
  MANGA_READING_MODE: 'settings_manga_reading_mode',
  READER_CONTINUOUS:      'settings_reader_continuous',
  READER_CONTINUOUS_BACK: 'settings_reader_continuous_back',
  DATA_SAVER:       'settings_data_saver',
  PNL_TRACKER:      'settings_pnl_tracker',
  ALLOW_ADULT:      'settings_allow_adult',
  LOCALE:           'settings_locale',
  EMAIL:            'settings_email',
  PUSH_TOKEN:       'settings_push_token',
  LEGAL_ACCEPTED:   'legal_accepted',
  LEGAL_ACCEPTED_AT:'legal_accepted_at',
};

async function getBool(key: string, def: boolean): Promise<boolean> {
  try {
    const v = await SecureStore.getItemAsync(key);
    if (v === null) return def;
    return v === 'true';
  } catch { return def; }
}
async function setBool(key: string, v: boolean) {
  await SecureStore.setItemAsync(key, v ? 'true' : 'false');
}
async function getString(key: string, def: string): Promise<string> {
  try { return (await SecureStore.getItemAsync(key)) ?? def; }
  catch { return def; }
}
async function setString(key: string, v: string) {
  await SecureStore.setItemAsync(key, v);
}

export const AppSettings = {
  getDarkMode:       () => getBool(K.DARK_MODE, true),
  getDarkModeRaw:    () => SecureStore.getItemAsync(K.DARK_MODE),
  setDarkMode:       (v: boolean) => setBool(K.DARK_MODE, v),
  getPushEnabled:    () => getBool(K.PUSH_ENABLED, false),
  setPushEnabled:    (v: boolean) => setBool(K.PUSH_ENABLED, v),
  getPushEpisodes:   () => getBool(K.PUSH_EPISODES, true),
  setPushEpisodes:   (v: boolean) => setBool(K.PUSH_EPISODES, v),
  getPushChapters:   () => getBool(K.PUSH_CHAPTERS, true),
  setPushChapters:   (v: boolean) => setBool(K.PUSH_CHAPTERS, v),
  getPushPass:       () => getBool(K.PUSH_PASS, true),
  setPushPass:       (v: boolean) => setBool(K.PUSH_PASS, v),
  getPushMarketing:  () => getBool(K.PUSH_MARKETING, true),
  setPushMarketing:  (v: boolean) => setBool(K.PUSH_MARKETING, v),
  getAutoplay:       () => getBool(K.AUTOPLAY, true),
  setAutoplay:       (v: boolean) => setBool(K.AUTOPLAY, v),
  getReadDirection:  () => getString(K.READ_DIRECTION, 'ltr'),
  setReadDirection:  (v: string) => setString(K.READ_DIRECTION, v),
  getReadingMode:       () => getString(K.READING_MODE, 'page'),
  setReadingMode:       (v: string) => setString(K.READING_MODE, v),
  getMangaReadingMode:  async () => {
    try {
      const manga = await SecureStore.getItemAsync(K.MANGA_READING_MODE);
      if (manga === 'scroll' || manga === 'page') return manga;
      const legacy = await SecureStore.getItemAsync(K.READING_MODE);
      if (legacy === 'scroll' || legacy === 'page') return legacy;
      return 'scroll';
    } catch {
      return 'scroll';
    }
  },
  setMangaReadingMode:  (v: string) => setString(K.MANGA_READING_MODE, v),
  /** Flow from the end of one chapter into the next without leaving the reader. */
  getReaderContinuous:     () => getBool(K.READER_CONTINUOUS, true),
  setReaderContinuous:     (v: boolean) => setBool(K.READER_CONTINUOUS, v),
  /**
   * Also flow *backwards* when scrolling up past the top of a chapter.
   * Separate from the forward switch because it is the riskier direction:
   * prepending shifts every row, and on Android the compensating scroll can
   * still be visible. This is the escape hatch for a device where it misbehaves.
   */
  getReaderContinuousBack: () => getBool(K.READER_CONTINUOUS_BACK, true),
  setReaderContinuousBack: (v: boolean) => setBool(K.READER_CONTINUOUS_BACK, v),
  getDataSaver:      () => getBool(K.DATA_SAVER, false),
  setDataSaver:      (v: boolean) => setBool(K.DATA_SAVER, v),
  getPnlTracker:     () => getBool(K.PNL_TRACKER, false),
  setPnlTracker:     (v: boolean) => setBool(K.PNL_TRACKER, v),
  getAllowAdult:     () => getBool(K.ALLOW_ADULT, false),
  setAllowAdult:     (v: boolean) => setBool(K.ALLOW_ADULT, v),
  getLocaleRaw:      () => SecureStore.getItemAsync(K.LOCALE),
  setLocale:         (v: string) => setString(K.LOCALE, v),
  getEmail:          () => getString(K.EMAIL, ''),
  setEmail:          (v: string) => setString(K.EMAIL, v),
  getPushToken:      () => getString(K.PUSH_TOKEN, ''),
  setPushToken:      (v: string) => setString(K.PUSH_TOKEN, v),
  getLegalAccepted:  () => getBool(K.LEGAL_ACCEPTED, false),
  setLegalAccepted:  (v: boolean) => setBool(K.LEGAL_ACCEPTED, v),
  getLegalAcceptedAt: () => getString(K.LEGAL_ACCEPTED_AT, ''),
  setLegalAcceptedAt: (v: string) => setString(K.LEGAL_ACCEPTED_AT, v),
};
