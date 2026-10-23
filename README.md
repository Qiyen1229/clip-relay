# Clip Relay

內網自建的**剪貼簿歷史與跨端傳輸**服務。開啟網頁就能用：貼上文字，或上傳**任意格式的檔案、整個資料夾、iOS 相簿的照片／影片**，其他設備立刻看到並可複製／下載。
**不需要登入、令牌或金鑰**；每筆都有 TTL，可選「讀取一次後刪除」。支援 iOS「加入主畫面」。

- 後端：Node.js 22，**零 npm 依賴**；前端：原生 ES Module，無建置步驟
- 部署：一個 `docker-compose.yml`，**更新時只要覆蓋上傳檔案**（見〈更新流程〉）
- 預覽：<http://localhost:9144>

> ⚠️ **沒有任何認證與加密**：能連到這個網址的人都能讀寫全部內容，內容以明文存放在伺服器記憶體。
> 請只放在可信任的內網。若要經 Cloudflare 對外，**務必**在前面加上 Cloudflare Access（或同等閘道），見〈對外使用〉。

## 目錄結構

```
clip-relay/
├── docker-compose.yml        # NAS 部署（預設，免 build、免重建更新）
├── docker-compose.build.yml  # 可選：自行 build 不可變映像
├── Dockerfile                # 同上（方式 B 使用）
├── .env.example              # 環境變數範例
├── supervisor.js             # 容器 PID 1：偵測檔案變動 → 自動重啟服務
├── package.json
├── src/                      # server.js / store.js / ratelimit.js / config.js
├── public/                   # 前端與 PWA 資源（由伺服器靜態提供）
│   ├── index.html  style.css  app.mjs
│   ├── zip.mjs               # 瀏覽器端資料夾打包（zip，存放不壓縮）
│   ├── manifest.json         # PWA manifest
│   ├── icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png
│   └── splash-*.png          # iOS 啟動畫面（17 種直向尺寸）
├── scripts/gen-assets.py     # 重新產生圖示與啟動畫面（需要 Pillow）
└── test/                     # node --test（34 個測試）
```

## 技術選型與理由

| 決策 | 選擇 | 理由 |
|---|---|---|
| 語言 | Node.js（零依賴） | 單一官方映像即可執行，不需 `npm install`／build，「覆蓋檔案即更新」才能成立。 |
| 同步 | 輪詢 + ETag/304 | 比 SSE/WebSocket 簡單可靠，穿過 Cloudflare／反向代理不需特別設定。每 2 秒一次（分頁隱藏 10 秒），無變動時回應僅幾百 bytes。 |
| 儲存 | 記憶體；可選 JSON 快照 | 資料短命，記憶體最簡單。`PERSIST=1` 會把內容快照寫到資料卷。 |

## 檔案、資料夾與相簿

| 來源 | 做法 |
|---|---|
| 任意檔案 | 「選擇檔案」、拖放，或直接貼上圖片（Ctrl/⌘+V）。可一次選多個，逐一上傳 |
| iOS 相簿 | 「相簿照片／影片」：iOS 會彈出系統的「照片圖庫／拍照／選擇檔案」選單，可多選 |
| 資料夾 | 「選擇資料夾」（桌面瀏覽器）或把資料夾拖進頁面：在瀏覽器端**打包成 zip**（保留子資料夾結構與中文檔名，略過 `.DS_Store` 等雜檔），以單一項目上傳，下載時得到 `資料夾名.zip` |

- **分塊上傳**：檔案切成 4 MB 一塊依序送出，有進度與取消、單塊失敗自動重試。因此即使經 Cloudflare（單一請求限 100 MB）也可傳大檔；伺服器**串流寫入磁碟**，不會把檔案讀進記憶體。
- **上限**：單檔預設 1 GiB（`MAX_FILE_BYTES`）、檔案總量預設 5 GiB（`MAX_FILE_TOTAL_BYTES`，超過時淘汰最舊的）。伺服器磁碟剩餘空間不足時會拒絕。資料夾 zip 因不使用 ZIP64，總大小須小於 4 GB。
- **預覽**：圖片（≤ 8 MB）顯示縮圖，圖片／影片／音訊可按 👁 預覽（支援 Range，影片可拖曳進度）。其餘類型（含 HTML、SVG）**一律強制下載**，並加上 `nosniff` 與 `Content-Security-Policy: sandbox`，避免同源 XSS。
- **阅後即焚**對檔案同樣有效：下載開始時即從伺服器移除（已開啟的串流會讀完）；下載中途失敗無法重取。
- **iOS 注意**：HEIC 原檔上傳後，非 Safari 瀏覽器可能無法顯示縮圖（會退回圖示，仍可下載）；是否由系統轉成 JPEG 取決於 iOS 的照片傳輸設定，本服務原樣保存收到的內容。iOS Safari 不支援選取資料夾，「選擇資料夾」會退化為一般檔案選擇（可先在「檔案」App 壓縮成 zip 再上傳）。
- **持久化**：compose 預設 `PERSIST=1`，重啟與熱更新後檔案仍在（存於 `clip_data` 資料卷）。設為 0 則重啟即清空。

