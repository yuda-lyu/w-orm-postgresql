# 狀態(現況)

本檔記當前已開發功能之最新狀態(各功能做到哪裡、對應之規則帳本條目與測試檔、已知缺口與待辦、最近一次驗證),**只記現況、不寫過程**(過程寫入 `sgud/exp/experience.md`);藍圖(程式碼須長成什麼樣)在 `sgud/rule/rulebook.md`.接續工作先讀本檔.

- 套件:`w-orm-postgresql`,`package.json` 版本 1.0.37(版本號與發布由主控處理,本檔不記發布);相依 `wsemi` ≥ 1.9.33(`getDiagBriefErr` 之 `types` 另以建構子名比對,真驅動 `DatabaseError` 才列為 `DatabaseError`);`package.json` 已升 `^1.9.69`(2026-11-19,W-20:判斷函數只收原始值,字串包裝物件作 `opt.url|db|cl` 與 `5`、`{}`、`''` 同視為未給取預設、不拋錯,見規則帳本 R17 站點表第 1 列與已知限制 2;`unit-wellformed` 斷言實際採用預設).
- 全部測試:`npm test`;各 `api-` 檔自建 docker 容器(`test/tools/pgContainer.mjs` 之 `PORTS` 登錄,埠序號 0–8 已全用〔8 為 `worm-test-pg-clienterr`〕,再增須擴 `PORT_COUNT`),不動使用者既有容器 `postgresql-worm`、`mssql-worm`.

## 功能現況

| 功能 | 規則帳本 | 測試檔 | 狀態 |
|---|---|---|---|
| find 白名單(wsemi `cvOrmFind` → `lowerFind` IR → knex 建句 + 輸出驗證)、order | R1–R3、R11–R14、R6 | `unit-cvfind`、`unit-sqlbuild`、`unit-irsemantics`、`api-find`、`api-find-whitelist`、`api-matrix` | 完成 |
| 主鍵值(只讀自有屬性)、寫入路徑、DDL/ON CONFLICT/RETURNING 引用 | R5、R7、R9、R10、R8 | `api-write-safety`、`api-postgresql`、`unit-cvwrite` | 完成 |
| 字串良構(孤立代理、NUL;wsemi `chkOrmStr`/`chkOrmData`) | R17 | `unit-wellformed`、`api-wellformed` | 完成 |
| 測試容器與埠 | R15 | `api-container-cleanup` | 完成 |
| **連線中斷之吸收與交易語句經 `pgq`**(第 162 項:`pgClient(mode)` 建立 client 即掛 `error` 監聽,吸收後經 `diag('client error', { mode, ...diag.brief(e) })` 輸出安全摘要,該次操作以驅動令其後語句 reject 之既有失敗通道回報;`insertBatches` 之 `BEGIN/COMMIT/ROLLBACK` 改 `pgq(…, [])`) | R18 站點 19、R8 | `unit-clienterr`(C1–C4,假驅動)、`api-clienterr`(真後端 + 獨立子行程)、`api-write-safety`(汙染情境 4 案、無字串語句)、`unit-diaglog`(`diag(` 站點恰 3) | **完成(2026-10-31),待主控複審與發布**;README〈Breaking changes (connection interruption, transaction statements)〉已載 |
| **讀取即拋錯之輸入依原失敗通道拒絕;主鍵給了而無效之處置**(第 557 項,2026-11-20;wsemi `chkReadable`〔wsemi ≥ 1.9.70〕:資料容器〔insert/insertBulk/save/del 之 data、createTable 樣本〕、option 與 `option.returnList`、selectByPk 之 pk、order、createTable 之 `cl`/`pk` 引數、建構 opt 與成員,判斷函數回 false 後探針;不可讀者寫入入口與 selectByPk 為 error 事件恰一次〔data 為 null〕後 reject、建構為同步 throw,訊息 `invalid <名稱>: must be a readable value`;可讀而型別不符者不變;型別化主鍵〔number、boolean、真 Date〕照舊有效。**對齊輪(oro557e2,同日)**:A2 存取器拋錯〔建構 `opt.<鍵>`、`option.returnList|autoInsert`、createTable 樣本之成員與陣列 `[0]`〕、A3 複製階段之巢狀不可讀值〔含第 2 份檢核複本;`cloneInput` 單一擁有者〕、`order` 之 symbol 鍵描述子拋錯,一律轉固定詞彙不轉出拋出者之文字;A4 error 事件 `data` 為 null 由 `emitError` 單點判定〔`mkReadErr`/`isReadErr`〕;A1、A5、A6 修前已合,以測試釘住) | R19(S31–S42)、R18 站點 7、8、21(`diag.err` 4、`Promise.reject` 25) | `unit-readable-probe`、`unit-readable-align`(A1~A6)、`unit-pk-given`、`unit-diaglog`(站點計數)、`unit-diagerr`(F5、F6)、`api-write-safety`〈S5〉〈R19〉 | **完成(2026-11-20),待主控複審與發布**;規則一(給了而非字串即拒絕)對本套件之型別化主鍵不適用,主控已裁維持(07:0x,共同規則一第 6 點) |
| **診斷輸出與對外錯誤值遮罩**(wsemi `getDiag`/`getDiagSecrets` 單一擁有,本套件只宣告秘密來源 `opt.url`+連線字串、`codes:['sqlstate']`、`types:['DatabaseError']`、`safeKeys:['mode']`;預設只輸出標籤與摘要,真驅動 `DatabaseError` 之 `errType` 為 `DatabaseError`;reject、`error` 事件之訊息、`save`/`del` 逐筆 `err` 之外來值經驅動接縫 `diag.err` 遮憑證;自身固定詞彙錯誤不遮) | **R18**(S26–S30) | `unit-diaglog`(wsemi 語料 wire 子集接線〔含 C01b:自帶 name 之驅動錯誤〕、選項、單一出口與站點盤點)、`unit-diagerr`(站點矩陣 F1–F6、固定詞彙原樣 O1–O16)、`api-diaglog`(真驅動:PG-R3、後端回顯、`DatabaseError` 類別名嚴格斷言;回傳契約 golden 5 組選項) | **mig-pg 完成(2026-10-29)、第 187 項 a-pg 修正輪完成(2026-10-30),待主控複審與發布** |

