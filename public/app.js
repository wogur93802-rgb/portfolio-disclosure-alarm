const state = {
  disclosures: [],
  mezzanine: [],
  search: "",
  activeView: "disclosures",
  mezzanineTypes: new Set(["conversion", "put", "call", "refixing"]),
  mezzanineWindow: "90",
  mezzanineSort: "nearest",
  lowPriceOnly: false,
  lowMarketCapOnly: false,
};
const list = document.querySelector("#disclosure-list");
const liveDot = document.querySelector("#live-dot");
const syncButton = document.querySelector("#sync-button");
const notifyButton = document.querySelector("#notify-button");
const searchInput = document.querySelector("#search");
const settingsDialog = document.querySelector("#settings-dialog");
const settingsForm = document.querySelector("#settings-form");
const installButton = document.querySelector("#install-button");
const mezzanineList = document.querySelector("#mezzanine-list");
let installPrompt;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replaceAll("앤", "엔");
}

function formatDate(value) {
  if (!value || value.length !== 8) return value || "-";
  return `${value.slice(4, 6)}.${value.slice(6, 8)}`;
}

function todayAtMidnight() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function parseScheduleDate(value) {
  const text = String(value || "").trim();
  if (!text || text === "-" || text === "없음") return null;
  let match = text.match(/(20\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
  if (!match) match = text.match(/'?(\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
  if (!match) return null;
  const year = match[1].length === 2 ? 2000 + Number(match[1]) : Number(match[1]);
  return new Date(year, Number(match[2]) - 1, Number(match[3]));
}

function parseCallPeriod(value) {
  const text = String(value || "").trim();
  if (!text || text === "-" || text === "없음") return null;
  const matches = [...text.matchAll(/'?(20\d{2}|\d{2})[-./](\d{1,2})[-./](\d{1,2})/g)];
  if (!matches.length) return null;
  const toDate = (match) => {
    const year = match[1].length === 2 ? 2000 + Number(match[1]) : Number(match[1]);
    return new Date(year, Number(match[2]) - 1, Number(match[3]));
  };
  return { start: toDate(matches[0]), end: matches[1] ? toDate(matches[1]) : toDate(matches[0]) };
}

function parsePutPeriod(item) {
  const period = parseCallPeriod(item.putPeriod);
  if (period) return period;
  const date = parseScheduleDate(item.putDate);
  return date ? { start: date, end: date } : null;
}

function putSchedules(item) {
  if (Array.isArray(item.putSchedule) && item.putSchedule.length) {
    return item.putSchedule
      .map((row) => ({
        no: row.no,
        start: parseScheduleDate(row.from || row.start),
        end: parseScheduleDate(row.to || row.end),
        payment: parseScheduleDate(row.payment || row.putDate),
        rate: row.rate || "",
      }))
      .filter((row) => row.start);
  }
  const period = parsePutPeriod(item);
  return period ? [{ start: period.start, end: period.end, payment: parseScheduleDate(item.putDate), rate: "" }] : [];
}

function daysUntil(date) {
  if (!date) return null;
  return Math.ceil((date.getTime() - todayAtMidnight().getTime()) / 86400000);
}

function formatDday(days) {
  if (days === null || days === undefined) return "";
  if (days === 0) return "D-day";
  if (days > 0) return `D-${days}`;
  return `D+${Math.abs(days)}`;
}

function formatDisplayDate(date) {
  if (!date) return "-";
  const year = String(date.getFullYear()).slice(2);
  return `${year}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function eventInWindow(event) {
  if (state.mezzanineWindow === "all") return true;
  const limit = Number(state.mezzanineWindow);
  return event.days >= 0 && event.days <= limit;
}

function mezzanineEvents(item) {
  const events = [];
  const push = (type, label, date, detail = "") => {
    if (!date || !state.mezzanineTypes.has(type)) return;
    const days = daysUntil(date);
    const event = { type, label, date, days, detail };
    if (eventInWindow(event)) events.push(event);
  };

  push("conversion", "전환가능", parseScheduleDate(item.conversionDate));
  push("refixing", "리픽싱", parseScheduleDate(item.nextRefixingDate));

  const puts = putSchedules(item);
  if (puts.length && state.mezzanineTypes.has("put")) {
    const today = todayAtMidnight();
    const activePut = puts.find((put) => put.start && put.end && put.start <= today && today <= put.end);
    const nextPut = activePut || puts
      .map((put) => ({ ...put, days: daysUntil(put.start) }))
      .filter((put) => put.days !== null && put.days >= 0)
      .sort((a, b) => a.days - b.days)[0];
    const target = activePut ? today : nextPut?.start;
    const event = {
      type: "put",
      label: activePut ? "PUT 진행중" : "PUT 시작",
      date: target,
      days: activePut ? 0 : daysUntil(target),
      detail: nextPut?.end && nextPut.end.getTime() !== nextPut.start.getTime()
        ? `${formatDisplayDate(nextPut.start)} - ${formatDisplayDate(nextPut.end)}`
        : formatDisplayDate(nextPut?.start),
    };
    if (eventInWindow(event)) events.push(event);
  }

  const call = parseCallPeriod(item.callPeriod);
  if (call && state.mezzanineTypes.has("call")) {
    const today = todayAtMidnight();
    const active = call.start <= today && today <= call.end;
    const target = active ? today : call.start;
    const event = {
      type: "call",
      label: active ? "Call 진행중" : "Call 시작",
      date: target,
      days: active ? 0 : daysUntil(target),
      detail: `${formatDisplayDate(call.start)} - ${formatDisplayDate(call.end)}`,
    };
    if (eventInWindow(event)) events.push(event);
  }

  return events.sort((a, b) => a.days - b.days || a.label.localeCompare(b.label, "ko"));
}

function render() {
  const query = normalizeSearchText(state.search);
  const filtered = state.disclosures.filter((item) =>
    normalizeSearchText(`${item.corp_name} ${item.report_nm} ${item.flr_nm}`).includes(query),
  );
  document.querySelector("#result-count").textContent = `${filtered.length}건`;
  if (!filtered.length) {
    list.innerHTML = '<p class="empty">표시할 공시가 없습니다.</p>';
    return;
  }
  list.innerHTML = filtered.map((item) => `
    <a class="disclosure" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">
      <span class="source ${item.source === "KIND" ? "kind" : ""}">${escapeHtml(item.source)}</span>
      <span class="content">
        <strong class="corp">${escapeHtml(item.corp_name)}</strong>
        <span class="report">${escapeHtml(item.report_nm)}</span>
      </span>
      <span class="date">${formatDate(item.rcept_dt)}</span>
    </a>
  `).join("");
}

function renderMezzanine() {
  const query = normalizeSearchText(state.search);
  const alertCount = state.mezzanine.filter((item) => item.alerts?.length).length;
  const lowPriceCount = state.mezzanine.filter((item) => item.lowPrice?.isBelow).length;
  const lowPriceWarningCount = state.mezzanine.filter((item) => item.lowPrice?.warning).length;
  const lowMarketCapCount = state.mezzanine.filter((item) => item.marketCap?.isBelow).length;
  const filtered = state.mezzanine
    .map((item) => ({ ...item, scheduleEvents: mezzanineEvents(item) }))
    .filter((item) =>
      normalizeSearchText(`${item.name} ${item.quoteName || ""} ${item.code} ${(item.funds || []).join(" ")}`).includes(query)
      && (state.lowPriceOnly ? item.lowPrice?.isBelow : true)
      && (state.lowMarketCapOnly ? item.marketCap?.isBelow : true)
      && (state.lowPriceOnly || state.lowMarketCapOnly || item.scheduleEvents.length > 0),
    );

  filtered.sort((a, b) => {
    if (state.mezzanineSort === "parity") {
      return Number(b.parity ?? -1) - Number(a.parity ?? -1) || a.name.localeCompare(b.name, "ko");
    }
    if (state.mezzanineSort === "name") return a.name.localeCompare(b.name, "ko");
    return (a.scheduleEvents[0]?.days ?? 99999) - (b.scheduleEvents[0]?.days ?? 99999)
      || a.name.localeCompare(b.name, "ko");
  });

  document.querySelector("#mezzanine-alert-badge").textContent = alertCount ? alertCount : "";
  document.querySelector("#mezzanine-result-count").textContent = `${filtered.length}건 · 알림 ${alertCount}건 · 1,000원 미만 ${lowPriceCount}건${lowPriceWarningCount ? ` · 20일+ ${lowPriceWarningCount}건` : ""} · 시총 300억 미만 ${lowMarketCapCount}건`;
  if (!filtered.length) {
    mezzanineList.innerHTML = '<p class="empty">선택한 조건에 해당하는 일정이 없습니다.</p>';
    return;
  }
  mezzanineList.innerHTML = filtered.map((item) => `
    <article class="mezzanine-card ${item.alerts?.length ? "alert" : ""} ${item.lowPrice?.warning ? "low-warning" : ""} ${item.lowPrice?.critical ? "low-critical" : ""} ${item.marketCap?.isBelow ? "market-cap-low" : ""}">
      <div class="mezzanine-head">
        <div>
          <strong class="mezzanine-name">${escapeHtml(item.name)}</strong>
          <span class="mezzanine-code">${escapeHtml(String(item.code).replace(/^A/, ""))}</span>
          ${item.quoteName && item.quoteName !== item.name ? `<span class="quote-name">시세 기준: ${escapeHtml(item.quoteName)}</span>` : ""}
        </div>
        <div class="price-box">
          <strong>${item.currentPrice ? `${Number(item.currentPrice).toLocaleString()}원` : "조회 실패"}</strong>
          <span>최초 ${Number(item.initialConversionPrice || 0).toLocaleString()}원</span>
          <span>현재/최저 ${Number(item.currentConversionPrice || 0).toLocaleString()}원 / ${Number(item.minimumConversionPrice || 0).toLocaleString()}원</span>
          <em>Parity ${item.parity !== null && item.parity !== undefined ? `${Number(item.parity).toLocaleString()}%` : "-"}</em>
          ${item.lowPrice?.isBelow ? `<i class="low-price-badge">7/1부터 1,000원 미만 ${Number(item.lowPrice.streak || 0).toLocaleString()}거래일${item.lowPrice.critical ? " · 30일 위험" : item.lowPrice.warning ? " · 20일 경고" : ""}</i>` : ""}
          ${item.marketCap?.isBelow ? `<i class="market-cap-badge">시총 ${escapeHtml(item.marketCap.marketCapText || `${item.marketCap.marketCapEok}억`)} · 300억 미만</i>` : ""}
        </div>
      </div>
      <div class="event-strip">
        ${item.scheduleEvents.map((event) => `
          <span class="event-chip ${event.type}">
            <b>${escapeHtml(event.label)}</b>
            <em>${escapeHtml(formatDday(event.days))}</em>
            <small>${escapeHtml(event.detail || formatDisplayDate(event.date))}</small>
          </span>
        `).join("")}
      </div>
      <div class="schedule-grid">
        <div><span>전환가능일</span><strong>${escapeHtml(item.conversionDate || "-")}</strong></div>
        <div><span>Put 행사기간</span><strong>${escapeHtml(item.putPeriod || item.putDate || "-")}</strong></div>
        <div><span>Call 행사기간</span><strong>${escapeHtml(item.callPeriod || "-")}</strong></div>
        <div><span>다음 리픽싱</span><strong>${escapeHtml(item.nextRefixingDate || "-")}</strong></div>
      </div>
      ${Array.isArray(item.putSchedule) && item.putSchedule.length ? `
        <details class="put-schedule">
          <summary>PUT 전체 일정 ${item.putSchedule.length}회 보기</summary>
          <div class="put-schedule-list">
            ${item.putSchedule.map((row) => `
              <span>
                <b>${escapeHtml(row.no ? `${row.no}차` : "PUT")}</b>
                <em>${escapeHtml(row.from || "-")} ~ ${escapeHtml(row.to || "-")}</em>
                <small>지급 ${escapeHtml(row.payment || "-")} ${row.rate ? `· ${escapeHtml(row.rate)}` : ""}</small>
              </span>
            `).join("")}
          </div>
        </details>
      ` : ""}
      ${item.alerts?.length ? `<div class="alert-list">${item.alerts.map((alert) => `<div class="alert-item">${escapeHtml(alert)}</div>`).join("")}</div>` : ""}
      <span class="funds">${escapeHtml((item.funds || []).join(" · "))}</span>
    </article>
  `).join("");
}

function setView(view) {
  state.activeView = view;
  document.querySelector("#disclosure-section").classList.toggle("hidden", view !== "disclosures");
  document.querySelector("#mezzanine-section").classList.toggle("hidden", view !== "mezzanine");
  document.querySelector("#disclosure-tab").classList.toggle("active", view === "disclosures");
  document.querySelector("#mezzanine-tab").classList.toggle("active", view === "mezzanine");
}

async function loadMezzanine(refresh = false) {
  mezzanineList.innerHTML = '<p class="empty">현재가와 일정을 확인하는 중입니다.</p>';
  const result = await fetch(`/api/mezzanine${refresh ? "?refresh=1" : ""}`).then((response) => response.json());
  state.mezzanine = result.items || [];
  renderMezzanine();
}

function renderStatus(status) {
  document.querySelector("#watch-count").textContent = `${status.watchlistCount}개`;
  document.querySelector("#last-check").textContent = status.lastSuccessAt
    ? new Date(status.lastSuccessAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : "-";
  const channels = [];
  if (status.ntfyEnabled) channels.push("ntfy");
  if (status.telegramEnabled) channels.push("텔레그램");
  document.querySelector("#push-status").textContent = channels.length ? channels.join(" + ") : "미설정";
  document.querySelector("#setup-card").classList.toggle("hidden", status.configured);
  liveDot.classList.toggle("live", status.configured && !status.lastError);
  document.querySelector("#local-urls").innerHTML = (status.localUrls || [])
    .map((url) => `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`).join("");
}

async function load() {
  const [disclosures, watchlist, status] = await Promise.all([
    fetch("/api/disclosures").then((response) => response.json()),
    fetch("/api/watchlist").then((response) => response.json()),
    fetch("/api/status").then((response) => response.json()),
  ]);
  state.disclosures = disclosures;
  document.querySelector("#watchlist").innerHTML = watchlist
    .map((name) => `<span class="chip">${escapeHtml(name)}</span>`).join("");
  renderStatus(status);
  render();
  loadMezzanine().catch(() => {
    mezzanineList.innerHTML = '<p class="empty">메자닌 일정을 불러올 수 없습니다.</p>';
  });
}

function showBrowserNotification(item) {
  if (Notification.permission !== "granted") return;
  const notification = new Notification(`[${item.source}] ${item.corp_name}`, {
    body: item.report_nm,
    icon: "/icon.svg",
    tag: item.rcept_no,
  });
  notification.onclick = () => window.open(item.url, "_blank", "noopener");
}

notifyButton.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    notifyButton.textContent = "이 브라우저는 미지원";
    return;
  }
  const permission = await Notification.requestPermission();
  notifyButton.textContent = permission === "granted" ? "화면 알림 켜짐" : "화면 알림 차단됨";
});

syncButton.addEventListener("click", async () => {
  syncButton.disabled = true;
  syncButton.textContent = "확인 중";
  await fetch("/api/sync", { method: "POST" });
  if (state.activeView === "mezzanine") await loadMezzanine(true);
  setTimeout(() => {
    syncButton.disabled = false;
    syncButton.textContent = "지금 확인";
  }, 1800);
});

searchInput.addEventListener("input", (event) => {
  state.search = event.target.value;
  render();
  renderMezzanine();
});

document.querySelectorAll(".mezzanine-type").forEach((input) => {
  input.addEventListener("change", () => {
    state.mezzanineTypes = new Set(
      [...document.querySelectorAll(".mezzanine-type:checked")].map((item) => item.value),
    );
    renderMezzanine();
  });
});

document.querySelector("#mezzanine-window")?.addEventListener("change", (event) => {
  state.mezzanineWindow = event.target.value;
  renderMezzanine();
});

document.querySelector("#mezzanine-sort")?.addEventListener("change", (event) => {
  state.mezzanineSort = event.target.value;
  renderMezzanine();
});

document.querySelector("#low-price-only")?.addEventListener("change", (event) => {
  state.lowPriceOnly = event.target.checked;
  renderMezzanine();
});

document.querySelector("#low-market-cap-only")?.addEventListener("change", (event) => {
  state.lowMarketCapOnly = event.target.checked;
  renderMezzanine();
});

document.querySelector("#disclosure-tab").addEventListener("click", () => setView("disclosures"));
document.querySelector("#mezzanine-tab").addEventListener("click", () => setView("mezzanine"));

document.querySelector("#settings-button").addEventListener("click", async () => {
  const settings = await fetch("/api/settings").then((response) => response.json());
  document.querySelector("#dart-api-key").value = settings.dartApiKey;
  document.querySelector("#ntfy-topic").value = settings.ntfyTopic;
  document.querySelector("#telegram-token").value = settings.telegramToken;
  document.querySelector("#telegram-chat-id").value = settings.telegramChatId;
  settingsDialog.showModal();
});

document.querySelector("#close-settings").addEventListener("click", () => settingsDialog.close());

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = Object.fromEntries(new FormData(settingsForm));
  const response = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  const result = await response.json();
  document.querySelector("#settings-message").textContent = result.saved ? "저장되었습니다." : result.error;
  if (result.saved) {
    renderStatus(result.status);
    setTimeout(() => settingsDialog.close(), 700);
  }
});

document.querySelector("#test-notification").addEventListener("click", async () => {
  document.querySelector("#settings-message").textContent = "테스트 알림을 보내는 중입니다.";
  await fetch("/api/test-notification", { method: "POST" });
  document.querySelector("#settings-message").textContent = "테스트 알림을 보냈습니다.";
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.classList.remove("hidden");
});

installButton.addEventListener("click", async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  installPrompt = null;
  installButton.classList.add("hidden");
});

const events = new EventSource("/api/events");
events.addEventListener("open", () => {
  load().catch(() => {
    list.innerHTML = '<p class="empty">서버에 연결할 수 없습니다.</p>';
  });
});
events.addEventListener("status", (event) => renderStatus(JSON.parse(event.data)));
events.addEventListener("disclosure", (event) => {
  const item = JSON.parse(event.data);
  state.disclosures = [item, ...state.disclosures.filter((existing) => existing.rcept_no !== item.rcept_no)];
  render();
  showBrowserNotification(item);
});
events.addEventListener("mezzanine-updated", () => {
  loadMezzanine(true).catch(() => {});
});
events.onerror = () => liveDot.classList.remove("live");

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
load().catch(() => { list.innerHTML = '<p class="empty">서버에 연결할 수 없습니다.</p>'; });
