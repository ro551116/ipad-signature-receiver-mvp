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
| `CONTROL_TOKEN`（staff token） | show-control 端點（`/api/cue/*`、`DELETE /api/signatures/:id`、`POST /api/lighting/*`）＋讀取端點（`GET /api/state`、`GET /api/signatures`、`GET /api/links`、`GET /api/lighting`）＋電視牆、控制台與 MIDI 橋接的 `/events` | 未設定且非 loopback（`127.0.0.1`/`localhost`）時一律回 403（fail-closed）。簽名是個資，不能讓同網路的人直接下載 |
| `SIGN_TOKEN` | 簽名端點（`/api/live-signature`、`/api/live-signature/clear`、`/api/signatures`）＋ iPad 的 `/events?role=sign` | 未設定時維持開放（MVP 預設），但非 loopback 啟動會印警告：任何連上 Wi-Fi 的人都能在牆上即時畫。設定後 iPad 要用帶 token 的 `/sign` 連結開啟 |
| `ALLOW_UNSAFE_NO_CONTROL_TOKEN=1` | 明確選擇不設 `CONTROL_TOKEN` 也開放上述 staff 端點（例如純內網快速測試） | 等同 fail-open，**不建議用在真實活動** |

**怎麼開頁面**：先開 `/control?token=<CONTROL_TOKEN>`，再用控制台的 Quick Links「開啟 / 複製連結」。連結由 server 產生，電視牆連結帶 staff token、簽名頁連結帶 `SIGN_TOKEN`。token 開過一次會存在該分頁的 sessionStorage；kiosk 模式建議直接把含 token 的完整網址設為開機頁。

**互動式輸入**：沒設 `CONTROL_TOKEN` 環境變數、且 `npm start` 在真實終端機（TTY）執行時，啟動會跳出 `Set CONTROL_TOKEN for /control and the walls:` 提示，直接按 Enter 沿用上次存的 token（存在 `data/control-token`，已 gitignore）；systemd / CI / 非互動環境跳過提示，直接走 fail-closed。

## Pages

- `/sign` — iPad 簽名端（Nordberg Medical logo 置頂）
- `/medical-wall` — 醫師迎賓牆（主要畫面）：滿版簽名跑馬燈＋中央品牌 logo、live 簽名直播、final 上牆動畫與極光背景
- `/curtain` — 入口黑布簾投影（依活動示意圖）：純黑底，由上而下是 logo、簽名、Welcome。沒人簽時只有 logo＋Welcome（中間留空）；醫師落筆後簽名直接寫在中間，送出後滑到正中並放大填滿簽名區，展示時間結束後淡出
- `/wall` — 簡易電視牆（只顯示 final 簽名描線，除錯 / 備援用）
- `/control` — 工作人員控制台（含燈光輸出設定）
- `/midi-bridge` — MIDI 橋接：要送 MIDI 時，在 server 這台電腦用 Chrome / Edge 開著（`http://localhost`），把燈光 cue 從這台電腦的 MIDI 介面送出

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

這套系統只送「cue 訊號」給燈光控台或 show control 軟體，燈怎麼亮由控台上的 cue 決定。四個 cue 跟著簽名流程走：落筆 → `live`、簽完上牆 → `final`、回待機 → `idle`、牆面 Blackout → `blackout`。server 正常關閉（Ctrl+C / SIGTERM）時會先送一次 `idle` 再停。

### 輸出種類

在 `/control` 的 Lighting 區按「＋」新增輸出；同一種可以加很多個，全部同時送（例如 OSC 給主控台、Art-Net 給備援、HTTP 給 Companion）。每個輸出四行，一個 cue 一行，打字時右邊即時顯示會送出什麼，打錯會標紅、不能儲存。

| 種類 | 設定 | 每個 cue 填什麼（多條用 `;` 分隔，留空不送） |
|---|---|---|
| **OSC** | IP、Port、傳輸：UDP／TCP（OSC 1.1 SLIP）／TCP（OSC 1.0 長度前綴） | OSC 位址＋參數：數字 = float、`"文字"` = string、`i:100` = int、`f:0.5` = float。例：ETC Eos `/eos/cue/1/3/fire`、grandMA3 `/gma3/cmd "Go+ Sequence 3"`、MagicQ `/pb/1/go`、grandMA3 推桿 `/Page1/Fader201 i:100` |
| **Art-Net** | IP、Port、Universe（從 0 起算） | `channel@值`，多組用逗號：`3@255`；同一個 channel 用不同值區分 cue 也行：`1@200`。目前的 cue 送它的值，其他 cue 用到的 channel 送 0，每 250ms 重送 |
| **sACN（E1.31）** | Universe（1–63999）、Priority、目標 IP（空白 = multicast 239.255.x.x）、送出網卡 IP | 同 Art-Net |
| **MIDI** | MIDI 輸出埠（名稱包含即可；空白 = 第一個）、MSC Device ID（127 = 全部）、MSC Command Format（1 = Lighting） | `msc go 3`（可再接 list、path）、`msc stop`、`msc resume`、`msc fire 5`、`msc all_off`、`note 1 60 127`（自動補 Note Off）、`noteoff 1 60`、`pc 1 5`、`cc 1 20 127`、`hex F0 7F …` |
| **UDP / TCP 文字** | IP、Port、傳輸 UDP／TCP、結尾（不加 / `\r` / `\n` / `\r\n`） | 一行文字指令，可用 `\r` `\n` `\t` `\xHH`（文字裡的 `;` 寫成 `\x3B`） |
| **HTTP** | Base URL（cue 填 `/路徑` 時套用） | `[GET\|POST\|PUT\|PATCH\|DELETE] 網址或 /路徑 [內容]`，預設 GET。例：`POST /api/location/1/0/1/press`（Bitfocus Companion） |

