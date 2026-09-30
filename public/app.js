// 前端：純 JS，所有動態內容一律用 textContent 寫入，避免 XSS

const $ = (sel) => document.querySelector(sel);

/** 簡單的 DOM 建構器：el("td", { className: "x" }, "文字", childNode) */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "dataset") Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    if (res.status === 401 && path !== "/api/login") showLogin();
    throw err;
  }
  return data;
}

let statusTimer = null;
function setStatus(message, kind = "") {
  const node = $("#status");
  node.textContent = message;
  node.className = kind;
  clearTimeout(statusTimer);
  // 錯誤訊息保留，其他訊息 6 秒後自動收起
  if (message && kind !== "danger") statusTimer = setTimeout(() => (node.textContent = ""), 6000);
}

// ---------- 狀態 ----------

let accounts = [];
/** 畫面上的選取：只存在記憶體，不寫 KV */
const selected = new Set();
let config = { repoUrl: null, manualMode: "usage", discordWebhookSet: false, discordWebhookHint: null };

// ---------- 格式化 ----------

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "?";
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(1)} 天`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} 小時`;
  return `${Math.max(0, Math.round(seconds / 60))} 分`;
}

function formatTime(value) {
  const d = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 與後端 secondsUntilReset 相同規則：優先 reset_after_seconds（依抓取時間校正），否則 reset_at */
function secondsUntilReset(w, usage) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (w.resetAfterSeconds !== null) return w.resetAfterSeconds - (nowSec - usage.fetchedAt);
  if (w.resetAt !== null) return w.resetAt - nowSec;
  return null;
}

const RUN_TEXT = { sent: "已送 hi", skipped: "略過", failed: "失敗", refreshed: "已查詢" };
const RUN_BADGE = { sent: "badge-ok", skipped: "", failed: "badge-danger", refreshed: "badge-accent" };

// ---------- 帳號列表 ----------

function renderUsage(a) {
  const parts = [];
  if (a.usage) {
    if (a.usage.windows.length === 0) parts.push(el("div", { className: "muted small" }, "沒有額度窗口資料"));
    for (const w of a.usage.windows) {
      const remaining = Math.max(0, Math.min(100, Math.round((100 - w.usedPercent) * 10) / 10));
      const left = secondsUntilReset(w, a.usage);
      const level = remaining <= 20 ? "low" : remaining <= 50 ? "mid" : "";
      // CSP 沒有 'unsafe-inline'，寬度用 CSSOM 設定而不是 style 屬性
      const fill = el("span", { className: level });
      fill.style.width = `${remaining}%`;
      parts.push(
        el(
          "div",
          { className: "usage-item" },
          el("div", { className: "usage-top" }, el("strong", {}, `剩 ${remaining}%`), el("span", { className: "muted" }, `${formatDuration(left)}後重置`)),
          el("div", { className: "bar", role: "img", "aria-label": `剩餘 ${remaining}%` }, fill),
          el("div", { className: "muted small" }, `${w.name} · 窗口 ${formatDuration(w.windowSeconds)}${w.resetAt ? ` · ${formatTime(w.resetAt)}` : ""}`),
        ),
      );
    }
    parts.push(el("div", { className: "muted small" }, `更新於 ${formatTime(a.usage.fetchedAt)}`));
  } else {
    parts.push(el("span", { className: "muted small" }, a.enabled ? "尚未查詢（到 GHA 執行）" : "尚未查詢（啟用後到 GHA 執行）"));
  }
  if (a.usageError) parts.push(el("div", { className: "danger small" }, a.usageError));
  return el("div", { className: "usage" }, parts);
}

function renderLastRun(a) {
  if (!a.lastRun) return el("span", { className: "muted small" }, "—");
  const r = a.lastRun;
  return [
    el("span", { className: `badge ${RUN_BADGE[r.status] || ""}` }, RUN_TEXT[r.status] || r.status),
    el("div", { className: "muted small" }, formatTime(r.at)),
    r.reason && r.status !== "sent" ? el("div", { className: "muted small" }, r.reason) : null,
  ];
}

