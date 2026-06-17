const DAY_MS = 24 * 60 * 60 * 1000;
const ALERT_DAYS = 14;

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

function evaluate(item, currentPrice, today = koreaToday()) {
  const alerts = [];
  const conversionDate = parseDate(item.conversionDate);
  const conversionDays = daysUntil(conversionDate, today);
  const initialPrice = number(item.initialConversionPrice);

  if (conversionDays !== null && conversionDays <= ALERT_DAYS && initialPrice !== null && currentPrice > initialPrice) {
    const premium = ((currentPrice / initialPrice - 1) * 100).toFixed(1);
    alerts.push(`전환 가능 ${conversionDays < 0 ? `${Math.abs(conversionDays)}일 경과` : conversionDays === 0 ? "오늘" : `${conversionDays}일 전`} · 현재가 ${currentPrice.toLocaleString()}원 > 최초전환가 ${initialPrice.toLocaleString()}원 (+${premium}%)`);
  }

  const putDate = parseDate(item.putDate);
  const putDays = daysUntil(putDate, today);
  if (putDays !== null && putDays >= 0 && putDays <= ALERT_DAYS) {
    alerts.push(`Put 행사 가능 ${putDays === 0 ? "오늘" : `${putDays}일 후`} (${formatDate(putDate)})`);
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
  const portfolioJson = options.portfolioJson
    || (process.env.MEZZANINE_PORTFOLIO_BASE64
      ? Buffer.from(process.env.MEZZANINE_PORTFOLIO_BASE64, "base64").toString("utf8")
      : process.env.MEZZANINE_PORTFOLIO_JSON);
  const fetchImpl = options.fetchImpl || fetch;
  const today = options.today || koreaToday();

  if (!telegramToken || !telegramChatId || !portfolioJson) {
    throw new Error("TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MEZZANINE_PORTFOLIO_BASE64가 필요합니다.");
  }

  const portfolio = JSON.parse(portfolioJson);
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

module.exports = { evaluate, fetchPrice, koreaToday, parseCallPeriod, parseDate, run, splitMessages };
