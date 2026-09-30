最後更新: 2026/9/30
狀態: 第五輪完成（99 測試通過，已部署 https://gpt-checker.pages.dev ）。待辦：建 GitHub repo + 推送、設定 GHA secrets（`PANEL_URL`、`PANEL_PASSWORD`）、用真實帳號驗證（usage 回應形狀、free 帳號窗口長度、HI_MODEL 是否可用）

## 目前設計（第五輪，以此節為準）

**查額度只能透過 GHA**
- Cloudflare（Pages / Workers）連不到 chatgpt.com（見下方「查額度失敗的選項」），所以查額度、refresh token、送 hi 全部在 GHA runner 上執行。
- 面板只顯示 GHA 寫回的結果，不會自己查，也不觸發 GHA（不用 GitHub token / PAT）。
- 單一 workflow `hi.yml`（`concurrency: gpt-checker`，`queue: max` 讓多次手動執行排隊；已在 probe repo 實測）：
  - 排程（每 2 天）：固定查額度＋送 hi。符合條件（剩 100% 且距離重置 ≥ 29 天）才送 hi；每次通知 Discord。
  - 手動（workflow_dispatch）：做什麼由面板右上角開關決定（存在 KV `config.manualMode`，GHA 執行時向面板讀）。
    - `只查額度`（預設）：不送 hi、不寫 `lastRun`、**不發任何通知**（有異常時 run 會顯示失敗）。
    - `查額度＋送 hi`：同排程。
- 面板右上角是唯一的 GHA 按鈕，開啟 `<repo>/actions/workflows/hi.yml`。面板只存 repo 網址（貼 actions / workflow 頁面網址也會自動正規化）。
- 手動執行：`hi.yml` 已有 `workflow_dispatch`，推到 repo 的**預設分支**後 GitHub 頁面才會出現 Run workflow 按鈕（2026/9/30 在 probe repo 實測可用 API 觸發）。

**開關不會被連點耗掉 KV 寫入**
- 前端：切換後停手 1.5 秒才送出，只送最後狀態；和上次儲存的一樣就不送（A→B→A 快速切回 = 0 次寫入）。點「前往 GHA 執行」或關閉分頁時會先送出未儲存的切換。
- 後端：`config` 內容和現在一樣就不寫。
- 結果：寫入次數 ≈ 真的改變心意的次數，不是點擊次數。

**帳號列表：勾選只是選取，按鈕才動 KV**
- 勾選框只存在頁面記憶體，**不寫 KV**。
- 上方按鈕對選取的帳號執行（每按一次一個請求）：
  - 啟用 / 停用：是否交給 GHA 處理。整份清單是一個 key `enabled`，一次寫 1 次；結果沒變不寫。
  - 匯出 CPA 格式（1 個是單一物件、多個是陣列，可直接匯回）：只讀 KV。codex-tools 匯出已移除（codex-tools 本身能匯入 CPA 格式的扁平 token）。
  - 刪除：每個帳號刪 1 次 + 索引寫 1 次。

**Discord 通知**
- Webhook 網址在**面板「設定」卡片**填寫（存在 KV `config.discordWebhook`），GHA 執行時向面板讀；GitHub 不需要 Discord secret。
- 面板只回傳「是否已設定 + 最後 4 碼」，完整網址只給 GHA 的 Bearer 端點；只接受 `https://discord.com/api/webhooks/<id>/<token>`（含 ptb / canary / discordapp.com）。
- Webhook 建立：Discord 頻道 → 編輯頻道 → 整合 → Webhook → 新 Webhook → 複製網址。
- 只查額度完全不通知；送 hi 每次通知（異常排最前面）。讀不到面板時拿不到 webhook，只會讓 run 失敗。

**KV 用量（免費方案：每天寫 1,000、刪 1,000、list 1,000、讀 100,000；同一 key 每秒寫 1 次）**

