const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const balanceRouter = require('../dist/routes/balance').default;
const tradeRouter = require('../dist/routes/trade').default;

test('legacy custodial routes fail before touching funds or exposing private account records', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/balance', balanceRouter);
  app.use('/api/trade', tradeRouter);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}/api`;
    for (const path of [
      '/balance/deposit-confirm', '/balance/withdraw', '/trade/open', '/trade/close',
    ]) {
      const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 503, path);
      assert.match((await response.json()).error, /unavailable/i);
    }
    const wallet = await fetch(base + '/trade/server-wallet');
    assert.equal(wallet.status, 503);
    assert.equal((await wallet.json()).address, undefined);
    for (const path of [
      '/balance/history/11111111111111111111111111111111',
      '/balance/11111111111111111111111111111111',
      '/trade/positions/11111111111111111111111111111111',
      '/trade/history/11111111111111111111111111111111',
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 503, path);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
