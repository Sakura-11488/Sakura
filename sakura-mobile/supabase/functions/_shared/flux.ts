const BFL_BASE = 'https://api.bfl.ai/v1';
const BFL_DEFAULT_MODEL = 'flux-pro-1.1';
const FAL_DEFAULT_MODEL = 'fal-ai/flux/dev';

/** Editing models — take a source image, unlike the text-to-image pair above. */
const BFL_KONTEXT_MODEL = 'flux-kontext-pro';
const FAL_KONTEXT_MODEL = 'fal-ai/flux-pro/kontext';

/**
 * Chunked because `String.fromCharCode(...bytes)` on a multi-megabyte upload
 * exceeds the argument limit and throws a RangeError rather than returning a
 * short string — a failure that would surface as an unrelated-looking error.
 */
function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function getProvider(): 'bfl' | 'fal' {
  const explicit = Deno.env.get('FLUX_PROVIDER')?.trim().toLowerCase();
  if (explicit === 'bfl' || explicit === 'fal') return explicit;
  // Keys copied from fal.ai dashboard commonly work with Authorization: Key ...
  return 'fal';
}

/**
 * Provider-aware so the two can't disagree: the provider defaults to fal, so an
 * unconditional BFL_API_KEY-first lookup would hand a BFL key to fal's endpoint
 * whenever both are set, and fail as a bare 401. Falls back to whatever key
 * exists, which preserves the single-key setups this ran on before.
 */
function getApiKey(): string {
  const bfl = Deno.env.get('BFL_API_KEY')?.trim();
  const fal = Deno.env.get('FAL_KEY')?.trim();
  const generic = Deno.env.get('FLUX_API_KEY')?.trim();
  const preferred = getProvider() === 'bfl' ? bfl : fal;
  const key = preferred || generic || bfl || fal;
  if (!key) throw new Error('Image service is not configured.');
  return key;
}

type BflTask = {
  id?: string;
  polling_url?: string;
  detail?: string;
  message?: string;
};

type BflPoll = {
  status?: string;
  result?: { sample?: string };
  error?: string;
  detail?: string;
};

type FalQueueSubmit = {
  request_id?: string;
  status_url?: string;
  response_url?: string;
  detail?: string;
};
type FalQueueStatus = { status?: string; detail?: string };
type FalQueueResult = {
  images?: Array<{ url?: string }>;
  detail?: string;
};

async function downloadImage(url: string): Promise<Uint8Array> {
  const imageRes = await fetch(url);
  if (!imageRes.ok) throw new Error('Failed to download generated image.');
  return new Uint8Array(await imageRes.arrayBuffer());
}

async function generateBflImage(prompt: string, apiKey: string): Promise<Uint8Array> {
  const model = Deno.env.get('BFL_FLUX_MODEL')?.trim() || BFL_DEFAULT_MODEL;

  const submitRes = await fetch(`${BFL_BASE}/${model}`, {
    method: 'POST',
    headers: {
      'x-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      prompt,
      width: 768,
      height: 1024,
      prompt_upsampling: false,
      safety_tolerance: 2,
    }),
  });

  const task = (await submitRes.json()) as BflTask;
  if (!submitRes.ok) {
    throw new Error(task.detail || task.message || `Flux submit failed (${submitRes.status}).`);
  }

  const pollUrl = task.polling_url || (task.id ? `${BFL_BASE}/get_result?id=${task.id}` : '');
  if (!pollUrl) throw new Error('Flux did not return a polling URL.');

  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 3 ? 1200 : 1800));
    const pollRes = await fetch(pollUrl, {
      headers: { 'x-key': apiKey, Accept: 'application/json' },
    });
    const poll = (await pollRes.json()) as BflPoll;

    if (!pollRes.ok) {
      throw new Error(poll.detail || poll.error || `Flux poll failed (${pollRes.status}).`);
    }

    if (poll.status === 'Ready') {
      const sampleUrl = poll.result?.sample;
      if (!sampleUrl) throw new Error('Flux returned no image.');
      return downloadImage(sampleUrl);
    }

    if (poll.status === 'Error' || poll.status === 'Failed' || poll.status === 'Request Moderated') {
      throw new Error(poll.error || poll.detail || 'Image generation was rejected.');
    }
  }

  throw new Error('Image generation timed out. Try again.');
}

/**
 * Submit to fal's queue and poll to completion. Split out from the
 * text-to-image path because Kontext takes a different input shape
 * (`image_url` + `aspect_ratio`, and no `image_size`) over the identical
 * queue protocol.
 */