| 操作                | KV 用量                                                                      | 之前的問題                                      |
| ------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| 切換開關            | 停手 1.5 秒後最多寫 1 次；切回原值 0 次                                      | 每次切換寫 1 次                                 |
| 勾選 / 全選         | 0（只是選取）                                                                | 每勾一個寫 1 次                                 |
| 啟用 / 停用（按鈕） | 1 次（`enabled` 一個 key）；沒變 0 次                                        | —                                               |
| 刪除（按鈕）        | 每個帳號刪 1 次 + 索引寫 1 次                                                | 每個帳號各自更新索引                            |
| 匯出（按鈕）        | 0（只讀）                                                                    | —                                               |
| 載入帳號列表        | 讀 3 + N 次，**0 次 list**                                                   | 每次載入呼叫 1 次 `list()`（每天只有 1,000 次） |
| 匯入 N 個帳號       | 有變動的帳號各寫 1 次 + 索引最多 1 次；內容相同不寫                          | 索引每個帳號各寫 1 次                           |
| OAuth 登入          | 開始寫 1 次（同一網址 14 分鐘內重用）；成功刪 1 次；失敗 0                   | 每按一次開始就寫 1 次，callback 再寫 2–3 次狀態 |
| GHA 一次執行        | 額度結果整批寫 1 次（`status` 一個 key）；有 refresh 的帳號各多寫 1 次 token | 每個帳號寫 1 次額度 + refresh 時再 1 次         |
| 儲存 repo / webhook | 沒變就不寫                                                                   | 每次都寫                                        |

- key 配置：`account:<id>`（token）、`index:accounts`、`enabled`、`status`、`config`、`oauth:<state>`（TTL 15 分鐘）。細節見 `src/lib/kv.ts`。
- 舊版資料（usage / selected 存在帳號裡、`selection` key、`config.ghaUrl`）讀取時自動相容，不用手動遷移。
- 索引不存在時才用 `list()` 重建一次。
- 已知上限：一次匯入超過約 990 個帳號會碰到每天 1,000 次寫入。

**查額度失敗的選項**（都用假 token，只看是否被擋）

| 嘗試                                                           | 結果                                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Pages Functions / Workers `fetch`（本機 workerd、edge TPE）    | 403「Unable to load site」；同 IP 的 curl / Node 正常 → 判斷是 workerd 連線指紋被擋                      |
| Workers 改用 `chat.openai.com`、`/api/codex/usage`             | 同樣 403                                                                                                 |
| Workers 帶全套 Chrome header（UA、sec-ch-ua、Referer、Origin） | 同樣 403                                                                                                 |
| Workers `cloudflare:sockets` 直連                              | 不允許連 Cloudflare 自家 IP（`Stream was cancelled`）                                                    |
| Cloudflare Browser Rendering（`/content`）                     | 同樣「Unable to load site」（出口 IP 104.28.x）；第二次呼叫即 `2001 Rate limit exceeded`                 |
| 瀏覽器直接打 chatgpt.com                                       | CORS 預檢回 400、沒有 `Access-Control-Allow-Origin`                                                      |
| 面板用 PAT 觸發 `workflow_dispatch` 再輪詢結果                 | 可行（`return_run_details` 會回 run 網址，已實測），但需要在 Pages 存 GitHub token；決定不採用，維持跳轉 |
| GitHub Actions runner（Node 22 fetch）                         | ✅ 正常 → 採用                                                                                            |

**登入：只用貼 callback 網址（照 CPA）**
- 裝置碼登入（`deviceauth`，CPA `sdk/auth/codex_device.go`）從 edge 可以取碼與輪詢，但**帳號預設沒開**，實際授權時 OpenAI 顯示：
  「請在 ChatGPT 安全性設定中啟用 Codex、Excel、PowerPoint 和 Word 的裝置代碼登入，然後再次執行「codex login --device-auth」。」
  每個帳號都要先手動開設定，不比貼網址方便，所以移除。
- 貼 callback 網址：換 token 走 auth.openai.com，edge 實測可連。

**送 hi**
- 內容是 `only reply hi`（`HI_PROMPT`），讓回覆盡量短。

**UI**
- 深藍灰主題、統一圓角（卡片 12px、控制項 8px）與間距；輸入框 + 按鈕同列。
- 外部連結一律用按鈕樣式；新增帳號收成「OAuth 登入 / 匯入 JSON」兩個分頁；額度用進度條；狀態訊息在右下角。

## 踩坑紀錄

