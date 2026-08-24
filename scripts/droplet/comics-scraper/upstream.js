/**
 * Upstream fetcher for the Sakura Comics scraper.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * In July 2026 xoxocomic.com was behind a Cloudflare managed challenge that
 * blocked this droplet's datacenter IP, so EVERY upstream byte — HTML, covers
 * and page images — was routed through ZenRows, a metered paid proxy
 * (commits ba43b84, 4308e77). That block has since LIFTED. Re-measured
 * 2026-08-13 with node's built-in fetch (undici — the exact client this service
 * uses), no proxy:
 *
 *   /popular-comic          200  631,061 b  text/html   132 comic links
 *   /search-comic?keyword=  200  327,999 b  text/html
 *   /comic/invincible       200  152,582 b  .list-info + .list-chapter present
 *   /comic/<s>/<i>/all      200  183,214 b  18 page URLs parsed
 *   /images/series/5061.jpg 200   16,898 b  image/jpeg, magic ffd8ffe0
 *   12 varied URLs, concurrency 4 -> 12/12 200, 0 challenges, 1,678 ms wall
 *   `cf-mitigated` absent on every response.
 *
 * THE BLOCK CAN COME BACK, so ZenRows stays wired as an automatic fallback
 * rather than being deleted. This file owns the ladder:
 *
 *       direct (undici, free)  ->  [challenge or transport failure]  ->  ZenRows
 *
 * Rules encoded here, each one paid for by a real incident or a real refutation:
 *
 *  1. ESCALATE ON A CHALLENGE OR A TRANSPORT FAILURE — NEVER ON A PRODUCT
 *     FAILURE. This is the load-bearing distinction and it is enforced by
 *     `escalationClass()` below, in ONE place, so it cannot drift between the
 *     HTML and image paths.
 *       - 2xx + no CF markers + validator says no  -> INVALID. Free. FINAL.
 *       - 4xx (not 403/429) + no CF markers        -> HTTP.    Free. FINAL.
 *       - challenge / 403 / 429 / 5xx / timeout / network -> escalate.
 *     Measured reason this matters: xoxocomic answers `/comic/<bogus-slug>` with
 *     HTTP 200 + its homepage, so a stale link or a crawler hitting
 *     `/details?id=<random>` would otherwise buy one metered js_render call per
 *     request, forever, on a public unauthenticated endpoint. That is the exact
 *     mechanism behind the 926 AUTH004 quota hits in the current logs.
 *
 *  2. EVEN AN ELIGIBLE ESCALATION IS RATE-LIMITED. `escalationBudget` is a token
 *     bucket (default 8 per 10 min). A block is one event; it does not need one
 *     paid call per inbound request to be discovered. Out of tokens = the direct
 *     error is returned as-is, free.
 *
 *  3. THE CHALLENGE-TOKEN SCAN MUST STAY ANCHORED TO THE FIRST 4 KB. Cloudflare
 *     injects its JSD beacon (/cdn-cgi/challenge-platform/scripts/jsd/main.js)
 *     near the END of every HEALTHY xoxocomic page — measured today at offset
 *     182,517 of a 183,205-byte chapter page, i.e. 688 bytes from the end.
 *     Scanning the whole body for "challenge-platform" would mark every single
 *     page as blocked and 502 the entire Comics tab. Head-slice first, always.
 *
 *  4. PROSE MARKERS ARE ANCHORED TO <title> AND ONLY CONSULTED AT status >= 400.
 *     Search echoes user input into the page; a bare substring test lets a user
 *     searching "just a moment" self-inflict a permanent 502.
 *
 *  5. A BLOCK IS A VERDICT, NOT A BLIP — AND IT IS PER-CHANNEL. HTML and images
 *     get INDEPENDENT cooldowns. They behave differently on this host (HTML is
 *     fine, chapter page images are dead for everyone) and coupling them is how
 *     an HTML challenge ends up routing 29 free-and-final image verdicts through
 *     the paid tier. Within a channel: cooldown, then exactly ONE single-flight
 *     re-probe.
 *
 *  6. ANY UNCHALLENGED HTTP RESPONSE FROM THE ORIGIN CLEARS THAT CHANNEL'S
 *     COOLDOWN. Reaching the origin is the whole question the probe asks; the
 *     usefulness of the body is a separate one. Not doing this leaves
 *     `blockedUntil` pinned in the past, which silently diverts every concurrent
 *     request to the metered tier while /healthz still reports mode "direct".
 *
 *  7. NEVER TRUST A 200. The caller supplies a validator asserting the PRODUCT
 *     (items parsed, chapters found, page URLs built), not the byte count. The
 *     validator RETURNS THE PARSED PRODUCT so the caller does not parse the same
 *     600 KB document twice on a 1-vCPU box.
 *
 *  8. 402 (quota dry) IS NOT 429 (too fast). 429 is transient and retried.
 *     402 means the safety net is GONE; mark it exhausted, stop attempting it,
 *     and surface an honest error instead of retrying into a paywall.
 *
 *  9. EVERY REQUEST HAS A HARD DEADLINE, and it is smaller than nginx's
 *     proxy_read_timeout. A retry ladder that outlives the socket is just money
 *     spent on a response nobody will read.
 *
 * 10. NOTHING IS BUFFERED WITHOUT A CEILING. This box is 1 GB with NO SWAP and
 *     six pm2 services that die together. /img fetches caller-supplied URLs.
 */

