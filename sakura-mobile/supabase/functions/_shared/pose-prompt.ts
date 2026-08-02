import { sanitizeUserHint } from './mappa-style.ts';

/**
 * Pose Studio prompts — image-to-image, not text-to-image.
 *
 * The important difference from `fan-art-prompt.ts`: that module generates a
 * character from nothing and so appends "no real people". Here the subject IS a
 * real person — the uploaded photo — and the whole point is that the result
 * still looks like them. So the safety posture is inverted: instead of keeping
 * real people out, we pin the edit to *the person who uploaded their own photo*
 * and describe only the pose and setting around them.
 *
 * Presets deliberately describe a stance and a room, never a named character or
 * a specific frame to copy. That keeps the output an original photo of the
 * user, which is also what makes it worth paying for.
 */

export interface PosePreset {
  id: string;
  label: string;
  /** One-line description shown in the picker. */
  blurb: string;
  /** The body of the edit instruction. */
  instruction: string;
}

const IDENTITY_LOCK = [
  "preserve the person's face, facial structure, hairstyle, hair colour and skin tone exactly as in the source photo",
  'same person, clearly recognisable',
  'do not beautify, slim, age, de-age or otherwise alter their features',
].join(', ');

const QUALITY_TAIL = [
  'sharp focus on the subject',
  'natural skin texture',
  'high detail',
  'no text',
  'no watermark',
  'no extra people',
  'anatomically correct hands',
].join(', ');

export const POSE_PRESETS: Record<string, PosePreset> = {
  todo: {
    id: 'todo',
    label: 'The Jacket Flex',
    blurb: 'Jacket held wide open, elbows out, huge confident grin — on a bright yellow wall.',
    instruction: [
      'Restage the person so they face the camera square-on, gripping the front lapels of their open jacket with both hands at chest height and pulling it wide open',
      'elbows pushed out to the sides, shoulders squared and pulled back, chest forward, leaning very slightly toward the camera',
      'broad closed-mouth grin, eyebrows raised, brimming with self-assurance',
      'medium shot framing them from the upper thighs to just above the head',
      'replace the background with a plain bright warm yellow indoor wall, strongly blurred with a shallow depth of field',
      'bright even warm lighting on the subject, softly glowing background',
    ].join(', '),
  },
};

export const DEFAULT_POSE = 'todo';

export function listPosePresets(): Array<Omit<PosePreset, 'instruction'>> {
  return Object.values(POSE_PRESETS).map(({ id, label, blurb }) => ({ id, label, blurb }));
}

export interface PoseInput {
  poseId?: string;
  /** Optional free-text tweak from the user, e.g. "keep my glasses". */
  hint?: string;
}

/**
 * Builds the Kontext edit instruction. Throws on an unknown preset or a blocked
 * hint, so the caller can reject BEFORE taking payment.
 */
export function buildPosePrompt(input: PoseInput): string {
  const preset = POSE_PRESETS[input.poseId ?? DEFAULT_POSE];
  if (!preset) throw new Error('Pick a pose from the list.');

  const hint = sanitizeUserHint(input.hint, 120);
  const extra = hint ? `, ${hint}` : '';

  return `${preset.instruction}, ${IDENTITY_LOCK}${extra}, ${QUALITY_TAIL}`;
}
