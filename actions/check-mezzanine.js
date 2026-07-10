const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { overrideKey } = require("./conversion-adjustments");

const DAY_MS = 24 * 60 * 60 * 1000;
const ALERT_DAYS = 14;
const LOW_PRICE_THRESHOLD = 1000;
const LOW_PRICE_COUNT_START = "2026-07-01";
const LOW_MARKET_CAP_EOK = 300;
const OVERRIDES_PATH = path.join(__dirname, "mezzanine-overrides.json");

function koreaToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
}

function parseDate(value) {
  if (!value || ["없음", "-", "nan"].includes(String(value).trim())) return null;
  const text = String(value).trim();
  const match = text.match(/(?:20)?(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!match) return null;
  return new Date(Date.UTC(2000 + Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function parseCallPeriod(value) {
  if (!value || ["없음", "-", "nan"].includes(String(value).trim())) return { start: null, end: null };
  const dates = String(value).match(/(?:20)?\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2}/g) || [];
  return { start: parseDate(dates[0]), end: parseDate(dates[1]) };
}

function putPeriod(item) {
  const period = parseCallPeriod(item.putPeriod);
  if (period.start || period.end) return period;
  const date = parseDate(item.putDate);
  return { start: date, end: null };
}

function putWindows(item) {
  if (Array.isArray(item.putSchedule) && item.putSchedule.length) {
    return item.putSchedule
      .map((row) => ({
        no: row.no,
        start: parseDate(row.from || row.start),
        end: parseDate(row.to || row.end),
        payment: parseDate(row.payment || row.putDate),
        rate: row.rate || "",
      }))
      .filter((row) => row.start);
  }
  const period = putPeriod(item);
  return period.start ? [{ start: period.start, end: period.end, payment: parseDate(item.putDate), rate: "" }] : [];
}

function daysUntil(date, today) {
  return date ? Math.round((date.getTime() - today.getTime()) / DAY_MS) : null;
}

function formatDate(date) {
  return date ? date.toISOString().slice(0, 10) : "-";
}

function number(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
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

function applyOverrides(portfolio, overrides = {}) {
  return portfolio.map((item) => {
    const override = overrides[overrideKey(item)];
    return override ? { ...item, ...override } : item;
  });
}

async function fetchPrice(code, fetchImpl = fetch) {
  const stockCode = String(code).replace(/^A/, "");
  const response = await fetchImpl(`https://m.stock.naver.com/api/stock/${stockCode}/basic`, {
    headers: { "User-Agent": "Mozilla/5.0 portfolio-disclosure-alarm/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Price HTTP ${response.status}: ${stockCode}`);
  const payload = await response.json();
  const price = number(payload.closePrice);
  if (price === null) throw new Error(`No price: ${stockCode}`);
  return { price, stockName: payload.stockName || stockCode };
}

async function fetchPriceHistory(code, fetchImpl = fetch, pageSize = 60) {
  const stockCode = String(code).replace(/^A/, "");
  const response = await fetchImpl(`https://m.stock.naver.com/api/stock/${stockCode}/price?pageSize=${pageSize}&page=1`, {
    headers: { "User-Agent": "Mozilla/5.0 portfolio-disclosure-alarm/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Price history HTTP ${response.status}: ${stockCode}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error(`No price history: ${stockCode}`);
  return payload.map((row) => ({
    date: row.localTradedAt || row.localDate,
    closePrice: number(row.closePrice),
  })).filter((row) => row.date && row.closePrice !== null);
}

function parseMarketCapEok(value) {
  const text = String(value || "").replaceAll(",", "").trim();
  let eok = 0;
  const jo = text.match(/([\d.]+)\s*조/);
  const uk = text.match(/([\d.]+)\s*억/);
  if (jo) eok += Number(jo[1]) * 10000;
  if (uk) eok += Number(uk[1]);
  if (!jo && !uk) {
    const raw = Number(text);
    if (Number.isFinite(raw)) eok = raw;
  }
  return Number.isFinite(eok) && eok > 0 ? eok : null;
}

async function fetchMarketInfo(code, fetchImpl = fetch) {
  const stockCode = String(code).replace(/^A/, "");
  const response = await fetchImpl(`https://m.stock.naver.com/api/stock/${stockCode}/integration`, {
    headers: { "User-Agent": "Mozilla/5.0 portfolio-disclosure-alarm/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Market info HTTP ${response.status}: ${stockCode}`);
  const payload = await response.json();
  const marketValueText = (payload.totalInfos || []).find((item) => item.code === "marketValue")?.value || "";
  const marketCapEok = parseMarketCapEok(marketValueText);
  return {
    marketCapText: marketValueText,
    marketCapEok,
    thresholdEok: LOW_MARKET_CAP_EOK,
    isBelow: marketCapEok !== null && marketCapEok < LOW_MARKET_CAP_EOK,
  };
}

function belowThresholdInfo(history, threshold = LOW_PRICE_THRESHOLD, startDate = LOW_PRICE_COUNT_START) {
  const filtered = (history || []).filter((row) => String(row.date).slice(0, 10) >= startDate);
  let streak = 0;
  for (const row of filtered) {
    if (Number(row.closePrice) < threshold) streak += 1;
    else break;
  }
  const latest = filtered?.[0] || history?.[0] || null;
  return {
    threshold,
    startDate,
    streak,
    isBelow: Boolean(latest && Number(latest.closePrice) < threshold),
    warning: streak >= 20,
    critical: streak >= 30,
    latestClose: latest?.closePrice ?? null,
    latestDate: latest?.date || "",
  };
}

function evaluate(item, currentPrice, today = koreaToday()) {
  const alerts = [];
  const conversionDate = parseDate(item.conversionDate);
  const conversionDays = daysUntil(conversionDate, today);
  const initialPrice = number(item.initialConversionPrice);

  if (conversionDays !== null && conversionDays <= ALERT_DAYS && initialPrice !== null && currentPrice > initialPrice) {
    const premium = ((currentPrice / initialPrice - 1) * 100).toFixed(1);
    alerts.push(`전환 가능 ${conversionDays < 0 ? `${Math.abs(conversionDays)}일 경과` : conversionDays === 0 ? "오늘" : `${conversionDays}일 전`} · 현재가 ${currentPrice.toLocaleString()}원 > 최초전환가 ${initialPrice.toLocaleString()}원 (+${premium}%)`);
  }

  const puts = putWindows(item);
  const activePut = puts.find((put) => put.start && put.end && today >= put.start && today <= put.end);
  if (activePut) {
    alerts.push(`현재 Put 행사기간 (${formatDate(activePut.start)} ~ ${formatDate(activePut.end)} · 지급 ${formatDate(activePut.payment)})`);
  } else {
    const nextPut = puts
      .map((put) => ({ ...put, days: daysUntil(put.start, today) }))
      .filter((put) => put.days !== null && put.days >= 0 && put.days <= ALERT_DAYS)
      .sort((a, b) => a.days - b.days)[0];
    if (nextPut) {
      const periodText = nextPut.end ? `${formatDate(nextPut.start)} ~ ${formatDate(nextPut.end)}` : formatDate(nextPut.start);
      alerts.push(`Put 행사기간 시작 ${nextPut.days === 0 ? "오늘" : `${nextPut.days}일 후`} (${periodText} · 지급 ${formatDate(nextPut.payment)})`);
    }
  }

  const call = parseCallPeriod(item.callPeriod);
  const callStartDays = daysUntil(call.start, today);
  if (call.start && call.end && today >= call.start && today <= call.end) {
    alerts.push(`현재 Call 행사기간 (${formatDate(call.start)} ~ ${formatDate(call.end)})`);
  } else if (callStartDays !== null && callStartDays >= 0 && callStartDays <= ALERT_DAYS) {
    alerts.push(`Call 행사 시작 ${callStartDays === 0 ? "오늘" : `${callStartDays}일 후`} (${formatDate(call.start)})`);
  } else if (call.start && !call.end && callStartDays !== null && callStartDays >= 0 && callStartDays <= ALERT_DAYS) {
    alerts.push(`Call 행사일 ${callStartDays === 0 ? "오늘" : `${callStartDays}일 후`} (${formatDate(call.start)})`);
  }

  const refixDate = parseDate(item.nextRefixingDate);
  const refixDays = daysUntil(refixDate, today);
  if (refixDays !== null && refixDays >= 0 && refixDays <= ALERT_DAYS) {
    alerts.push(`다음 리픽싱 ${refixDays === 0 ? "오늘" : `${refixDays}일 후`} (${formatDate(refixDate)})`);
  }

  return alerts;
}

async function sendTelegram(text, token, chatId, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
}

function splitMessages(lines, maxLength = 3900) {
  const messages = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 2 > maxLength) {
      messages.push(current);
      current = "";
    }
    current += `${current ? "\n\n" : ""}${line}`;
  }
  if (current) messages.push(current);
  return messages;
}

async function run(options = {}) {
  const telegramToken = options.telegramToken || process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = options.telegramChatId || process.env.TELEGRAM_CHAT_ID;
  const portfolioJson = options.portfolioJson || portfolioJsonFromEnv();
  const fetchImpl = options.fetchImpl || fetch;
  const today = options.today || koreaToday();

  if (!telegramToken || !telegramChatId || !portfolioJson) {
    throw new Error("TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MEZZANINE_PORTFOLIO_BASE64가 필요합니다.");
  }

  const portfolio = applyOverrides(
    JSON.parse(portfolioJson),
    options.overrides || readJson(options.overridesPath || OVERRIDES_PATH, {}),
  );
  const lines = [];
  const errors = [];
  const priceCache = new Map();

  for (const item of portfolio) {
    try {
      const quoteCode = item.quoteCode || item.code;
      if (!priceCache.has(quoteCode)) priceCache.set(quoteCode, await fetchPrice(quoteCode, fetchImpl));
      const { price } = priceCache.get(quoteCode);
      const alerts = evaluate(item, price, today);
      if (alerts.length) {
        lines.push(`▶ ${item.name} (${String(item.code).replace(/^A/, "")})\n${alerts.map((alert) => `- ${alert}`).join("\n")}`);
      }
    } catch (error) {
      errors.push(`${item.name}: ${error.message}`);
    }
  }

  if (lines.length) {
    const header = `[메자닌 일정 알림] ${formatDate(today)}\n조건 해당 ${lines.length}건`;
    const messages = splitMessages([header, ...lines]);
    for (const message of messages) await sendTelegram(message, telegramToken, telegramChatId, fetchImpl);
  }

  if (errors.length) console.error(`조회 실패 ${errors.length}건\n${errors.join("\n")}`);
  console.log(`메자닌 점검 완료: ${portfolio.length}개 증권, 조건 해당 ${lines.length}건`);
  return { portfolioCount: portfolio.length, alertCount: lines.length, errors };
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { applyOverrides, belowThresholdInfo, evaluate, fetchMarketInfo, fetchPrice, fetchPriceHistory, koreaToday, parseCallPeriod, parseDate, parseMarketCapEok, portfolioJsonFromEnv, putPeriod, putWindows, run, splitMessages };