import { fetch as undiciFetch } from "undici";

export class UpstreamError extends Error {
    /** @param {"BLOCKED"|"QUOTA"|"BUSY"|"TIMEOUT"|"NETWORK"|"HTTP"|"INVALID"} code */
    constructor(code, message, { status = null, cause = null } = {}) {
        super(message);
        this.name = "UpstreamError";
        this.code = code;
        this.status = status;
        if (cause) this.cause = cause;
    }
}

// Cloudflare-specific tokens. Conclusive at any status code — but see rule 3:
// these MUST only ever be tested against the head of the document, because CF's
// JSD beacon puts "challenge-platform" at the tail of every healthy page.
const CF_TOKENS = ["__cf_chl", "cf_chl_opt", "challenge-platform", "cf-browser-verification"];

// Rule 4: anchored to <title>, and only consulted on an error status.
const CHALLENGE_PROSE = [
    /<title>\s*just a moment/i,
    /<title>\s*attention required/i,
    /<title>\s*(access denied|please wait|checking your browser)/i,
];

/**
 * @param {{status:number, headers:{get?:(k:string)=>string|null}|null, html:string}} r
 */
export function looksLikeChallenge({ status, headers, html }) {
    if (headers && typeof headers.get === "function" && headers.get("cf-mitigated")) return true;
    // Rule 3 — head slice FIRST. Never scan the full body for CF_TOKENS.
    const head = String(html || "").slice(0, 4000);
    const lower = head.toLowerCase();
    if (CF_TOKENS.some((t) => lower.includes(t))) return true;
    if (status >= 400 && CHALLENGE_PROSE.some((re) => re.test(head))) return true;
    return false;
}

/**
 * Rule 1, in ONE place. Given what the direct tier produced, may we spend money?
 *
 * @param {{challenge:boolean, status:number|null, code:string|null}} o
 * @returns {"escalate"|"final"}
 */
export function escalationClass({ challenge, status, code }) {
    if (challenge) return "escalate";
    // Transport-level failures can be a TLS-fingerprint block wearing a
    // network error's clothes (that is literally what broke hentaifox), so a
    // different client is worth trying — under the token bucket.
    if (code === "TIMEOUT" || code === "NETWORK") return "escalate";
    if (status === 403 || status === 429) return "escalate";
    if (typeof status === "number" && status >= 500) return "escalate";
    // Everything else — a validated-but-useless 200, a 404, a 410 — is a product
    // failure. A second opinion from a residential IP will say the same thing.
    return "final";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Counting semaphore with a BOUNDED queue. An unbounded queue is worse than a
 * cap: a burst parks hundreds of waiters, they all outlive nginx's read timeout,
 * and the caller gets an opaque 504 for work we are still doing. Over the cap we
 * shed load immediately with a clean 503 (BUSY).
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
        get active() { return active; },
        get queued() { return waiters.length; },
    };
}

/** Rule 2. Refilling token bucket — cheap, allocation-free, no timers. */
function createBudget(tokens, windowMs) {
    let remaining = tokens;
    let windowStartedAt = Date.now();
    return {
        take() {
            const now = Date.now();
            if (now - windowStartedAt >= windowMs) {
                windowStartedAt = now;
                remaining = tokens;
            }
            if (remaining <= 0) return false;
            remaining -= 1;
            return true;
        },
        get remaining() {
            return Date.now() - windowStartedAt >= windowMs ? tokens : remaining;
        },
    };
}

/** Rule 10. Read a response body with a hard ceiling, checking content-length first. */
async function readCapped(res, maxBytes, what) {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
        try { await res.body?.cancel(); } catch { /* already closed */ }
        throw new UpstreamError("INVALID", `${what} too large: ${declared} > ${maxBytes} bytes`);
    }
    if (!res.body) return Buffer.alloc(0);
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) {
            try { await res.body.cancel(); } catch { /* already closed */ }
            throw new UpstreamError("INVALID", `${what} exceeded ${maxBytes} bytes mid-stream`);
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
}

