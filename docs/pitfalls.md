最後更新: 2026/10/1
狀態: 已部署

# 踩坑紀錄與設計判斷

## 連線與執行環境

### Cloudflare 連不到 chatgpt.com → 查額度、送 hi 移到 GHA

原本計畫在 Pages Functions 裡直接查額度、送 hi。實測（假 token，只看是否被擋）：

| 嘗試                                                           | 結果                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 本機 curl / Node fetch                                         | 401 JSON（正常）                                                                         |
| 本機 workerd（`wrangler pages dev`）                           | 403「Unable to load site」                                                               |
| Pages Functions / Workers `fetch`（edge，TPE）                 | 同上 403。同 IP 的 curl / Node 正常 → 判斷是 workerd 的連線指紋被擋                      |
| Workers 改打 `chat.openai.com`、`/api/codex/usage`             | 同樣 403                                                                                 |
| Workers 帶全套 Chrome header（UA、sec-ch-ua、Referer、Origin） | 同樣 403                                                                                 |
| Workers `cloudflare:sockets` 直連                              | 不允許連 Cloudflare 自家 IP（`Stream was cancelled`）                                    |
| Cloudflare Browser Rendering（`/content`）                     | 同樣「Unable to load site」（出口 IP 104.28.x）；第二次呼叫就 `2001 Rate limit exceeded` |
| 瀏覽器直接打 chatgpt.com                                       | CORS 預檢回 400、沒有 `Access-Control-Allow-Origin`                                      |
| GitHub Actions runner（Node 22 fetch）                         | ✅ 正常 → 採用                                                                            |

- `auth.openai.com`（換 token / refresh）從 edge 可以連，所以 OAuth 登入留在面板上。
- 結論：refresh、查額度、送 hi 全在 GHA runner 上跑，面板只負責管理與顯示。本機要測查額度，也要用 Node 直接跑腳本，不能透過 workerd。

### 不用 PAT 從面板觸發 GHA

用 GitHub token 呼叫 `workflow_dispatch` 再輪詢結果是可行的（`return_run_details` 會回 run 網址，已實測），但要把有 repo 權限的 GitHub token 存在 Pages 上。決定不採用：面板按鈕只開啟 workflow 頁面，到 GitHub 按 Run workflow。

- 附帶一提：dispatch API 用預設版本時會回 `Deprecation` header（Sunset 2028-03-10）。日後若要用，帶 `X-GitHub-Api-Version: 2026-03-10`。

## 登入

### 不用裝置碼（驗證碼）登入

裝置碼登入（`deviceauth`，CPA `sdk/auth/codex_device.go`）從 edge 可以取碼與輪詢，但**帳號預設沒開**。實際授權時 OpenAI 顯示：

> 請在 ChatGPT 安全性設定中啟用 Codex、Excel、PowerPoint 和 Word 的裝置代碼登入，然後再次執行「codex login --device-auth」。

每個帳號都要先手動開設定，不比貼網址方便，所以移除，只保留 CPA 的貼 callback 網址流程（`redirect_uri` 固定 `http://localhost:1455/auth/callback`）。

### 面板 session 從 HMAC cookie 改成 KV session

原本用 HMAC 簽章 cookie（需要 `SESSION_SECRET`），缺點是登出無法讓 cookie 失效。改成 cookie 只放隨機 token、KV 存 `session:<sha256(token)>`（TTL 7 天）：登出會真的失效（其他地區最多約 60 秒），看得到 KV 內容也拿不到可用的 cookie。代價是每個已登入請求多讀 1 次 KV。`SESSION_SECRET` 已不再使用。

## Token

### refresh token 每次都會輪替

每次 refresh 都會拿到新的 refresh token，舊的立刻失效（重用會得到 `refresh_token_reused`）。因此：

- 新 token **立刻**寫回面板，不能等全部帳號跑完才寫；寫回失敗重試 3 次，仍失敗就列為異常（帳號可能要重新登入）。
- 寫回時帶 `expectRefreshToken`（讀取時的 refresh token）。如果 KV 裡的已經不同（執行期間被重新匯入 / 登入），就不覆寫，避免把較新的 token 蓋掉。
- 原計畫用 KV 鎖（TTL 60 秒）防止同時 refresh，但 KV 是最終一致，鎖不可靠 → 移除，改用 workflow `concurrency` 保證同時只有一個 run。
- 同一次執行可能 refresh 兩次（快過期先 refresh，送 hi 又回 401 再 refresh）。曾經的 bug：`expectRefreshToken` 固定用執行開始時的 token，第二次寫回時面板上已經是第一次的新 token → 鏈檢查失敗、第二組 token 沒寫回，而面板上那組已被輪替掉 → 帳號壞掉。現在每次寫回成功就更新鏈檢查用的 token。

## 送 hi

### 條件：只看窗口有沒有開始倒數

1. **原計畫**：任一窗口 `used_percent == 0` 且距離重置 ≥ 29 天。問題：剛送完 hi，用量四捨五入後仍是 0、距離重置仍 ≥ 29 天，24 小時內會重送。
2. **改成看窗口是否開始倒數**。實測 free / go 帳號：
   - 沒用過的窗口，每次查詢 `reset_after_seconds` 都等於 `limit_window_seconds`（2592000），`reset_at` 跟著查詢時間往後移。
   - 開始使用後 `reset_at` 就固定，剩餘秒數開始變少。
   - 所以「距離重置 ≥ 窗口長度 − 誤差」＝還沒開始。`reset_at` 與抓取時間實測差 1 秒（2592001 vs 2592000），誤差容許 10 秒。
