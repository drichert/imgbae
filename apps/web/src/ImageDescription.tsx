import { useEffect, useRef, useState } from 'react';

export default function ImageDescription({ url }: { url: string }) {
  const pending = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ description: string; model: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => () => pending.current?.abort(), []);

  async function generate() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(url, { method: 'POST', signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Description unavailable.');
      setResult(data);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Description unavailable.');
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return <section className="image-description" aria-label="Image description">
    <button type="button" disabled={loading} onClick={generate}>
      {loading ? 'Generating description…' : result ? 'Regenerate description' : 'Generate description'}
    </button>
    <div aria-live="polite">
      {error && <p>{error}</p>}
      {result && <><p>{result.description}</p><small>{result.model}</small></>}
    </div>
  </section>;
}
