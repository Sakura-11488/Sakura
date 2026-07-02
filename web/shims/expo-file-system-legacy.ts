type FileInfo = {
  exists: boolean;
  isDirectory: boolean;
  uri: string;
  size?: number;
  modificationTime?: number;
};

const STORAGE_KEY = 'sakura-web-fs-v1';
const store = new Map<string, string>();

function loadStore(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw) as [string, string][];
    for (const [key, value] of entries) store.set(key, value);
  } catch {
    // ignore corrupt cache
  }
}

function persistStore(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...store.entries()]));
  } catch {
    // ignore quota errors
  }
}

loadStore();

export const documentDirectory = 'sakura-web://documents/';
export const cacheDirectory = 'sakura-web://cache/';

export const EncodingType = {
  UTF8: 'utf8',
  Base64: 'base64',
} as const;

function normalizeKey(uri: string): string {
  return uri.replace(/^sakura-web:\/\/[^/]+\//, '');
}

export async function readAsStringAsync(
  fileUri: string,
  _options?: { encoding?: (typeof EncodingType)[keyof typeof EncodingType] },
): Promise<string> {
  const key = normalizeKey(fileUri);
  const value = store.get(key);
  if (value === undefined) throw new Error(`File not found: ${fileUri}`);
  return value;
}

export async function writeAsStringAsync(
  fileUri: string,
  contents: string,
  _options?: { encoding?: (typeof EncodingType)[keyof typeof EncodingType] },
): Promise<void> {
  store.set(normalizeKey(fileUri), contents);
  persistStore();
}

export async function getInfoAsync(fileUri: string, _options?: { size?: boolean }): Promise<FileInfo> {
  const key = normalizeKey(fileUri);
  const value = store.get(key);
  return {
    exists: value !== undefined,
    isDirectory: false,
    uri: fileUri,
    size: value?.length ?? 0,
    modificationTime: Date.now(),
  };
}

export async function makeDirectoryAsync(_dirUri: string, _options?: { intermediates?: boolean }): Promise<void> {}

export async function deleteAsync(fileUri: string, options?: { idempotent?: boolean }): Promise<void> {
  const key = normalizeKey(fileUri);
  if (!store.has(key) && options?.idempotent) return;
  store.delete(key);
  persistStore();
}

export async function readDirectoryAsync(dirUri: string): Promise<string[]> {
  const prefix = normalizeKey(dirUri);
  return [...store.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .filter(Boolean);
}

export async function downloadAsync(
  uri: string,
  fileUri: string,
  _options?: { headers?: Record<string, string> },
): Promise<{ uri: string; status: number; headers: Record<string, string>; md5?: string }> {
  const response = await fetch(uri);
  const body = await response.text();
  await writeAsStringAsync(fileUri, body);
  return { uri: fileUri, status: response.status, headers: {} };
}