export function createUpstream(options = {}) {
    const upstreamBase = String(options.upstreamBase || "https://xoxocomic.com").replace(/\/+$/, "");

    // Rule 9. The whole ladder must finish inside this, which must sit under
    // nginx's proxy_read_timeout (30s live). Everything below is derived from it.
    const totalBudgetMs = Number(options.totalBudgetMs || 25_000);

    // --- direct tier (free) ---------------------------------------------------
    const directTimeoutMs = Number(options.directTimeoutMs || 8_000);
    const directLimiter = createLimiter(
        Math.max(1, Number(options.directConcurrency || 6)),
        Math.max(1, Number(options.directQueueMax || 24)),
    );
    // Rule 5. How long we stay on the proxy after a channel is challenged.
    const blockCooldownMs = Number(options.blockCooldownMs || 10 * 60 * 1000);

    // Rule 10. Ceilings. The largest page measured is 631 KB; the largest image
    // on disk is 873 KB. These are ~3x headroom, not tight fits.
    const maxHtmlBytes = Number(options.maxHtmlBytes || 3 * 1024 * 1024);
    const maxImageBytes = Number(options.maxImageBytes || 8 * 1024 * 1024);

    // --- proxy tier (ZenRows, metered) ---------------------------------------
    const fetchProxyTemplate = String(options.fetchProxyTemplate || "");
    const imageProxyTemplate = String(options.imageProxyTemplate || fetchProxyTemplate || "");
    const proxyTimeoutMs = Number(options.proxyTimeoutMs || 9_000);
    const proxyImageTimeoutMs = Number(options.proxyImageTimeoutMs || proxyTimeoutMs);
    const PROXY_MAX_RETRIES = Math.max(0, Number(options.proxyMaxRetries ?? 1));
    const PROXY_BACKOFF_BASE_MS = Number(options.proxyBackoffMs || 600);
    // The paid tier gets a BOUNDED queue too. The shipped version had an
    // unbounded waiter array, and it is the tier that is actually under pressure
    // during a block — backpressure belongs here more than anywhere.
    const proxyLimiter = createLimiter(
        Math.max(1, Number(options.proxyConcurrency || 2)),
        Math.max(1, Number(options.proxyQueueMax || 16)),
    );
    // Rule 8. Once 402 lands, the paid tier is gone until someone pays; there is
    // no point rediscovering that once per request.
    const quotaCooldownMs = Number(options.quotaCooldownMs || 6 * 60 * 60 * 1000);
    // Rule 2.
    const escalationBudget = createBudget(
        Math.max(1, Number(options.escalationBudget || 8)),
        Number(options.escalationWindowMs || 10 * 60 * 1000),
    );

    function proxiedUrl(template, url) {
        if (!template) return url;
        return template.replace("{{url}}", encodeURIComponent(url));
    }

    // Rule 5 — independent per-channel block state.
    const channels = {
        html: { blockedUntil: 0, probeInFlight: false, blockedCount: 0 },
        image: { blockedUntil: 0, probeInFlight: false, blockedCount: 0 },
    };

    const state = {
        requests: 0,
        failures: 0,
        directOk: 0,
        directFail: 0,
        proxyOk: 0,
        proxyFail: 0,
        escalations: 0,          // every entry into the paid tier, no exceptions
        escalationsDenied: 0,    // eligible but out of budget
        invalidResults: 0,       // product failures — free, and NOT health signals
        deadImageShortCircuits: 0,
        quotaExhaustedUntil: 0,
        quotaHits: 0,
        proxyCredits: 0,
        consecutiveFailures: 0,
        lastOkAt: null,
        lastOkVia: null,
        lastErrorAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
    };

    /**
     * Negative memo for URLs the origin answers with non-image bytes and no
     * challenge. 100% of chapter page images are in this state today, ~29 per
     * chapter. Without it, a reader session re-downloads ~106 KB of homepage
     * HTML per page, per view — and during a block it would send all of them to
     * the paid tier at 5 credits each.
     */
    const deadImageTtlMs = Number(options.deadImageTtlMs || 30 * 60 * 1000);
    const deadImages = new Map(); // url -> expiry ms
    const deadImagesMax = Math.max(64, Number(options.deadImagesMax || 4096));
    function markDeadImage(url) {
        if (deadImages.size >= deadImagesMax) {
            // Cheap FIFO trim — insertion order is Map iteration order.
            const oldest = deadImages.keys().next().value;
            if (oldest !== undefined) deadImages.delete(oldest);
        }
        deadImages.set(url, Date.now() + deadImageTtlMs);
    }
    function isKnownDeadImage(url) {
        const exp = deadImages.get(url);
        if (exp === undefined) return false;
        if (Date.now() >= exp) {
            deadImages.delete(url);
            return false;
        }
        return true;
    }

    const proxyConfigured = () => Boolean(fetchProxyTemplate || imageProxyTemplate);
    const quotaDry = () => Date.now() < state.quotaExhaustedUntil;
    const proxyUsable = () => proxyConfigured() && !quotaDry();

    /**
     * Current live mode, for /healthz. Reports "proxy" whenever a channel is in
     * ANY blocked state — including "cooldown expired, probe pending" — because
     * in that state real traffic is still being routed to the metered tier.
     * Reporting "direct" there is how a credit leak stays invisible.
     */
    function mode() {
        const blocked = channels.html.blockedUntil !== 0 || channels.image.blockedUntil !== 0;
        if (!blocked) return "direct";
        return proxyUsable() ? "proxy" : "blocked";
    }

    function recordSuccess(via) {
        state.requests += 1;
        state.consecutiveFailures = 0;
        state.lastOkAt = new Date().toISOString();
        state.lastOkVia = via;
        if (via === "direct") state.directOk += 1;
        else state.proxyOk += 1;
    }

    /**
     * Only OUR-path-is-broken failures move the health needle. A caller-supplied
     * bogus slug produces INVALID; counting it would let anyone drive /healthz to
     * 503 with three requests, on a public endpoint, while the service is
     * serving real traffic perfectly.
     */
    const HEALTH_AFFECTING = new Set(["BLOCKED", "QUOTA", "TIMEOUT", "NETWORK"]);
    function recordFailure(err, { probe = false } = {}) {
        const code = err?.code || "UNKNOWN";
        if (code === "INVALID") state.invalidResults += 1;
        state.lastErrorAt = new Date().toISOString();
        state.lastErrorCode = code;
        state.lastErrorMessage = String(err?.message || err).slice(0, 200);
        // Probes must never feed the health counters: /readyz failing during a
        // block would otherwise take /healthz down with it and page an operator
        // about a service that is up.
        if (probe) return;
        state.requests += 1;
        state.failures += 1;
        if (HEALTH_AFFECTING.has(code)) state.consecutiveFailures += 1;
    }

    /** Rule 5: enter sticky proxy mode for ONE channel. */
    function enterBlockedMode(channel, reason) {
        const ch = channels[channel];
        ch.blockedUntil = Date.now() + blockCooldownMs;
        ch.blockedCount += 1;
        console.warn(
            `[upstream] ${channel} direct path challenged (${reason}); ` +
            `using proxy for ${Math.round(blockCooldownMs / 1000)}s`,
        );
    }

    /**
     * Rule 6. We reached the origin and it was not challenging us. That is the
     * only question the cooldown exists to answer, so clear it — regardless of
     * whether the BODY turned out to be useful. Leaving it set is the leak that
     * routes every concurrent request to the meter while /healthz says "direct".
     */
    function clearBlock(channel) {
        if (channels[channel].blockedUntil !== 0) {
            console.log(`[upstream] ${channel} direct path recovered; back to the free tier`);
        }
        channels[channel].blockedUntil = 0;
    }

    /** Rule 8: the paid tier is dry. */
    function enterQuotaExhausted(status) {
        if (!quotaDry()) {
            state.quotaExhaustedUntil = Date.now() + quotaCooldownMs;
            state.quotaHits += 1;
            const forText = quotaCooldownMs >= 3600000
                ? `${Math.round(quotaCooldownMs / 3600000)}h`
                : `${Math.round(quotaCooldownMs / 1000)}s`;
            console.error(
                `[upstream] proxy quota exhausted (HTTP ${status}); disabling paid tier for ` +
                `${forText} — top up the account to restore the fallback`,
            );
        }
    }

    /**
     * Rule 5, the way back, per channel.
     *
     *   never blocked          -> everyone goes direct
     *   inside the cooldown    -> nobody goes direct, everyone uses the proxy
     *   cooldown just expired  -> exactly ONE request re-probes direct while
     *                             everyone else keeps using the proxy
     *
     * The latch is claimed SYNCHRONOUSLY here, before any await, which is what
     * makes it genuinely single-flight on an event loop. Without it, cooldown
     * expiry releases the entire backlog at a freshly-scored origin in the same
     * tick — the precise behaviour that earned the block in the first place.
     */
    function claimDirect(channel) {
        const ch = channels[channel];
        if (ch.blockedUntil === 0) return { tryDirect: true, isProbe: false };
        if (Date.now() < ch.blockedUntil) return { tryDirect: false, isProbe: false };
        if (ch.probeInFlight) return { tryDirect: false, isProbe: false };
        ch.probeInFlight = true;
        return { tryDirect: true, isProbe: true };
    }

    /**
     * Release the probe latch. A probe that did NOT reach the origin must re-arm
     * the cooldown; otherwise `blockedUntil` stays pinned in the past and every
     * subsequent request probes again, turning the cooldown into a no-op.
     * `clearBlock()` (rule 6) handles the success side and has already run by
     * the time we get here, so `blockedUntil === 0` means "recovered".
     */
    function releaseDirectProbe(channel, reachedOrigin) {
        const ch = channels[channel];
        ch.probeInFlight = false;
        if (!reachedOrigin && ch.blockedUntil !== 0 && Date.now() >= ch.blockedUntil) {
            ch.blockedUntil = Date.now() + blockCooldownMs;
        }
    }

    function classifyNetworkError(err, timeoutMs) {
        if (err instanceof UpstreamError) return err;
        const name = String(err?.name || "");
        const msg = String(err?.message || err);
        if (name === "AbortError" || /timeout|timed out/i.test(msg) || /timeout/i.test(name)) {
            return new UpstreamError("TIMEOUT", `upstream timed out after ${timeoutMs}ms`, { cause: err });
        }
        return new UpstreamError("NETWORK", `upstream network error: ${msg.slice(0, 120)}`, { cause: err });
    }

    // -----------------------------------------------------------------------
    // Tier 1 — direct. Free, unmetered, and deliberately NOT routed through the
    // proxy limiter: a free request must never consume a paid slot.

    const DIRECT_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

    async function directFetch(url, { accept, timeoutMs, referer, maxBytes, what }) {
        await directLimiter.acquire();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await undiciFetch(url, {
                method: "GET",
                signal: controller.signal,
                headers: {
                    "User-Agent": DIRECT_UA,
                    Accept: accept,
                    "Accept-Language": "en-US,en;q=0.9",
                    ...(referer ? { Referer: referer } : {}),
                },
                redirect: "follow",
            });
            const buf = await readCapped(res, maxBytes, what);
            // `redirect: follow` means the host we ended on is not necessarily
            // the host we vetted. /img takes caller-supplied URLs, so re-check.
            return { status: res.status, ok: res.ok, headers: res.headers, buf, finalUrl: res.url || url };
        } catch (err) {
            throw classifyNetworkError(err, timeoutMs);
        } finally {
            clearTimeout(timer);
            directLimiter.release();
        }
    }

    // -----------------------------------------------------------------------
    // Tier 2 — ZenRows.

    /**
     * Fetch through the metered proxy honouring the account-wide concurrency
     * limit, retrying transient failures (429 concurrency, 403 unsolved
     * challenge, 5xx, network aborts) with exponential backoff. The per-attempt
     * timeout only starts once a slot is acquired, so time spent queued does not
     * count against it — but `deadline` (rule 9) bounds the whole thing so a
     * queued retry cannot outlive the socket nginx is holding open.
     *
     * `label` is a proxy-free string for error messages and logs; it keeps the
     * API key out of everything we log or return.
     */
    async function proxyFetch(targetUrl, options, { timeoutMs, label, deadline }) {
        let lastErr = null;
        for (let attempt = 0; attempt <= PROXY_MAX_RETRIES; attempt += 1) {
            const remaining = deadline - Date.now();
            if (remaining <= 250) {
                throw lastErr || new UpstreamError("TIMEOUT", `ran out of request budget for ${label}`);
            }
            await proxyLimiter.acquire();
            const attemptMs = Math.min(timeoutMs, deadline - Date.now());
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Math.max(500, attemptMs));
            try {
                const res = await undiciFetch(targetUrl, { ...options, signal: controller.signal });
                if (res.ok) return res;
                const body = await res.text().catch(() => "");
                const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
                lastErr = new Error(`Upstream HTTP ${res.status} for ${label}: ${body.slice(0, 200)}`);
                lastErr.status = res.status;
                if (!retryable) throw lastErr;
            } catch (err) {
                if (err.status && err.status !== 429 && err.status !== 403 && err.status < 500) throw err;
                lastErr = err;
            } finally {
                clearTimeout(timer);
                proxyLimiter.release();
            }
            if (attempt < PROXY_MAX_RETRIES) {
                const backoff = Math.min(3_000, PROXY_BACKOFF_BASE_MS * 2 ** attempt);
                if (Date.now() + backoff >= deadline) break;
                await sleep(backoff + Math.floor(Math.random() * 200));
            }
        }
        throw lastErr || new Error(`Upstream failed for ${label}`);
    }

    /** Wraps proxyFetch to add 402 classification and per-request credit accounting. */
    async function proxyGet(template, url, { accept, timeoutMs, label, deadline, maxBytes, what }) {
        if (!template) throw new UpstreamError("BLOCKED", "no proxy configured for this resource");
        if (quotaDry()) {
            throw new UpstreamError("QUOTA", "proxy quota exhausted; paid fallback unavailable");
        }
        // Every entry into the paid tier is counted, including the ones where the
        // direct tier was skipped entirely because a cooldown was active. The old
        // counter only fired when `directErr` was set, so it could read 1 while
        // hundreds of credits were spent.
        state.escalations += 1;
        try {
            const res = await proxyFetch(
                proxiedUrl(template, url),
                {
                    method: "GET",
                    headers: {
                        "User-Agent": DIRECT_UA,
                        Accept: accept,
                        "Accept-Language": "en-US,en;q=0.9",
                        Referer: upstreamBase,
                    },
                    redirect: "follow",
                },
                { timeoutMs, label, deadline },
            );
            // ZenRows reports per-request spend; summing it is the only burn-rate
            // observability that exists (there is no balance endpoint — every
            // /v1/usage, /v1/account, /v1/subscription candidate 404s).
            const credits = Number(res.headers.get("x-request-credits") || 0);
            if (Number.isFinite(credits) && credits > 0) state.proxyCredits += credits;
            const buf = await readCapped(res, maxBytes, what);
            return { status: res.status, ok: res.ok, headers: res.headers, buf };
        } catch (err) {
            if (err?.status === 402) {
                enterQuotaExhausted(err.status);
                throw new UpstreamError("QUOTA", "proxy quota exhausted; paid fallback unavailable", {
                    status: 402,
                });
            }
            if (err?.status === 429) {
                throw new UpstreamError("BUSY", "proxy concurrency limit reached", { status: 429 });
            }
            if (err instanceof UpstreamError) throw err;
            const e = classifyNetworkError(err, timeoutMs);
            e.status = err?.status ?? null;
            throw e;
        }
    }

    /**
     * Rules 1 + 2 + 8, in one gate. Decides whether the paid tier may be entered.
     * @returns {UpstreamError|null} null = go ahead; an error = stop here, free.
     */
    function paidTierGate({ template, allowProxy, directErr, directClass, skippedDirect }) {
        if (!allowProxy || !template) {
            return directErr || new UpstreamError("BLOCKED", "direct path is cooling down");
        }
        // Direct was never attempted (channel in cooldown): the proxy IS the path.
        if (!skippedDirect) {
            if (directClass === "final") {
                state.invalidResults += 1;
                return directErr;
            }
            if (!escalationBudget.take()) {
                state.escalationsDenied += 1;
                console.warn("[upstream] escalation budget exhausted; staying on the free tier");
                return directErr || new UpstreamError("BLOCKED", "escalation budget exhausted");
            }
        }
        if (quotaDry()) {
            return new UpstreamError(
                "QUOTA",
                `direct path failed (${directErr?.code || "BLOCKED"}) and the paid fallback is out of quota`,
            );
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // The ladder.

    /**
     * Fetch a page of HTML through the ladder.
     *
     * @param {string} url
     * @param {{
     *   validate?: (html:string) => {ok:true, value:any} | {ok:false, reason:string},
     *   allowProxy?: boolean,
     *   probe?: boolean,
     *   budgetMs?: number,
     * }} opts
     *   `validate` RETURNS THE PARSED PRODUCT (rule 7) so the caller does not
     *   re-parse the same document. `probe: true` keeps the call out of the
     *   health counters.
     * @returns {Promise<{html:string, via:"direct"|"proxy", value:any}>}
     */
    async function fetchHtml(url, { validate = null, allowProxy = true, probe = false, budgetMs, referer = upstreamBase } = {}) {
        const deadline = Date.now() + Number(budgetMs || totalBudgetMs);
        const { tryDirect, isProbe } = claimDirect("html");
        let directErr = null;
        let directClass = "escalate"; // when direct is skipped, the proxy is the path
        let reachedOrigin = false;

        if (tryDirect) {
            try {
                const res = await directFetch(url, {
                    accept: "text/html,application/xhtml+xml",
                    timeoutMs: Math.min(directTimeoutMs, Math.max(1000, deadline - Date.now())),
                    // Defaults to the XOXO base; a second source passes its own,
                    // because sending one site's Referer to another is both wrong
                    // and, on hotlink-protected hosts, a 403.
                    referer,
                    maxBytes: maxHtmlBytes,
                    what: "html body",
                });
                const html = res.buf.toString("utf8");
                const challenge = looksLikeChallenge({ status: res.status, headers: res.headers, html });

                if (challenge) {
                    enterBlockedMode("html", `HTTP ${res.status} challenge`);
                    directErr = new UpstreamError("BLOCKED", `bot challenge from upstream (HTTP ${res.status})`, {
                        status: res.status,
                    });
                    directClass = "escalate";
                } else {
                    // Rule 6 — we reached the origin, unchallenged.
                    reachedOrigin = true;
                    clearBlock("html");
                    if (!res.ok) {
                        directErr = new UpstreamError("HTTP", `upstream HTTP ${res.status}`, { status: res.status });
                        directClass = escalationClass({ challenge: false, status: res.status, code: "HTTP" });
                    } else {
                        const verdict = validate ? validate(html) : { ok: true, value: null };
                        if (verdict.ok) {
                            state.directOk += 0; // counted by recordSuccess
                            recordSuccess("direct");
                            return { html, via: "direct", value: verdict.value };
                        }
                        // Rule 1: a 200 with no product and no CF markers is
                        // markup drift or a soft-404. FREE and FINAL.
                        state.directFail += 1;
                        directErr = new UpstreamError("INVALID", `upstream returned unusable HTML: ${verdict.reason}`);
                        directClass = "final";
                    }
                }
            } catch (err) {
                directErr = classifyNetworkError(err, directTimeoutMs);
                if (directErr.code === "BUSY") {
                    // Our own backpressure, not an upstream problem — never spend
                    // money to work around our own queue cap.
                    recordFailure(directErr, { probe });
                    if (isProbe) releaseDirectProbe("html", false);
                    throw directErr;
                }
                if (directErr.code === "INVALID") {
                    // readCapped tripped: we did reach the origin.
                    reachedOrigin = true;
                    clearBlock("html");
                    directClass = "final";
                } else {
                    directClass = escalationClass({ challenge: false, status: null, code: directErr.code });
                }
            } finally {
                if (isProbe) releaseDirectProbe("html", reachedOrigin);
            }
        }

        const stop = paidTierGate({
            template: fetchProxyTemplate,
            allowProxy,
            directErr,
            directClass,
            skippedDirect: !tryDirect,
        });
        if (stop) {
            recordFailure(stop, { probe });
            throw stop;
        }

        try {
            const res = await proxyGet(fetchProxyTemplate, url, {
                accept: "text/html,application/xhtml+xml",
                timeoutMs: proxyTimeoutMs,
                label: url, // never the proxied form — that carries the API key
                deadline,
                maxBytes: maxHtmlBytes,
                what: "html body",
            });
            const html = res.buf.toString("utf8");
            if (looksLikeChallenge({ status: res.status, headers: null, html })) {
                const err = new UpstreamError("BLOCKED", "bot challenge survived the proxy tier");
                state.proxyFail += 1;
                recordFailure(err, { probe });
                throw err;
            }
            const verdict = validate ? validate(html) : { ok: true, value: null };
            if (!verdict.ok) {
                // Both tiers produced an unusable page: markup drift, not a
                // block. Retrying will not heal it, and the direct tier is
                // demonstrably fine, so make sure we are not stuck on the meter.
                clearBlock("html");
                state.proxyFail += 1;
                const err = new UpstreamError("INVALID", `upstream returned unusable HTML: ${verdict.reason}`);
                recordFailure(err, { probe });
                throw err;
            }
            recordSuccess("proxy");
            return { html, via: "proxy", value: verdict.value };
        } catch (err) {
            const e = classifyNetworkError(err, proxyTimeoutMs);
            if (!(err instanceof UpstreamError)) {
                state.proxyFail += 1;
                recordFailure(e, { probe });
            }
            throw e;
        }
    }

    /**
     * Fetch image bytes through the ladder.
     *
     * `isImage` is supplied by the caller (magic-byte sniffing) because the
     * content-type header lies in BOTH directions here: ZenRows returns proxied
     * binaries as text/plain, and xoxocomic returns dead page images as
     * text/html with HTTP 200.
     *
     * Rule 1 in action: a non-image body that is NOT a challenge does not
     * escalate, and the URL is memoised as dead. That is what stops us paying
     * 5 credits per page to re-fetch the homepage for the ~29 dead page images
     * in every chapter — measured today at 105,995 bytes of homepage HTML per
     * page image, on every comic tried.
     *
     * @returns {Promise<{buf:Buffer, via:"direct"|"proxy"|"memo"}>}
     */
    async function fetchImage(url, { isImage, allowProxy = true, referer = upstreamBase, probe = false, budgetMs } = {}) {
        if (isKnownDeadImage(url)) {
            state.deadImageShortCircuits += 1;
            throw new UpstreamError("INVALID", "upstream did not return image bytes (memoised)");
        }
        const deadline = Date.now() + Number(budgetMs || totalBudgetMs);
        const { tryDirect, isProbe } = claimDirect("image");
        let directErr = null;
        let directClass = "escalate";
        let reachedOrigin = false;

        if (tryDirect) {
            try {
                const res = await directFetch(url, {
                    accept: "image/webp,image/apng,image/*,*/*;q=0.8",
                    timeoutMs: Math.min(directTimeoutMs, Math.max(1000, deadline - Date.now())),
                    referer,
                    maxBytes: maxImageBytes,
                    what: "image body",
                });
                if (res.ok && isImage(res.buf)) {
                    reachedOrigin = true;
                    clearBlock("image");
                    recordSuccess("direct");
                    return { buf: res.buf, via: "direct", finalUrl: res.finalUrl };
                }
                // Not image bytes. Decode only the head — these bodies are ~106 KB
                // of HTML and we only need to know whether Cloudflare is talking.
                const head = res.buf.subarray(0, 4096).toString("utf8");
                if (looksLikeChallenge({ status: res.status, headers: res.headers, html: head })) {
                    enterBlockedMode("image", `image HTTP ${res.status} challenge`);
                    directErr = new UpstreamError("BLOCKED", "bot challenge on image fetch", { status: res.status });
                    directClass = "escalate";
                } else {
                    // Rules 1 + 6: a soft-404 / dead image. Free, final, memoised
                    // — and it PROVES the origin is reachable, so clear the block.
                    reachedOrigin = true;
                    clearBlock("image");
                    state.directFail += 1;
                    markDeadImage(url);
                    directErr = new UpstreamError("INVALID", "upstream did not return image bytes", {
                        status: res.status,
                    });
                    directClass = "final";
                }
            } catch (err) {
                directErr = classifyNetworkError(err, directTimeoutMs);
                if (directErr.code === "BUSY") {
                    if (isProbe) releaseDirectProbe("image", false);
                    throw directErr;
                }
                if (directErr.code === "INVALID") {
                    reachedOrigin = true;
                    clearBlock("image");
                    markDeadImage(url);
                    directClass = "final";
                } else {
                    directClass = escalationClass({ challenge: false, status: null, code: directErr.code });
                }
            } finally {
                if (isProbe) releaseDirectProbe("image", reachedOrigin);
            }
        }

        const stop = paidTierGate({
            template: imageProxyTemplate,
            allowProxy,
            directErr,
            directClass,
            skippedDirect: !tryDirect,
        });
        if (stop) {
            // Image failures are logged but do not move consecutiveFailures for
            // INVALID (see recordFailure); a dead upstream image is a content
            // outage, not a broken service.
            recordFailure(stop, { probe });
            throw stop;
        }

        const res = await proxyGet(imageProxyTemplate, url, {
            accept: "image/webp,image/apng,image/*,*/*;q=0.8",
            timeoutMs: proxyImageTimeoutMs,
            label: url,
            deadline,
            maxBytes: maxImageBytes,
            what: "image body",
        });
        if (!isImage(res.buf)) {
            state.proxyFail += 1;
            // Both tiers agree it is not an image: memoise so we never pay twice.
            markDeadImage(url);
            const err = new UpstreamError("INVALID", "upstream did not return image bytes", { status: res.status });
            recordFailure(err, { probe });
            throw err;
        }
        recordSuccess("proxy");
        return { buf: res.buf, via: "proxy" };
    }

    /** Observed state for /healthz. Booleans/counters only for anything credentialed. */
    function stats() {
        const now = Date.now();
        return {
            mode: mode(),
            htmlBlocked: now < channels.html.blockedUntil,
            imageBlocked: now < channels.image.blockedUntil,
            // "cooldown expired, waiting on a probe" — real traffic is on the
            // meter here even though the two booleans above are false.
            htmlProbePending: channels.html.blockedUntil !== 0 && now >= channels.html.blockedUntil,
            imageProbePending: channels.image.blockedUntil !== 0 && now >= channels.image.blockedUntil,
            blockedCount: channels.html.blockedCount + channels.image.blockedCount,
            proxyConfigured: proxyConfigured(),
            proxyQuotaExhausted: quotaDry(),
            proxyQuotaResumesInMs: Math.max(0, state.quotaExhaustedUntil - now),
            proxyQuotaHits: state.quotaHits,
            proxyCreditsSpent: state.proxyCredits,
            escalations: state.escalations,
            escalationsDenied: state.escalationsDenied,
            escalationBudgetRemaining: escalationBudget.remaining,
            requests: state.requests,
            failures: state.failures,
            invalidResults: state.invalidResults,
            deadImageShortCircuits: state.deadImageShortCircuits,
            deadImageMemoSize: deadImages.size,
            directOk: state.directOk,
            directFail: state.directFail,
            proxyOk: state.proxyOk,
            proxyFail: state.proxyFail,
            consecutiveFailures: state.consecutiveFailures,
            lastOkAt: state.lastOkAt,
            lastOkVia: state.lastOkVia,
            lastErrorAt: state.lastErrorAt,
            lastErrorCode: state.lastErrorCode,
            lastErrorMessage: state.lastErrorMessage,
            directActive: directLimiter.active,
            directQueued: directLimiter.queued,
            proxyActive: proxyLimiter.active,
            proxyQueued: proxyLimiter.queued,
        };
    }

    return { fetchHtml, fetchImage, stats, mode };
}
