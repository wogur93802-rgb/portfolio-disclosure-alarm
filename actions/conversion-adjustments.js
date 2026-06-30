const fs = require("node:fs");

function normalizeCode(code) {
  const value = String(code || "").trim();
  if (!value) return "";
  return value.startsWith("A") ? value : `A${value.padStart(6, "0")}`;
}

function numberText(value) {
  const match = String(value || "").match(/[\d,]+(?:\.\d+)?/);
  return match ? match[0].replaceAll(",", "") : null;
}

function issueNo(name) {
  const match = String(name || "").match(/(\d+)\s*(?:CB|BW|EB|CPS|RCPS)/i);
  return match ? match[1] : "";
}

function overrideKey(item) {
  return [normalizeCode(item.code), issueNo(item.name), String(item.name || "").replace(/\s+/g, "")].join("|");
}

function isConversionAdjustmentDisclosure(disclosure) {
  const title = String(disclosure.report_nm || disclosure.reportName || "");
  return /(\uC804\uD658\uAC00\uC561|\uD589\uC0AC\uAC00\uC561|\uAD50\uD658\uAC00\uC561).{0,12}\uC870\uC815|\uC870\uC815.{0,12}(\uC804\uD658\uAC00\uC561|\uD589\uC0AC\uAC00\uC561|\uAD50\uD658\uAC00\uC561)/.test(title);
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#40;/g, "(")
    .replace(/&#41;/g, ")")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function htmlToText(html) {
  return decodeHtml(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

async function responseText(response) {
  const contentType = response.headers.get("content-type") || "";
  const charset = contentType.match(/charset=([^;\s]+)/i)?.[1]?.toLowerCase();
  if (charset && !/^utf-?8$/i.test(charset)) {
    const encoding = charset === "ms949" ? "euc-kr" : charset;
    return new TextDecoder(encoding).decode(await response.arrayBuffer());
  }
  return response.text();
}

async function fetchDisclosureText(rceptNo, fetchImpl = fetch) {
  const mainUrl = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(rceptNo)}`;
  const mainResponse = await fetchImpl(mainUrl, {
    headers: { "User-Agent": "Mozilla/5.0 portfolio-disclosure-alarm/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!mainResponse.ok) throw new Error(`DART main HTTP ${mainResponse.status}`);
  const mainHtml = await responseText(mainResponse);
  const view = mainHtml.match(/viewDoc\(["'](\d+)["']\s*,\s*["'](\d+)["']\s*,\s*["'](\d+)["']\s*,\s*["'](\d+)["']\s*,\s*["'](\d+)["']\s*,\s*["']([^"']+)["']/);
  if (!view) return htmlToText(mainHtml);

  const [, rcpNo, dcmNo, eleId, offset, length, dtd] = view;
  const viewerUrl = `https://dart.fss.or.kr/report/viewer.do?rcpNo=${rcpNo}&dcmNo=${dcmNo}&eleId=${eleId}&offset=${offset}&length=${length}&dtd=${encodeURIComponent(dtd)}`;
  const viewerResponse = await fetchImpl(viewerUrl, {
    headers: { "User-Agent": "Mozilla/5.0 portfolio-disclosure-alarm/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!viewerResponse.ok) throw new Error(`DART viewer HTTP ${viewerResponse.status}`);
  return htmlToText(await responseText(viewerResponse));
}

async function fetchDisclosureTextFromUrl(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "Mozilla/5.0 portfolio-disclosure-alarm/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Disclosure HTTP ${response.status}`);
  return htmlToText(await responseText(response));
}

function extractAdjustmentPrices(text) {
  const clean = String(text || "").replace(/\s+/g, " ");
  const byIssue = {};

  const listingRowPattern = /(?:^|\s)(\d+)\s+(?:\uC0C1\uC7A5|\uBE44\uC0C1\uC7A5)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)(?=\s|$)/g;
  for (const match of clean.matchAll(listingRowPattern)) {
    byIssue[match[1]] = numberText(match[3]);
  }

  const issuePattern = /\uC81C\s*(\d+)\s*\uD68C/g;
  const afterPattern = /\uC870\uC815\s*\uD6C4|\uC870\uC815\uD6C4/;
  for (const match of clean.matchAll(issuePattern)) {
    const segment = clean.slice(match.index, match.index + 260);
    if (!afterPattern.test(segment)) continue;
    const afterIndex = segment.search(afterPattern);
    const afterSegment = segment.slice(afterIndex);
    const price = numberText(afterSegment.replace(afterPattern, ""));
    if (price && !byIssue[match[1]]) byIssue[match[1]] = price;
  }

  const afterPatterns = [
    /\uCD5C\uC885\s*(?:\uC804\uD658\uAC00\uC561|\uD589\uC0AC\uAC00\uC561|\uAD50\uD658\uAC00\uC561).{0,20}?([\d,]+(?:\.\d+)?)/,
    /\uCD5C\uC800\s*\uC870\uC815\uAC00\uC561.{0,20}?([\d,]+(?:\.\d+)?)/,
    /(?:\uC870\uC815\uD6C4|\uC870\uC815\s*\uD6C4).{0,40}?(?:\uC804\uD658\uAC00\uC561|\uD589\uC0AC\uAC00\uC561|\uAD50\uD658\uAC00\uC561).{0,80}?([\d,]+(?:\.\d+)?)/,
    /(?:\uC804\uD658\uAC00\uC561|\uD589\uC0AC\uAC00\uC561|\uAD50\uD658\uAC00\uC561).{0,20}(?:\uC870\uC815\uD6C4|\uC870\uC815\s*\uD6C4).{0,80}?([\d,]+(?:\.\d+)?)/,
  ];
  let single = null;
  for (const pattern of afterPatterns) {
    const match = clean.match(pattern);
    if (match) {
      single = numberText(match[1]);
      break;
    }
  }
  if (!single) {
    const afterIndex = clean.search(afterPattern);
    if (afterIndex >= 0) single = numberText(clean.slice(afterIndex + 3, afterIndex + 160));
  }

  return { single, byIssue };
}

function readJson(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function updateOverridesFromDisclosure(disclosure, options = {}) {
  if (!isConversionAdjustmentDisclosure(disclosure)) return { updated: 0, updates: [] };
  const portfolio = options.portfolio || readJson(options.portfolioPath, []);
  const overrides = readJson(options.overridesPath, {});
  const stockCode = normalizeCode(disclosure.stock_code || disclosure.stockCode);
  const disclosureName = String(disclosure.corp_name || disclosure.corpName || "").replace(/\s+/g, "");
  const matched = portfolio.filter((item) => {
    if (stockCode) return normalizeCode(item.code) === stockCode;
    const names = [item.name, item.quoteName].map((value) => String(value || "").replace(/\s+/g, ""));
    return disclosureName && names.some((name) => name.includes(disclosureName) || disclosureName.includes(name.replace(/\d+(?:CB|BW|EB|CPS|RCPS)$/i, "")));
  });
  if (!matched.length) return { updated: 0, updates: [] };

  const text = options.text
    || (disclosure.source === "KIND" && disclosure.url
      ? await fetchDisclosureTextFromUrl(disclosure.url, options.fetchImpl || fetch)
      : await fetchDisclosureText(disclosure.rcept_no || disclosure.rceptNo, options.fetchImpl || fetch));
  const prices = extractAdjustmentPrices(text);
  const updates = [];

  for (const item of matched) {
    const itemIssue = issueNo(item.name);
    const hasIssuePrices = Object.keys(prices.byIssue).length > 0;
    const newPrice = itemIssue && prices.byIssue[itemIssue]
      ? prices.byIssue[itemIssue]
      : hasIssuePrices ? null : prices.single;
    if (!newPrice) continue;
    const key = overrideKey(item);
    if (String(item.currentConversionPrice) === String(newPrice) && !overrides[key]) continue;
    overrides[key] = {
      currentConversionPrice: String(newPrice),
      sourceRceptNo: disclosure.rcept_no || disclosure.rceptNo,
      sourceReportName: disclosure.report_nm || disclosure.reportName,
      updatedAt: new Date().toISOString(),
    };
    updates.push({ code: item.code, name: item.name, currentConversionPrice: String(newPrice), key });
  }

  if (updates.length && options.overridesPath) writeJson(options.overridesPath, overrides);
  return { updated: updates.length, updates };
}

module.exports = {
  extractAdjustmentPrices,
  fetchDisclosureText,
  fetchDisclosureTextFromUrl,
  isConversionAdjustmentDisclosure,
  issueNo,
  normalizeCode,
  overrideKey,
  updateOverridesFromDisclosure,
};
