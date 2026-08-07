const fetch = globalThis.fetch;
const base = 'http://127.0.0.1:3001';
(async () => {
  try {
    const r = await fetch(base + '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { name: 'Test', email: 't@test.com', phone: '12345', address: 'a', city: 'b', state: 'c', pincode: '000000' },
        items: [{ product: { id: '1', name: 'Test' }, quantity: 1 }],
        totalAmount: 100
      }),
    });
    const text = await r.text();
    console.log('status', r.status);
    console.log('text', text);
  } catch (err) {
    console.error(err);
  }
})();