| 問題                            | 現象 / 原因                                                                                                                                                          | 處理                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Workers 打 chatgpt.com          | 見上方「查額度失敗的選項」                                                                                                                                           | 查額度、送 hi 移到 GHA                                        |
| KV `list()` 延遲                | 剛匯入的帳號在列表看不到                                                                                                                                             | 另存 `index:accounts` 索引；一般路徑只讀索引，不呼叫 `list()` |
| KV 免費額度                     | 每天寫 1,000 / list 1,000；把常變動的設定（開關、勾選）逐次寫 KV 很快會用完                                                                                          | 見上方「KV 用量」表                                           |
| workflow YAML                   | `run: curl ... -H "Authorization: Bearer x"` 的 plain scalar 含 `: ` → 整個檔案解析失敗，run 0 秒失敗、名稱顯示成檔案路徑，dispatch 回 422「沒有 workflow_dispatch」 | 含 `: ` 的指令用 `run: \|` block scalar                       |
| GitHub dispatch API（已不使用） | 預設 API 版本回 `Deprecation` header（Sunset 2028-03-10）                                                                                                            | 若日後要用：帶 `X-GitHub-Api-Version: 2026-03-10`             |
| 裝置碼登入                      | 帳號預設沒開，授權時才提示要到安全性設定啟用                                                                                                                         | 移除，只留貼網址                                              |
| CSP `style-src 'self'`          | inline `style` 屬性會被擋                                                                                                                                            | 進度條寬度用 CSSOM（`el.style.width`）設定                    |
| gh token 權限                   | 沒有 `delete_repo`，刪不掉自己建的 probe repo                                                                                                                        | 需手動刪除 `Artin0123/gpt-checker-probe`                      |

**已建立的資源**
- Cloudflare Pages 專案 `gpt-checker`（production：https://gpt-checker.pages.dev ），secrets：`PANEL_PASSWORD`、`SESSION_SECRET`（值在本機 `.deploy-secrets.local`，已 gitignore）。
- KV namespace `gpt-checker-accounts`（id 寫在 wrangler.toml）。
- 暫時用的私有 repo `Artin0123/gpt-checker-probe`（需手動刪除）。

**GHA 需要的設定**
- secrets：`PANEL_URL`、`PANEL_PASSWORD`（Discord webhook 改在面板設定）。
- variables（選填）：`HI_MODEL`（預設 `gpt-5.6-sol`）。

以下為歷史紀錄（第一輪、原始計畫），內容若與上方衝突以上方為準。

## 第一輪變更（2026/9/30）

**連線實測**（假 token，只看是否被 Cloudflare 擋）

| 來源                                            | chatgpt.com（wham/usage、codex/responses）                                                                  | auth.openai.com/oauth/token |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------- |
| 本機 curl / Node fetch                          | 401 JSON（正常）                                                                                            | 正常                        |
| 本機 workerd                                    | 403「Unable to load site」                                                                                  | 正常                        |
| Cloudflare edge（`wrangler dev --remote`，TPE） | 403「Unable to load site」；`chat.openai.com`、`/api/codex/usage` 同樣被擋；`cloudflare:sockets` 直連也失敗 | 正常                        |
| GitHub Actions runner（Node 22 fetch）          | 401 JSON（正常）                                                                                            | 正常                        |

**因此改為方案 b**
- Pages：密碼登入、匯入 / 匯出、OAuth（貼 callback 網址，換 token 走 auth.openai.com，edge 實測可連）、勾選、GHA 連結。不再有 `/api/accounts/:id/usage`、`/hi`。
- GHA（`scripts/gha-run.ts` + `scripts/runner.ts`）：refresh token、查額度、送 hi 都在 runner 上直接打 OpenAI，經面板的 Bearer 專用端點讀寫 KV：
  - `GET /api/gha/accounts`：勾選帳號（含 token），只接受 Bearer，瀏覽器 cookie 回 403。
  - `PATCH /api/gha/accounts/:id`：帶 `expectRefreshToken`，與 KV 不同（期間被重新匯入 / 登入）就不覆寫 token。
