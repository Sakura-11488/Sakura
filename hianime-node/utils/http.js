const { USER_AGENT, REQUEST_TIMEOUT_MS } = require("../config");

async function fetchText(url, opts = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    ...opts.headers,
  };

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeout || REQUEST_TIMEOUT_MS
  );

  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJSON(url, opts = {}) {
  const text = await fetchText(url, {
    ...opts,
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      ...opts.headers,
    },
  });
  return JSON.parse(text);
}

async function fetchBuffer(url, opts = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    ...opts.headers,
  };

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeout || REQUEST_TIMEOUT_MS
  );

  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.arrayBuffer();
  } finally {
    clearTimeout(timeout);
  }
}

// Fallback: shell out to curl for TLS-fingerprint-sensitive hosts
async function curlText(url, referer) {
  const { execSync } = require("child_process");
  const args = [
    "curl",
    "-sS",
    "--max-time",
    "20",
    "-H",
    `"User-Agent: ${USER_AGENT}"`,
    "-H",
    `"Accept: */*"`,
  ];
  if (referer) {
    args.push("-H", `"Referer: ${referer}"`);
  }
  args.push(`"${url}"`);
  return execSync(args.join(" "), { encoding: "utf-8", timeout: 25000 });
}

module.exports = { fetchText, fetchJSON, fetchBuffer, curlText };
