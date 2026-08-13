/**
 * Upstream HTML/binary fetcher for the Sakura hentai scraper.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * hentaifox.com sits behind Cloudflare bot management. The block is on the
 * CLIENT FINGERPRINT, not on our IP: from one machine, in the same second,
 * Node/undici sending a Chrome User-Agent gets `403 cf-mitigated: challenge`
 * while a genuine Chrome TLS handshake gets `200` and the full HTML. No amount
 * of header work fixes that from inside Node — the giveaway is Node's TLS
 * ClientHello (JA3/JA4), not the headers.
 *
 * So HTML is fetched through `impit` (Rust/reqwest, prebuilt binary, no browser,
 * no daemon, no metered API). Images stay on plain undici: the image CDN
 * (i*.hentaifox.com) is an unprotected static Cloudflare cache — verified 200
 * image/jpeg to a bare `curl` UA with no Referer — so it costs nothing.
 *
 * Rules encoded here, each one paid for by a real incident:
 *   1. A bot-management 403 is a VERDICT, not a transient. Never retry it.
 *      Retrying hammers a scored origin with the request that just lost, and
 *      the client's /popular fallback turns one failure into five. We cool down.
 *   2. Never trust the status code alone — some CF configs serve the
 *      interstitial with 200, which "succeeds" into an empty parse. That is the
 *      green-healthcheck-over-a-dead-path failure this project keeps hitting.
 *   3. Never trust a 200 either. The caller supplies a validator that must
 *      assert the PRODUCT (items parsed, page URLs built), not the byte count.
 *   4. The whole retry budget must stay under nginx's proxy_read_timeout, or
 *      the app gets an opaque 504 instead of our error. See ecosystem.config.cjs.
 */

import { Impit } from "impit";
import { fetch as undiciFetch } from "undici";

export class UpstreamError extends Error {
    /** @param {"BLOCKED"|"BUSY"|"TIMEOUT"|"NETWORK"|"HTTP"|"INVALID"} code */
    constructor(code, message, { status = null, cause = null } = {}) {
        super(message);
        this.name = "UpstreamError";
        this.code = code;
        this.status = status;
        if (cause) this.cause = cause;
    }
}

// Cloudflare-specific tokens. These never appear in HentaiFox's own markup, so
// they are conclusive at any status code.
const CF_TOKENS = ["__cf_chl", "cf_chl_opt", "challenge-platform", "cf-browser-verification"];

// Prose markers are NOT conclusive: HentaiFox echoes the search query into
// <title> (`<title>Searching: love - HentaiFox</title>`), so a user searching
// "just a moment" would otherwise self-inflict a permanent 502. Anchored to
// <title> and only consulted on an error status.
const CHALLENGE_PROSE = [
    /<title>\s*just a moment/i,
    /<title>\s*attention required/i,
    /<title>\s*(access denied|please wait)/i,
];

