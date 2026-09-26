import { Platform } from 'react-native';
import type { DocumentPickerAsset } from 'expo-document-picker';
import { File } from 'expo-file-system';
import type { Keypair } from '@solana/web3.js';
import { invokeCreatorFunction } from './creator-api';
import { supabase } from './supabase';

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Upload a supplementary file directly to private Storage with a short-lived,
 * wallet-authorized token. The Edge Function confirms the stored object and
 * attaches it to the release; readers receive a signed download URL. */
export async function uploadCreatorAttachment(input: {
  keypair: Keypair;
  workId: string;
  releaseId: string;
  asset: DocumentPickerAsset;
  sortOrder: number;
}): Promise<void> {
  const { asset } = input;
  const nativeFile = Platform.OS === 'web' ? null : new File(asset.uri);
  const size = asset.size ?? nativeFile?.size ?? 0;
  if (!size || size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${asset.name} must be 50 MB or smaller.`);
  }
  const mimeType = asset.mimeType || 'application/octet-stream';
  const prepared = await invokeCreatorFunction<{ object_path: string; token: string }>(
    'upload-work-media', 'upload-work-media', input.keypair,
    { work_id: input.workId, release_id: input.releaseId,
      attachment_request: { file_name: asset.name, mime_type: mimeType, size_bytes: size } },
  );
  const body = Platform.OS === 'web'
    ? asset.file ?? await (await fetch(asset.uri)).blob()
    : await nativeFile!.arrayBuffer();
  const { error } = await supabase.storage.from('release-attachments')
    .uploadToSignedUrl(prepared.object_path, prepared.token, body,
      { contentType: mimeType });
  if (error) throw new Error(`Could not upload ${asset.name}: ${error.message}`);
  await invokeCreatorFunction('upload-work-media', 'upload-work-media', input.keypair, {
    work_id: input.workId, release_id: input.releaseId,
    sort_order: input.sortOrder,
    attachment_complete: { object_path: prepared.object_path,
      file_name: asset.name, mime_type: mimeType },
  });
}
