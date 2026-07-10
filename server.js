const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { applyOverrides, belowThresholdInfo, evaluate: evaluateMezzanine, fetchMarketInfo: fetchMezzanineMarketInfo, fetchPrice: fetchMezzaninePrice, fetchPriceHistory: fetchMezzaninePriceHistory, koreaToday } = require("./actions/check-mezzanine");
const { updateOverridesFromDisclosure } = require("./actions/conversion-adjustments");
const { fetchKindDisclosures } = require("./actions/kind-disclosures");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const WATCHLIST_PATH = path.join(ROOT, "watchlist.json");
const MEZZANINE_PATH = path.join(ROOT, "mezzanine-portfolio-secret.json");
const MEZZANINE_OVERRIDES_PATH = path.join(DATA_DIR, "mezzanine-overrides.json");
const ENV_PATH = path.join(ROOT, ".env");

loadEnv(ENV_PATH);

const config = {
  dartApiKey: process.env.DART_API_KEY || "",
  pollIntervalMs: Math.max(30, Number(process.env.POLL_INTERVAL_SECONDS || 60)) * 1000,
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "0.0.0.0",
  notifyOnFirstSync: /^true$/i.test(process.env.NOTIFY_ON_FIRST_SYNC || ""),
  ntfyTopic: process.env.NTFY_TOPIC || "",
  ntfyServer: (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, ""),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
};

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "disclosures.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS disclosures (
    rcept_no TEXT PRIMARY KEY,
    corp_name TEXT NOT NULL,
    stock_code TEXT,
    report_nm TEXT NOT NULL,
    flr_nm TEXT,
    rcept_dt TEXT NOT NULL,
    source TEXT NOT NULL,
    remark TEXT,
    url TEXT NOT NULL,
    discovered_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const watchlist = new Set(readWatchlist());
const sseClients = new Set();
const status = {
  running: false,
  syncing: false,
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastError: null,
  nextCheckAt: null,
};
const mezzanineCache = { checkedAt: null, items: [], errors: [], promise: null };

