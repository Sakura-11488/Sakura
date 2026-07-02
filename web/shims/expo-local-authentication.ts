export enum AuthenticationType {
  FINGERPRINT = 1,
  FACIAL_RECOGNITION = 2,
  IRIS = 3,
}

export async function hasHardwareAsync(): Promise<boolean> {
  return false;
}

export async function isEnrolledAsync(): Promise<boolean> {
  return false;
}

export async function supportedAuthenticationTypesAsync(): Promise<AuthenticationType[]> {
  return [];
}

export async function authenticateAsync(_options?: {
  promptMessage?: string;
  cancelLabel?: string;
  fallbackLabel?: string;
}): Promise<{ success: boolean; error?: string }> {
  const ok = typeof window !== 'undefined'
    ? window.confirm('Unlock Sakura wallet in this browser session?')
    : true;
  return { success: ok };
}
