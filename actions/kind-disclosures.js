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

function stripHtml(text) {
  return decodeHtml(String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function parseKindRows(html, date) {
  const rows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const rowMatch of html.matchAll(rowPattern)) {
    const row = rowMatch[1];
    const acptNo = row.match(/openDisclsViewer\('([^']+)'/)?.[1];
    if (!acptNo) continue;

    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cells.length < 4) continue;

    const corpName = decodeHtml(
      cells[1].match(/<a\b[^>]*title=['"]([^'"]+)['"][^>]*>/i)?.[1] || stripHtml(cells[1]),
    ).trim();
    const reportName = decodeHtml(
      cells[2].match(/openDisclsViewer\('[^']+'\s*,\s*'[^']*'\)[^>]*title=['"]([^'"]+)['"]/i)?.[1]
        || cells[2].match(/<a\b[^>]*title=['"]([^'"]+)['"][^>]*>/i)?.[1]
        || stripHtml(cells[2]),
    ).trim();
    const flrName = stripHtml(cells[3]);

    if (!corpName || !reportName) continue;
    rows.push({
      rcept_no: `KIND-${acptNo}`,
      kind_acpt_no: acptNo,
      corp_name: corpName,
      stock_code: "",
      report_nm: reportName,
      flr_nm: flrName,
      rcept_dt: date,
      source: "KIND",
      remark: "KIND",
      url: `https://kind.krx.co.kr/common/disclsviewer.do?method=search&acptno=${encodeURIComponent(acptNo)}`,
    });
  }
  return rows;
}

async function fetchKindDisclosures(date, fetchImpl = fetch) {
  const mainUrl = "https://kind.krx.co.kr/disclosure/todaydisclosure.do?method=searchTodayDisclosureMain";
  const main = await fetchImpl(mainUrl, {
    headers: { "User-Agent": "Mozilla/5.0 portfolio-disclosure-alarm/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!main.ok) throw new Error(`KIND main HTTP ${main.status}`);
  const cookie = main.headers?.get?.("set-cookie") || "";
  if (typeof main.text !== "function") throw new Error("KIND main response is not HTML");
  await main.text();

  const body = new URLSearchParams({
    method: "searchTodayDisclosureSub",
    currentPageSize: "100",
    pageIndex: "1",
    orderMode: "",
    orderStat: "",
    marketType: "",
    forward: "todaydisclosure_sub",
    searchMode: "",
    searchCodeType: "",
    chose: "",
    todayFlag: "Y",
    repIsuSrtCd: "",
    kosdaqSegment: "",
    searchCorpName: "",
  });
  const response = await fetchImpl("https://kind.krx.co.kr/disclosure/todaydisclosure.do", {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 portfolio-disclosure-alarm/1.0",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Referer": mainUrl,
      "Cookie": cookie,
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`KIND HTTP ${response.status}`);
  return parseKindRows(await response.text(), date);
}

module.exports = { fetchKindDisclosures, parseKindRows };