3. **拿掉 `used_percent` 檢查**：用過就一定會開始倒數，沒倒數就一定是 100%，多檢查一次沒有意義。
4. 不看方案、不看窗口長度（5 小時窗口沒用過也符合）。付費方案目前沒有帳號可驗證。

### 對方報錯仍算已送出，GHA 自己的錯才算失敗

- 請求送到 OpenAI、對方有回應（非 2xx、`failed` / `error` 事件、串流中斷、沒有結束事件）→ 算已送出，錯誤只記在 `lastRun.upstreamError`，不讓 run 變紅。窗口到底有沒有開始，看送完後重新查的額度。
- GHA 這邊的問題才算失敗、讓 run 變紅：連不上對方 / 逾時、被 Cloudflare 擋（請求根本沒進到 OpenAI）。
- 401 例外：代表 token 問題，refresh 後重送一次。

### 其他

- 內容是 `only reply hi`，讓回覆盡量短、少吃額度。
- 手動執行的預設模式是「只查額度」：不消耗額度、不發通知，要送 hi 必須明確切換。只查額度不會覆蓋「最近送 hi」。

## Cloudflare KV

### 免費方案限制

每天寫 1,000、刪 1,000、list 1,000、讀 100,000；同一個 key 每秒最多寫 1 次。一開始把常變動的狀態逐次寫 KV，很快會用完：

| 操作          | 現在                                                             | 之前的問題                            |
| ------------- | ---------------------------------------------------------------- | ------------------------------------- |
| 手動模式開關  | 停手 1.5 秒後最多寫 1 次；切回原值 0 次；開 GHA / 關分頁前先送出 | 每次切換寫 1 次                       |
| 勾選 / 全選   | 0（只存在頁面記憶體）                                            | 每勾一個寫 1 次                       |
| 啟用 / 停用   | 1 次（`enabled` 一個 key）；沒變 0 次                            | —                                     |
| 刪除          | 每個帳號刪 1 次＋索引寫 1 次                                     | 每個帳號各自更新索引                  |
| 載入帳號列表  | 0 次 `list()`                                                    | 每次載入呼叫 1 次 `list()`            |
| 匯入 N 個帳號 | 有變動的帳號各寫 1 次＋索引最多 1 次；內容相同不寫               | 索引每個帳號各寫 1 次                 |
| OAuth 登入    | 開始寫 1 次（同一網址 14 分鐘內重用）；成功刪 1 次               | 每按一次寫 1 次，callback 再寫 2–3 次 |
| GHA 一次執行  | 額度結果整批寫 1 次（`status`）＋有 refresh 的帳號各 1 次        | 每個帳號寫 1 次額度＋refresh 再 1 次  |
| 儲存設定      | 沒變就不寫                                                       | 每次都寫                              |

原則：常變動的資料集中在少數 key、整批寫一次；內容沒變就不寫。token（`account:<id>`）和額度結果（`status`）分開存，查額度不會動到每個帳號的 key。

- **同一個 key 每秒只能寫 1 次**：同一次匯入含重複帳號（例如同一個人的兩份檔案）時，曾經對同一個 `account:<id>` 連寫兩次。現在同一次匯入先以帳號 id 去重（以最後一筆為準），每個 key 只寫一次。
- **讀取也要省**：啟用 / 停用只讀 `index:accounts` 與 `enabled` 兩個 key（`enabled` 還不存在的舊資料才讀每個帳號）；匯出只讀選取的帳號。

### `list()` 有延遲

剛匯入的帳號在列表裡看不到。改成另存 `index:accounts` 索引，一般路徑只讀索引；只有索引不存在時才用 `list()` 重建一次。

## GitHub Actions

- **YAML plain scalar 含 `: `**：`run: curl ... -H "Authorization: Bearer x"` 會讓整個檔案解析失敗。現象是 run 0 秒失敗、名稱顯示成檔案路徑，dispatch 回 422「沒有 workflow_dispatch」。含 `: ` 的指令改用 `run: |` block scalar。
- **`concurrency` 加 `queue: max`**：預設只保留一個 pending run，新的會把舊的 pending 取消；加上後多次手動執行會排隊（已在 probe repo 實測）。
- **`workflow_dispatch` 只在預設分支生效**：`hi.yml` 推到預設分支後，GitHub 頁面才會出現 Run workflow。
- **不跑 `npm ci`**：devDependencies 含 wrangler / workerd，裝起來約 250 MB，但 GHA 腳本只 import 專案內的 `src/`，沒有執行期依賴。workflow 直接 `npx --yes tsx@<版本>`；版本要和 `package.json` 一致，`test/workflow.test.ts` 會檢查。
- **Discord 訊息限制**：一則最多 10 個 embed，而且所有 embed 的字數合計最多 6000。原本只按 10 個分批，帳號多、錯誤訊息長時會超過 6000 被拒絕、run 變紅。現在同時按個數與字數分批。
- **Discord webhook 存在面板而不是 GitHub secret**：改網址不用動 GitHub；GHA 執行時向面板讀取。面板本身有密碼保護、匯出也含 token，所以面板直接顯示完整網址。
- 已知可接受：cron `0 0 */2 * *` 在月底可能連續兩天執行；public repo 60 天沒活動，排程會被 GitHub 停用。

## 前端

- **CSP `style-src 'self'` 會擋 inline `style` 屬性**：進度條寬度改用 CSSOM（`el.style.width`）設定。
- **字級**：電腦最小 14px、平板 / 手機（≤ 1024px）最小 13px（12px 太小）。
- **表格斷點 860px**：最小字級 13px 時，四欄表格實測要 861px 以上才不會橫向捲動；860px 以下改成一個帳號一張卡片。
- 帳號欄限制寬度、email 過長截斷（完整內容在 title），多出來的寬度給「最近送 hi」顯示錯誤訊息。
