// fetchPhoenixMarketState against the responses perp-api.phoenix.trade really
// sends. /app/trade showed "SOL-PERP $0.00" because the stats endpoint
// answers `{ stats: [{ mark_price, ... }] }` and the parser only read
// `{ data: [{ markPx, ... }] }`. And `{ limit: 1 }` on its own is the oldest
// row of the last hour, so the price has to come from a recent window.
import assert from 'node:assert/strict';
import test from 'node:test';
// The app's own SDK copy: web/metro.config.js keeps resolving
// @ellipsis-labs/rise from sakura-mobile (KEEP_APP_COPY in
// web/scripts/app-package-dedupe.cjs), so web and native both run this version.
import * as rise from '@ellipsis-labs/rise';
import { loadTs } from './wallet-web-harness.mjs';

const API = 'https://perp-api.phoenix.trade';

// Verbatim bodies, saved 2026-10-14.
// STATS_BODY: GET /v1/market/SOL/stats?limit=1 at 09:35:19Z. Its one row is
// from 08:35:30Z: without start_time the endpoint starts an hour back.
// RECENT_BODY: GET /v1/market/SOL/stats?start_time=2026-10-14T09:42:33Z&limit=30
// at 09:43:33Z, rows oldest first; the newest (09:43:16Z) is the live price.
// MARKET_BODY: GET /exchange/market/SOL, the request exchange().getMarket('SOL') makes.
const STATS_BODY = '{"market_id":1,"symbol":"SOL","timeframe":null,"stats":[{"open_interest":84303.13,"total_maker_fees":15641.622875,"total_taker_fees":207386.590765,"mark_price":107.82,"spot_price":107.75,"timestamp":"2026-10-14T08:35:30Z","slot":456773971}]}';
const RECENT_BODY = '{"market_id":1,"symbol":"SOL","timeframe":null,"stats":[{"open_interest":84272.12,"total_maker_fees":15661.108422,"total_taker_fees":207470.215171,"mark_price":106.72,"spot_price":106.65,"timestamp":"2026-10-14T09:42:58Z","slot":456792586},{"open_interest":84292.12,"total_maker_fees":15661.204461,"total_taker_fees":207470.215171,"mark_price":106.71,"spot_price":106.65,"timestamp":"2026-10-14T09:43:00Z","slot":456792598},{"open_interest":84297.42,"total_maker_fees":15661.283346,"total_taker_fees":207470.567533,"mark_price":106.71,"spot_price":106.64,"timestamp":"2026-10-14T09:43:16Z","slot":456792669}]}';
// Not captured live: an empty window, in the shape the SDK's schema requires.
const EMPTY_STATS_BODY = '{"market_id":1,"symbol":"SOL","timeframe":null,"stats":[]}';
const MARKET_BODY = '{"symbol":"SOL","assetId":0,"marketStatus":"active","metadata":{"earningsDates":[],"name":"Solana","description":null,"classifications":["solana","l1","featured"],"logoUri":"https://phoenixcdn.trade/logos/SOL/b82944495839f0a92b535eaa8923ea68283b875e8c444840b9eff4fac8819c01.svg","coinGeckoId":"solana","coinMarketCapId":5426,"tokensXyzAssetId":null,"displayColor":"#9945FF","circulatingSupply":587296838.8226068},"marketPubkey":"71Si24E4uc3oCaPbPZTozC1ptSNNqygjjebxSmErSsC2","splinePubkey":"EVhkquLbfm5rDRXtZu9FoyDSXX5mYq2EYU6yD8zfKEqM","tickSize":100,"baseLotsDecimals":2,"takerFee":0.00035,"makerFee":0.00005,"leverageTiers":[{"maxLeverage":25.0,"maxSizeBaseLots":32164684,"limitOrderRiskFactor":100.0,"limitOrderRiskFactorBps":10000},{"maxLeverage":1.0,"maxSizeBaseLots":32164685,"limitOrderRiskFactor":100.0,"limitOrderRiskFactorBps":10000},{"maxLeverage":1.0,"maxSizeBaseLots":32164686,"limitOrderRiskFactor":100.0,"limitOrderRiskFactorBps":10000},{"maxLeverage":1.0,"maxSizeBaseLots":32164687,"limitOrderRiskFactor":100.0,"limitOrderRiskFactorBps":10000}],"riskFactors":{"maintenance":50.0,"maintenanceBps":5000,"backstop":20.0,"backstopBps":2000,"highRisk":10.0,"highRiskBps":1000,"upnl":100.0,"upnlBps":10000,"upnlForWithdrawals":70.0,"upnlForWithdrawalsBps":7000,"cancelOrder":75.0,"cancelOrderBps":7500},"fundingIntervalSeconds":3600,"fundingPeriodSeconds":86400,"maxFundingRatePerInterval":2377,"maxFundingRatePerIntervalPercentage":0.22142524452724738,"openInterestCapBaseLots":"32164684","maxLiquidationSizeBaseLots":"500000","isolatedOnly":false,"statsSnapshot":{"slot":456779367,"slotIndex":1210,"openInterestBaseLots":"8433081","fundingStartIntervalTimestamp":"1791964800","cumulativeFundingRate":"40260"}}';