- 面板的「刷新額度」改成跳到 GHA：workflow_dispatch 有 `usage_only` 勾選框；只刷新模式沒有異常就不發通知，送 hi 模式一律通知。
- KV 鎖移除，改用 workflow `concurrency` 保證同時只有一個 run。新 token 寫回失敗會重試 3 次，仍失敗列為異常。
- KV `list()` 實測有延遲（剛匯入的帳號列不出來），新增 `index:accounts` 索引，與 `list()` 取聯集。
- 其他：cookie 寫入請求檢查 Origin（CSRF）；GHA 連結只接受 `https://github.com/`。

**已建立的資源**
- Cloudflare Pages 專案 `gpt-checker`（production：https://gpt-checker.pages.dev ），secrets：`PANEL_PASSWORD`、`SESSION_SECRET`（值在本機 `.deploy-secrets.local`，已 gitignore）。
- KV namespace `gpt-checker-accounts`（id 寫在 wrangler.toml）。
- 暫時用的私有 repo `Artin0123/gpt-checker-probe`（只有探測腳本；gh token 沒有 delete_repo 權限，需手動刪除）。

**GHA 需要的設定**
- secrets：`PANEL_URL`、`PANEL_PASSWORD`、`DISCORD_WEBHOOK_URL`。
- variables（選填）：`HI_MODEL`（預設 `gpt-5.6-sol`）。

**Implementation Plan：GPT Checker（Cloudflare Pages）**

**Problem Statement**
在 Cloudflare Pages 上做一個有密碼保護的面板，用來管理 ChatGPT/Codex 帳號，功能包括 OAuth 登入、匯入匯出、查額度。GHA 每 2 天執行一次，也可以手動執行：對勾選的帳號檢查條件，符合的就送一句 "hi" 啟動額度窗口，結果通知到 Discord。

**Requirements**
- 登入：照 CPA 的做法。
  1. 用 PKCE 產生授權網址，`redirect_uri` 固定是 `http://localhost:1455/auth/callback`。
  2. 使用者把跳轉後的完整網址貼回面板。
  3. 後端解析網址並驗證 state，確認 session 存在且還沒完成，再換 token。
  - PKCE session 存 KV，TTL 15 分鐘。
- 匯入格式：CPA 扁平 JSON、`~/.codex/auth.json`、codex-tools 的 `accounts.json`（整個 store、單一 account、或陣列）。沒有 `refresh_token` 就拒絕。缺少 `account_id` 時，從 id_token 的 `https://api.openai.com/auth.chatgpt_account_id` 補上。
- 匯出：單一帳號可匯出 CPA 格式，全部帳號可匯出 codex-tools 的 `accounts.json`（`{version:2, accounts:[...]}`）。
- 驗證：面板用密碼加 HMAC 簽章 cookie。`/api/*` 全部要驗證：瀏覽器帶 cookie，GHA 帶 `Authorization: Bearer <PANEL_PASSWORD>`，一律用 constant-time 比對。
- 查額度：面板上手動刷新，只顯示結果，不發通知。
- 送 hi 的條件：任一額度窗口 `used_percent == 0`（剩 100%），而且距離重置 ≥ 29 天。重置時間優先用 `reset_after_seconds`，沒有的話用 `reset_at - now`。
- GHA：cron `0 0 */2 * *`（UTC），加上 `workflow_dispatch`。面板上存 GHA workflow 的網址，按鈕點了直接跳過去。
- 通知：只有 GHA 會發。內容包括每個帳號的結果（已送、略過、失敗）、剩餘額度、重置時間。異常（token 刷新失敗、refresh token 失效、查額度失敗、送 hi 失敗）會醒目標示。
- 技術選型：Pages Functions 加 TypeScript，前端純 HTML/JS，測試用 Vitest。依賴一律鎖定精確版本。

**Background（已查證）**
- OAuth 的常數和參數出自 CPA 的 `internal/auth/codex/openai_auth.go`：
  - `ClientID=app_EMoamEEZ73f0CkXaXp7hrann`
  - scope 是 `openid email profile offline_access`
  - 參數有 `prompt=login`、`id_token_add_organizations=true`、`codex_cli_simplified_flow=true`
  - token endpoint 是 `https://auth.openai.com/oauth/token`，換 code 和 refresh 都用 form 編碼。refresh 時帶 `scope=openid profile email`。
