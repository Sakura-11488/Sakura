import type { ChatMessage } from './chat';

export type ChatMediaKind = 'gif' | 'sticker';

export interface ChatMediaPayload {
  kind: ChatMediaKind;
  url: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  title?: string;
}

const MEDIA_PREFIX = 'sakura-media:';

export function encodeChatMedia(payload: ChatMediaPayload): string {
  return `${MEDIA_PREFIX}${JSON.stringify(payload)}`;
}

export function parseChatMedia(content: string | null | undefined): ChatMediaPayload | null {
  if (!content?.startsWith(MEDIA_PREFIX)) return null;
  try {
    const parsed = JSON.parse(content.slice(MEDIA_PREFIX.length)) as ChatMediaPayload;
    if (!parsed?.url || (parsed.kind !== 'gif' && parsed.kind !== 'sticker')) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function chatMediaPreviewLabel(content: string | null | undefined): string | null {
  const media = parseChatMedia(content);
  if (!media) return null;
  return media.kind === 'sticker' ? 'Sticker' : 'GIF';
}

export function chatMessagePreview(content: string | null | undefined): string {
  const mediaLabel = chatMediaPreviewLabel(content);
  if (mediaLabel) return mediaLabel;
  return content?.trim() || '';
}

export function mediaMessageType(kind: ChatMediaKind): string {
  return kind;
}

export function pendingMatchesConfirmed(pending: ChatMessage, confirmed: ChatMessage): boolean {
  if (pending.sender_wallet !== confirmed.sender_wallet) return false;
  if (pending.content === confirmed.content) return true;

  const pendingMedia = parseChatMedia(pending.content);
  const confirmedMedia = parseChatMedia(confirmed.content);
  if (pendingMedia && confirmedMedia) {
    return pendingMedia.url === confirmedMedia.url && pendingMedia.kind === confirmedMedia.kind;
  }

  return false;
}