## API

無需認證。錯誤格式：`{"error":{"code","message"}}`。

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/items` | body `{text, ttl?, burn?}` → `201 {id,seq,size,createdAt,expiresAt,burn}`；超過上限 `413`；格式錯誤 `400` |
| GET | `/api/items` | 未過期紀錄（新到舊）。非阅後即焚且 ≤ `INLINE_TEXT_BYTES` 者內嵌 `text`，其餘為 `null`。支援 `If-None-Match` → `304` |
| GET | `/api/items/{id}` | 取單筆。文字：含內容，**阅後即焚者回傳後立即刪除**；檔案：僅中繼資料。不存在/過期/已讀 `404` |
| GET | `/api/items/{id}/content[?inline=1]` | 下載檔案／資料夾 zip（支援 `Range`）。僅白名單媒體類型可 `inline=1` 預覽；阅後即焚者下載時即刪除 |
| POST | `/api/files` | 建立上傳 `{name,size,mime?,ttl?,burn?,kind?('file'\|'folder'),fileCount?}` → `201 {id,chunkBytes}`；超過單檔上限 `413`，磁碟不足 `507` |
| PUT | `/api/files/{id}?offset=N` | 上傳一塊（`application/octet-stream`），offset 須等於已接收位元組數 → `200 {received}`；不符 `409` |
| POST | `/api/files/{id}/complete` | 完成上傳 → `201`（項目才會出現在列表）；未收完 `409` |
| DELETE | `/api/files/{id}` | 放棄上傳並清除暫存 |
| DELETE | `/api/items/{id}` | 手動刪除 `204` / `404` |
| DELETE | `/api/items` | 清空全部 |
| GET | `/api/config` | 上限、TTL 選項等設定 |
| GET | `/api/health` | 健康檢查 `{ok,version,build}` |

## 行為細節

- **過期**：TTL 可選 1 分／10 分／1 時／24 時（預設 10 分）。**惰性刪除**（任何讀取前先清除過期項目）＋ **主動刪除**（每 30 秒定時任務）。
- **阅後即焚**：列表不回傳其內容；只有 `GET /api/items/{id}` 會取出並同步刪除，併發讀取只會有一個成功。若瀏覽器拒絕自動複製，會跳出對話框顯示內容，避免已刪除的資料遺失。
- **上限**：預設 50 筆、總量 64 MB，超過淘汰最舊；單筆預設 1 MB（UTF-8 位元組）。
- **併發**：順序以**伺服器接收順序**為準（單調遞增 `seq`），不信任客戶端時鐘。
- **複製**：HTTPS/localhost 用 `navigator.clipboard`（含 Safari 需要的 Promise 形式 `ClipboardItem`）；**純 HTTP 內網自動降級**為隱藏 textarea + `execCommand('copy')`；仍失敗則顯示手動複製對話框。
- **XSS**：使用者內容只以 `textContent` 渲染；CSP `default-src 'none'; script-src 'self'`，無行內腳本。
- **限流**：發送預設每 IP 每分鐘 30 次、讀取 600 次。

## iOS「加入主畫面」

Safari 開啟網址 → 分享 → 「加入主畫面」。已提供：

- `manifest.json`：`name`、`short_name`、192/512 圖示、512 maskable、`theme_color`、`background_color`、`display: standalone`
- `apple-touch-icon`（180×180）、`apple-mobile-web-app-capable`、`status-bar-style=black-translucent`、`apple-mobile-web-app-title`
- `viewport-fit=cover` + `env(safe-area-inset-*)`：頂欄延伸到狀態列／動態島後方，底部與左右內縮避開橫條與缺口
- 啟動畫面：17 種 iPhone／iPad 直向尺寸（iPhone SE 到 16 Pro Max、iPad 到 12.9"）。**橫向與未列出的新機型會顯示白屏或系統預設啟動畫面**，可在 `scripts/gen-assets.py` 的 `SPLASH` 清單新增後重新產生。
- 輸入框字級 16px，避免 iOS 聚焦時自動放大。

注意：iOS 已加入主畫面後，圖示與啟動畫面會被系統快取；更新圖示需刪除主畫面捷徑後重新加入。

## 部署到 NAS（Docker）

1. 把整個專案資料夾上傳到 NAS（例如 `/volume1/docker/clip-relay`）。
2. （可選）複製 `.env.example` 為 `.env` 調整參數。
3. Container Manager → 專案 → 新增 → 路徑選該資料夾（自動讀取 `docker-compose.yml`）→ 啟動；或 `docker compose up -d`。
4. 瀏覽 `http://NAS-IP:9144`。