function renderToolbar() {
  const n = selected.size;
  $("#selection-count").textContent = n ? `已選取 ${n} 個` : "未選取";
  for (const id of ["#enable-btn", "#disable-btn", "#export-btn", "#delete-btn"]) $(id).disabled = n === 0;
  const all = $("#select-all");
  all.checked = accounts.length > 0 && n === accounts.length;
  all.indeterminate = n > 0 && n < accounts.length;
  all.disabled = accounts.length === 0;
}

function renderAccounts() {
  // 清掉已不存在的選取
  for (const id of selected) if (!accounts.some((a) => a.id === id)) selected.delete(id);
  const enabledCount = accounts.filter((a) => a.enabled).length;
  $("#accounts-count").textContent = `${accounts.length} 個 · 啟用 ${enabledCount}`;

  const rows = accounts.map((a) => {
    const label = a.email || a.accountId;
    const isSelected = selected.has(a.id);
    return el(
      "tr",
      { className: isSelected ? "is-selected" : "" },
      el("td", {}, el("input", { type: "checkbox", checked: isSelected, dataset: { id: a.id }, "aria-label": `選取 ${label}` })),
      el(
        "td",
        {},
        el("div", {}, el("strong", {}, a.email || "（無 email）")),
        el(
          "div",
          { className: "row small" },
          a.planType ? el("span", { className: "badge badge-accent" }, a.planType) : null,
          a.invalid ? el("span", { className: "badge badge-danger", title: a.invalidReason || "" }, "需重新登入") : null,
          el("code", { title: a.accountId }, a.accountId.slice(0, 8) + "…"),
        ),
      ),
      el("td", {}, a.enabled ? el("span", { className: "badge badge-ok" }, "啟用") : el("span", { className: "badge" }, "停用")),
      el("td", {}, renderUsage(a)),
      el("td", {}, renderLastRun(a)),
    );
  });
  if (rows.length === 0) rows.push(el("tr", {}, el("td", { colSpan: 5, className: "empty" }, "還沒有帳號，從下方「新增帳號」開始")));
  $("#accounts-body").replaceChildren(...rows);
  renderToolbar();
}

async function loadAccounts() {
  accounts = (await api("/api/accounts")).accounts;
  renderAccounts();
}

function onRowSelect(e) {
  const box = e.target.closest("input[type=checkbox][data-id]");
  if (!box) return;
  if (box.checked) selected.add(box.dataset.id);
  else selected.delete(box.dataset.id);
  box.closest("tr").classList.toggle("is-selected", box.checked);
  renderToolbar();
}

function onSelectAll(e) {
  selected.clear();
  if (e.target.checked) for (const a of accounts) selected.add(a.id);
  renderAccounts();
}

function selectedList() {
  return accounts.filter((a) => selected.has(a.id));
}

/** 上方按鈕共用：執行中停用整排按鈕，避免連點重送 */
async function runBulk(btn, fn) {
  const buttons = document.querySelectorAll("[role=toolbar] button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (err) {
    setStatus(err.message, "danger");
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    renderToolbar();
  }
}

async function setEnabled(enabled) {
  const targets = selectedList().filter((a) => a.enabled !== enabled);
  if (targets.length === 0) {
    setStatus(`選取的帳號都已經是${enabled ? "啟用" : "停用"}`, "ok");
    return;
  }
  const { enabled: ids } = await api("/api/accounts/enabled", { method: "POST", body: JSON.stringify({ ids: targets.map((a) => a.id), enabled }) });
  const set = new Set(ids);
  for (const a of accounts) a.enabled = set.has(a.id);
  renderAccounts();
  setStatus(`已${enabled ? "啟用" : "停用"} ${targets.length} 個帳號`, "ok");
}

