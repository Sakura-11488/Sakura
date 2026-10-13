export interface AnimeDeviceSaveSnapshot {
  key: string;
  title: string;
  filename: string;
  status: 'preparing' | 'ready' | 'error';
  progress: number;
  error?: string;
  url?: string;
  canShare: boolean;
  downloadStarted: boolean;
  subtitle?: { url: string; filename: string; label: string };
  queued: number;
}
