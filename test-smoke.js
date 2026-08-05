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

    const product = await req('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke Test Pickle', category: 'Pickles', productType: 'Pickles' })
    });
    console.log('Created product ->', product);

    const order = await req('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: { name: 'Test', email: 'a@b.com' }, items: [{ product, quantity: 1 }], totalAmount: 0 })
    });
    console.log('Created order ->', order);

    const review = await req('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke', product: product.name || product.id || 'unknown', rating: 5, text: 'OK' })
    });
    console.log('Created review ->', review);

    const products = await req('/api/products');
    console.log('Products count ->', Array.isArray(products) ? products.length : products);
  } catch (err) {
    console.error('Smoke test failed', err);
    process.exitCode = 1;
  }
})();