## R18 診斷輸出現況(第 153 項、第 161 項)

- `src/getDiag.mjs` 已刪;實際 console 出口只有 wsemi 之 `getDiag`;本套件之 `diag(` 站點 2 處(`emitChange`/`emitError` 之 catch):`change handler threw`、`error handler threw`,safe 為 `{ mode, ...diag.brief(e) }`,預設 stdout `console.log`;`logDetail:true` 輸出 `console.log(label, 遮罩後細節)`;`funLog(label, safe, detail)` 取代 console.
- 驅動呼叫(`new PgClient`、`connect`、`query`、`end`)經 `pgClient`、`pgConnect`、`pgRun`、`pgEnd` 接縫,外來值於接縫經 `diag.err`;`cloneDeep` catch(4 處)與 `createTable` 讀樣本(1 處)為使用端程式拋出之外來值;本套件自身之固定詞彙錯誤不遮.站點全集與處置見規則帳本 R18 站點表(20 列,無空白格).
- 回傳契約:無憑證之值與修改前相同,`diagGolden.json` 未重產且全綠;含憑證者(PG-R3:畸形網址之 `getaddrinfo ENOTFOUND <片段>`、後端回顯等於密碼之資料值)為預期之行為變化,README〈Breaking changes〉已載.
- README 已含〈Diagnostic output (`logDetail`, `funLog`) and error values〉與〈Breaking changes (diagnostic output and error values)〉;JSDoc 已更新.

## 已知缺口與待辦

- **待主控裁示**:
  1. 回顯呼叫端自身輸入之訊息(`createTable` 之 `obj[<值>]`、`can not select by find|pk[…]`、`cvFind`/`cvOrder` 之欄名與使用端 hook 訊息)目前不遮憑證(屬回傳契約,視為自身訊息);是否也須遮,見帳本 R18 已知限制 1.
  (原第 2 點〔`client.on('error')` 未掛、`BEGIN/COMMIT/ROLLBACK` 不經 `pgq`〕已於第 162 項解決.)