- Callback 驗證邏輯出自 CPA 的 `oauth_callback.go`。
- 每次 refresh 都會換一組新的 refresh token，舊的就失效（CPA 會處理 `refresh_token_reused` 錯誤），所以新 token 要立刻寫回 KV，並加一把 KV 鎖（TTL 60 秒）。KV 是最終一致性，這把鎖只能降低 GHA 和手動刷新同時執行時出事的機率，無法完全保證。
- 查額度參考 codex-tools 的 `usage.rs`：`GET https://chatgpt.com/backend-api/wham/usage`，header 帶 `Authorization: Bearer`、`ChatGPT-Account-Id`、`Accept: application/json`。
- 送 hi 參考 codex-tools 的 `warmup.rs`：
  - 請求：`POST https://chatgpt.com/backend-api/codex/responses`
  - header：`Accept: text/event-stream`、`User-Agent: codex_cli_rs/<ver>`、`Originator: codex_cli_rs`、`Version`、`session-id`
  - body：`stream:true`、`store:false`、`instructions:""`
  - 判斷：讀到 `response.completed` 或 `response.done` 就算成功，`response.failed` 或 `error` 算失敗。
  - 模型名稱做成 `HI_MODEL` 環境變數，預設值 `gpt-5.6-sol`（codex-tools 的預設）。
- 還沒驗證：從 Workers 打 `chatgpt.com` 和 `auth.openai.com` 會不會被 Cloudflare challenge 擋下，這會在 Task 3 部署後實測。另外，free 帳號是不是 30 天窗口，也要用真實回應確認。

**Proposed Solution**

```mermaid
flowchart LR
  U[瀏覽器面板] -- cookie --> F[Pages Functions /api/*]
  G[GHA cron 每2天 / 手動] -- Bearer 密碼 --> F
  F <--> KV[(KV: account:* / oauth:* / lock:* / config)]
  F --> A[auth.openai.com<br/>換 token / refresh]
  F --> W[chatgpt.com<br/>wham/usage · codex/responses]
  G -- 彙整結果 --> D[Discord webhook]
  U -. 點連結 .-> GH[GitHub Actions 頁面]
```

**KV 結構**
- `account:<id>`：`{id, email, accountId, planType, tokens:{id_token, access_token, refresh_token}, expired, lastRefresh, selected, usage, usageError, updatedAt}`
- `oauth:<state>`：`{codeVerifier}`，TTL 900 秒
- `lock:<id>`：TTL 60 秒
- `config`：`{ghaUrl}`

**API**
- `login` / `logout`
- `GET /api/accounts`：只回傳摘要，不含 token
- `POST /api/oauth/start`、`POST /api/oauth/callback`
- `POST /api/import`、`GET /api/export`
- `PATCH` / `DELETE /api/accounts/:id`
- `POST /api/accounts/:id/usage`
- `POST /api/accounts/:id/hi`：依序執行刷新 token、查額度、判斷條件、送 hi、再查一次額度，最後回傳結果
- `GET` / `PUT /api/config`

**專案結構**
```
functions/_middleware.ts          # 驗證
functions/api/...                 # 路由
src/lib/                          # session, jwt, oauth, tokens, import, export, usage, hi, kv, lock
public/                           # index.html, app.js, style.css
scripts/gha-hi.ts                 # GHA 協調腳本
.github/workflows/hi.yml
wrangler.toml / vitest.config.ts / package.json
```

**秘密與設定**
- Pages：`PANEL_PASSWORD`、`SESSION_SECRET`、`HI_MODEL`（選填），KV binding 叫 `ACCOUNTS`。
- GitHub secrets：`PANEL_URL`、`PANEL_PASSWORD`、`DISCORD_WEBHOOK_URL`。

**Task Breakdown**

**Task 1：專案骨架和密碼驗證**
- 目標：專案可以在本機跑起來，面板和 API 都受密碼保護。
- 做法：
  - 用 `package.json` 鎖定 `wrangler`、`typescript`、`vitest`、`tsx` 的版本。
  - `wrangler.toml` 設定 `pages_build_output_dir="public"` 和 KV binding。
  - `src/lib/session.ts` 用 Web Crypto 做 HMAC-SHA256 簽章 cookie：HttpOnly、Secure、SameSite=Strict，7 天到期。
  - `_middleware.ts` 讓 `/api/login` 直接通過，其他路由接受 cookie 或 `Bearer PANEL_PASSWORD`，一律 constant-time 比對。
  - `public/` 放登入表單。
  - 測試環境用 in-memory 的 KV fake。
