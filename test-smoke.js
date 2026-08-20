// Simple smoke test script to verify backend endpoints
const BASE = process.env.BACKEND_URL || 'http://localhost:3001';

async function req(path, opts) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

(async () => {
  try {
    console.log('Health ->', await req('/health'));

    const products = await req('/api/products');
    if (!Array.isArray(products)) throw new Error('Products endpoint did not return an array');
    console.log('Products count (read-only smoke test) ->', products.length);
  } catch (err) {
    console.error('Smoke test failed', err);
    process.exitCode = 1;
  }
})();