const insertDisclosure = db.prepare(`
  INSERT OR IGNORE INTO disclosures
  (rcept_no, corp_name, stock_code, report_nm, flr_nm, rcept_dt, source, remark, url, discovered_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const recentDisclosures = db.prepare(`
  SELECT * FROM disclosures
  ORDER BY rcept_dt DESC, rcept_no DESC
  LIMIT ?
`);
const getStateStmt = db.prepare("SELECT value FROM app_state WHERE key = ?");
const setStateStmt = db.prepare(`
  INSERT INTO app_state (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

for (const [key, property, envName] of [
  ["dart_api_key", "dartApiKey", "DART_API_KEY"],
  ["ntfy_topic", "ntfyTopic", "NTFY_TOPIC"],
  ["telegram_token", "telegramToken", "TELEGRAM_BOT_TOKEN"],
  ["telegram_chat_id", "telegramChatId", "TELEGRAM_CHAT_ID"],
]) {
  const saved = getState(key);
  if (!process.env[envName] && saved) config[property] = saved;
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function readWatchlist() {
  const values = JSON.parse(fs.readFileSync(WATCHLIST_PATH, "utf8"));
  if (!Array.isArray(values) || values.some((name) => typeof name !== "string")) {
    throw new Error("watchlist.json은 종목명 문자열 배열이어야 합니다.");
  }
  const names = new Set(values.map((name) => name.trim()).filter(Boolean));
  if (fs.existsSync(MEZZANINE_PATH)) {
    for (const item of JSON.parse(fs.readFileSync(MEZZANINE_PATH, "utf8"))) {
      for (const value of [item.name, item.quoteName]) {
        const name = String(value || "")
          .replace(/\s*\d+\s*(?:CB|BW|EB|CPS|RCPS)$/i, "")
          .trim();
        if (name) names.add(name);
      }
    }
  }
  return [...names];
}

function readMezzaninePortfolio() {
  if (!fs.existsSync(MEZZANINE_PATH)) return [];
  const portfolio = JSON.parse(fs.readFileSync(MEZZANINE_PATH, "utf8"));
  const overrides = fs.existsSync(MEZZANINE_OVERRIDES_PATH)
    ? JSON.parse(fs.readFileSync(MEZZANINE_OVERRIDES_PATH, "utf8"))
    : {};
  return applyOverrides(portfolio, overrides);
}

async function getMezzanineDashboard(force = false) {
  const cacheAge = mezzanineCache.checkedAt ? Date.now() - new Date(mezzanineCache.checkedAt).getTime() : Infinity;
  if (!force && cacheAge < 5 * 60 * 1000) return mezzanineCache;
  if (mezzanineCache.promise) return mezzanineCache.promise;

  mezzanineCache.promise = (async () => {
    const portfolio = readMezzaninePortfolio();
    const priceCache = new Map();
    const historyCache = new Map();
    const marketInfoCache = new Map();
    const errors = [];
    const today = koreaToday();
    const items = [];

    for (const item of portfolio) {
      try {
        const quoteCode = item.quoteCode || item.code;
        if (!priceCache.has(quoteCode)) priceCache.set(quoteCode, await fetchMezzaninePrice(quoteCode));
        if (!historyCache.has(quoteCode)) historyCache.set(quoteCode, await fetchMezzaninePriceHistory(quoteCode).catch((error) => ({ error })));
        if (!marketInfoCache.has(quoteCode)) marketInfoCache.set(quoteCode, await fetchMezzanineMarketInfo(quoteCode).catch((error) => ({ error })));
        const quote = priceCache.get(quoteCode);
        const history = historyCache.get(quoteCode);
        const marketInfo = marketInfoCache.get(quoteCode);
        const lowPrice = Array.isArray(history) ? belowThresholdInfo(history) : { threshold: 1000, streak: 0, isBelow: false, warning: false, critical: false, latestClose: quote.price, latestDate: "", error: history.error.message };
        items.push({
          ...item,
          currentPrice: quote.price,
          quoteName: item.quoteName || quote.stockName,
          lowPrice,
          marketCap: marketInfo.error ? { thresholdEok: 300, isBelow: false, error: marketInfo.error.message } : marketInfo,
          parity: Number(item.currentConversionPrice) > 0
            ? Math.round((quote.price / Number(item.currentConversionPrice)) * 1000) / 10
            : null,
          alerts: evaluateMezzanine(item, quote.price, today),
        });
      } catch (error) {
        errors.push(`${item.name}: ${error.message}`);
        items.push({ ...item, currentPrice: null, alerts: [], priceError: error.message });
      }
    }

    items.sort((a, b) => Number(b.alerts.length > 0) - Number(a.alerts.length > 0) || a.name.localeCompare(b.name, "ko"));
    mezzanineCache.checkedAt = new Date().toISOString();
    mezzanineCache.items = items;
    mezzanineCache.errors = errors;
    return mezzanineCache;
  })().finally(() => {
    mezzanineCache.promise = null;
  });

  return mezzanineCache.promise;
}

function getState(key) {
  return getStateStmt.get(key)?.value ?? null;
}

function setState(key, value) {
  setStateStmt.run(key, String(value));
}

function saveSettings(settings) {
  const values = {
    dartApiKey: String(settings.dartApiKey || "").trim(),
    ntfyTopic: String(settings.ntfyTopic || "").trim(),
    telegramToken: String(settings.telegramToken || "").trim(),
    telegramChatId: String(settings.telegramChatId || "").trim(),
  };
  for (const [property, key] of [
    ["dartApiKey", "dart_api_key"],
    ["ntfyTopic", "ntfy_topic"],
    ["telegramToken", "telegram_token"],
    ["telegramChatId", "telegram_chat_id"],
  ]) {
    config[property] = values[property];
    setState(key, values[property]);
  }
  status.lastError = null;
  broadcast("status", publicStatus());
}

function localUrls() {
  const urls = new Set([`http://localhost:${config.port}`]);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.add(`http://${address.address}:${config.port}`);
      }
    }
  }
  return [...urls];
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function koreaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

function classifySource(item) {
  return /[유코넥채]/.test(item.rm || "") ? "KIND" : "DART";
}

function normalizeDisclosure(item) {
  if (item.source === "KIND") {
    return {
      ...item,
      stock_code: item.stock_code || "",
      flr_nm: item.flr_nm || "",
      remark: item.remark || "KIND",
      discovered_at: new Date().toISOString(),
    };
  }
  return {
    rcept_no: item.rcept_no,
    corp_name: item.corp_name,
    stock_code: item.stock_code || "",
    report_nm: item.report_nm,
    flr_nm: item.flr_nm || "",
    rcept_dt: item.rcept_dt,
    source: classifySource(item),
    remark: item.rm || "",
    url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
    discovered_at: new Date().toISOString(),
  };
}

async function fetchTodayDisclosures() {
  const date = koreaDate();
  const results = [];
  let page = 1;
  let totalPages = 1;

  do {
    const params = new URLSearchParams({
      crtfc_key: config.dartApiKey,
      bgn_de: date,
      end_de: date,
      page_no: String(page),
      page_count: "100",
      sort: "date",
      sort_mth: "desc",
    });
    const response = await fetch(`https://opendart.fss.or.kr/api/list.json?${params}`, {
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "portfolio-disclosure-alarm/1.0" },
    });
    if (!response.ok) throw new Error(`OpenDART HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.status === "013") break;
    if (payload.status !== "000") {
      throw new Error(`OpenDART ${payload.status}: ${payload.message}`);
    }
    results.push(...(payload.list || []));
    totalPages = Number(payload.total_page || 1);
    page += 1;
  } while (page <= totalPages);

  const dartItems = results.filter((item) => watchlist.has(item.corp_name));
  const kindItems = await fetchKindDisclosures(date).catch((error) => {
    console.error(`KIND fetch failed: ${error.message}`);
    return [];
  });
  const merged = [...dartItems, ...kindItems.filter((item) => watchlist.has(item.corp_name))];
  const seen = new Set();
  return merged.filter((item) => {
    const source = item.source || classifySource(item);
    const key = `${item.corp_name}|${item.report_nm}|${item.rcept_dt}|${source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function notify(disclosure) {
  const title = `[${disclosure.source}] ${disclosure.corp_name}`;
  const message = `${disclosure.report_nm}\n제출인: ${disclosure.flr_nm || "-"}\n${disclosure.url}`;
  const jobs = [];

  if (config.ntfyTopic) {
    jobs.push(fetch(config.ntfyServer, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: config.ntfyTopic,
        title,
        message,
        tags: [disclosure.source === "KIND" ? "chart_with_upwards_trend" : "page_facing_up"],
        click: disclosure.url,
      }),
      signal: AbortSignal.timeout(15000),
    }).then((response) => {
      if (!response.ok) throw new Error(`ntfy HTTP ${response.status}`);
    }));
  }

  if (config.telegramToken && config.telegramChatId) {
    const telegramUrl = `https://api.telegram.org/bot${config.telegramToken}/sendMessage`;
    jobs.push(fetch(telegramUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: `${title}\n${message}`,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15000),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
    }));
  }

  const settled = await Promise.allSettled(jobs);
  const failures = settled.filter((result) => result.status === "rejected");
  if (failures.length) {
    console.error("알림 전송 실패:", failures.map((item) => item.reason?.message || item.reason));
  }
  return {
    attempted: jobs.length,
    failures: failures.map((item) => item.reason?.message || String(item.reason)),
  };
}

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) client.write(data);
}