- 測試：簽章和驗章、竄改或過期的 cookie 會被拒絕、Bearer 驗證、沒登入時回 401。
- Demo：`wrangler pages dev` 開起來後，輸入錯的密碼被拒絕，輸入對的密碼可以進面板。

**Task 2：匯入帳號和帳號列表**
- 目標：可以貼上或上傳 JSON 匯入帳號，面板顯示帳號列表，也可以刪除帳號。
- 做法：
  - `src/lib/jwt.ts`：解碼 id_token 的 claims，只解碼、不驗簽，用來取 email、account_id、plan。
  - `src/lib/import.ts`：依序判斷格式：accounts store → stored account（`authJson`/`auth_json`）→ 陣列 → `tokens` 物件 → CPA 扁平格式。
  - 沒有 refresh_token 的帳號拒絕。用 `email + accountId` 產生 id，重複匯入時覆蓋。
  - 實作 `POST /api/import`、`GET /api/accounts`（不回傳 token）、`DELETE /api/accounts/:id`。
  - 前端：匯入區塊、帳號表格。
- 測試：每種格式各準備一份 fixture；缺 refresh_token、缺 account_id 從 claim 補上、重複匯入時覆蓋。
- Demo：匯入一份 CPA JSON 和一份 `auth.json`，列表上出現兩個帳號，刪掉其中一個。

**Task 3：刷新 token、查額度，以及 Workers 連線 spike**
- 目標：面板上按「刷新額度」可以看到每個窗口的剩餘 %、重置時間和方案類型。
- 做法：
  - `src/lib/tokens.ts`：access token 在 5 分鐘內到期（依 `expired` 或 JWT 的 exp 判斷）就先 refresh。refresh 前取得 `lock:<id>`，拿到新 token 立刻寫回 KV。
  - 遇到 `refresh_token_reused`，或 401/400 且錯誤是 invalid_grant，就把帳號標成失效。
  - `src/lib/usage.ts`：打 wham/usage，把 primary、secondary、additional 窗口整理成 `{usedPercent, windowSeconds, resetAt, resetAfterSeconds}`，存成 usage snapshot。
  - 實作 `POST /api/accounts/:id/usage`。前端每列加刷新按鈕，另有一顆「全部刷新」，會逐一呼叫每個帳號。
- 測試：mock fetch，涵蓋正常 refresh、reused 錯誤、窗口解析，以及只有單一窗口或缺欄位的情況。
- Demo 和 spike：部署到 Pages preview（部署前會先問你），用真實帳號按刷新。
  - 成功就保存一份去識別化的回應當 fixture，並確認 free 帳號的窗口長度。
  - 如果被 challenge 擋下，就停下來回報，討論要不要改成方案 b。

**Task 4：OAuth 登入（CPA 的貼網址流程）**
- 目標：在面板上完成 OAuth 登入並新增帳號。
- 做法：
  - `src/lib/oauth.ts`：產生 PKCE（S256）和 state，組出和 CPA 參數相同的授權網址。
  - `POST /api/oauth/start` 把 `oauth:<state>` 存進 KV（TTL 900）。
  - `POST /api/oauth/callback {redirect_url}` 依照 CPA 的順序處理：
    1. 解析 `code`、`state`、`error`。
    2. 驗證 state，確認 session 存在且還沒完成。
    3. 換 token，然後刪掉這筆 session。
    4. 沿用 Task 2 的流程寫入帳號。
  - 前端：「開啟登入頁」按鈕，加上貼網址的輸入框和提示文字。
- 測試：state 不符、session 過期、網址帶 error、缺 code、重複送出。
- Demo：開啟登入頁，登入後把 localhost 網址貼回面板，帳號出現在列表上，而且可以刷新額度。