/** 匯出選取的帳號（CLIProxyAPI 格式；一個帳號是單一物件，多個是陣列） */
async function downloadExport() {
  const ids = selectedList().map((a) => a.id);
  const res = await fetch(`/api/export?ids=${encodeURIComponent(ids.join(","))}`, { credentials: "same-origin" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`匯出失敗：${data.error || `HTTP ${res.status}`}`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "accounts.json";
  const url = URL.createObjectURL(await res.blob());
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`已匯出 ${ids.length} 個帳號（檔案含 token，請妥善保管）`, "ok");
}

async function deleteSelected() {
  const list = selectedList();
  const names = list.slice(0, 5).map((a) => a.email || a.accountId).join("、") + (list.length > 5 ? ` 等 ${list.length} 個` : "");
  if (!confirm(`確定刪除 ${names}？此動作無法復原。`)) return;
  const { deleted } = await api("/api/accounts/delete", { method: "POST", body: JSON.stringify({ ids: list.map((a) => a.id) }) });
  selected.clear();
  await loadAccounts();
  setStatus(`已刪除 ${deleted.length} 個帳號`, "ok");
}

// ---------- 設定 ----------

// 手動執行模式存在面板（GHA 要讀），但切換時先在本地合併：停手 1.5 秒後只送最後狀態，
// 和上次儲存的一樣就不送，快速來回切換不會寫 KV（後端也會比對，沒變就不寫）
const MODE_SAVE_DELAY_MS = 1500;
let modeTimer = null;
let pendingMode = null;

function renderConfig() {
  const link = $("#gha-link");
  if (config.repoUrl) {
    link.href = `${config.repoUrl}/actions/workflows/hi.yml`;
    link.removeAttribute("aria-disabled");
    link.title = "";
  } else {
    link.href = "#";
    link.setAttribute("aria-disabled", "true");
    link.title = "請先在設定填 GitHub repo";
  }
  $("#repo-url").value = config.repoUrl || "";
  const mode = pendingMode ?? config.manualMode;
  for (const r of document.querySelectorAll("input[name=manual-mode]")) r.checked = r.value === mode;
  $("#discord-status").textContent = config.discordWebhookSet ? `已設定（${config.discordWebhookHint}）。輸入新網址可覆蓋。` : "尚未設定：送 hi 的結果不會通知。";
  $("#discord-clear-btn").hidden = !config.discordWebhookSet;
}

async function loadConfig() {
  config = (await api("/api/config")).config;
  renderConfig();
}

async function saveConfig(patch) {
  config = (await api("/api/config", { method: "PUT", body: JSON.stringify(patch) })).config;
  renderConfig();
}

function onModeChange(e) {
  pendingMode = e.target.value === "hi" ? "hi" : "usage";
  clearTimeout(modeTimer);
  modeTimer = setTimeout(flushMode, MODE_SAVE_DELAY_MS);
}

async function flushMode() {
  clearTimeout(modeTimer);
  const mode = pendingMode;
  pendingMode = null;
  if (!mode || mode === config.manualMode) return;
  try {
    await saveConfig({ manualMode: mode });
    setStatus(mode === "hi" ? "手動執行會查額度＋送 hi（會通知 Discord）" : "手動執行只查額度（不通知）", "ok");
  } catch (err) {
    renderConfig();
    setStatus(`切換失敗：${err.message}`, "danger");
  }
}

async function onGhaClick(e) {
  if (!config.repoUrl) {
    e.preventDefault();
    setStatus("請先在設定填 GitHub repo", "danger");
    $("#repo-url").focus();
    return;
  }
  // 開啟 GHA 前先把還沒送出的模式存好，免得 GHA 讀到舊設定
  if (pendingMode) await flushMode();
}

async function onSaveRepo(e) {
  e.preventDefault();
  try {
    await saveConfig({ repoUrl: $("#repo-url").value.trim() || null });
    setStatus("已儲存 GitHub repo", "ok");
  } catch (err) {
    setStatus(`儲存失敗：${err.message}`, "danger");
  }
}

async function onSaveDiscord(e) {
  e.preventDefault();
  const value = $("#discord-url").value.trim();
  if (!value) {
    setStatus("請貼上 Discord webhook 網址", "danger");
    return;
  }
  try {
    await saveConfig({ discordWebhook: value });
    $("#discord-url").value = "";
    setStatus("已儲存 Discord webhook", "ok");
  } catch (err) {
    setStatus(`儲存失敗：${err.message}`, "danger");
  }
}

async function onClearDiscord() {
  if (!confirm("確定清除 Discord webhook？之後送 hi 不會再通知。")) return;
  try {
    await saveConfig({ discordWebhook: null });
    setStatus("已清除 Discord webhook", "ok");
  } catch (err) {
    setStatus(`清除失敗：${err.message}`, "danger");
  }
}

// ---------- 新增帳號：分頁 ----------

const TABS = ["callback", "import"];

function selectTab(name, focus = false) {
  for (const t of TABS) {
    const tab = $(`#tab-${t}`);
    const on = t === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#pane-${t}`).hidden = !on;
    if (on && focus) tab.focus();
  }
}

function onTabKey(e) {
  const i = TABS.indexOf(e.target.id.replace("tab-", ""));
  if (i === -1) return;
  if (e.key === "ArrowRight") selectTab(TABS[(i + 1) % TABS.length], true);
  else if (e.key === "ArrowLeft") selectTab(TABS[(i + TABS.length - 1) % TABS.length], true);
  else return;
  e.preventDefault();
}

// ---------- 新增帳號：OAuth（貼 callback 網址） ----------

/** 同一個登入網址 14 分鐘內重複使用（session TTL 15 分鐘），避免每按一次就寫一次 KV */
let oauthCache = null;
const OAUTH_REUSE_MS = 14 * 60 * 1000;

async function onOAuthStart() {
  const btn = $("#oauth-start-btn");
  btn.disabled = true;
  try {
    if (!oauthCache || Date.now() - oauthCache.at > OAUTH_REUSE_MS) {
      const { url } = await api("/api/oauth/start", { method: "POST" });
      oauthCache = { url, at: Date.now() };
    }
    const link = $("#oauth-link");
    link.href = oauthCache.url;
    link.hidden = false;
    $("#oauth-step2").hidden = false;
    window.open(oauthCache.url, "_blank", "noopener");
    $("#oauth-callback").focus();
  } catch (err) {
    setStatus(`無法產生登入網址：${err.message}`, "danger");
  } finally {
    btn.disabled = false;
  }
}

async function onOAuthSubmit(e) {
  e.preventDefault();
  const redirect_url = $("#oauth-callback").value.trim();
  if (!redirect_url) return;
  const btn = $("#oauth-submit-btn");
  btn.disabled = true;
  try {
    const { account } = await api("/api/oauth/callback", { method: "POST", body: JSON.stringify({ redirect_url }) });
    oauthCache = null;
    $("#oauth-callback").value = "";
    $("#oauth-step2").hidden = true;
    $("#oauth-link").hidden = true;
    setStatus(`已登入並新增 ${account.email || account.accountId}`, "ok");
    await loadAccounts();
  } catch (err) {
    setStatus(`登入失敗：${err.message}`, "danger");
  } finally {
    btn.disabled = false;
  }
}

// ---------- 新增帳號：匯入 ----------

async function onImport() {
  const payload = [];
  try {
    for (const file of $("#import-files").files) payload.push(JSON.parse(await file.text()));
    const text = $("#import-text").value.trim();
    if (text) payload.push(JSON.parse(text));
  } catch (err) {
    setStatus(`JSON 格式錯誤：${err.message}`, "danger");
    return;
  }
  if (payload.length === 0) {
    setStatus("請選擇檔案或貼上 JSON", "danger");
    return;
  }
  const btn = $("#import-btn");
  btn.disabled = true;
  try {
    let data;
    try {
      data = await api("/api/import", { method: "POST", body: JSON.stringify(payload) });
    } catch (err) {
      if (!err.data || !err.data.errors) throw err;
      data = err.data;
    }
    $("#import-result").replaceChildren(
      ...data.imported.map((i) => el("li", { className: "ok" }, `${i.path}：已匯入 ${i.account.email || i.account.accountId}`)),
      ...data.errors.map((x) => el("li", { className: "danger" }, `${x.path}：${x.error}`)),
    );
    setStatus(`匯入完成：成功 ${data.imported.length}、失敗 ${data.errors.length}`, data.errors.length ? "danger" : "ok");
    $("#import-text").value = "";
    $("#import-files").value = "";
    await loadAccounts();
  } catch (err) {
    setStatus(`匯入失敗：${err.message}`, "danger");
  } finally {
    btn.disabled = false;
  }
}

// ---------- 登入 / 畫面切換 ----------

function showLogin() {
  $("#login-view").hidden = false;
  $("#panel-view").hidden = true;
  $("#password").focus();
}

async function showPanel() {
  $("#login-view").hidden = true;
  $("#panel-view").hidden = false;
  await Promise.all([loadAccounts(), loadConfig()]);
}

async function init() {
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("#password").value }) });
      $("#password").value = "";
      setStatus("");
      await showPanel();
    } catch (err) {
      setStatus(err.status === 401 ? "密碼錯誤" : `登入失敗：${err.message}`, "danger");
    }
  });

  $("#logout-btn").addEventListener("click", async () => {
    await flushMode();
    await api("/api/logout", { method: "POST" }).catch(() => { });
    setStatus("已登出");
    showLogin();
  });

  $("#reload-btn").addEventListener("click", (e) => runBulk(e.target, () => loadAccounts().then(() => setStatus("已重新載入", "ok"))));
  $("#enable-btn").addEventListener("click", (e) => runBulk(e.target, () => setEnabled(true)));
  $("#disable-btn").addEventListener("click", (e) => runBulk(e.target, () => setEnabled(false)));
  $("#export-btn").addEventListener("click", (e) => runBulk(e.target, downloadExport));
  $("#delete-btn").addEventListener("click", (e) => runBulk(e.target, deleteSelected));
  $("#select-all").addEventListener("change", onSelectAll);
  $("#accounts-body").addEventListener("change", onRowSelect);

  $("#repo-form").addEventListener("submit", onSaveRepo);
  $("#discord-form").addEventListener("submit", onSaveDiscord);
  $("#discord-clear-btn").addEventListener("click", onClearDiscord);
  $("#gha-link").addEventListener("click", onGhaClick);
  for (const r of document.querySelectorAll("input[name=manual-mode]")) r.addEventListener("change", onModeChange);
  // 分頁關閉前送出還沒儲存的模式（keepalive 讓請求在頁面卸載後繼續）
  window.addEventListener("pagehide", () => {
    if (!pendingMode || pendingMode === config.manualMode) return;
    fetch("/api/config", {
      method: "PUT",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manualMode: pendingMode }),
    });
  });

  for (const t of TABS) $(`#tab-${t}`).addEventListener("click", () => selectTab(t));
  $(".tabs").addEventListener("keydown", onTabKey);
  $("#oauth-start-btn").addEventListener("click", onOAuthStart);
  $("#oauth-form").addEventListener("submit", onOAuthSubmit);
  $("#import-btn").addEventListener("click", onImport);

  try {
    await api("/api/me");
    await showPanel();
  } catch (err) {
    if (err.status === 401) showLogin();
    else setStatus(`無法連線：${err.message}`, "danger");
  }
}

init();