- **第 557 項之裁示與待裁示**:
  1. 〔主控已裁:維持〕共同規則一「給了而非字串即拒絕」:本套件無 `autoGenPk`、主鍵欄位型別化,number(非 NaN)、boolean、真 Date 為有效主鍵(README、R5、`api-matrix`),給了而無效者本就全拒(`unsupported primary key value`),故只核實並釘住,未改為「非字串一律拒絕」(改則型別化主鍵全廢);詳見帳本 R19 規則 6.
  2. 〔主控已裁:沿用,第 560 項另議〕`find` 不可讀之訊息沿用 wsemi `cvOrmFind`(`invalid find: an exception was thrown while reading the condition at [find]`),與 `must be a readable value` 措辭不同;`option.autoInsert` 之值不經判斷函數,不探針.
  3. 〔待主控裁示〕A4 之範圍:`createTable` 讀取**可讀而無效**之引數(表名不合、主鍵名不合、欄名不合、樣本非有效物件如 `5`)之整批拒絕,error 事件 `data` 仍為呼叫端給的 `arr`(僅「不可讀」者為 `null`;與 w-orm-lowdb 參考實作 `isReadErr ? null : data` 同形);若須「入口階段一律 null」須另裁(會改既有釘住之 `unit-readable-probe` 〈readable but not a valid sample〉).帳本 R19 已知限制 3、S40.
- 第 162 項之已知限制:驅動只在無進行中語句時於 client 發 `error` 事件(有進行中語句時錯誤交給該語句,本來就不崩潰);監聽輸出走 stdout(與既有二站一致,無 stderr 站),依賴 stderr 內容或「崩潰後由監督程式重啟」之使用端行為會改變(README 已載).
- 發布、版本號由主控處理.

## 最近一次驗證

第 557 項對齊輪 oro557e2(2026-11-20):wsemi 1.9.70;全套 `npm test` 4218 passing / 610 pending / 0 failing(quiet-run `--lock`,exit=0;較 oro557e 之 4071 增 147 案:`unit-readable-align` 144、`unit-readable-probe` 2、`api-write-safety` 1);同一探針 329 格,修前(工作樹快照)對修後 83 格不同(A2 19、A3 64),A1、A4、A5、A6 全部不變(已合);修前紅 114 案(快照 `src` 搭現行測試);變異 67 項 65 殺死、2 等價存活(E22、E11b);eslint 0 error(改動檔);L0e 掃描必修 0、待判讀 0.證據與報告在 `C:\opensrcOper\dnow\20261120043625\agent-out\oro557e2-修正報告.md`.

第 557 項 oro557e(2026-11-20):wsemi 1.9.70;全套 `npm test` 4071 passing / 610 pending / 0 failing(quiet-run `--lock`,exit=0;較前 3833 增 238 案:`unit-pk-given` 與 `unit-readable-probe` 共 234、`api-write-safety` 〈R19〉 4);修前紅(新測試跑於 HEAD 之 `src`):`unit-readable-probe` 58/113 案紅、`api-write-safety` 〈R19〉 2/4 紅、`unit-pk-given` 0/121 紅(規則一原已合規,釘住用);變異 36 個(規則一 9、規則二 27)35 殺死、1 等價存活(E22);eslint 0 error(改動檔);private-guard CLEAN.證據與報告在 `C:\opensrcOper\dnow\20261120043625\agent-out\oro557e-修正報告.md`.

第 162 項 pg(2026-10-31):自有相依(wsemi 1.9.33、w-package-tools)已為最新;全套 `npm test` 3833 passing / 610 pending / 0 failing(quiet-run `--lock`,exit=0;較前一次 3775 增 58 案:unit-clienterr 32、api-clienterr 22、汙染 4);修前紅(HEAD 版 src)四檔 48 案紅;變異 11/11 殺死;eslint 0 error(改動檔).證據與報告在 `C:\opensrcOper\dnow\20261031065406\agent-out\pg-修正報告.md`.

第 187 項 a-pg(2026-10-30):wsemi 1.9.32 → 1.9.33;全套 `npm test` 3775 passing / 610 pending / 0 failing(quiet-run `--lock`,exit=0);新增/收緊之 `DatabaseError` 斷言對 1.9.32 紅(unit 1、api 2)、對 1.9.33 綠,變異 `types: []` 5 案紅;eslint 0 error(改動檔).證據與報告在 `C:\opensrcOper\dnow\20261030184428\agent-out\a-pg-修正報告.md`.

mig-pg(2026-10-29):全套 `npm test` 3773 passing / 610 pending / 0 failing(quiet-run `--lock`,exit=0);`unit-diaglog`+`unit-diagerr` 120 案、`api-diaglog` 41 案全綠;eslint 0 error(改動檔);修前紅:unit 66/120、api 7/41;變異 64/64 殺死(1 個僅盤點掃描殺死,行為等價),api 層(挑 8 個)單獨 5/8.證據在 `C:\opensrcOper\dnow\20261029002013\agent-out\mig-pg-evidence\`,報告 `…\mig-pg-修正報告.md`.