/**
 * A fresh copy of lib/wallet/phoenix.ts (its HTTP client is cached per
 * module). Only the market-data path runs, so the signing and RPC imports are
 * empty stand-ins: nothing here can build, sign or send a transaction.
 */
function loadPhoenix(riseModule = rise) {
  const config = loadTs('../lib/wallet/phoenix-config.ts', {}, { process: { env: {} } });
  return loadTs('../lib/wallet/phoenix.ts', {
    buffer: {},
    '@solana/web3.js': {},
    '@ellipsis-labs/rise': riseModule,
    './connection': {},
    './confirm': {},
    './phoenix-validation': {},
    './phoenix-config': config,
  });
}

/**
 * Runs `fn` with the real SDK talking to a stand-in for perp-api: `routes`
 * maps a request path to the body it gets, or to a function of the URL that
 * returns the body (or a Response). Records every request.
 */
async function withPhoenixApi(routes, fn) {
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ method: init.method ?? 'GET', url });
    const route = routes[url.pathname];
    const body = typeof route === 'function' ? route(url) : route;
    if (body === undefined) return new Response('not found', { status: 404 });
    if (body instanceof Response) return body;
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    return { result: await fn(), requests };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** A PhoenixHttpClient stand-in that hands back `stats` as the SDK's result, every call. */
function riseReturning(stats, market = JSON.parse(MARKET_BODY)) {
  return {
    PhoenixHttpClient: class {
      exchange() { return { getMarket: async () => market }; }
      markets() {
        return {
          getMarketStatsHistory: async () => {
            if (stats instanceof Error) throw stats;
            return stats;
          },
        };
      }
    },
  };
}

