import { Platform } from 'react-native';

export function getSendAuthLabel(): string {
  return Platform.OS === 'web' ? 'Confirm send' : 'Send with Face ID / Biometrics';
}

export function getSwapAuthLabel(): string {
  return Platform.OS === 'web' ? 'Confirm swap' : 'Swap with Face ID / Biometrics';
}

export function getTransactionAuthLabel(action = 'transaction'): string {
  return Platform.OS === 'web' ? `Confirm ${action}` : `Confirm with Face ID`;
}

export function getWalletProtectionCopy(): string {
  return Platform.OS === 'web'
    ? 'A private Sakura account in this browser. Confirm each send or mint before signing.'
    : 'A private Sakura account on this device, protected by Face ID or your passcode.';
}

export function getAvatarMintAuthPrompt(): string {
  return Platform.OS === 'web'
    ? 'Confirm to pay and forge your Sakura avatar.'
    : 'Approve with Face ID to pay and forge your Sakura avatar.';
}

export function getExportKeyCopy(): string {
  return Platform.OS === 'web'
    ? 'Copies your key to clipboard after confirmation'
    : 'Copies your key to clipboard after Face ID';
}

export function getTradeSignLabel(side: 'long' | 'short'): string {
  const action = side === 'long' ? 'Open Long' : 'Open Short';
  return Platform.OS === 'web' ? `${action} · Confirm` : `${action} · Sign with Biometrics`;
}
