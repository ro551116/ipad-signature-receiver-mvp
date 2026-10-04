# iPad Signature Receiver MVP

第一版 prototype：iPad 簽名即時送到電腦，在電視牆 / LED 牆頁面顯示，並同步觸發燈光 cue。

> 原始開發脈絡在私人 vault 的 `Projects/scratch-2026-05-31/deliverables/ipad-signature-receiver-mvp/`，此 repo 為獨立出來的可部署版本。

## Run

```bash
npm start   # 啟動 server
npm test    # 跑 server 行為測試（node --test，每個測試用獨立 data 目錄）
```

無外部套件依賴，僅用 Node.js 內建模組。

Server 預設跑在 `0.0.0.0:3000`。

| 環境變數 | 預設 | 用途 |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 監聽位址 |
| `DATA_DIR` | `./data` | 簽名、燈光設定、control token 的存放目錄 |
| `DISPLAY_DURATION_MS` | `7800` | final 上牆展示時間；保持在極光影片長度（8 秒）以內 |
| `MAX_SIGNATURES` | `1000` | 保存上限。滿了之後**拒收新簽名**（iPad 顯示錯誤），不會刪掉舊簽名 |

## Security / Auth

Server 預設綁 `0.0.0.0`，同一個 Wi-Fi 的任何裝置都連得到。正式上場前務必設定：

| 環境變數 | 保護對象 | 行為 |
|---|---|---|
| `CONTROL_TOKEN`（staff token） | show-control 端點（`/api/cue/*`、`DELETE /api/signatures/:id`、`/api/lighting/config`、`/api/lighting/cue`）＋所有會回傳簽名筆跡的端點（`GET /api/state`、`GET /api/signatures`、`GET /api/links`、電視牆與控制台的 `/events`） | 未設定且非 loopback（`127.0.0.1`/`localhost`）時一律回 403（fail-closed）。簽名是個資，不能讓同網路的人直接下載 |
| `SIGN_TOKEN` | 簽名端點（`/api/live-signature`、`/api/live-signature/clear`、`/api/signatures`）＋ iPad 的 `/events?role=sign` | 未設定時維持開放（MVP 預設），但非 loopback 啟動會印警告：任何連上 Wi-Fi 的人都能在牆上即時畫。設定後 iPad 要用帶 token 的 `/sign` 連結開啟 |
| `ALLOW_UNSAFE_NO_CONTROL_TOKEN=1` | 明確選擇不設 `CONTROL_TOKEN` 也開放上述 staff 端點（例如純內網快速測試） | 等同 fail-open，**不建議用在真實活動** |

**怎麼開頁面**：先開 `/control?token=<CONTROL_TOKEN>`，再用控制台的 Quick Links「開啟 / 複製連結」。連結由 server 產生，電視牆連結帶 staff token、簽名頁連結帶 `SIGN_TOKEN`。token 開過一次會存在該分頁的 sessionStorage；kiosk 模式建議直接把含 token 的完整網址設為開機頁。

**互動式輸入**：沒設 `CONTROL_TOKEN` 環境變數、且 `npm start` 在真實終端機（TTY）執行時，啟動會跳出 `Set CONTROL_TOKEN for /control and the walls:` 提示，直接按 Enter 沿用上次存的 token（存在 `data/control-token`，已 gitignore）；systemd / CI / 非互動環境跳過提示，直接走 fail-closed。

## Pages

- `/sign` — iPad 簽名端（Nordberg Medical logo 置頂）
- `/medical-wall` — 醫師迎賓牆（主要畫面）：滿版簽名跑馬燈＋中央品牌 logo、live 簽名直播、final 上牆動畫與極光背景
- `/curtain` — 入口黑布簾投影（依活動示意圖）：純黑底，由上而下是 logo、簽名、Welcome。沒人簽時只有 logo＋Welcome（中間留空）；醫師落筆後簽名直接寫在中間，送出後滑到正中並放大填滿簽名區，展示時間結束後淡出
- `/wall` — 簡易電視牆（只顯示 final 簽名描線，除錯 / 備援用）
- `/control` — 工作人員控制台

## 行為

