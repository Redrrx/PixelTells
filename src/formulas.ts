export type RGB = [number, number, number];
export type Texture = [RGB, RGB, RGB, RGB];
export const MODELS = ['AMD', 'SwiftShader', 'NVIDIA'] as const;
export type Model = typeof MODELS[number];
export const CHANNELS = 128 * 128 * 3;

export type Score = {
  model: Model;
  matches: number;
  error: number;
  mismatch: { x: number; y: number; actual: RGB; expected: RGB } | null;
};
export type Result = {
  scores: Score[];
  verdict: Model | 'Invalid' | 'Ambiguous';
  controls: number;
};

function roundEven(value: number): number {
  const integer = Math.floor(value);
  const fraction = value - integer;
  return integer + Number(fraction > 0.5 || (fraction === 0.5 && integer % 2 !== 0));
}

const float = new Float32Array(1);
const bits = new Uint32Array(float.buffer);

function truncateHalf(value: number): number {
  float[0] = value;
  const exponent = ((bits[0] >>> 23) & 255) - 127;
  const step = 2 ** Math.max(-24, exponent - 10);
  return Math.floor(value / step) * step;
}

export function predict(texture: Texture, x: number, y: number): Record<Model, RGB> {
  const s = 2 * x - 127;
  const t = 2 * y - 127;
  const w = (s * t + 128) >>> 8;
  const output: Record<Model, RGB> = { AMD: [0, 0, 0], SwiftShader: [0, 0, 0], NVIDIA: [0, 0, 0] };

  for (let channel = 0; channel < 3; channel++) {
    const [a, b, c, d] = texture.map(color => color[channel]);
    const sum = (256 - s) * (256 - t) * a + s * (256 - t) * b + (256 - s) * t * c + s * t * d;
    const amd = Math.fround(roundEven(sum / 8) / (8192 * 255));
    output.AMD[channel] = roundEven(255 * truncateHalf(amd));
    output.SwiftShader[channel] = roundEven(Math.fround(255 * Math.fround((sum / 256) * Math.fround(1 / 65280))));

    const n = (256 + w - s - t) * a + (s - w) * b + (t - w) * c + w * d;
    const nvidia = Math.fround(((257 * n + 128) >>> 8) / 65535);
    output.NVIDIA[channel] = (255 * Math.floor(4096 * nvidia) + 2047) >>> 12;
  }
  return output;
}

export function randomTexture(): Texture {
  for (let attempt = 0; attempt < 256; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const texture: Texture = [
      [bytes[0], bytes[1], bytes[2]], [bytes[3], bytes[4], bytes[5]],
      [bytes[6], bytes[7], bytes[8]], [bytes[9], bytes[10], bytes[11]],
    ];
    const distinct = [false, false, false];
    for (let y = 64; y <= 191; y++) {
      for (let x = 64; x <= 191; x++) {
        const p = predict(texture, x, y);
        distinct[0] ||= p.AMD.some((v, c) => v !== p.NVIDIA[c]);
        distinct[1] ||= p.AMD.some((v, c) => v !== p.SwiftShader[c]);
        distinct[2] ||= p.NVIDIA.some((v, c) => v !== p.SwiftShader[c]);
        if (distinct.every(Boolean)) return texture;
      }
    }
  }
  throw new Error('Could not generate distinct formula predictions');
}

export function compare(texture: Texture, pixels: Uint8ClampedArray): Result {
  if (pixels.length !== 512 * 256 * 4) throw new Error('Invalid canvas readback');
  const scores: Score[] = MODELS.map(model => ({ model, matches: 0, error: 0, mismatch: null }));
  let controls = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] !== 255 || ((i / 4) % 512 >= 256 && (pixels[i] || pixels[i + 1] || pixels[i + 2]))) controls++;
  }
  for (let y = 64; y <= 191; y++) {
    for (let x = 64; x <= 191; x++) {
      const i = (y * 512 + x) * 4;
      const actual: RGB = [pixels[i], pixels[i + 1], pixels[i + 2]];
      const predicted = predict(texture, x, y);
      for (const score of scores) {
        const expected = predicted[score.model];
        for (let channel = 0; channel < 3; channel++) {
          const difference = Math.abs(actual[channel] - expected[channel]);
          score.error += difference;
          if (difference === 0) score.matches++;
          else score.mismatch ??= { x, y, actual, expected };
        }
      }
    }
  }
  const matches = scores.filter(score => score.matches === CHANNELS);
  const verdict = controls || matches.length === 0 ? 'Invalid' : matches.length === 1 ? matches[0].model : 'Ambiguous';
  return { scores, verdict, controls };
}
