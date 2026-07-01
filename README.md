# iPad Signature Receiver MVP

第一版 prototype：先驗證 iPad 簽名能否穩定送到電腦，並在電腦電視牆頁面即時顯示。

> 原始開發脈絡在私人 vault 的 `Projects/scratch-2026-05-31/deliverables/ipad-signature-receiver-mvp/`，此 repo 為獨立出來的可部署版本。

## Run

```bash
npm start
```

無外部套件依賴，僅用 Node.js 內建模組。

Server 預設跑在 `0.0.0.0:3000`。

## Pages

- `/sign` — iPad 簽名端
- `/wall` — 電視牆顯示端
- `/medical-wall` — 醫師迎賓空間版本：滿版簽名跑馬燈、即時直播簽名畫面、完成後上牆動畫、極光背板
- `/control` — 工作人員控制台

## MVP Scope

- iPad Canvas 簽名
- 以 normalized stroke points 傳送簽名，不只傳 PNG
- 支援多位醫師依序簽名；不需要輸入醫師名稱或編號，server 會自動編號
- Node.js server 接收即時簽名直播與完成簽名
- Server 以記憶體保留多筆簽名，`reset` 不刪除保留簽名
- SSE 即時廣播給 wall/control；iPad 每個 animation frame 推送最新筆跡，落筆時不需確認即可直播到 `/medical-wall`
- 醫師牆端三段模式：滿版跑馬燈 -> live 簽名直播 -> final 上牆動畫
- final 上牆動畫**依書寫順序逐筆重播**（每一筆獨立 path、按筆畫長度分配時間，含 pen-lift 間隔），不會所有筆畫同時出現
- final 退場模糊由 JS 依實際畫完時間排程：**整個簽名畫完並停留後才開始模糊退場**，不會中途糊掉
- 極光三層架構：CSS 絲帶層為常駐背景；final 簽名播放時優先播放**生成影片背景**（`public/assets/aurora-final.mp4`，Google Flow 生成、object-fit cover、自動 loop 與淡入淡出）；影片缺檔或載入失敗時自動 fallback 到 canvas 程序極光（大弧度光帶 + 星點 + 反光）。換影片直接覆蓋同名檔案即可
- 控制台可刪除單筆保留簽名（`DELETE /api/signatures/:id`）
- 停筆約 1.3 秒後 iPad 自動完成簽名；final 展示約 9.5 秒後回到滿版跑馬燈
- Reset / Replay / Blackout / Idle / Clear All Signatures 控制
- 簽名持久化到 `data/signatures.json`，server 重啟後跑馬燈牆自動還原
- 燈光 cue bridge（`lighting.mjs`）：簽名事件自動觸發 `live / final / idle / blackout` 燈光 cue，支援 Art-Net DMX 直推 PAR 燈與 OSC 送燈控台

## Lighting

簽名流程會自動送燈光訊號：落筆 → `live`、簽完上牆 → `final`（跟 9.5 秒展示同步）、回跑馬燈 → `idle`、blackout → `blackout`。

**訊號種類在 `/control` 控制台直接選**（runtime 切換，存到 `data/lighting-config.json`，重啟保留）：

| 訊號種類 | 行為 | 適用場景 |
|---|---|---|
| **Log（無輸出）** | 只在 console 印 cue | 開發 / 無硬體測試 |
| **OSC 觸發** | 每個 cue 送一則 OSC 訊息（`/signature-wall/cue <name> <intensity>`） | 控台 / TouchDesigner / QLC+ 接手做效果 |
| **Art-Net 觸發** | 把指定 DMX channel 設為 per-cue 觸發值（預設 idle:10 / live:120 / final:200 / blackout:0），250ms keepalive 持續保持 | 控台監聽該 channel，值變化即跑自己的 cue（**觸發式作法，推薦**） |
| **Art-Net 效果串流** | 內建極光效果引擎，30fps 直推 RGB PAR 全頻 DMX | 沒有控台、自己接 Art-Net node 直推燈具 |

Host / port / universe / 觸發 channel / 觸發值 / PAR 數量等都在控制台表單調，按「套用設定」即生效。環境變數（`LIGHT_MODE`、`LIGHT_ARTNET_HOST`、`LIGHT_TRIGGER_CHANNEL`...）只當第一次啟動的預設值。

API：`GET /api/lighting` 看狀態、`POST /api/lighting/cue {"cue":"final"}` 手動測試、`POST /api/lighting/config {"mode":"artnet-trigger",...}` 改設定。

## Medical Welcome Context

我找到前案：

```text
Projects/scratch-2026-05-25/deliverables/welcome-aurora-animation/
```

該案情境是高端醫學會議迎賓 / 報到空間，不是主舞台。LED 牆約 200 cm x 100 cm，底部約離地 135 cm。這一版先回到基礎流程：平常由多位醫師簽名組成滿版跑馬燈；醫師一落筆，牆面立即切到 live 簽名直播；停筆後 iPad 自動完成，牆面播放 final 上牆動畫，結束後簽名加入滿版跑馬燈。

LED PAR 燈光已接上：`signature:submitted` / `cue:auto-idle` 等事件對應 Art-Net / OSC cue（見上方 Lighting 章節）。

## Next Integration

剩餘的下一階段工作：

- 等主視覺進來後，再重做 `/medical-wall` 的背景、亮度、速度與簽名尺寸。
- 到現場後確認燈具 DMX channel mapping（目前假設 RGB / dimmer+RGB 兩種 profile），必要時擴充 `lighting.mjs` 的 fixture profile。
- 若燈控由現場控台接管，改用 OSC driver 把效果交給控台 programmer。
