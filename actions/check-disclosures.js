const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { updateOverridesFromDisclosure } = require("./conversion-adjustments");
const { fetchKindDisclosures } = require("./kind-disclosures");

const ROOT = path.resolve(__dirname, "..");
const WATCHLIST_PATH = path.join(ROOT, "watchlist.json");
const STATE_PATH = path.join(ROOT, "actions", "state.json");
const OVERRIDES_PATH = path.join(ROOT, "actions", "mezzanine-overrides.json");
const MAX_STATE_IDS = 5000;

function koreaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

function classifySource(item) {
  return /[유코넥채]/.test(item.rm || "") ? "KIND" : "DART";
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function portfolioJsonFromEnv(env = process.env) {
  if (env.MEZZANINE_PORTFOLIO_GZIP_BASE64) {
    return zlib.gunzipSync(Buffer.from(env.MEZZANINE_PORTFOLIO_GZIP_BASE64, "base64")).toString("utf8");
  }
  if (env.MEZZANINE_PORTFOLIO_BASE64) {
    return Buffer.from(env.MEZZANINE_PORTFOLIO_BASE64, "base64").toString("utf8");
  }
  return env.MEZZANINE_PORTFOLIO_JSON;
}

function disclosureNamesFromPortfolio(portfolio) {
  const names = new Set();
  for (const item of portfolio || []) {
    for (const value of [item.name, item.quoteName]) {
      const name = String(value || "")
        .replace(/\s*\d+\s*(?:CB|BW|EB|CPS|RCPS)$/i, "")
        .trim();
      if (name) names.add(name);
    }
  }
  return names;
}

async function fetchDisclosures(apiKey, fetchImpl = fetch) {
  const date = koreaDate();
  const results = [];
  let page = 1;
  let totalPages = 1;

  do {
    const params = new URLSearchParams({
      crtfc_key: apiKey,
      bgn_de: date,
      end_de: date,
      page_no: String(page),
      page_count: "100",
      sort: "date",
      sort_mth: "desc",
    });
    const response = await fetchImpl(`https://opendart.fss.or.kr/api/list.json?${params}`, {
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "portfolio-disclosure-alarm-github-actions/1.0" },
    });
    if (!response.ok) throw new Error(`OpenDART HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.status === "013") break;
    if (payload.status !== "000") throw new Error(`OpenDART ${payload.status}: ${payload.message}`);
    results.push(...(payload.list || []));
    totalPages = Number(payload.total_page || 1);
    page += 1;
  } while (page <= totalPages);

  const kindItems = await fetchKindDisclosures(date, fetchImpl).catch((error) => {
    console.error(`KIND fetch failed: ${error.message}`);
    return [];
  });
  const merged = [...results, ...kindItems];
  const seen = new Set();
  return merged.filter((item) => {
    const key = `${item.corp_name}|${item.report_nm}|${item.rcept_dt}|${item.source || classifySource(item)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function sendTelegram(item, token, chatId, fetchImpl = fetch) {
  const source = item.source || classifySource(item);
  const url = item.url || `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`;
  const text = [
    `[${source}] ${item.corp_name}`,
    item.report_nm,
    `제출인: ${item.flr_nm || "-"}`,
    url,
  ].join("\n");
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
}

async function run(options = {}) {
  const apiKey = options.apiKey || process.env.DART_API_KEY;
  const telegramToken = options.telegramToken || process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = options.telegramChatId || process.env.TELEGRAM_CHAT_ID;
  const fetchImpl = options.fetchImpl || fetch;
  const watchlistPath = options.watchlistPath || WATCHLIST_PATH;
  const statePath = options.statePath || STATE_PATH;
  const portfolioJson = options.portfolioJson || portfolioJsonFromEnv();

  if (!apiKey || !telegramToken || !telegramChatId) {
    throw new Error("DART_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID가 모두 필요합니다.");
  }

  const portfolio = portfolioJson ? JSON.parse(portfolioJson) : [];
  const watchlist = new Set([...readJson(watchlistPath, []), ...disclosureNamesFromPortfolio(portfolio)]);
  const state = readJson(statePath, { initialized: false, seen: [] });
  const seen = new Set(state.seen || []);
  const allItems = await fetchDisclosures(apiKey, fetchImpl);
  const watchedItems = allItems.filter((item) => watchlist.has(item.corp_name));
  const newItems = watchedItems.filter((item) => !seen.has(item.rcept_no)).reverse();

  for (const item of newItems) {
    const adjustment = await updateOverridesFromDisclosure(item, {
      portfolio,
      overridesPath: options.overridesPath || OVERRIDES_PATH,
      fetchImpl,
    });
    if (adjustment.updated) {
      console.log(`전환가액 조정 반영: ${adjustment.updates.map((update) => `${update.name}=${update.currentConversionPrice}`).join(", ")}`);
    }
    if (state.initialized) await sendTelegram(item, telegramToken, telegramChatId, fetchImpl);
  }

  if (!state.initialized) console.log("첫 실행: 기존 공시는 저장만 하고 알림을 보내지 않습니다.");

  const nextSeen = [
    ...watchedItems.map((item) => item.rcept_no),
    ...(state.seen || []),
  ].filter((value, index, values) => values.indexOf(value) === index).slice(0, MAX_STATE_IDS);

  const nextState = {
    initialized: true,
    seen: nextSeen,
  };
  if (JSON.stringify(state) !== JSON.stringify(nextState)) {
    fs.writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
  }

  console.log(`확인 완료: 관심 종목 공시 ${watchedItems.length}건, 신규 알림 ${state.initialized ? newItems.length : 0}건`);
  return { watchedCount: watchedItems.length, notifiedCount: state.initialized ? newItems.length : 0 };
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { classifySource, fetchDisclosures, run, sendTelegram };
