# 回饋(任務中發現之調整與抽提提案)

只增不改,一條一列;處置結果另記一列.欄位:日期、類別、對象、內容、依據.

| 日期 | 類別 | 對象 | 內容 | 依據 |
|---|---|---|---|---|
| 2026-11-20 | 全域設定(派工共同規則,對齊條款 A3) | `align-rules.md` A3 之「複製處」 | A3 未提醒「複製處」可能不只一處:寫入入口於第 1 份複本之後常再複製一份檢核複本(本庫之 `checkData`、`save` 逐筆檢核),第 1 份複製成功而第 2 份於較深堆疊再複製時,過深巢狀(窄窗,非確定)或原型有狀態存取器會讓原文字外洩.建議對齊條款加一句「各庫盤點 `cloneDeep`/展開之全部站點,含檢核用之第二份複本」,他庫(mdb、reladb 等)可 `rg "cloneDeep\(" src` 逐一核對 | `src/WOrmPostgresql.mjs` `checkData`、`save` 逐筆檢核(改走 `cloneInput`);`test/unit-readable-align.test.mjs` 〈the second copy…〉;複審(sonnet)實測 |
| 2026-11-20 | 自有套件(wsemi) | `chkReadable` 之 `{ ownKeys: true }` | 只讀字串鍵之描述子,symbol 鍵之 `getOwnPropertyDescriptor` 陷阱拋錯不被涵蓋(`ownKeys` 陷阱多回 symbol 鍵者);本庫之 `cvOrder` 因此改由 catch 對非本模組之錯誤一律轉固定詞彙.建議 `chkReadable` 之 `ownKeys` 選項亦讀 symbol 鍵之描述子(或另給選項),使各庫探針可涵蓋 | `src/cvFind.mjs` `readOwn`、`cvOrder` 之 catch;`test/unit-readable-align.test.mjs` 〈A2 order…〉 |
| 2026-11-20 | 全域技能(派工任務書範本) | 對齊輪之「主控已知之不合」清單 | 清單稱「save 之 option 為 `ownKeys` 拋錯之 Proxy 時 reject 原例外文字(第一輪表 B 第三欄)」,實測該 Proxy 可讀而無錯,該欄夾具實為 `option.autoInsert` 存取器;預判轉述時易誤讀表欄.建議主控預判附夾具名(或 probe 之輸入標籤),執行者仍須逐代號實測校正(本輪已做) | `tmp/oro557e2/probe.mjs` A1 組 15 格;報告〈結論〉第 1 點 |
| 2026-11-20 | 全域設定(派工共同規則) | 第 557 項共同規則一(`common-rules.md`) | 規則一「給了而非字串即拒絕」之前提是字串 id 型 ORM 之 `autoGenPk` 靜默換值;型別化後端(本套件、w-orm-mdb 等,主鍵欄位為 INTEGER/BOOLEAN/TIMESTAMPTZ,number、boolean、真 Date 為有效主鍵且文件與測試皆如此)不適用,字面照做會使型別化主鍵全廢.建議共同規則一註明適用面(字串 id 型)與型別化後端之處置(只核實「給了而無效者全拒、有效型別原樣」),或由主控逐庫裁示 | `sgud/rule/rulebook.md` R19 規則 6;`README.md` 〈Inputs that cannot be read〉;`C:\opensrcOper\dnow\20261120043625\common-rules.md` 規則一 |
| 2026-11-20 | 全域技能 | role-coder-for-test | 失敗斷言之 `actual`/`expected` 若是已撤銷之 Proxy 等不可讀值,mocha 報告器 `util.inspect` 拋錯而崩潰,輸出截斷、離開碼可為 0(對變異驗證即為假「存活」).建議於測試規範補一條:斷言不可讀值相關之條件時用 `assert.ok(條件, 訊息)`,不把不可讀值作為 `strictEqual`/`deepStrictEqual` 之 actual | `tmp/oro557e/mut.mjs` 之 E18 首輪(`fail=0 pass=0` 但輸出截斷於 createTable 組);`sgud/exp/experience.md` 第 557 項 |
| 2026-11-20 | 自有套件(wsemi) | `chkReadable` 之 `ownKeys` | 沿用主控已知之批 10 待修(對型別陣列、Buffer 亦列舉全部索引);本套件以「標籤為 `[object Object]` 才加 `ownKeys`」繞過(`isUnreadableData`、`isUnreadableOrder`),批 10 修正後可評估改回 `{ ownKeys: true }` 一律給 | `src/WOrmPostgresql.mjs` `isUnreadableData`;`test/unit-readable-probe.test.mjs` 〈the own-keys probe…〉 |
| 2026-11-19 | 全域技能(派工提示詞範本) | 派工共通守則之 `decision-log.mjs` 指令範例 | 範例之任務資料夾以反斜線路徑書寫;於 Git Bash 下反斜線被當跳脫字元吞掉(路徑變成無分隔之字串),指令回 `任務資料夾不存在` 而失敗一次.建議範例改用正斜線(`C:/…`),或註明須加引號/雙反斜線 | 實際執行回傳 `FAILED 任務資料夾不存在`,改正斜線後 `LOGGED` |