async function sync() {
  if (status.syncing || !config.dartApiKey) return;
  status.syncing = true;
  status.lastCheckedAt = new Date().toISOString();
  status.lastError = null;

  try {
    const initialSyncDone = getState("initial_sync_done") === "true";
    const items = await fetchTodayDisclosures();
    const newItems = [];

    for (const rawItem of items.reverse()) {
      const item = normalizeDisclosure(rawItem);
      const result = insertDisclosure.run(
        item.rcept_no, item.corp_name, item.stock_code, item.report_nm,
        item.flr_nm, item.rcept_dt, item.source, item.remark, item.url, item.discovered_at,
      );
      if (result.changes > 0) newItems.push(item);
    }

    for (const item of newItems) {
      const adjustment = await updateOverridesFromDisclosure(item, {
        portfolio: readMezzaninePortfolio(),
        overridesPath: MEZZANINE_OVERRIDES_PATH,
      });
      if (adjustment.updated) {
        mezzanineCache.checkedAt = null;
        broadcast("mezzanine-updated", adjustment);
      }
      broadcast("disclosure", item);
      if (initialSyncDone || config.notifyOnFirstSync) await notify(item);
    }

    setState("initial_sync_done", "true");
    status.lastSuccessAt = new Date().toISOString();
    broadcast("status", publicStatus());
    console.log(`[${new Date().toLocaleString("ko-KR")}] 확인 완료: 신규 ${newItems.length}건`);
  } catch (error) {
    status.lastError = error.message;
    broadcast("status", publicStatus());
    console.error(`[${new Date().toLocaleString("ko-KR")}] 수집 실패:`, error.message);
  } finally {
    status.syncing = false;
    status.nextCheckAt = new Date(Date.now() + config.pollIntervalMs).toISOString();
  }
}

