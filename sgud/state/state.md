# 狀態(現況)

本檔記當前已開發功能之最新狀態(各功能做到哪裡、對應之規則帳本條目與測試檔、已知缺口與待辦、最近一次驗證),**只記現況、不寫過程**(過程寫入 `sgud/exp/experience.md`);藍圖(程式碼須長成什麼樣)在 `sgud/rule/rulebook.md`.接續工作先讀本檔.

- 套件:`w-orm-postgresql`,`package.json` 版本 1.0.36(版本號與發布由主控處理,本檔不記發布).
- 全部測試:`npm test`;各 `api-` 檔自建 docker 容器(`test/tools/pgContainer.mjs` 之 `PORTS` 登錄,埠序號 0–7 已用,8 為空),不動使用者既有容器 `postgresql-worm`、`mssql-worm`.

## 功能現況

| 功能 | 規則帳本 | 測試檔 | 狀態 |
|---|---|---|---|
| find 白名單(wsemi `cvOrmFind` → `lowerFind` IR → knex 建句 + 輸出驗證)、order | R1–R3、R11–R14、R6 | `unit-cvfind`、`unit-sqlbuild`、`unit-irsemantics`、`api-find`、`api-find-whitelist`、`api-matrix` | 完成 |
| 主鍵值(只讀自有屬性)、寫入路徑、DDL/ON CONFLICT/RETURNING 引用 | R5、R7、R9、R10、R8 | `api-write-safety`、`api-postgresql`、`unit-cvwrite` | 完成 |
| 字串良構(孤立代理、NUL;wsemi `chkOrmStr`/`chkOrmData`) | R17 | `unit-wellformed`、`api-wellformed` | 完成 |
| 測試容器與埠 | R15 | `api-container-cleanup` | 完成 |
| **診斷輸出單一出口**(`src/getDiag.mjs`;選項 `logDetail`、`funLog`;預設只輸出標籤與不含個資之摘要;連線憑證遮罩) | **R18**(S26–S28) | `unit-diaglog`、`api-diaglog`(共用 `test/tools/diagScenario.mjs`、`diagGolden.json`) | **pg-run01 完成(2026-10-28),待主控跑全套並發布** |

## R18 診斷輸出現況(第 153 項)

- 實際 console 站點僅 2 處(`WOrmPostgresql.mjs` 的 `emitChange`/`emitError` catch),皆改經 `diag`;預設 `change handler threw { mode, errType, errCode? }`/`error handler threw {…}`;`logDetail:true` 還原為遮罩後之錯誤副本(bare);`funLog(label, safe, detail)` 取代 console.
- 建構函式/連線設定無回顯網址或帳密之站點(未新增 `maskUrl`);以 `unit-diaglog` R18-8、`api-diaglog` R18-5 鎖住現況.
- 回傳契約以修改前 HEAD 產生之 `diagGolden.json` 逐項比對(五種選項組合 × 一般/壞訂閱函數 × 可連線/不可連線).
- README 已含〈Diagnostic output〉與〈Breaking changes (diagnostic output)〉;JSDoc 已含 `opt.logDetail`、`opt.funLog`.

## 已知缺口與待辦

- **待主控裁示**(pg-run01 外審與盤點所得,皆既有行為、屬回傳契約或範圍外,未改):
  1. reject 值與 `error` 事件 payload 含後端/驅動原文與本套件既有回顯(`createTable` 樣本非物件之 `obj[<值>]`、`can not select by find|pk[…]`、`cvFind` 欄名/Proxy 陷阱訊息);畸形網址(密碼含未編碼 `@ / ? #`)時含密碼片段.
  2. `new PgClient` 未掛 `client.on('error')`:連線建立後被後端非同步中斷為未捕捉例外.
  3. `BEGIN/COMMIT/ROLLBACK` 不經 `pgq`:`Object.prototype.name` 資料型汙染 > 63 字元時 pg 當具名查詢並 `console.error`.
- 發布、版本號、全套驗證由主控處理.

## 最近一次驗證

pg-run01(2026-10-28):全套 `npm test` 3695 passing / 610 pending / 0 failing(quiet-run exit=0);`unit-diaglog` 50 案、`api-diaglog` 33 案全綠;eslint 0 error(改動檔);變異 54/56 殺死(餘 2 等價);外審 Argon 24 條(屬實 23、部分 2、誤報 1).證據在 `C:\opensrcOper\dnow\20261028054319\agent-out\pg-run01-evidence\`,報告 `…\pg-run01-修正報告.md`.