async function runFalQueue(
  model: string,
  input: Record<string, unknown>,
  apiKey: string,
): Promise<Uint8Array> {
  const auth = { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' };

  const submitRes = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(input),
  });

  const submit = (await submitRes.json()) as FalQueueSubmit;
  if (!submitRes.ok || !submit.request_id) {
    throw new Error(submit.detail || `Fal submit failed (${submitRes.status}).`);
  }

  const requestId = submit.request_id;
  const statusUrl =
    submit.status_url || `https://queue.fal.run/${model}/requests/${requestId}/status`;
  const resultUrl =
    submit.response_url || `https://queue.fal.run/${model}/requests/${requestId}`;

  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 3 ? 1500 : 2000));

    const statusRes = await fetch(statusUrl, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    const statusText = await statusRes.text();
    const status = statusText ? (JSON.parse(statusText) as FalQueueStatus) : {};

    if (!statusRes.ok) {
      throw new Error(status.detail || `Fal status failed (${statusRes.status}).`);
    }

    if (status.status === 'COMPLETED') {
      const resultRes = await fetch(resultUrl, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      const resultText = await resultRes.text();
      const result = resultText ? (JSON.parse(resultText) as FalQueueResult) : {};
      if (!resultRes.ok) {
        throw new Error(result.detail || `Fal result failed (${resultRes.status}).`);
      }
      const imageUrl = result.images?.[0]?.url;
      if (!imageUrl) throw new Error('Fal returned no image URL.');
      return downloadImage(imageUrl);
    }

    if (status.status === 'FAILED') {
      throw new Error(status.detail || 'Fal image generation failed.');
    }
  }

  throw new Error('Image generation timed out. Try again.');
}

function generateFalImage(prompt: string, apiKey: string): Promise<Uint8Array> {
  const model = Deno.env.get('FAL_FLUX_MODEL')?.trim() || FAL_DEFAULT_MODEL;
  return runFalQueue(
    model,
    {
      prompt,
      image_size: { width: 768, height: 1024 },
      num_images: 1,
      output_format: 'png',
      enable_safety_checker: true,
    },
    apiKey,
  );
}

function editFalImage(prompt: string, imageUrl: string, apiKey: string): Promise<Uint8Array> {
  const model = Deno.env.get('FAL_KONTEXT_MODEL')?.trim() || FAL_KONTEXT_MODEL;
  // `safety_tolerance` is a string enum here, not a number, and Kontext has no
  // `image_size` — it infers dimensions from the source unless aspect_ratio says
  // otherwise. Sending the text-to-image body silently produces the wrong result.
  return runFalQueue(
    model,
    {
      prompt,
      image_url: imageUrl,
      num_images: 1,
      output_format: 'png',
      safety_tolerance: '2',
      guidance_scale: 3.5,
    },
    apiKey,
  );
}

async function editBflImage(prompt: string, imageBase64: string, apiKey: string): Promise<Uint8Array> {
  const model = Deno.env.get('BFL_KONTEXT_MODEL')?.trim() || BFL_KONTEXT_MODEL;

  const submitRes = await fetch(`${BFL_BASE}/${model}`, {
    method: 'POST',
    headers: {
      'x-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    // BFL wants bare base64 for input_image — no `data:` prefix.
    body: JSON.stringify({
      prompt,
      input_image: imageBase64,
      prompt_upsampling: false,
      safety_tolerance: 2,
      output_format: 'png',
    }),
  });

  const task = (await submitRes.json()) as BflTask;
  if (!submitRes.ok) {
    throw new Error(task.detail || task.message || `Flux edit submit failed (${submitRes.status}).`);
  }

  const pollUrl = task.polling_url || (task.id ? `${BFL_BASE}/get_result?id=${task.id}` : '');
  if (!pollUrl) throw new Error('Flux did not return a polling URL.');

  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 3 ? 1200 : 1800));
    const pollRes = await fetch(pollUrl, { headers: { 'x-key': apiKey, Accept: 'application/json' } });
    const poll = (await pollRes.json()) as BflPoll;

    if (!pollRes.ok) {
      throw new Error(poll.detail || poll.error || `Flux poll failed (${pollRes.status}).`);
    }
    if (poll.status === 'Ready') {
      const sampleUrl = poll.result?.sample;
      if (!sampleUrl) throw new Error('Flux returned no image.');
      return downloadImage(sampleUrl);
    }
    if (poll.status === 'Error' || poll.status === 'Failed' || poll.status === 'Request Moderated') {
      throw new Error(poll.error || poll.detail || 'Image edit was rejected.');
    }
  }

  throw new Error('Image edit timed out. Try again.');
}

export async function generateFluxImage(prompt: string): Promise<Uint8Array> {
  const apiKey = getApiKey();
  const provider = getProvider();
  if (provider === 'fal') return generateFalImage(prompt, apiKey);
  return generateBflImage(prompt, apiKey);
}

/**
 * Image-to-image: restage `image` according to `prompt`, keeping the subject.
 *
 * `image` is the raw upload. Both providers take it inline (fal as a data URI,
 * BFL as bare base64) so the source photo is never persisted anywhere public —
 * which matters when the source is a picture of the user's face.
 */
export async function editFluxImage(
  prompt: string,
  image: { bytes: Uint8Array; contentType: string },
): Promise<Uint8Array> {
  const apiKey = getApiKey();
  const provider = getProvider();
  const base64 = encodeBase64(image.bytes);
  if (provider === 'fal') {
    return editFalImage(prompt, `data:${image.contentType};base64,${base64}`, apiKey);
  }
  return editBflImage(prompt, base64, apiKey);
}