### 更新流程（免刪除、免重建）

容器用官方 `node:22-alpine` 並掛載專案資料夾，內建 supervisor 偵測變動。

1. 把新版檔案**直接覆蓋上傳**到同一個資料夾（File Station 選「覆寫」；不要先刪資料夾）。
2. 約 5～10 秒後 supervisor 偵測到 `src/`、`public/`、`package.json` 變更並自動重啟服務。
3. 已開啟的網頁在下次輪詢時顯示「有新版本可用 → 重新整理」。

- 上傳了有語法錯誤的檔案時，服務會退避重試；修正並重新上傳後自動恢復。
- `supervisor.js` 自己被更新時會結束行程，由 `restart: unless-stopped` 重啟容器。
- 只有 **`docker-compose.yml` 本身**變更（連接埠、環境變數、掛載）時，才需在 Container Manager 對專案按一次「重新啟動」。
- 想要不可變映像：`docker compose -f docker-compose.build.yml up -d --build`（更新需重新 build）。

## 對外使用（Cloudflare）

- 純內網使用不需要任何設定。
- 要讓外網可用：用 Cloudflare Tunnel 指向 `NAS-IP:9144`，並在 Zero Trust 建立 **Access 應用程式**（Email OTP／Google 登入即可），否則任何人都能讀寫。同時設定 `TRUST_PROXY=1` 讓限流取得真實 IP。
- 因為沒有加密，Cloudflare 與任何中間節點在傳輸中可看到內容（TLS 在其終止）；介意的話請不要經過公網。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` / `HOST_PORT` | 9144 | 容器內／對外連接埠 |
| `MAX_ITEMS` | 50 | 歷史筆數 |
| `MAX_ITEM_BYTES` | 1048576 | 單筆上限（bytes） |
| `MAX_TOTAL_BYTES` | 67108864 | 文字總容量上限 |
| `MAX_FILE_BYTES` | 1073741824 | 單一檔案上限 |
| `MAX_FILE_TOTAL_BYTES` | 5368709120 | 檔案總容量上限（超過淘汰最舊） |
| `CHUNK_BYTES` | 4194304 | 上傳分塊大小 |
| `MIN_FREE_DISK_BYTES` | 268435456 | 磁碟剩餘低於「檔案大小 + 此值」時拒收 |
| `DEFAULT_TTL` / `MAX_TTL` | 600 / 86400 | 秒 |
| `POST_RATE_PER_MIN` / `READ_RATE_PER_MIN` | 30 / 600 | 每 IP 每分鐘 |
| `TRUST_PROXY` | 0 | 信任 `CF-Connecting-IP`／`X-Forwarded-For` |
| `PERSIST` | 0（compose 預設 1） | 1 = 索引快照寫入 `/data/items.json`（文字明文，0600），檔案保留在 `/data/files` |
| `INLINE_TEXT_BYTES` | 16384 | 列表內嵌內容的大小門檻 |
| `WATCH_POLL_MS` / `WATCH_SETTLE_MS` | 3000 / 2500 | 熱更新偵測間隔／穩定等待 |

## 資源占用（估計值）

本機實測服務行程閒置 RSS 約 47 MB；加上 supervisor 與容器開銷，整個容器約 80～100 MB。檔案上傳／下載皆為串流，不會隨檔案大小增加記憶體；compose 預設 `mem_limit: 256m`。實際請以 NAS 數據為準。

## 測試

```bash
npm test      # 或：node --test test/
```

涵蓋：過期（惰性＋定時，含磁碟檔刪除）、阅後即焚（文字與檔案）、超大內容拒絕、輸入驗證、速率限制、分塊上傳（offset、重傳、放棄）、Range、inline 白名單、檔名清理、持久化與孤兒檔清理、zip 正確性（以 Python zipfile 驗證）、靜態檔安全標頭與路徑穿越、PWA 資源完整性。

## 已知限制

- 無使用者／多租戶；**無認證、無加密**（見上方警告）。
- 檔案以原樣存放在 NAS 磁碟，不加密；資料夾以 zip 單一項目呈現，無法單獨下載其中的某個檔案。
- 上傳以分塊進行但**不支援跨頁面重新整理後續傳**；頁面關閉即中止（伺服器 1 小時後清除暫存）。
- iOS 背景或鎖屏後，Safari 可能暫停上傳，請保持頁面在前景。
- 記憶體儲存：預設重啟即清空。
- 輪詢最多約 2 秒延遲。
- iOS 啟動畫面僅直向、僅涵蓋列出的機型。
- 沒有 Service Worker／離線模式：服務本身就需要連線。