**Task 5：匯出**
- 目標：匯出的 JSON 可以直接給 CPA 或 codex-tools 使用。
- 做法：
  - `src/lib/export.ts`：單一帳號轉成 CPA 扁平格式（`type:"codex"`，包含 `expired`、`last_refresh`、`plan_type`）。全部帳號轉成 codex-tools 的 `{version:2, accounts:[StoredAccount]}`。
  - 實作 `GET /api/export?format=cpa&id=` 和 `?format=codex-tools`，回應加上 `Content-Disposition`。
- 測試：匯出後再匯入（round-trip），內容要一致。
- Demo：下載兩種格式的檔案，再匯入回面板，資料不變。

**Task 6：勾選框和 GHA 連結**
- 目標：面板上可以勾選要讓 GHA 處理的帳號，也可以設定和開啟 GHA 連結。
- 做法：
  - `PATCH /api/accounts/:id {selected}`。
  - `GET /api/accounts?selected=1` 給 GHA 使用。
  - `GET` / `PUT /api/config {ghaUrl}`，只接受 `https://github.com/` 開頭的網址。
  - 前端：每列一個勾選框，另有「前往 GHA 執行」按鈕（新分頁開啟，加 `rel=noopener`）。
- 測試：勾選狀態會保存下來、過濾結果正確、不合法的網址被拒絕。
- Demo：勾選兩個帳號並設定連結，點按鈕會跳到 GitHub Actions 頁面。

**Task 7：送 hi 的 API**
- 目標：`POST /api/accounts/:id/hi` 完成整個流程並回傳結構化結果。
- 做法：
  - `src/lib/hi.ts`：
    - `shouldSendHi(usage, now)`：任一窗口用量為 0，而且距離重置 ≥ 29×86400 秒。
    - `sendHi()`：照 codex-tools 的 header 和 body，input 是 "hi"，逐塊讀 SSE，讀到終止事件就停，最多讀 1 MiB。
  - 路由流程：刷新 token → 查額度 → 判斷條件 → 符合才送 hi → 等 750ms → 再查一次額度。
  - 回傳 `{status: sent|skipped|failed, reason, remaining, resetAt, anomalies[]}`。
  - 這支 API 本身不發任何通知。
- 測試：條件的邊界值（剛好 29 天、99%、沒有窗口）；SSE 的 completed、failed、error 事件，以及事件被切在不同 chunk 的情況。
- Demo：用 curl 帶 Bearer 呼叫。不符合條件的帳號回 skipped，符合條件的帳號回 sent，而且額度窗口開始倒數。

**Task 8：GHA 腳本、workflow 和 Discord 通知（整合）**
- 目標：GHA 排程或手動執行時，處理勾選的帳號，並把結果送到 Discord。
- 做法：
  - `scripts/gha-hi.ts` 讀取環境變數 `PANEL_URL`、`PANEL_PASSWORD`、`DISCORD_WEBHOOK_URL`，依序：
    1. 取得勾選帳號。
    2. 逐一呼叫 hi API，單一帳號失敗不影響其他帳號。
    3. 組成 Discord embed。一則訊息最多 10 個 embed，超過就分批送。每個帳號顯示結果、剩餘 %、重置時間。有異常時用紅色 embed 放在最前面。
    4. 呼叫面板 API 失敗時，也要送一則異常通知。
  - `.github/workflows/hi.yml`：`schedule: cron '0 0 */2 * *'` 加上 `workflow_dispatch`，Node 22，`npm ci`，再執行 `npx tsx scripts/gha-hi.ts`。
- 測試：mock 面板 API 和 Discord，涵蓋 embed 內容、分批、異常置頂、API 整個掛掉的情況。
- Demo：在 GitHub 上按 Run workflow，Discord 收到每個帳號的結果。故意改錯密碼再跑一次，會收到異常通知。

**幾點注意**
- 部署、建立 KV namespace、設定 secrets 都會動到你的 Cloudflare 和 GitHub 帳號，執行時每一步都會先問你。
- 如果 repo 是 public，60 天沒有活動，GitHub 會停用排程 workflow。
- 面板密碼同時是 GHA 的驗證憑證，所以密碼要夠長。
- 我目前的理解是：排程和手動執行都只處理「面板上勾選的帳號」，而且都會檢查送 hi 的條件，沒有強制送的選項。