function publicStatus() {
  return {
    ...status,
    configured: Boolean(config.dartApiKey),
    pollIntervalSeconds: config.pollIntervalMs / 1000,
    ntfyEnabled: Boolean(config.ntfyTopic),
    telegramEnabled: Boolean(config.telegramToken && config.telegramChatId),
    watchlistCount: watchlist.size,
    mezzanineCount: readMezzaninePortfolio().length,
    localUrls: localUrls(),
  };
}

function json(res, value, statusCode = 200) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function serveFile(req, res) {
  let requested;
  try {
    const pathname = req.url.split("?")[0];
    requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  } catch {
    json(res, { error: "Bad request" }, 400);
    return;
  }
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    json(res, { error: "Not found" }, 404);
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  res.writeHead(200, {
    "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
    "Cache-Control": requested === "/sw.js" ? "no-cache" : "public, max-age=300",
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/disclosures") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 200)));
    json(res, recentDisclosures.all(limit));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/watchlist") {
    json(res, [...watchlist]);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/mezzanine") {
    try {
      const force = url.searchParams.get("refresh") === "1";
      json(res, await getMezzanineDashboard(force));
    } catch (error) {
      json(res, { error: error.message }, 500);
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    json(res, publicStatus());
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/settings") {
    json(res, {
      dartApiKey: config.dartApiKey ? "configured" : "",
      ntfyTopic: config.ntfyTopic,
      telegramToken: config.telegramToken ? "configured" : "",
      telegramChatId: config.telegramChatId,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/settings") {
    try {
      const settings = await readJsonBody(req);
      if (settings.dartApiKey === "configured") settings.dartApiKey = config.dartApiKey;
      if (settings.telegramToken === "configured") settings.telegramToken = config.telegramToken;
      saveSettings(settings);
      sync();
      json(res, { saved: true, status: publicStatus() });
    } catch (error) {
      json(res, { error: error.message }, 400);
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/test-notification") {
    const sample = {
      source: "DART",
      corp_name: "공시 알리미",
      report_nm: "모바일 알림 테스트입니다.",
      flr_nm: "포트폴리오 공시 알리미",
      url: `http://${req.headers.host || `localhost:${config.port}`}`,
    };
    const result = await notify(sample);
    json(res, {
      sent: result.attempted > 0 && result.failures.length === 0,
      ...result,
    }, result.failures.length ? 502 : 200);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/sync") {
    sync();
    json(res, { accepted: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(`event: status\ndata: ${JSON.stringify(publicStatus())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  serveFile(req, res);
});

server.listen(config.port, config.host, () => {
  status.running = true;
  status.nextCheckAt = new Date().toISOString();
  console.log(`공시 알리미 실행: http://${config.host}:${config.port}`);
  if (!config.dartApiKey) console.log(".env에 DART_API_KEY를 설정하면 수집이 시작됩니다.");
  sync();
  setInterval(sync, config.pollIntervalMs);
});