- iPad Canvas 簽名，以 normalized stroke points 傳送（座標取到小數 4 位），不傳 PNG。
- **落筆即直播**：iPad 每個 animation frame 推送最新筆跡（上一筆送達才送下一筆）。server 只把「這一筆簽名」推給電視牆，不夾帶已保留的簽名，所以簽名越來越多也不會拖慢直播。
- **停筆約 1.3 秒自動完成**：送出期間畫布鎖定（下一位落筆不會混進來）；網路失敗或逾時會自動重試（1、2、4、8 秒），仍失敗則顯示「重送」按鈕。server 以簽名 id 去重，重送不會存兩筆、不會重播。
- 晚到的 live 封包（屬於已送出的簽名）會被拒收（409），不會把牆面拉回直播狀態。
- 醫師編號（醫師 01、02…）由 server 持久計數，刪除後不會重號；Clear All 後從 01 重新開始。
- final 上牆：簽名直接出現（scale + fade 進場），極光影片 `public/assets/aurora-final.mp4` 播放一次、不循環；影片缺檔或載入失敗時改用 canvas 程序極光。約 7.8 秒後退場模糊並回到跑馬燈。換影片直接覆蓋同名檔案，影片長度變了要一起調 `DISPLAY_DURATION_MS`。
- 牆面計時以 server 時間為準（state 帶 `activeSince` 與 `serverNow`）：電視牆電腦時鐘不準、或中途重新整理，都會接在正確的進度上；展示中刪除其他簽名也不會讓動畫重播。
- 跑馬燈只顯示最新 18 筆（4 排），只在簽名清單變動時重建；完整清單只在控制台（staff token）讀取。
- 簽名持久化到 `data/signatures.json`（含編號計數），server 重啟後自動還原；Clear All 會先備份到 `data/signatures-cleared-<ts>.json`。
- SSE 每 15 秒送一次 ping；頁面 40 秒沒收到任何事件就自動重連（Wi-Fi 半斷線也能恢復）。
- 控制台：Reset / Replay / Blackout / Idle / Clear All、單筆刪除、連線中的電視牆與 iPad 數量、燈光設定、一鍵匯出。
- **一鍵匯出**（控制台「匯出全部簽名（ZIP）」）：在瀏覽器裡產生 `signatures-YYYYMMDD-HHMM.zip`，內含每位醫師一張 `png/doctor-NN.png`（白底黑字，長邊 2000 px）與 `svg/doctor-NN.svg`（透明背景向量），都裁到簽名本身、保持 iPad 上的比例；另附 `index.csv`（編號、醫師、簽名時間、檔名；含 BOM，Excel 直接開不亂碼）和原始 `signatures.json`。實作在 `public/assets/export.js`，不需要額外套件。

## Branding

Logo 素材：`public/assets/nordberg-medical-logo-dark.png`（iPad 淺色介面）、`public/assets/nordberg-medical-logo-light.png`（電視牆深色背景）。兩者由客戶提供的 `CENTRAL Nordberg Medical logo dark` PNG 裁掉透明邊，light 版為同一 alpha 的白色。電視牆上：跑馬燈模式放在中央、上下各兩排簽名；live / final 模式縮小置於簽名下方。位置與大小在 `app.css` 的 `.medical-brand` 調整（單位為 cqw，隨 LED 畫面縮放）。

黑布簾投影（`/curtain`）用 light 版 logo、白色簽名、襯線字 Welcome（Baskerville / Didot / Garamond / Times New Roman，依電腦已安裝字型），尺寸以畫面高度（vh）計算；投影區域比例不同時，用瀏覽器縮放或投影機梯形校正對位。樣式在 `app.css` 的 `.curtain-*`。

## Lighting

簽名流程會自動送燈光訊號：落筆 → `live`、簽完上牆 → `final`（跟 7.8 秒展示同步）、回跑馬燈 → `idle`、blackout → `blackout`。

**訊號種類在 `/control` 控制台直接選**（runtime 切換，存到 `data/lighting-config.json`，重啟保留）：

| 訊號種類 | 行為 | 適用場景 |
|---|---|---|
| **Log（無輸出）** | 只在 console 印 cue | 開發 / 無硬體測試 |
| **OSC 觸發** | 每個 cue 送一則 OSC 訊息（`/signature-wall/cue <name> <intensity>`） | 控台 / TouchDesigner / QLC+ 接手做效果 |
| **Art-Net 觸發** | 把指定 DMX channel 設為 per-cue 觸發值（預設 idle:10 / live:120 / final:200 / blackout:0），250ms keepalive 持續保持 | 控台監聽該 channel，值變化即跑自己的 cue（**觸發式作法，推薦**） |
| **Art-Net 效果串流** | 內建極光效果引擎，30fps 直推 RGB PAR 全頻 DMX | 沒有控台、自己接 Art-Net node 直推燈具 |

Host / port / universe / 觸發 channel / 觸發值 / PAR 數量等都在控制台表單調，按「套用設定」即生效；效果串流模式若「起始 channel + PAR 數量 × 每盞 channel 數」超過 512 會直接拒絕並顯示錯誤。環境變數（`LIGHT_MODE`、`LIGHT_ARTNET_HOST`、`LIGHT_TRIGGER_CHANNEL`...）只當第一次啟動的預設值。

API：`GET /api/lighting` 看狀態、`POST /api/lighting/cue {"cue":"final"}` 手動測試、`POST /api/lighting/config {"mode":"artnet-trigger",...}` 改設定（後兩者需 staff token）。

## Medical Welcome Context

前案：

```text
Projects/scratch-2026-05-25/deliverables/welcome-aurora-animation/
```

該案情境是高端醫學會議迎賓 / 報到空間，不是主舞台。LED 牆約 200 cm x 100 cm，底部約離地 135 cm。平常由多位醫師簽名組成滿版跑馬燈；醫師一落筆，牆面立即切到 live 簽名直播；停筆後 iPad 自動完成，牆面播放 final 上牆動畫，結束後簽名加入跑馬燈。細節見 `medical-welcome-context.md`。

## Next Integration

- 等主視覺進來後，再重做 `/medical-wall` 的背景、亮度、速度與簽名尺寸。
- 決定牆上顯示真實簽名或抽象化筆跡（`privacyMode`），以及活動後簽名的保存 / 刪除方式。
- 到現場後確認燈具 DMX channel mapping（目前假設 RGB / dimmer+RGB 兩種 profile），必要時擴充 `lighting.mjs` 的 fixture profile。
- 若燈控由現場控台接管，改用 OSC driver 把效果交給控台 programmer。