/** The stats request's start_time, checked to be whole seconds and three minutes before [from, to]. */
function assertRecentStart(url, from, to) {
  const start = url.searchParams.get('start_time');
  assert.match(start, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const at = Date.parse(start);
  assert.ok(at >= from - 180_000 - 1000 && at <= to - 180_000, `start_time ${start}`);
}

test('shows the newest mark price from the recent stats window', async () => {
  const { fetchPhoenixMarketState } = loadPhoenix();
  const from = Date.now();
  const { result: market, requests } = await withPhoenixApi({
    '/exchange/market/SOL': MARKET_BODY,
    '/v1/market/SOL/stats': (url) => (url.searchParams.has('start_time') ? RECENT_BODY : undefined),
  }, () => fetchPhoenixMarketState('SOL-PERP'));
  const to = Date.now();

  // Read-only: one GET for the market, one for recent stats, nothing else.
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url.origin}${r.url.pathname}`).sort(), [
    `GET ${API}/exchange/market/SOL`,
    `GET ${API}/v1/market/SOL/stats`,
  ]);
  const stats = requests.find((r) => r.url.pathname === '/v1/market/SOL/stats').url;
  assert.deepEqual([...stats.searchParams.keys()].sort(), ['limit', 'start_time']);
  assert.equal(stats.searchParams.get('limit'), '100');
  assertRecentStart(stats, from, to);

  // The 09:43:16Z row, not the first (oldest) one.
  assert.equal(market.symbol, 'SOL');
  assert.equal(market.displaySymbol, 'SOL-PERP');
  assert.equal(market.markPrice, 106.71);
  assert.equal(market.indexPrice, 106.64);
  assert.equal(market.midPrice, 106.71);
  assert.equal(market.openInterest, 84297.42);
  assert.equal(market.active, true);
  assert.equal(market.maxLeverage, 25);
  assert.equal(market.takerFee, 0.00035);
  assert.equal(market.makerFee, 0.00005);

  // The response has no 24h, volume or funding fields: these keep their
  // fallbacks rather than inventing numbers.
  assert.equal(market.change24h, 0);
  assert.equal(market.high24h, 106.71);
  assert.equal(market.low24h, 106.71);
  assert.equal(market.volume24h, 0);
  assert.equal(market.fundingRate, 0);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(market.nextFundingTs >= now + 3600 - 5 && market.nextFundingTs <= now + 3600 + 5);
});

test('falls back to the default window when the recent one is empty or fails', async () => {
  for (const recent of [EMPTY_STATS_BODY, new Response('{"error":"bad request"}', { status: 400 })]) {
    const { fetchPhoenixMarketState } = loadPhoenix();
    const { result: market, requests } = await withPhoenixApi({
      '/exchange/market/SOL': MARKET_BODY,
      '/v1/market/SOL/stats': (url) => (url.searchParams.has('start_time') ? recent : STATS_BODY),
    }, () => fetchPhoenixMarketState('SOL'));

    const stats = requests.filter((r) => r.url.pathname === '/v1/market/SOL/stats').map((r) => r.url);
    assert.equal(requests.length, 3);
    assert.equal(stats.length, 2);
    assert.ok(stats[0].searchParams.has('start_time'));
    // The fallback is the plain request, after the recent one came back empty.
    assert.equal(stats[1].search, '?limit=1');

    // A real price, if an old one, rather than $0.00.
    assert.equal(market.markPrice, 107.82);
    assert.equal(market.indexPrice, 107.75);
    assert.equal(market.openInterest, 84303.13);
    assert.equal(market.change24h, 0);
    assert.equal(market.high24h, 107.82);
    assert.equal(market.low24h, 107.82);
    assert.equal(market.maxLeverage, 25);
  }
});

test('the recent window is not followed by a second request when it has a row', async () => {
  const calls = [];
  const rise = riseReturning(JSON.parse(RECENT_BODY));
  const markets = rise.PhoenixHttpClient.prototype.markets;
  rise.PhoenixHttpClient.prototype.markets = function () {
    const api = markets.call(this);
    return { getMarketStatsHistory: (symbol, params) => { calls.push(params); return api.getMarketStatsHistory(); } };
  };
  const { fetchPhoenixMarketState } = loadPhoenix(rise);
  const market = await fetchPhoenixMarketState('SOL');
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['limit', 'start_time']);
  assert.equal(market.markPrice, 106.71);
});

test('takes the newest row whatever order the rows come in', async () => {
  for (const [rows, expected] of [
    // Newest first.
    [[
      { mark_price: 3, timestamp: '2026-10-14T09:43:16Z' },
      { mark_price: 2, timestamp: '2026-10-14T09:43:00Z' },
      { mark_price: 1, timestamp: '2026-10-14T09:42:58Z' },
    ], 3],
    // Mixed, with a junk row and a row that is not an object.
    [[
      { mark_price: 2, timestamp: '2026-10-14T09:43:00Z' },
      null,
      { mark_price: 3, timestamp: '2026-10-14T09:43:16Z' },
      { mark_price: 1, timestamp: '2026-10-14T09:42:58Z' },
    ], 3],
    // Equal or missing timestamps: the later row, as perp-api lists oldest first.
    [[{ mark_price: 1, timestamp: '2026-10-14T09:43:00Z' }, { mark_price: 2, timestamp: '2026-10-14T09:43:00Z' }], 2],
    [[{ markPx: 1 }, { markPx: 2 }], 2],
  ]) {
    const { fetchPhoenixMarketState } = loadPhoenix(riseReturning({ stats: rows }));
    const market = await fetchPhoenixMarketState('SOL');
    assert.equal(market.markPrice, expected, JSON.stringify(rows));
  }
});

test('still reads the earlier camelCase stats shape', async () => {
  const { fetchPhoenixMarketState } = loadPhoenix(riseReturning({
    data: [{
      markPx: 150, midPx: 149.5, oraclePx: 149.8, prevDayPx: 120,
      dayNtlVlm: 1_000_000, openInterest: 42, funding: 0.0001, high24h: 155, low24h: 118,
    }],
  }));
  const market = await fetchPhoenixMarketState('SOL');
  assert.equal(market.markPrice, 150);
  assert.equal(market.indexPrice, 149.8);
  assert.equal(market.midPrice, 149.5);
  assert.equal(market.change24h, 25);
  assert.equal(market.high24h, 155);
  assert.equal(market.low24h, 118);
  assert.equal(market.volume24h, 1_000_000);
  assert.equal(market.openInterest, 42);
  assert.equal(market.fundingRate, 0.0001);
});

test('skips a zero or unparseable mark price for the next real one', async () => {
  for (const [row, expected] of [
    [{ mark_price: 0, spot_price: 107.75 }, 107.75],
    [{ markPx: 'n/a', midPx: '99.5' }, 99.5],
    [{ mark_price: null, markPx: 0, oraclePx: 101 }, 101],
  ]) {
    const { fetchPhoenixMarketState } = loadPhoenix(riseReturning({ stats: [row] }));
    const market = await fetchPhoenixMarketState('SOL');
    assert.equal(market.markPrice, expected, JSON.stringify(row));
    assert.ok(Number.isFinite(market.change24h) && Number.isFinite(market.high24h) && Number.isFinite(market.low24h));
  }
});

test('shows no price, rather than failing, when stats are missing', async () => {
  for (const stats of [new Error('HTTP 503'), null, { stats: [] }, { data: [] }, { stats: [null] }, 'oops']) {
    const { fetchPhoenixMarketState } = loadPhoenix(riseReturning(stats));
    const market = await fetchPhoenixMarketState('SOL');
    assert.equal(market.markPrice, 0, String(stats));
    assert.equal(market.change24h, 0);
    // The market config still loads, so the screen keeps its other details.
    assert.equal(market.maxLeverage, 25);
    assert.equal(market.active, true);
  }
});
