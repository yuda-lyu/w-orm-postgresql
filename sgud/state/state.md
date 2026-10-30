# 狀態(現況)

本檔記當前已開發功能之最新狀態(各功能做到哪裡、對應之規則帳本條目與測試檔、已知缺口與待辦、最近一次驗證),**只記現況、不寫過程**(過程寫入 `sgud/exp/experience.md`);藍圖(程式碼須長成什麼樣)在 `sgud/rule/rulebook.md`.接續工作先讀本檔.

- 套件:`w-orm-postgresql`,`package.json` 版本 1.0.37(版本號與發布由主控處理,本檔不記發布);相依 `wsemi` ≥ 1.9.33(`getDiagBriefErr` 之 `types` 另以建構子名比對,真驅動 `DatabaseError` 才列為 `DatabaseError`).
- 全部測試:`npm test`;各 `api-` 檔自建 docker 容器(`test/tools/pgContainer.mjs` 之 `PORTS` 登錄,埠序號 0–7 已用,8 為空),不動使用者既有容器 `postgresql-worm`、`mssql-worm`.

## 功能現況

| 功能 | 規則帳本 | 測試檔 | 狀態 |
|---|---|---|---|
| find 白名單(wsemi `cvOrmFind` → `lowerFind` IR → knex 建句 + 輸出驗證)、order | R1–R3、R11–R14、R6 | `unit-cvfind`、`unit-sqlbuild`、`unit-irsemantics`、`api-find`、`api-find-whitelist`、`api-matrix` | 完成 |
| 主鍵值(只讀自有屬性)、寫入路徑、DDL/ON CONFLICT/RETURNING 引用 | R5、R7、R9、R10、R8 | `api-write-safety`、`api-postgresql`、`unit-cvwrite` | 完成 |
| 字串良構(孤立代理、NUL;wsemi `chkOrmStr`/`chkOrmData`) | R17 | `unit-wellformed`、`api-wellformed` | 完成 |
| 測試容器與埠 | R15 | `api-container-cleanup` | 完成 |
| **診斷輸出與對外錯誤值遮罩**(wsemi `getDiag`/`getDiagSecrets` 單一擁有,本套件只宣告秘密來源 `opt.url`+連線字串、`codes:['sqlstate']`、`types:['DatabaseError']`、`safeKeys:['mode']`;預設只輸出標籤與摘要,真驅動 `DatabaseError` 之 `errType` 為 `DatabaseError`;reject、`error` 事件之訊息、`save`/`del` 逐筆 `err` 之外來值經驅動接縫 `diag.err` 遮憑證;自身固定詞彙錯誤不遮) | **R18**(S26–S30) | `unit-diaglog`(wsemi 語料 wire 子集接線〔含 C01b:自帶 name 之驅動錯誤〕、選項、單一出口與站點盤點)、`unit-diagerr`(站點矩陣 F1–F6、固定詞彙原樣 O1–O16)、`api-diaglog`(真驅動:PG-R3、後端回顯、`DatabaseError` 類別名嚴格斷言;回傳契約 golden 5 組選項) | **mig-pg 完成(2026-10-29)、第 187 項 a-pg 修正輪完成(2026-10-30),待主控複審與發布** |

## R18 診斷輸出現況(第 153 項、第 161 項)

- `src/getDiag.mjs` 已刪;實際 console 出口只有 wsemi 之 `getDiag`;本套件之 `diag(` 站點 2 處(`emitChange`/`emitError` 之 catch):`change handler threw`、`error handler threw`,safe 為 `{ mode, ...diag.brief(e) }`,預設 stdout `console.log`;`logDetail:true` 輸出 `console.log(label, 遮罩後細節)`;`funLog(label, safe, detail)` 取代 console.
- 驅動呼叫(`new PgClient`、`connect`、`query`、`end`)經 `pgClient`、`pgConnect`、`pgRun`、`pgEnd` 接縫,外來值於接縫經 `diag.err`;`cloneDeep` catch(4 處)與 `createTable` 讀樣本(1 處)為使用端程式拋出之外來值;本套件自身之固定詞彙錯誤不遮.站點全集與處置見規則帳本 R18 站點表(20 列,無空白格).
- 回傳契約:無憑證之值與修改前相同,`diagGolden.json` 未重產且全綠;含憑證者(PG-R3:畸形網址之 `getaddrinfo ENOTFOUND <片段>`、後端回顯等於密碼之資料值)為預期之行為變化,README〈Breaking changes〉已載.
- README 已含〈Diagnostic output (`logDetail`, `funLog`) and error values〉與〈Breaking changes (diagnostic output and error values)〉;JSDoc 已更新.

## 已知缺口與待辦

- **待主控裁示**:
  1. 回顯呼叫端自身輸入之訊息(`createTable` 之 `obj[<值>]`、`can not select by find|pk[…]`、`cvFind`/`cvOrder` 之欄名與使用端 hook 訊息)目前不遮憑證(屬回傳契約,視為自身訊息);是否也須遮,見帳本 R18 已知限制 1.
  2. 既有、範圍外:`new PgClient` 未掛 `client.on('error')`(連線建立後被後端非同步中斷為未捕捉例外);`BEGIN/COMMIT/ROLLBACK` 不經 `pgq`.
- 發布、版本號由主控處理.

## 最近一次驗證

第 187 項 a-pg(2026-10-30):wsemi 1.9.32 → 1.9.33;全套 `npm test` 3775 passing / 610 pending / 0 failing(quiet-run `--lock`,exit=0);新增/收緊之 `DatabaseError` 斷言對 1.9.32 紅(unit 1、api 2)、對 1.9.33 綠,變異 `types: []` 5 案紅;eslint 0 error(改動檔).證據與報告在 `C:\opensrcOper\dnow\20261030184428\agent-out\a-pg-修正報告.md`.

mig-pg(2026-10-29):全套 `npm test` 3773 passing / 610 pending / 0 failing(quiet-run `--lock`,exit=0);`unit-diaglog`+`unit-diagerr` 120 案、`api-diaglog` 41 案全綠;eslint 0 error(改動檔);修前紅:unit 66/120、api 7/41;變異 64/64 殺死(1 個僅盤點掃描殺死,行為等價),api 層(挑 8 個)單獨 5/8.證據在 `C:\opensrcOper\dnow\20261029002013\agent-out\mig-pg-evidence\`,報告 `…\mig-pg-修正報告.md`.