OSC、MIDI、文字、HTTP 是「動作」：cue 開始時送一次、不重送。Art-Net、sACN 是「狀態」：一直送目前 cue 的 channel 值。

**MIDI 怎麼送**：server 本身不碰 MIDI 硬體。在 server 這台電腦用 Chrome / Edge 開控制台 Quick Links 的「MIDI 橋接」（`http://localhost:<port>/midi-bridge`，Web MIDI 只在 localhost / HTTPS 開放），允許 MIDI（含 SysEx，MSC 需要），頁面開著就會把 cue 從 USB MIDI 介面、macOS IAC Bus 或網路 MIDI（rtpMIDI）送出。橋接頁看到的輸出埠會出現在控制台 MIDI 輸出的下拉提示；沒有橋接頁連線時，那個 MIDI 輸出會顯示錯誤。

### 改參數

- **控制台表單**：每個輸出一張卡片，可改名稱、啟用 / 停用、刪除；每個 cue 旁邊的「送出」只對那個輸出送那個 cue（要先儲存）。下方 Test 按鈕送到所有啟用的輸出。卡片下面顯示已送次數、最後送出時間和錯誤（送成功一次就清掉）。
- **JSON**：Lighting 區最下面「進階：用 JSON 編輯全部設定」可以一次改很多、複製到別台電腦，按「套用並儲存 JSON」生效。
- **設定檔**：存在 `data/lighting-config.json`（`{ "outputs": [...] }`，格式同上面的 JSON）。server 停著時也可以直接改檔，下次啟動載入；有問題的輸出會照樣載入但不送，錯誤顯示在控制台。
- 儲存時會擋下送不到的設定：啟用的輸出沒填 IP / Port、填了 `255.255.255.255`、cue 行看不懂。停用的輸出可以先存草稿。

### 現場對控台前確認

- 填控台（或轉換器）的 IP。要廣播就用燈光網段的廣播位址（例如 `2.255.255.255`）；`255.255.255.255` 在電腦有多張網卡時會從預設網卡（通常是 Wi-Fi）出去，控台收不到，所以不接受。sACN multicast 走燈光網路時，填「送出網卡 IP」。
- 電腦接燈光網路的網卡要和控台同網段、同 netmask（Art-Net 設備常見預設 2.x.x.x / 255.0.0.0）。
- Art-Net：universe 填原始編號（從 0 起算，很多控台畫面上的「Universe 1」就是 0）；送 cue 的 universe 要專用，因為 ArtDmx 從 channel 1 開始，前面的 channel 也會送成 0。
- UDP 送的動作（OSC、文字）每次只送一包，建議走有線網路，或改用 TCP；切完 cue 在控台上確認有跑。
- 「已送 N 次」只代表這台電腦送出去了（UDP 沒有回應），控台有沒有收到要看控台；HTTP 和 MIDI 會回報實際成功與否。

API（需 staff token）：`GET /api/lighting` 看設定與各輸出狀態、`POST /api/lighting/cue {"cue":"final","outputId":"…"}` 手動送 cue（不帶 `outputId` = 全部）、`POST /api/lighting/config {"outputs":[…]}` 換整份設定。

## Medical Welcome Context

前案：

```text
Projects/scratch-2026-05-25/deliverables/welcome-aurora-animation/
```

該案情境是高端醫學會議迎賓 / 報到空間，不是主舞台。LED 牆約 200 cm x 100 cm，底部約離地 135 cm。平常由多位醫師簽名組成滿版跑馬燈；醫師一落筆，牆面立即切到 live 簽名直播；停筆後 iPad 自動完成，牆面播放 final 上牆動畫，結束後簽名加入跑馬燈。細節見 `medical-welcome-context.md`。

## Next Integration

- 等主視覺進來後，再重做 `/medical-wall` 的背景、亮度、速度與簽名尺寸。
- 決定牆上顯示真實簽名或抽象化筆跡（`privacyMode`），以及活動後簽名的保存 / 刪除方式。
- 和燈光團隊確認控台型號與接法（OSC 指令或 Art-Net DMX Remote），把四個 cue 對到控台上的 cue，現場用控制台 Test 按鈕逐一驗證。