export function looksLikeChallenge({ status, headers, html }) {
    if (headers && typeof headers.get === "function" && headers.get("cf-mitigated")) return true;
    const head = String(html || "").slice(0, 4000);
    const lower = head.toLowerCase();
    if (CF_TOKENS.some((t) => lower.includes(t))) return true;
    if (status >= 400 && CHALLENGE_PROSE.some((re) => re.test(head))) return true;
    return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * impit accepts anything with tough-cookie's two async methods. This 25-line
 * in-memory jar carries Cloudflare's __cf_bm / cf_clearance and HentaiFox's
 * PHPSESSID across requests — the most un-browserlike trait left after the TLS
 * fix, and free to remove. Verified against impit 0.14.3: it awaits the returned
 * promises and does not pass a callback.
 */
function createCookieJar() {
    const byHost = new Map();
    return {
        async setCookie(cookie, url) {
            let host;
            try {
                host = new URL(url).host;
            } catch {
                return;
            }
            const [pair] = String(cookie).split(";");
            const eq = pair.indexOf("=");
            if (eq <= 0) return;
            const jar = byHost.get(host) || new Map();
            jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            while (jar.size > 32) jar.delete(jar.keys().next().value);
            byHost.set(host, jar);
        },
        async getCookieString(url) {
            let host;
            try {
                host = new URL(url).host;
            } catch {
                return "";
            }
            const jar = byHost.get(host);
            if (!jar || jar.size === 0) return "";
            return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
        },
        clear() {
            byHost.clear();
        },
    };
}

/**
 * Counting semaphore with a BOUNDED queue. An unbounded queue is worse than a
 * cap: a burst parks hundreds of waiters, they all outlive nginx's read timeout,
 * and the caller gets a 504 for work we are still doing. Over the cap we shed
 * load immediately with a clean 503 instead.
 */
function createLimiter(concurrency, queueMax) {
    let active = 0;
    const waiters = [];
    return {
        async acquire() {
            if (active < concurrency) {
                active += 1;
                return;
            }
            if (waiters.length >= queueMax) {
                throw new UpstreamError("BUSY", "upstream fetch queue is full");
            }
            await new Promise((resolve) => waiters.push(resolve));
        },
        release() {
            const next = waiters.shift();
            if (next) next();
            else active -= 1;
        },
        get active() {
            return active;
        },
        get queued() {
            return waiters.length;
        },
    };
}

export function createUpstream(options = {}) {
    const timeoutMs = Number(options.timeoutMs || 8_000);
    const maxRetries = Math.max(0, Number(options.maxRetries ?? 1));
    const backoffMs = Number(options.backoffMs || 600);
    const blockCooldownMs = Number(options.blockCooldownMs || 90_000);
    const proxyUrl = String(options.proxyUrl || "").trim();
    const limiter = createLimiter(
        Math.max(1, Number(options.concurrency || 4)),
        Math.max(1, Number(options.queueMax || 24)),
    );

    // Two impersonation profiles. We do not retry into a challenge, but when one
    // profile gets scored we come back after the cooldown wearing a different
    // one, with a fresh cookie identity.
    const PROFILES = ["chrome", "firefox"];
    let profileIndex = 0;
    let client = null;
    let clientProfile = null;
    const jar = createCookieJar();

    const state = {
        requests: 0,
        failures: 0,
        blockedCount: 0,
        consecutiveFailures: 0,
        blockedUntil: 0,
        lastOkAt: null,
        lastErrorAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
    };

    function getClient() {
        const want = PROFILES[profileIndex % PROFILES.length];
        if (!client || clientProfile !== want) {
            client = new Impit({
                browser: want,
                cookieJar: jar,
                timeout: timeoutMs,
                followRedirects: true,
                maxRedirects: 5,
                // Credentialed; never logged, never surfaced in /healthz.
                ...(proxyUrl ? { proxyUrl } : {}),
            });
            clientProfile = want;
        }
        return client;
    }

    function rotateProfile() {
        profileIndex += 1;
        client = null;
        jar.clear();
    }

    function recordSuccess() {
        state.requests += 1;
        state.consecutiveFailures = 0;
        state.blockedUntil = 0;
        state.lastOkAt = new Date().toISOString();
    }

    function recordFailure(err) {
        state.requests += 1;
        state.failures += 1;
        state.consecutiveFailures += 1;
        state.lastErrorAt = new Date().toISOString();
        state.lastErrorCode = err?.code || "UNKNOWN";
        state.lastErrorMessage = String(err?.message || err).slice(0, 200);
    }

    function classifyNetworkError(err) {
        const name = String(err?.name || "");
        const msg = String(err?.message || err);
        if (/timeout/i.test(name) || /timeout|timed out/i.test(msg) || name === "AbortError") {
            return new UpstreamError("TIMEOUT", `upstream timed out after ${timeoutMs}ms`, { cause: err });
        }
        return new UpstreamError("NETWORK", `upstream network error: ${msg.slice(0, 120)}`, { cause: err });
    }

    /**
     * Fetch a page of HTML.
     *
     * DELIBERATELY SENDS NO CUSTOM HEADERS. impit's profile emits a coherent
     * Chrome set (User-Agent, sec-ch-ua, sec-fetch-*, Accept-Language) that
     * matches the TLS fingerprint it presents. Hand-setting a Chrome-126 UA on a
     * Chrome-137 handshake, or a Referer alongside a `Sec-Fetch-Site: none`
     * navigation, is itself a detectable mismatch — the exact class of tell we
     * are here to remove.
     *
     * @param {(html: string) => true|string} [validate] returns true, or a
     *        human reason string that becomes an INVALID error. The result is
     *        never cached by the caller when this rejects.
     */
    async function fetchHtml(url, { validate = null, timeoutMs: perCall } = {}) {
        const now = Date.now();
        if (now < state.blockedUntil) {
            const left = Math.ceil((state.blockedUntil - now) / 1000);
            throw new UpstreamError("BLOCKED", `upstream is challenging us; cooling down ${left}s`);
        }

        let lastErr = null;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            await limiter.acquire(); // may throw BUSY — intentionally not retried
            let res;
            let body;
            try {
                res = await getClient().fetch(url, {
                    method: "GET",
                    timeout: perCall || timeoutMs,
                    redirect: "follow",
                });
                body = await res.text();
            } catch (err) {
                limiter.release();
                lastErr = classifyNetworkError(err);
                if (attempt < maxRetries) {
                    await sleep(backoffMs * (attempt + 1) + Math.floor(Math.random() * 200));
                    continue;
                }
                recordFailure(lastErr);
                throw lastErr;
            }
            limiter.release();

            if (looksLikeChallenge({ status: res.status, headers: res.headers, html: body })) {
                state.blockedUntil = Date.now() + blockCooldownMs;
                state.blockedCount += 1;
                rotateProfile();
                const err = new UpstreamError(
                    "BLOCKED",
                    `bot challenge from upstream (HTTP ${res.status})`,
                    { status: res.status },
                );
                recordFailure(err);
                throw err; // rule 1: a verdict, not a blip
            }

            if (!res.ok) {
                const err = new UpstreamError("HTTP", `upstream HTTP ${res.status}`, { status: res.status });
                if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
                    lastErr = err;
                    await sleep(backoffMs * (attempt + 1) + Math.floor(Math.random() * 200));
                    continue;
                }
                recordFailure(err);
                throw err;
            }

            if (validate) {
                const verdict = validate(body);
                if (verdict !== true) {
                    // Markup drift does not heal on retry, and caching it is how
                    // an empty reader becomes sticky. Fail loud, cache nothing.
                    const err = new UpstreamError(
                        "INVALID",
                        `upstream returned unusable HTML: ${verdict || "failed validation"}`,
                    );
                    recordFailure(err);
                    throw err;
                }
            }

            recordSuccess();
            return body;
        }
        const err = lastErr || new UpstreamError("NETWORK", "upstream failed");
        recordFailure(err);
        throw err;
    }

    /**
     * Binary fetch used ONLY as the /img fallback. The image CDN is unprotected
     * today; this exists so that if it ever starts scoring us the way the HTML
     * host does, images recover automatically instead of going blank.
     */
    async function fetchBinary(url, { timeoutMs: perCall } = {}) {
        await limiter.acquire();
        try {
            const res = await getClient().fetch(url, {
                method: "GET",
                timeout: perCall || timeoutMs,
                redirect: "follow",
            });
            const buf = Buffer.from(await res.arrayBuffer());
            if (!res.ok) throw new UpstreamError("HTTP", `upstream HTTP ${res.status}`, { status: res.status });
            return { buf, contentType: res.headers.get("content-type") || "" };
        } finally {
            limiter.release();
        }
    }

    /** Direct, unproxied, free. The image CDN needs nothing clever. */
    async function fetchBinaryDirect(url, { timeoutMs: perCall, headers = {} } = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), perCall || timeoutMs);
        try {
            const res = await undiciFetch(url, {
                method: "GET",
                signal: controller.signal,
                headers,
                redirect: "follow",
            });
            const buf = Buffer.from(await res.arrayBuffer());
            return { ok: res.ok, status: res.status, buf, contentType: res.headers.get("content-type") || "" };
        } finally {
            clearTimeout(timer);
        }
    }

    function stats() {
        const now = Date.now();
        return {
            blocked: now < state.blockedUntil,
            blockedForMs: Math.max(0, state.blockedUntil - now),
            profile: PROFILES[profileIndex % PROFILES.length],
            viaProxy: Boolean(proxyUrl), // boolean only — the URL holds credentials
            requests: state.requests,
            failures: state.failures,
            blockedCount: state.blockedCount,
            consecutiveFailures: state.consecutiveFailures,
            lastOkAt: state.lastOkAt,
            lastErrorAt: state.lastErrorAt,
            lastErrorCode: state.lastErrorCode,
            lastErrorMessage: state.lastErrorMessage,
            active: limiter.active,
            queued: limiter.queued,
        };
    }

    return { fetchHtml, fetchBinary, fetchBinaryDirect, stats };
}
