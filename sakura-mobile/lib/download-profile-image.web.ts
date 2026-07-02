function extensionFromUrl(url: string): string {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'jpg';
  if (path.endsWith('.webp')) return 'webp';
  if (path.endsWith('.gif')) return 'gif';
  return 'png';
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export async function saveProfileImageToDevice(imageUrl: string, label = 'sakura-pfp'): Promise<void> {
  const trimmed = imageUrl.trim();
  if (!trimmed) throw new Error('No profile photo to save.');

  if (typeof document === 'undefined' || typeof fetch === 'undefined') {
    throw new Error('Downloads are not available in this browser.');
  }

  const response = await fetch(trimmed);
  if (!response.ok) {
    throw new Error('Could not download your profile photo.');
  }

  const blob = await response.blob();
  const ext = extensionFromUrl(trimmed);
  triggerBrowserDownload(blob, `${label}-${Date.now()}.${ext}`);
}
