import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CHANNELS, MODELS, compare, randomTexture, type Model, type Result, type Texture } from './formulas';
import './style.css';

const TESTED: Record<Model, string[]> = {
  AMD: ['Tested: RDNA 2 / RDNA 4', 'RX 6900 XT / RX 9070'],
  NVIDIA: ['Tested: Ampere / Ada Lovelace', 'RTX 3070 / 3070 Ti / 4070'],
  SwiftShader: ['Tested: software'],
};

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

async function render(host: HTMLDivElement, texture: Texture): Promise<Uint8ClampedArray> {
  const source = canvas(2, 2);
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('Canvas2D unavailable');
  const image = sourceContext.createImageData(2, 2);
  image.data.set(texture.flatMap(rgb => [...rgb, 255]));
  sourceContext.putImageData(image, 0, 0);

  const destination = canvas(512, 256);
  destination.setAttribute('aria-label', 'Test canvas');
  host.replaceChildren(destination);
  const format = { alpha: false, colorSpace: 'srgb', colorType: 'unorm8', willReadFrequently: false } as const;
  const context = destination.getContext('2d', format) as CanvasRenderingContext2D | null;
  const attributes = context?.getContextAttributes();
  if (!context || !attributes || Object.entries(format).some(([key, value]) => attributes[key as keyof typeof attributes] !== value)) {
    throw new Error('Canvas format unavailable');
  }
  context.fillStyle = '#000';
  context.fillRect(0, 0, 512, 256);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'low';
  context.drawImage(source, 0, 0, 256, 256);
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  const output = context.getImageData(0, 0, 512, 256);
  if (!(output.data instanceof Uint8ClampedArray) || output.colorSpace !== 'srgb') throw new Error('Invalid canvas readback');
  return output.data;
}

function App() {
  const host = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState('');

  async function test() {
    if (busy.current || !host.current) return;
    busy.current = true;
    setTesting(true);
    setResult(null);
    setStatus('');
    try {
      const started = performance.now();
      const texture = randomTexture();
      const pixels = await render(host.current, texture);
      const next = compare(texture, pixels);
      setResult(next);
      setStatus(`${next.verdict} / ${(performance.now() - started).toFixed(1)} ms`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Test failed');
    } finally {
      busy.current = false;
      setTesting(false);
    }
  }

  return (
    <main>
      <div className="actions">
        <button disabled={testing} onClick={test}>{testing ? 'Testing…' : 'Test'}</button>
        <output role="status" aria-live="polite">{status}</output>
      </div>
      <div className="canvas" ref={host} />
      <table aria-label="Model scores">
        <thead><tr><th>Model</th><th>Score</th><th>Error</th><th>Result</th></tr></thead>
        <tbody>
          {MODELS.map(model => {
            const score = result?.scores.find(item => item.model === model);
            const exact = score?.matches === CHANNELS;
            return (
              <tr key={model} className={result?.verdict === model ? 'match' : ''}>
                <th scope="row">{model}{TESTED[model].map(label => <small key={label}>{label}</small>)}</th>
                <td title={score ? `${score.matches}/${CHANNELS} exact` : ''}>{score ? exact ? '100%' : `${(100 * score.matches / CHANNELS).toFixed(3)}%` : '-'}</td>
                <td>{score?.error ?? '-'}</td>
                <td>{!score ? '-' : result?.controls ? 'Invalid' : exact ? 'Match' : 'No match'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {result && <details>
        <summary>Differences</summary>
        {result.scores.map(({ model, matches, mismatch }) => <section key={model}>
          <strong>{model}</strong>
          <p>{matches.toLocaleString('en-US')}/{CHANNELS.toLocaleString('en-US')} exact</p>
          {mismatch ? <>
            <p>Pixel ({mismatch.x}, {mismatch.y})</p>
            <p>Rendered RGB: <code>{mismatch.actual.join(', ')}</code></p>
            <p>Predicted RGB: <code>{mismatch.expected.join(', ')}</code></p>
          </> : <p>No RGB differences</p>}
        </section>)}
      </details>}

    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
