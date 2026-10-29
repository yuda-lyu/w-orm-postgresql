# 規則帳本

本檔為套件設計與開發階段之規則帳本,為要求程式碼須長成什麼樣,或由規格產出之測試(項目/說明/流程)有哪些,包含軸、單一擁有者、已知限制、破壞性變更紀錄,以及對應是哪些測試檔案或指令等,由agent自行編列、擴充與維護.

- 規格來源:`C:\opensrcOper\dspec\w-orm系列條件語法支援盤點.md` §一.2(系列最低要求①②③)與〈一之一〉〈一之三〉(系列條件白名單,第 33 項);審計 run01 `C:\opensrcOper\dnow\20261016211321\agent-out\run01-審計回應.md`(下稱「審計」);主控複審 `review\run01-複審.md`(Q1–Q10 裁示);第 33 項全系列審計與方案 `C:\opensrcOper\dnow\20261017093849\agent-out\run01-審計與方案.md`(下稱「方案」)與其複審 `review\run01-複審.md`(D1–D13 裁示);接線任務 `C:\opensrcOper\dnow\20261019163524\task.md`(批 1);第 66 項批 1e(字串良構):任務 `C:\opensrcOper\dnow\20261020172106\task.md`,審計 `…\agent-out\run01-系列審計回應.md`,wsemi 批 0 報告 `…\agent-out\wsemi-run01-修正報告.md`,本批報告 `…\agent-out\批1-postgresql-修正報告.md`(R17). 第 58、76 項(knex 取代 mongo-sql、欄名解析 fail-closed):任務 `C:\opensrcOper\dnow\20261020084203\task.md`,run01 審計與方案 `…\agent-out\run01-審計與方案.md`,主控複審 `…\review\run01-複審.md`(R1–R13 裁示,本帳本 R12–R16 為其落地).
- 全部測試:`npm test`(`mocha --parallel "test/*.test.mjs" --timeout 180000`;各 api- 檔自建 docker 容器,容器名與對外埠固定登錄於 `test/tools/pgContainer.mjs` 之 `PORTS` 表(8451–8459,綁 127.0.0.1,見 R15),測畢以 `docker rm -f -v` 銷毀,需 docker daemon).單檔:`npx mocha test/<檔> --timeout 180000`.純函數測試(`unit-*`)不需 docker.
- 規格句編號(測試以此標註):
  - S1 同一 find 於 select 命中之數據,即 delAll 刪除之數據.
  - S2 不支援之運算子與無法轉譯之值必須 reject(整批性錯誤),不得靜默忽略、改變語意或擴大刪除範圍.
  - S3 恆真恆假須明確,不得因條件清單恰為空或某值為 `undefined` 而成為刪全表(`{}` 或未給 find 刻意為全部者除外).
  - S4 受支援運算子之既有語意不變.
  - S5 reject 時資料不變,於 reject 前發 1 次 `error` 事件,reject 之值為 `Error` 且訊息含 `invalid find`(order 為 `invalid order`).
  - S6 以主鍵值構成之條件(selectByPk、del、save)不得因主鍵值為 `$..$` 字串而命中全部:`$..$` 字串為**一般字面值**(綁定參數),作用於「該字面主鍵之列」(text 主鍵表),於其他主鍵型別為與一般字串相同之型別錯(run02,R4,C11).
  - S7 order 僅接受 `asc|desc`(可接 `nulls first|last`).
  - S8 useCache 下檢核不被快取繞過;快取鍵不因不同型別之值而混同.
  - W1 insert、insertBulk、save 之值(含物件、帶 `type` 屬性之物件/Date/陣列/Buffer)一律以綁定參數寫入(物件由 pg 序列化為 JSON),不被當成子查詢,不得跨表讀取.
  - W2 `save(…,{autoInsert:false})` 之 UPDATE 以綁定參數寫入字面值(`$..$` 字串、資料鍵 `$inc/$dec/$custom` 不得生效);非識別字之欄名鍵整批 reject.
  - W3 包裝物件(`Object(5)` 等)、非 Date 物件、含 NUL 或孤立代理字元之字串為無效主鍵值;Date 主鍵以內部槽重建(`cleanPk`)後才組成條件.首尾皆 `$` 之字串**不再是**無效主鍵值(S6、R4).
  - W4 `createTable` 之欄名鍵、主鍵名須為識別字,表名須為「經 `quoteTable` 引用後僅由雙引號識別字構成」者;不合者於送出任何語句之前整批 reject(訊息不回顯該值);DDL 以雙引號引用表名與欄名(與 INSERT/UPDATE/find 一致),並經 `pgq`(extended 協定)送出,不可堆疊第二語句.
  - W5 `save`(autoInsert:true)之 `ON CONFLICT … DO UPDATE SET` 僅含「在 INSERT 欄單中(值非 `undefined`)且非主鍵」之欄,欄名與 INSERT 同法引用;值為 `undefined` 之鍵不更動既有欄、不被引用(與 autoInsert:false 之 UPDATE 一致);無可更新欄時 `DO NOTHING`.
  - W6 `opt.pk` 於建構時須為識別字(不合者建構拋 `Error`,訊息 `invalid opt.pk`,不回顯值);`ON CONFLICT (…)`、`RETURNING …` 之主鍵名一律引用.
  - W7 INSERT 資料鍵(值非 `undefined` 者)含 NUL 或孤立代理字元 → `Error('invalid data key: …')`(不回顯該鍵、不送出該語句):insert/insertBulk 整批 reject(交易回滾,無寫入),save(autoInsert:true)該筆 `ok:0`.(第 66 項起:孤立代理鍵〔不論值是否 `undefined`〕先由 wsemi `chkOrmData` 於連線前拒收,訊息為 `invalid data: string contains lone surrogate at [data[k].<invalid key>]`;本條之 `invalid data key` 實際只對 NUL 鍵生效,對孤立代理鍵為縱深防禦,`unit-wellformed`、`unit-cvwrite` 直測.)
  - W8 主鍵只讀**自有可列舉**屬性:insert、insertBulk、save、del 對資料之主鍵(`checkData`、`save`、`del`、`genInsertList`)皆不讀繼承值;缺自有主鍵者依各函數既有「缺主鍵」語意處置(insert/insertBulk/save 整批 reject `invalid id: primary key is missing at [data[i].<pk>]`;del 該筆 `ok:0`,`err` 同詞彙;第 66 項起訊息不回顯值,見 R17),繼承值不得作用於任何列.
  - S9 find 只支援系列白名單(dspec〈一之三〉):頂層 `undefined`/`{}` 為全部;欄位等值 `{欄:純量|null}`;欄位運算子 `$eq $ne $gt $gte $lt $lte`(純量)、`$in $nin`(純量陣列);文件層 `$and $or`;其餘一律整批 reject(S2 之具體化).形狀檢核之唯一擁有者是 wsemi 的 `cvOrmFind`(R11),本套件不重寫形狀規則.
  - S10 檢查之值即使用之值:`cvFind` 之後一律只用檢核後之全新 null 原型複本與由其導出之 IR(含快取鍵、建句),不再讀呼叫端原物件.
  - S11 壞 find 於送出任何 SQL 之前 reject:不建立 `pg.Client`、不連線、不查詢(select、delAll 皆然).
  - S12 布林 `$ne` 為 SQL 三值,與其他型別一致(`{ok:{$ne:true}}` 不含 `ok IS NULL` 之列;SQL 為 `IS FALSE`).
  - S13 首尾皆 `$` 之字串(原為 mongo-sql 之欄引用語法)於**所有**比較運算子(等值、`$eq`、`$ne`、`$gt $gte $lt $lte`、`$in`、`$nin`)與主鍵值皆為字面值(綁定參數),不具欄引用義,與表名無關(run02,R4/R5,C1/C8/C11).
  - S14 JSON 取值鍵(`欄->k`、`欄->>k`、`欄#>k`、`欄#>>k`)與 `::型別` 轉型鍵不是合法欄名鍵(reject);find 自第 33 項批 1 起,order 自 run02 起亦然(S16).
  - S15 欄名解析 fail-closed(第 76 項):欄名一律**未限定**引用且表加固定別名 `"$t"`,故錯拼欄名即使恰為 PG 函數名(`concat`、`to_json`…)或與表名同名,PG 回報欄不存在(42703),條件不得對整列求值而成立;PG 保證不可建立同名欄之 6 個系統欄名(`ctid tableoid xmin xmax cmin cmax`)於 find、order、`opt.pk`、`save(…, {autoInsert:false})` 之 UPDATE 資料鍵與 `createTable` 欄名一律 reject;`insert`/`insertBulk`/`save(autoInsert:true)` 之資料鍵不預先拒收系統欄(寫入路徑無「條件變寬」之危險,由 PG 回報,R13;外審 sol F07 指出此句原與 R13 不符).
  - S16 order 鍵與 find 同文法:僅識別字(含 63 bytes 與系統欄檢核);`->` `->>` `#>` `#>>` `::` 一律 reject(`invalid order: unsupported column name [..] at [order.<鍵>]`);方向/nulls 為固定字面值(R3).
  - S17 建句 fail-closed:`select`/`delAll` 之 SQL 於 `new PgClient` 之前建構並經 `verifySql`(詞彙序列與值逐一比對)驗證,建句途中之任何例外(含 knex 內部)轉為固定格式 `invalid find|order: internal statement check failed (statement check): … at [find|order]`,不洩漏內部訊息;不改動全域 `Object.prototype`/`Array.prototype`(R12).
  - S18 IR 契約(wsemi `lowerFind` 檔頭即契約,已自本套件移入 wsemi ≥ 1.9.25〔第 94 項①〕,契約表為 wsemi `_lowerFindCases`):六種節點、單項展開與同型攤平、`maxParams` 必填、葉節點帶來源路徑 `p`、`in{vs:[]}` 不得影響結果集(R14).
  - S19 測試容器收尾連同匿名 volume 移除(`docker rm -f -v`),埠固定、表外名稱 throw(R15).
  - S20 字串良構(第 66 項批 1e,R17):主鍵字串含孤立代理字元或 NUL → 無效;寫入資料之字串值與鍵名(含巢狀、陣列元素、Map/Set 等 wsemi `chkOrmData` 走訪者)含孤立代理字元 → 無效(值之 NUL 不屬共用檢核);`opt.url`、`opt.db`、`opt.cl` 含孤立代理字元或 NUL → 建構即 `throw Error('invalid opt.<名>: <原因>')`.判定由 wsemi `chkOrmStr`/`chkOrmData` 單一擁有,本套件不得有私有複本.
  - S21 處置同形:`insert`/`insertBulk` 整批 reject、不寫任何一筆、reject 前發 1 次 `error`;`save` 對良構性問題(主鍵字串孤立代理/NUL,資料孤立代理)該筆 `{n:1,nInserted:0,nModified:0,ok:0,err}`、同批其他筆照常、每筆失敗發 1 次 `error`(原為整批 reject,D5);`save` 對未帶有效主鍵(未給、型別不符)與 `autoInsert:false` 之欄名不合文法仍為整批 reject(統一規格 T6、W2);`del` 該筆 `{n:0,nDeleted:0,ok:0,err}`;`selectByPk` 回 `null`.
  - S22 檢查之值即使用之值、且先於連線:檢核作用於 `cloneDeep` 之複本,於 `new PgClient` 之前完成(insert、insertBulk、save、del 皆然);`save`/`del` 檢核當下讀取之主鍵值(`pks`)於其後逐筆使用同一份;`save`/`del` 逐筆迴圈取批次索引(`pmSeries` 回呼第二參數).
  - S23 錯誤訊息固定詞彙、不回顯值:`invalid id: <原因> at [data[<k>].<主鍵名>]`、`invalid data: <原因> at [data[<k>].<路徑>]`、`invalid opt.<名>: <原因>`;原因取 wsemi(`string contains lone surrogate`、`string contains NUL`、`not a string`)加本套件主鍵專屬之 `primary key is missing`、`string is empty`、`unsupported primary key value`;k 為最小索引之不合格筆(同一筆主鍵先於資料,同一物件鍵名先於值).
  - S24 本套件無 `autoGenPk`(主鍵從不補值),檢核不隨任何設定改變(案例表以 `autoGenPk:false` 再跑一輪證明).
  - S25 既有資料不遷移(D8);PostgreSQL 以 UTF-8 儲存,過去寫入之孤立代理已被改寫為 U+FFFD,無從還原(README 載明檢出與清除).排序規則弱相等(mssql/Jet)與本套件無關.
  - S26 診斷輸出預設只含固定標籤與不含個資之摘要(資料值、id、使用者識別、錯誤原文、連線憑證皆不出現),所有輸出經 wsemi 之 `getDiag`(R18;第 161 項起,原 `src/getDiag.mjs` 已刪).
  - S27 `opt.logDetail`(`true` 才生效,輸出 `console.log(label, 遮罩後細節)`)與 `opt.funLog(label, safe, detail)`(取代 console)之語意比照 w-serv-orm;型別錯誤者忽略並用預設;選項於建構時成快照(R18).
  - S28 連線字串與帳密於任何診斷輸出一律以 `***` 遮罩;無憑證之值其 resolve/reject、事件 payload 與時機不變(以修改前 HEAD 產生之 `diagGolden.json` 逐項比對,R18).
  - S29 對外錯誤值(reject、`error` 事件之訊息、`save`/`del` 逐筆 `err`)不含連線憑證:外來值經 `diag.err`,含憑證者為遮罩副本、無憑證者原物件;本套件自身之固定詞彙錯誤不遮(R18;依 dspec〈診斷輸出與遮罩〉D3).
  - S30 驅動呼叫經單一接縫(`pgClient`、`pgConnect`、`pgRun`、`pgEnd`),接縫外不得直接呼叫 `new PgClient`、`client.connect|query|end`(R18).

## 〔條件(find)之支援範圍〕

- 轉譯路徑(第 58 項起):`select`/`delAll` 之 find 先經 `src/cvFind.mjs` 之 `cvFind`——**第一步 `cvOrmFind(find)`(wsemi ≥ 1.9.20,系列共用形狀檢核,回傳全新 null 原型深複本)**,第二階段 `lowerFind`(`import lowerFind from 'wsemi/src/lowerFind.mjs'`〔wsemi ≥ 1.9.25,第 94 項①自本套件移入〕,零 import,方言中立 IR,PG 專屬限制由 `dialectPg.checkColumn`/`maxParams` 注入)——再由 `emitKnex`(IR → knex where/order)與 `buildSql`(`buildSelect`/`buildDelete`,knex 只建 SQL 不連線,輸出經 `verifySql` 驗證)產生 `{query, values}` 交 `pgq`;select 與 delAll 共用同一檢核,故同一 find 命中之數據即刪除之數據(S1).
- 支援範圍(白名單,與系列〈一之三〉一致):
  - 頂層:未給、`undefined`、`{}`(含 `Object.create(null)` 之空物件)為全部;其餘須為條件物件.
  - 欄位等值 `{欄: 純量|null}`,多欄隱含 AND(`null` → `is null`).
  - 欄位運算子:`$eq $ne $gt $gte $lt $lte`(值為純量;`$eq/$ne` 可為 null)、`$in $nin`(值為純量陣列,元素不收 null;`$in:[]` 為恆假允許,`$nin:[]` reject).同欄可並列多個運算子(AND).
  - 文件層:`$and`、`$or`(非空陣列,元素為**非空**條件物件);欄位鍵可與 `$and/$or` 並列(AND).
  - 純量:字串(不含 NUL 與孤立代理字元)、有限數值(含 `-0`)、布林、有效 Date.
  - 欄名鍵(兩層):①共用層(wsemi)識別字 `^[\p{L}_][\p{L}\p{M}\p{N}_]*$`、1–128 字元、禁 `__proto__`;②pg 專屬(`dialectPg.checkColumn`):≤63 bytes(UTF-8 計,PG 識別字上限,超長被伺服器靜默截斷;伺服器編碼須為 UTF8)、拒收 6 個系統欄名;`Infinity`、`oid` 為一般欄名.欄是否存在、大小寫由 PG 回報(不查 schema;錯拼為函數名或表名同名者回報 42703,S15).
  - 上限(共用預設,pg 不下調):深度 32、`$and/$or` 長度 1000、`$in/$nin` 長度 10000、節點 100000、欄名 128 字元;pg 專屬:單一 find 綁定參數 ≤ 65535(`lowerFind` 之 `maxParams`,計數契約:cmp 1、in 每元素 1、bool/null/空 in 0).
  - pg 專屬轉譯:布林值 → `bool` 節點(等值/不等值 `IS TRUE`/`IS FALSE`,三值;其餘比較 `>= TRUE` 字面值);`$in:[]` → 恆假 `false`(不引用欄位、無綁定);`$..$` 字串無特殊處理(S13).
- **不支援者一律 reject**(整批性錯誤,訊息格式 `invalid find: <原因> at [<路徑>]`):白名單外運算子(`$not $nor $regex $options $exists $notExists $type $where $expr $like $ilike $null $notNull $equals $custom $custom_array $custom_object $years_ago…$seconds_ago` 與一切其他 `$` 鍵)、欄位層 `$and/$or`、`$or` 給物件、JSON 取值鍵(`欄->k` 等)與 `::型別` 轉型鍵、含 `.` `"` `'` 空白 `*` `;` `-` 之欄名鍵(含表.欄)、數字開頭之鍵、`__proto__`、系統欄名(`ctid tableoid xmin xmax cmin cmax`)、>63 bytes 之欄名、子查詢物件、`undefined`、NaN、±Infinity(值)、無效 Date、**bigint、Buffer**、孤立代理字元、NUL、RegExp/Map/Set/函數/Symbol/類別實例/包裝物件作為值、空物件、陣列作為欄位值(請用 `$in`)、巢狀非運算子鍵、`$nin:[]`、`$and/$or` 內之 `{}`(含 `$and:[{name:'aa'},{}]`)、`$in/$nin` 元素含 null、`$gt…$lte` 給 null、Symbol 鍵/不可列舉/存取器/繼承屬性、原型被改為 `null`/`Object.prototype` 之內建品牌物件(Map、Set、Promise、TypedArray…)、頂層 Proxy 空物件、深度>32、`$and/$or`>1000、`$in/$nin`>10000、綁定參數>65535、節點>100000.(`$..$` 字串與欄名 `Infinity` 不在此列:分別為字面值與一般欄名.)
- 保留之恆假:`{c:{$in:[]}}` = 恆假(select 無命中、delAll 刪 0),不引用欄位,故錯欄不被回報(設計限制).
- 語意:SQL 三值邏輯(`{a:null}` → `is null`;`$ne`、`$nin` 不含 NULL 列,**含布林 `$ne`**——第 33 項批 1 起 `{ok:{$ne:true}}` 不再含 NULL 列);不支援 `$regex`、`$like/$ilike`.系列可攜寫法(7 後端實測一致):排除 NULL `{$and:[{f:{$ne:null}},{f:{$ne:x}}]}`,含 NULL `{$or:[{f:null},{f:{$ne:x}}]}`.
- **頂層 find(使用者裁示 B,見〈delAll 與 find 之頂層語意〉;取代審計 Q3「維持現況」)**:僅 `undefined`(未傳)與一般物件(`{}` 為全部)可作頂層 find;`null`、`false`、`true`、`0`、`''`、任何數值(含 NaN、±Infinity)、字串、bigint、Symbol、陣列(含 `[]`、`[{}]`、`[{…}]`、巢狀陣列)、函數、Date、RegExp、Map、Set、Promise、Error、類別實例、繼承屬性者等一律整批 reject(`invalid find: … got [null|array|<tag>|<typeof>] at [find]`),不得視為 `{}`.`select` 與 `delAll` 共用.陣列僅可作為 `$and/$or` 之清單.
  - 測試:`api-find`〈top-level value that is not a condition object…〉(21 種值 × select/delAll,資料不變、各發 1 次 error 事件;另測 `undefined`/`{}` 仍為全部)、`unit-cvfind`〈top-level value…rejects〉(25 種)、`api-find-whitelist` T 組(wsemi 案例表 T01–T39).
- `$..$` 字串(S13,第 58 項起):首尾皆 `$` 之字串於所有比較運算子皆為綁定參數字面值(原 mongo-sql 視為欄引用,第 33 項批 1 曾以 `$in/$nin` 改寫並於 `$gt…$lte` reject,該改寫與限制隨 mongo-sql 移除而取消);`$nin` 之表名守門(`ninOk`)移除,表名不影響任何運算子.
- **非缺陷聲明**:本套件之支援範圍(運算子集合、NULL、`$regex`、大小寫之語意)屬設計.**不得**僅因「MongoDB 或其他 w-orm 套件支援」而視為缺陷、撰寫建議書或自行擴充;擴充或改變語意須主控同意.
- **系列最低要求**:①同一 find 於 select 命中之數據即 delAll 刪除之數據;②不支援之運算子與無法轉譯之值必須 reject,不得靜默忽略、改變語意或擴大刪除範圍;③不得因條件清單恰為空或值為 `undefined` 而刪全表.

## R1 條件(find)與排序(order)經單一擁有者檢核並建成 IR 後才建句

- 規則:凡把呼叫端提供之 find、order 轉成 SQL 者,先經 `src/cvFind.mjs` 之 `cvFind(find)`(回傳 IR)、`cvOrder(order)`(回傳 `[{c, dir, nulls}]`);檢核早於快取查詢與連線;失敗 → `emitError(mode, null, err)` 後 `Promise.reject(err)`(`err` 為 `Error`);驗證過程中任何例外(呼叫端物件之 getter、Proxy trap、`Symbol.toStringTag` 拋錯)一律轉為 `invalid find`;`cvFind` 可重入(內層呼叫不重置外層預算);select 與 delAll 共用;不擴充支援範圍.**find 之形狀檢核由 wsemi `cvOrmFind` 擁有(R11)**;`cvOrder` 仍用本模組之 `chkKey`/`readOwn`(order 不屬系列 find 白名單,但鍵與 find 同文法,S16).
- 輸出必為**全新複本**:`cvOrmFind` 之複本為 null 原型;`lowerFind` 之 IR 節點為 null 原型,陣列元素以 `Object.defineProperty` 附加(不用 `push`/索引指派:`Array.prototype` 上之數字索引 setter 會吞掉元素而令條件變寬,外審 sol F01);`cvOrder` 項目為 null 原型.不得改回「驗證後傳原物件」,亦不得在第二階段讀呼叫端原物件(S10).`Object.defineProperty` 之描述子字面量一律 `__proto__: null`(免受 `Object.prototype.get/set` 汙染).
- 只有本模組 `fail()` 所建之 Error(模組私有 `WeakSet ours`)才原樣重拋;其餘例外(含 `cvOrmFind`、`lowerFind` 所拋者)一律包成**新** `Error('invalid find: … at […]')`/`invalid order`(保留其訊息),reject 值恆為本模組建立之 `Error`.
- 陣列(`cvOrmFind` 複本中之 `$and/$or` 清單、`$in/$nin`)於 `lowerFind` 以 `length` 與索引**讀取**走訪(不呼叫 `forEach/map`);**建立**輸出時一律不以索引指派寫入陣列.
- 建句(`buildSelect`/`buildDelete`)見 R12;欄名解析之結構性規則見 R13.
- 盤點:`rg -n "buildSelect\(|buildDelete\(" src/WOrmPostgresql.mjs` → 站點全集見 R6;判準:接受呼叫端條件之站點(select、delAll)必經 `cvFind`(早於 `new PgClient`),其餘站點之條件由 `lowerFindEq(pkName, cleanPk(pkv))`(wsemi `lowerFindEq`,第 94 項①前名 `eqNode`)構成(R5).
- 測試:`test/unit-cvfind.test.mjs`、`test/unit-irsemantics.test.mjs`(wsemi 契約表掛接)、`test/api-find.test.mjs`(S1–S8,含汙染、第 76 項)、`test/api-matrix.test.mjs`;`lowerFind` 本體之契約測試在 wsemi(第 94 項①起,原 `unit-lowerfind` 62 案移出).

## R2 運算子白名單之單一來源

- 運算子集合與值型別之唯一來源為 wsemi `cvOrmFind`(第 33 項批 1 起;原 `src/cvFind.mjs` 之 `OPS_*` 常數與 `chk*` 形狀檢核已移除,轉譯自第 58 項起為 `lowerFind` → `emitKnex` → `buildSql`,只依 `cvOrmFind` 複本之已知運算子);README〈條件(find)白名單〉與本帳本只引用不另列.新增運算子須先與主控確認(不擴充),且須由 wsemi 修改(本套件不得自行放寬).

## R3 order

- 規則:僅接受 `undefined/null/{}` 或一般物件;鍵與 find 同文法(僅識別字;含 63 bytes 與系統欄檢核,S16);值為 `asc|desc`(不分大小寫,可接 `nulls first|last`),輸出正規化為小寫固定字面值,由 `emitOrder` 以 `orderByRaw` 發射(不經 knex 之方向參數:其對非法方向靜默改為 asc).字串、陣列、`1/-1`(舊況 `{time:-1}` 被當 `time - 1` 升冪排序)、含分號或子查詢之方向、JSON 取值鍵與 `::` 轉型鍵一律 reject,訊息 `invalid order: …`.(run02 起破壞性變更 C5/C5A:全庫無呼叫端使用 order 之 JSON/轉型鍵,主控 R3 裁示.)
- 測試:`unit-cvfind` U8、`api-find` S7.

## R4 快取鍵

- 規則:`getCacheKey` 由 IR 與正規化後之 order 以 `cvKey` 產生(區分 Date、bigint、Buffer 與字串;NaN、±Infinity 與 null;**忽略 IR 葉節點之來源路徑 `p`**:`{a:1}` 與 `{$and:[{a:1}]}` 同鍵);`select` 於檢核後才查快取;`selectByPk` 之 find 為 `lowerFindEq(pk, v)`,其鍵與 `select({[pk]: v})` 之 IR 相同(共用快取之前提).
- 測試:`unit-cvfind`(cvKey)、`api-find` S8(含 selectByPk 與 select 共用快取).

## R5 主鍵值

- 規則(主鍵值之**讀取**只讀自有可列舉屬性,見 R10;本條管**值之有效性**):`checkPk` 只接受原始值(字串〔不得含 NUL 或孤立代理字元,判定由 wsemi `chkOrmStr` 單一擁有,見 R17:孤立代理經 UTF-8 送出變 U+FFFD,`del({id:'\ud800'})` 會誤刪主鍵為 U+FFFD 之列;**首尾皆 `$` 之字串為一般字面值**〕、數值〔`isnum`:除 NaN 外皆可,**±Infinity 為有效主鍵值**(FLOAT8 主鍵可存,HEAD 行為,`api-matrix` 守住);find 內之數值則只接受有限者〕、布林)與真 Date(內部槽、有效時間值);包裝物件(`Object(5)`)與其他物件一律無效;條件以 `lowerFindEq(pkName, cleanPk(pkv))` 構成(Date 以內部槽重建,不帶呼叫端附加之屬性),值恆為綁定參數;selectByPk、insert、insertBulk、save、del 共用同一 `checkPk`.
- 盤點:`rg -n "checkPk\(" src/WOrmPostgresql.mjs` → 4(定義 + `checkData`〔insert、insertBulk、save 共用,檢核資料內之主鍵值〕、selectByPk、del);判準:每一個把主鍵值構成條件之站點皆先經 `checkPk`,且條件以 `lowerFindEq(pkName, cleanPk(pkv))` 構成(`rg -n "cleanPk\(" src/WOrmPostgresql.mjs`).Date 主鍵須為真 Date:原型為 `Date.prototype` 且無自有屬性(裝飾過之 Date 於各站點被不同函數以不同方式解讀,一律視為無效).
- 測試:`api-write-safety` W3、`api-find` S6.

## R8 送給 pg 之查詢設定(pgq;外審 opus F12、Argon F1)

- 規則:select、selectByPk、delAll、del、insert/insertBulk(`insertBatches`)、save(預讀、UPSERT、UPDATE)之 `client.query` 一律經 `pgq(text, values)`:設定物件為 **null 原型**(pg 以一般物件讀 `name/rowMode/types/binary/…`,會繼承被汙染之 `Object.prototype`;實測 `Object.prototype.rowMode='array'` 令 select 回陣列列)且 `queryMode:'extended'`(無綁定參數時 pg 預設走 simple protocol,可堆疊多語句;extended 協定由伺服器拒絕多語句,`cannot insert multiple commands into a prepared statement`).交易控制語句(`BEGIN/COMMIT/ROLLBACK`,常數字串)不經 `pgq`;`createTable` 之 DDL 自 run03 起亦經 `pgq`(R9;原為無綁定參數之 simple protocol,實測可堆疊建出第二張表).
- 動機(沿革):舊 SQL 產生器對純量值讀 `value[0]`、`value[NaN]`、`value.substring`,純量之原型鏈被塞入**函數**(需程式碼執行權)時可產出無綁定參數且帶第二語句之 SQL;`pgq` 令第二語句不可執行.現改 knex 只建 SQL 並經 `verifySql` 驗證(R12),本條之 `pgq` 仍為縱深防禦(表名等建構設定被置入片段之情形亦不致堆疊執行),不退場.
- 盤點:`rg -n "client\.query\(" src/WOrmPostgresql.mjs` → 12 處;經 `pgq(` 者 9(`insertBatches` 之 INSERT、`createTable`、select、selectByPk、save 之預讀/UPSERT/UPDATE、del、delAll);非 `pgq` 者 3:`BEGIN`、`COMMIT`、`ROLLBACK`(常數).判準:凡帶呼叫端值或名稱之語句皆 `pgq`;`rg -n "client\.query\(" src/WOrmPostgresql.mjs | rg -v "pgq\(|BEGIN|COMMIT|ROLLBACK"` 之結果須為空.
- 測試:`api-write-safety`〈statements use a null-prototype extended-protocol query config〉(堆疊語句被拒、`rowMode`/`name` 汙染無影響)與〈more input shapes found by review round 3〉(stub `pg.Client.prototype.query`,斷言 9 個站點〔含 `createTable`〕之設定物件皆 null 原型且 `queryMode==='extended'`,字串形式僅 `BEGIN/COMMIT/ROLLBACK`;變異「某站點退回 `client.query(text, values)`」會紅).

## R6 SQL 產生站點全集(第 58 項後;盤點:`rg -n "buildSelect\(|buildDelete\(|lowerFindEq\(" src/WOrmPostgresql.mjs`;`rg -n "mongo" src package.json toolg` 須為空)

| 站點(函數) | 型式 | 輸入來源 | 處置 |
|---|---|---|---|
| insertBatches(insert、insertBulk) | 手寫參數化 INSERT(`genInsert`) | 呼叫端資料值與資料鍵 | R7(W1) |
| select | `buildSelect(cl, ir, order)` | 呼叫端 find、order | `cvFind`、`cvOrder`(R1),建句早於 `new PgClient`(R12) |
| selectByPk | `buildSelect(cl, lowerFindEq(pk, v))` | 主鍵值 | `checkPk`(R5) |
| save 預讀 | `buildSelect(cl, lowerFindEq(pk, v))` | 主鍵值 | `checkPk`(R5) |
| save 插入(autoInsert) | 手寫參數化 INSERT(`genInsert`) | 呼叫端資料值與資料鍵 | R7(W1) |
| save 更新(autoInsert:false) | 手寫參數化 UPDATE,欄名 `quoteKey`,WHERE `quoteKey(pkName)`(不加表限定) | 呼叫端資料值與資料鍵 | R7(W2) |
| del | `buildDelete(cl, lowerFindEq(pk, v))` | 主鍵值 | `checkPk`(R5) |
| delAll | `buildDelete(cl, ir)` | 呼叫端 find | `cvFind`(R1),建句早於 `new PgClient`(R12) |

(原 `ninOk` 建構時自檢與 `qry`/`sqlOf` 包裝已隨 mongo-sql 移除.)

## R7 寫入路徑之值(Q6;T1、T2)

- 規則:(T1)insert、insertBulk、save(autoInsert)之 INSERT 改為手寫參數化 SQL(`src/cvWrite.mjs` 之 `genInsert`,輸出格式(沿用 mongo-sql 版之格式):`insert into "表" ("k1", "k2") values ($1, $2), ($3, DEFAULT)`,null 為字面 `null`,undefined 為 `DEFAULT`),所有值以綁定參數送出,物件值由 pg 序列化(`JSON.stringify` 或其 `toPostgres`),**不呼叫 `JSON.stringify`、`toJSON`、getter**;不經任何 SQL 產生器之值輔助(舊 mongo-sql 版之 `values` 輔助以 `'type' in value`(對含自有或繼承 `type` 屬性之物件、Date、陣列、Buffer 皆成立)判定為子查詢,該行為已不可達);欄名以雙引號引用並將內含雙引號加倍(原逐字拼接,含雙引號之鍵會破壞語句).(T2)`save(…,{autoInsert:false})` 之 UPDATE 改為手寫參數化 SQL `UPDATE <表> SET "k"=$n,… WHERE <主鍵>=$m`,所有值以綁定參數送出;欄名鍵須為識別字(`cvColumns`,同 R1 欄名文法之識別字部分),否則於任何寫入之前整批 reject(`invalid data[k]: …`);無可更新欄位時該筆 `ok:0`(`no column to update`).(註:mongo-sql 已於第 58 項移除,本節提及 mongo-sql 者為沿革.)
- **`insert(…, {returnList:true})` 之輸入主鍵比對(外審 sol F06,第 3 次執行)**:`genInsertList` 以 `RETURNING 主鍵` 回傳值對映輸入序;輸入為字串而欄位為 INTEGER/FLOAT 或 BOOLEAN 時 PG 轉換後寫入,回傳為 number/boolean,輸入側須同樣轉換(`normPk`:回傳型別為 number 時字串輸入以 `Number()`,為 boolean 時依 PG 布林字面〔`pgBools`〕),否則逐筆 `nInserted` 全報 0 而實際已寫入(HEAD 同,非本次回歸);文字欄位(回傳為字串)維持原值不轉換;BIGINT/NUMERIC 回傳為字串,不在本修正範圍(輸入須與回傳字串同形)。測試:`api-postgresql` returnList 之 INTEGER/BOOLEAN 主鍵字串輸入案.
- DDL(`createTable`)、`ON CONFLICT`、`RETURNING` 之識別字內插(原 T3)已於 run03 納入規則,見 R9;INSERT 資料鍵含 NUL/孤立代理字元之檢核(W7)亦在 `genInsert`(R9).
- 測試:`unit-cvwrite`(`genInsert` 固定期望字串、`quoteTable` 手寫對照表、原型汙染、欄名引用)、`api-write-safety`(W1、W2、W3).

## R9 DDL、ON CONFLICT、RETURNING 與主鍵名:識別字檢核 + 一律雙引號引用(原 T3;run03;W4–W7)

- 規則:凡把**呼叫端或建構設定**提供之名稱(資料鍵、`createTable` 之表名/欄名鍵/pk、`opt.pk`)放進 SQL 文字者,一律 ①先檢核 ②以雙引號引用(內含雙引號加倍),且帶這類文字之語句一律經 `pgq`;不得以 `${名稱}` 直接內插.
  - `createTable`:`genSqlForCreateTable` 於任何語句送出之前檢核——表名經 `cvTable`(未含 `"` 者以 `.` 分段後每段須為 PG 未引號識別字形 `^[\p{L}_][\p{L}\p{M}\p{N}_$]*$` 且 ≤63 bytes,擋空白/連字號/分號/關鍵字〔如 `IF NOT EXISTS t`、`TEMP t`、`t (a int)`〕等 DDL 片段;含 `"` 者須為完整雙引號名稱;兩者之 `quoteTable` 結果須全由雙引號識別字以 `.` 相接而成,否則 reject;擋 `"` 破壞引號、`->1; …`/`::型別` 等會被原樣輸出之尾巴)、欄名鍵與 pk 為識別字(`isColumnName`,同 find 欄名文法,含 63 bytes 與系統欄名拒收;`Infinity` 自第 58 項起為合法欄名)、樣本物件須至少有一個自有可列舉鍵(`iseobj` 以 for..in 判定而含繼承鍵,原可建出零欄表);不合者 `Error('invalid createTable: …')`,整批 reject、發 1 次 `error` 事件、訊息不回顯值.欄名以 `quoteKey` 引用(與 `genInsert` 同函數),型別為固定常數集合(`getValueType`),不含呼叫端字串;DDL 經 `pgq`.
  - **大小寫折疊之相容影響**:`createTable` 原以未引號識別字建欄,PG 折為小寫(`{userName:1}` 得欄 `username`),而 insert/save/find/order 皆以雙引號引用欄名(`"userName"`,不折疊),故含大寫之鍵在 HEAD 即「建得出欄卻寫不進、查不到」;今 `createTable` 同樣引用,欄名與其餘路徑逐字一致(`{userName:1}` 得欄 `userName`).唯一受影響之用法:建表時用含大寫之範例物件、其後 insert/save/find 卻全用小寫鍵(原可運作,今小寫鍵對不上 `userName` 而由 PG 回報欄不存在);補救為範例物件改用小寫鍵.全小寫之鍵與既有 129 案不受影響.
  - `ON CONFLICT`:由 `genConflict(pk, row)` 產生——`ON CONFLICT ("pk") DO UPDATE SET "k" = EXCLUDED."k", …`,更新欄 = `row` 之自有可列舉鍵中「值非 `undefined` 且非 pk」者(與 `genInsert` 之欄單同一函數 `colsOf`,故 `EXCLUDED."k"` 必指 INSERT 欄單內之欄,不會把未列於欄單之欄清成預設值);無可更新欄 → `DO NOTHING`;資料鍵經 `colsOf` 檢核 NUL/孤立代理字元(W7);`colsOf` 與 `genInsert` 取值皆為「自有**可列舉**屬性」(`Object.keys` / `propertyIsEnumerable`,外審 Argon F-4:取值原用 `hasOwnProperty` 會讀到自有不可列舉屬性).`insert` 之 `ON CONFLICT ("pk") DO NOTHING`(`insertBulk` 不帶 `ON CONFLICT` 與 `RETURNING`)亦同函數.
  - `RETURNING`:`RETURNING "pk"`(`quoteKey`);回傳列之欄名即 pk 原字串,`genInsertList` 以 `row[pk]` 讀取不變.
  - `opt.pk`:建構時 `isColumnName` 檢核,不合即 `throw new Error('invalid opt.pk: …')`(非字串/空字串仍採預設 `'time'`,既有).pk 為識別字故 `get(v, pk)` 不致被 lodash 解讀為路徑.
  - INSERT 資料鍵含 NUL/孤立代理字元:`colsOf` 拋 `Error('invalid data key: contains NUL or an unpaired surrogate')`(原:NUL 在 extended 協定 Parse 被 C 字串截斷,得協定層錯誤 `insufficient data left in message`;孤立代理字元經 UTF-8 變 U+FFFD 而寫入他欄).值為 `undefined` 之鍵不被寫入故不檢.
- 不在本規則範圍:`opt.cl`(建構設定之表名)仍視為可信,不另檢核(`cvTable` 只用於 `createTable` 之呼叫端表名);`opt.cl` 含 `"` 者由 `quoteTable` 原樣使用(視為呼叫端自負之 SQL 片段,不經 `verifySql` 之詞彙驗證).完整雙引號表名(如 `'"Po_Q"'`)作為 `opt.cl` 時,**自第 58 項起 select/selectByPk/save/del/delAll 皆可用**(C7;舊版因 mongo-sql 輸出 `""Po_Q""."time"` 而僅 insert 可用);`createTable` 表名不限段數(`db.schema.table` 於同庫合法):三段以上由 PG 回報(跨庫參照不支援、`improper qualified name`,以字串 reject 且訊息含該名),無注入面,維持不收窄(外審 Argon F-3,部分屬實).
- 盤點:`rg -n "\$\{(pkName|key|tableName|cl)\}" src/WOrmPostgresql.mjs | rg -v "Error\(|err:"` 應無結果(名稱不得直接內插進 SQL 文字;僅錯誤訊息模板〔`idErrOf` 之 `invalid id: … at [data[k].<pk>]`〕例外,第 66 項起現為 1 行);`rg -n "client\.query\(" src/WOrmPostgresql.mjs | rg -v "pgq\(|BEGIN|COMMIT|ROLLBACK"` 應無結果(含 `createTable`);判準:SQL 文字中的每個名稱皆來自 `quoteKey`/`quoteTable`/`cvTable`(已先檢核者;`mongoSql.quoteObject` 已隨 mongo-sql 移除).
- 測試:`api-write-safety` T3 區塊(`createTable` 堆疊/引用/表名、ON CONFLICT 引號與 `undefined`、pk 名建構檢核、NUL 資料鍵、站點 stub 9 處)、`unit-cvwrite`(`genConflict`、`cvTable`、`isColumnName`、`genInsert` 資料鍵檢核).

## R10 主鍵只讀自有可列舉屬性(run03;W8)

- 規則:資料物件(insert、insertBulk、save、del 之 `data` 元素)之主鍵一律經 `ownPk(v)`(`propertyIsEnumerable.call(v, pk) ? v[pk] : undefined`,`v` 為 `null`/`undefined`/非物件者回 `undefined`)讀取,不經 lodash `get`:`get` 會讀**繼承**值,資料型原型汙染(JSON 造得出,如不安全 merge 了 `{"__proto__":{"time":"k7"}}`)下缺主鍵之資料(`del([{}])`)會作用於汙染值所指之列(HEAD 實測 `del` 刪掉 `k7` 列);主鍵定義於類別原型 getter 之用法同時失效(破壞性變更,使用者/主控裁示:庫內資料皆為 JSON/一般物件,與 w-serv-orm 第 60 項 D1「只迭代自有可列舉鍵」一致).
- 站點全集(`rg -n "ownPk\(|get\(v, pkName\)|get\(v, pk" src/WOrmPostgresql.mjs`):`checkData`(2 處:檢核與錯誤訊息)、`genInsertList`(2 處)、`save`(`pkv`)、`del`(`pkv`)均為 `ownPk`;`get(…, pkName)` 只允許出現在讀 DB 回傳列(`rows`)者(`genInsertList` 之 `rows.forEach`、`omit(_v, pkName)`).
- 缺自有主鍵者之處置不新增語意,沿用各函數既有「缺主鍵」:`checkData` 拋 `invalid id: primary key is missing at [data[i].<pk>]`(整批 reject,發 1 次 `error`,無寫入;第 66 項起不回顯值);`save` 同為整批 reject(T6);`del` 該筆 `ok:0`、`err` 同詞彙(取批次索引)、每筆發 1 次 `error`,其餘筆照常.`selectByPk(pk)` 之主鍵值由呼叫端直接給,不受影響.
- **入口守衛之既有語意(外審 Argon F-2B,維持不修,無列受影響)**:`insert/insertBulk/save/del` 入口以 wsemi `iseobj`/`isearr` 判定輸入是否「空」,二者皆以 `for..in`(含繼承可列舉鍵、不含不可列舉鍵)判定:資料物件**沒有任何可列舉鍵**(例如主鍵只在類別原型 getter、或為自有不可列舉屬性,且無其他可列舉鍵)且為單筆或單元素陣列時,視同空輸入 `{}`/`[{}]`——`del`/`save` 回 `[]`、`insert`/`insertBulk` 回 `{n:0,nInserted:0,ok:1}`,不發 `error`、不送任何語句(HEAD 同;`del({})` 亦回 `[]`);兩筆以上之陣列不經此守衛,走上述缺主鍵處置(`del` 逐筆 `ok:0`、其餘整批 reject).此為 fail-closed 之既有空輸入語意,非 W8 之破口(繼承值不作用於任何列).測試:`api-write-safety`〈own non-enumerable pk and prototype-only pk〉.
- 測試:`api-write-safety`〈own pk only〉(`Object.prototype.time` 汙染下 `del([{}])`/`save`/`insert` 不作用於汙染值所指之列;原型/類別 getter 主鍵視為缺主鍵).

## R11 find 之形狀檢核單一擁有者 = wsemi `cvOrmFind`;本套件只做 pg 專屬第二階段(第 33 項批 1;S9–S14;第 58 項後第二階段改為 `lowerFind`)

- 規則:`cvFind(find)` 的**第一步**必為 `cvOrmFind(find)`(`import cvOrmFind from 'wsemi/src/cvOrmFind.mjs'`,預設 opt,不下調上限,不提供放寬運算子或欄名之開關),取得全新 null 原型深複本;其後**只走訪該複本**(不得再讀 `find` 原物件),交 `lowerFind(copy, {maxParams: dialectPg.maxParams, checkColumn: dialectPg.checkColumn})`,只做下列 pg 專屬工作,不重寫形狀規則(型別、運算子集合、空集合、欄名文法、異常結構、上限皆屬 wsemi):
  1. 欄名鍵 ≤63 bytes、拒收 6 個系統欄名(`dialectPg.checkColumn`,R13);
  2. 綁定參數計數 ≤ 65535(`maxParams` 必填,計數契約見 R14);
  3. 布林節點、恆假 in 節點之 IR 表達(R14);
  4. 輸出全新 null 原型(免疫 `Object.prototype` 汙染).
  (原 `$nin` 表名守門、`$eq` → `$equals`、布林 `$ne` 反相、`$..$` 改寫、`$and/$or` 轉索引物件、碰撞收集器、`Infinity` 排除皆為 mongo-sql 之性質,隨其移除.)
- 例外處置:`cvOrmFind` 與 `lowerFind` 所拋之 `Error` 與其他例外一律包成本模組建立之新 `Error`(訊息保留 `invalid find: <原因> at [<路徑>]`);成功路徑不吞例外.
- 時序(S11):`select`/`delAll` 於 `new PgClient`、`connect`、`query` 之前呼叫 `cvFind` 與 `buildSelect`/`buildDelete`;失敗 → `emitError(mode, null, err)` 一次後 `Promise.reject(err)`;`change` 不發.
- 盤點指令(可重跑):
  - `rg -n "cvOrmFind\(" src` → 恰 1(`src/cvFind.mjs` 之 `cvFind`);`rg -n "^import cvOrmFind" src` → 恰 1.判準:已套.
  - `rg -n "cvFind\(" src/WOrmPostgresql.mjs` → 2(select、delAll),均早於 `new PgClient`(已套).
  - `rg -n "\$like|\$ilike|\$null|\$notNull|\$equals|->>|#>|::" src/cvFind.mjs` → 僅出現在註解(order 與 find 同文法,已無 JSON/轉型鍵).
- 站點全集(find 入口):select(`cvFind` → `getCache` → `buildSelect`)、delAll(`cvFind` → `buildDelete`);selectByPk、del、save 之條件由主鍵值構成(R5),不收呼叫端 find.
- 軸:頂層 × 位置(欄位值、運算子值、`$in/$nin` 元素、`$and/$or` 元素、運算子物件)× 型別 × 規模 × 異常結構 → wsemi 案例表(255 案)逐案對公開 `select`/`delAll`;pg 專屬軸(欄名 63 bytes、系統欄、函數名欄、`$..$`、布林 `$ne`、綁定參數、表名)另測(`api-find`、`api-matrix`).
- 測試與指令:`npx mocha test/api-find-whitelist.test.mjs --timeout 180000`;`npm test`.變異(須轉紅):①拿掉 `cvOrmFind` 呼叫;②驗證後改走訪原物件;③檢核放到送 SQL 之後.

## R12 輸出驗證層(verifySql)與 knex 邊界(第 58 項;S17)

- 規則:`buildSql.mjs` 之 `out()` 編譯 knex builder 後必經 `verifySql(text, values, head, ir, order)`:①文字以預期表頭 `<verb> <quoteTable(表)> as "$t"` 逐字開頭(表名片段為建構設定之信任輸入,不經詞彙驗證);②其餘部分須能被詞法表完整消耗(空白、`"識別子"`、`$n`、運算子 `= != <> > >= < <= ( ) ,`、英文單字;數字字面值、單引號字串、註解、分號、`::`、`->` 一律不認);③詞彙**序列**須與由 IR 與 order 導出之期望序列逐一相等(欄名、運算子、and/or 連接詞及位置、`is [not] null`、`in (…)`、括號對及位置);④`$n` 自 1 連續遞增且個數 = `values.length`;⑤`values` 與由 IR 推得之值序列逐一全等(Date 比時間值)且每個值為純量.不符 → `Error('invalid find|order: internal statement check failed (statement check): … at [find|order]')`(差異落在 order 子句者前綴為 invalid order),於連線之前拋出.
- 建句途中任何例外(含 knex 內部 `TypeError`)轉為固定訊息 `… (statement check): the statement could not be built at […]`,本模組與發射器所拋之 `invalid find|order` 原樣保留;不洩漏 knex 內部訊息.
- **不改動全域原型**(主控 R2 裁示:不採 `withCleanProto`):knex 內部以一般物件承載 limit/schema/only/distinct/returning… 並讀取其繼承值,`Object.prototype` 被資料型汙染時其 SQL 可能靜默改變或拋錯;本套件以 `verifySql` 對整條語句全文做序列比對,使結果恆為「與無汙染相同」或「fail-closed reject」,絕無第三種.knex 實例於模組載入時建立(早於任何執行期汙染),設定為 null 原型、不給 connection(不建連線池,行程可自然結束).
- 內部函式一律**位置參數**(`buildSelect(table, ir, order)`),不用選項物件解構(呼叫端自己的物件字面量也會讀到繼承值).表名以佔位詞 `"$tbl$"` 建 builder 並於編譯後換回 `quoteTable(table)`(knex 的 raw 對 `?`、`.`、`as` 另有解析).
- 強度聲明:`verifySql` 為「與 IR 結構一致」之檢查,**不是對 IR 本身(`lowerFind`)語意之驗證**;`lowerFind` 若把 `or` 誤降為 `and`,期望序列與實際序列同樣錯而放行——語意由案例表閘門、`api-matrix`(獨立手寫 SQL 預言機)、wsemi 之 `lowerFind` 契約測試(`_lowerFindCases` 節點語意期望表)守住.
- **檢查之值即使用之值**:`verifySql` 通過後,`buildSql.out()` 以 `snapshotValues` 把綁定值轉為獨立快照(Date 以時間值重建新實體;其餘純量本即不可變)——knex 的 bindings 與 IR 持有同一個 Date 實體,若不複製,驗證與送出之間(`await client.connect()` 空檔)該實體被改動(如存取器汙染於建句時取得它再改寫)則送出之值不是驗證之值(外審 opus F2,已修;`unit-sqlbuild`〈snapshot〉案與變異 M41 守住).表名拆段以 `splitDots` 手動為之,不用 `String.prototype.split`(外審 opus F3;變異 M42).**建句途中亦然**(外審 sol F03,上列快照只管「驗證之後」):`emitKnex` 交給 knex 的 Date 一律是依時間值重建的獨立副本(`toKnex`),knex 讀值屬性(如 `isRawInstance`)時若被就地改寫,被改的只是副本,IR 持有的 Date 不受影響,`verifySql` 以時間值(`timeOf`,經 `Date.prototype.getTime.call`,不查屬性)比對 IR 與 bindings 而拒收;原做法讓 IR 與 knex 共用同一 Date,途中改寫會同時改兩邊而通過驗證(公開 `delAll` 刪錯列);單元測試 `should reject, never send, a Date that is rewritten in place while knex reads its properties` 與變異 M47 守住.
- 無任何關閉驗證之開關(無環境變數、無選項;`unit-sqlbuild` 讀檔斷言).
- 汙染掃描:`test/tools/pollutionSweep.mjs`(單元測試用 24 名 × 5 值;全量 `node test/tools/pollutionSweep.mjs --all [--protos] [--list-threw]`:母體 = `node_modules/knex/lib` 內出現過之屬性名,不證明無未知名稱,證明力來自 `verifySql` 全文比對).**升版 knex 時必重跑全量掃描**(且 knex 輸出格式改變時 `verifySql` 序列不等 → fail-closed,由測試揭露).
- 測試:`unit-sqlbuild`(節點語意 SQL、表名佔位、order、發射端縱深、verifySql 正反例含 18 種語意竄改與 25 種通用竄改、汙染掃描、non-configurable 子行程、行程自然結束)、`api-find`(汙染 select/delAll 為 same 或 statement check)、`api-write-safety`.

## R13 欄名解析結構性規則(第 76 項;S15)

- 規則:欄名一律**未限定**引用(`"c"`,不寫 `"t"."c"`),表一律加固定別名 `"$t"`(`$` 不可能出現在合法欄名鍵,故整列參照 `"$t"` 不可達);`dialectPg.checkColumn` 拒收 6 個系統欄名(PG 不允許建立同名欄,未限定時可被解析為系統欄,條件可能對全表成立);find、order、`opt.pk`(建構拋 `invalid opt.pk: system column names (...) are not supported`)、`save(autoInsert:false)` 資料鍵與 `createTable` 欄名共用同一檢核(`cvColumn`).
- 依據(PG 17 實測):`"t"."concat"` 在表無此欄時被解析為函數 `concat(t)`(整列為引數)而條件成立;未限定 `"concat"` 為 42703;未限定時欄名等於表名會解析為整列參照,加別名後不可達;6 系統欄 PG 以 42701 拒絕建立.`oid` 在 PG ≥ 12 為一般欄,不拒.
- 限制(已載於 README):視圖輸出欄可取名同系統欄(被拒收,為收窄);63 bytes 以 UTF-8 計,非 UTF8 伺服器編碼下長多位元組欄名可被伺服器截斷而解析到他欄(HEAD 同,非回歸);PG ≥ 12;insert/insertBulk/save(autoInsert:true) 不預先拒收系統欄名(寫入路徑無「條件變寬」之危險,由 PG 回報).
- 備選未採:建構後首次使用時讀 `pg_attribute` 欄名集合(多一次查詢、連線後才 reject、DB 錯誤型別改變);結構性機制已覆蓋全部已知危險.
- 測試:`api-find`(函數名/表名同名欄 × 4 種 find,select 42703 / delAll 字串 / 資料不變 / 1 次 error 事件;系統欄 6 個 × find/order;大小寫變體)、`unit-sqlbuild`、`api-write-safety`(`opt.pk`、寫入路徑系統欄).

## R14 `lowerFind` 之 IR 契約(第 58 項建立;第 94 項①移入 wsemi ≥ 1.9.25;S18)

- 規則:`lowerFind` 已移入 wsemi(`wsemi/src/lowerFind.mjs`;主鍵等值節點 `eqNode` 改名 `wsemi/src/lowerFindEq.mjs`),**零 import**、不含任何資料庫/建構器/方言專屬名稱(由 wsemi 之契約測試讀檔守門;本套件**不再持有副本**,`src/` 不得再出現 `lowerFind.mjs`);檔頭即 IR 契約:六種節點(`and/or` n 元,≥2 項,單項展開、同型攤平;`cmp`、`bool`、`null`、`in`),葉節點帶來源路徑 `p`(供後續映射遍回報 `invalid find: <原因> at [<路徑>]`,不參與語意,快取鍵忽略),`opt.maxParams` **必填**(`typeof number` 且 > 0;不限者傳 `Infinity`;核心不預設任何方言上限),`opt.checkColumn` 選填;`in{vs:[]}` 恆假只有一種語意(結果集為空),是否引用欄位由發射器自決、**不得影響結果集**(R7:PG 發射為 `false`,不引用欄位);`and/or` 之深度/寬度上限與平衡二分由發射器處理(核心不因方言上限限制攤平寬度);`bool` 節點語意為 SQL 三值(NULL 列不命中任何布林比較含 ne),各方言字面值自選(R11 裁示:PG 於 `=`/`$ne` 為字面值而 `$in/$nin` 內布林為綁定參數,維持並載入已知限制,IR 移 wsemi 前定案).
- 契約資產(第 94 項①已移入 wsemi,使其他後端可獨立對拍):wsemi `_lowerFindCases`(`semantics` 85 筆節點語意期望表:id → node → find → 期望 IR → 期望命中集合;`seed()` 固定 6 列;`snapshots` 73 筆 IR 快照),本套件**不另存**(原 `test/tools/ir-snapshots.json`、`genIrSnapshots.mjs` 已刪)。本套件只保留 pg 自有之 SQL 骨架 `test/tools/irSemantics.mjs` 之 `SQL`(id → where 子句與綁定值,40 筆,全手寫),以 id 掛接 wsemi 表;`unit-irsemantics`(5 案)守:①`SQL` 之每個 id 存在於 wsemi 表;②wsemi 表之每個 id 有骨架或明列於 `NO_SQL_SKELETON`(免除,現 45 筆),兩者不重疊;③`SEMANTICS` = wsemi 之 find/ir/hits + 本套件 where/values;④經本套件 `cvFind`(pg 的 maxParams/checkColumn)所得 IR = wsemi 期望 IR。wsemi 新增 id 時本套件即紅,須補骨架或明列免除。
- 盤點:`rg -n "lowerFind" src` 須只剩 `import lowerFind from 'wsemi/src/lowerFind.mjs'`、`import lowerFindEq from 'wsemi/src/lowerFindEq.mjs'`、使用處與註解;`rg -n "\./lowerFind|eqNode|ir-snapshots|genIrSnapshots|unit-lowerfind|[ (\`]src/lowerFind" src test` 須只剩 `unit-irsemantics` I5 守門碼自身(`CLAUDE_*.md` 之歷史紀錄除外).
- 時程(主控 R8):第 94 項①已完成 pg 部分(`lowerFind` 移入 wsemi 1.9.25,pg 改 import);reladb 採用(含型別化第二遍之 PoC)、mdb 繼承由主控另排;第 87 項(mdb 負偏移時區之浮動時間)併入 reladb 採用階段評估.
- 測試:`lowerFind` 本體契約測試在 wsemi;本套件 `unit-irsemantics`(5 案)、`unit-sqlbuild`(IR → 精確 SQL,逐筆取 `SEMANTICS`)、`api-matrix`(真 PG 命中集合,逐筆取 `SEMANTICS`).原 `unit-lowerfind`(62 案)隨本體移出.

## R15 測試容器與埠(第 58 項 D10 / R9;第 88 項;S19)

- 規則:`test/tools/pgContainer.mjs` 之 `PORTS` 表登錄容器名 → 埠序號(實際埠 = base + 序號,base 預設 8451,環境變數 `WORM_TEST_PORT_BASE` 確定性整段平移並使容器名帶 `-<base>` 後綴,供同機多工作區並行,須為 8000–48992 之整數);表外名稱 `throw`(不退回隨機);`docker run` 綁 `127.0.0.1`;埠被占用時丟出明確訊息;新增 api- 測試檔須在表內登錄一行(`api-container-cleanup` 讀檔斷言每個 `let ctName` 皆已登錄且互異).
- **第 88 項**:啟動前清殘留與結束移除一律 `docker rm -f -v <名>`(postgres 映像宣告 VOLUME,`--rm` 之自動移除與手動 `rm -f` 競爭時不帶 `-v` 會遺留懸置匿名 volume,C: 槽曾因此剩 0 位元組);`api-container-cleanup` 以容器實際掛載之 volume 名稱逐一驗證收尾後 `docker volume inspect` 失敗(含「同名殘留容器被下一次 startPg 清掉」).回驗(run02):全套測試前後 `docker volume ls -q -f dangling=true | wc -l` 皆為 0;變異 M24(拿掉 `-v`)使 `api-container-cleanup` 轉紅.
- 不得執行 `docker volume prune`/`docker system prune` 等全域清理(屬主控);不動使用者既有容器(`postgresql-worm`、`mssql-worm`).
- 他套件之埠登錄表由主控另訂.

## R16 案例表閘門(轉換期工具,非永久測試)

- 位置(repo `tmp/cases/`,受 ignore):`cases.mjs`(固定資料表 `wcase` 14 列 15 欄與全部案例產生器)、`run-cases.mjs`(對公開 API 逐案記錄 JSON;**單欄單運算子形狀之 find 另以手寫 SQL 直連 PG 取得獨立預言機結果 `orc`**,不經被測套件)、`classify.mjs`(新舊差異依規則歸類,**未歸類須為 0**;驗 `evErr`、`unchanged`、`unchangedFull`〔整表全欄快照,第 3 次執行外審 sol 起〕、`chg`、`after`、`s1`、B 獨有 id、**id 不得重複**、ok 之 sel 的 `n` = ids 筆數 / del 的 `n`、`nDeleted` = deleted 筆數、錯誤類別;歸類規則驗「新結果 = 預期結果」而非僅看舊結果或 id 前綴;**預言機落差帳**:預言機成功而新結果被拒、或 SQLSTATE 不同者,只許兩類——`O-BOOL`(find 值為布林,字面值 `IS TRUE`/`>= TRUE` 契約 R11,HEAD 同)與 `O-FIELD`(欄名白名單/系統欄/函數名欄之設計決定),其餘為未歸類,且全表時兩類格數須等於已知值〔O-BOOL 167、O-FIELD 105〕)、`merge.mjs`、`mkdbs.mjs`、`gate.mjs`(一鍵:4 組並行 + 2 時區子集 + 合併 + 歸類)、`mk-fixtures.mjs`(閘門自驗)、`axes-diff.mjs`(補充軸:視圖/分區表/繼承表/`?` 與 `$1` 表名/enum char timestamp smallint real bytea domain int[] interval COLLATE,HEAD 對新實作並列)。HEAD 基準 `out-head-all6.json`(6765 記錄 / 13491 格;由 `out-head-all5.json` 把 logic 組以修正後之邊界案重跑覆蓋),時區 HEAD 基準以同一版 runner 重跑(`out-head3-{utc,ny}.json`;HEAD 原始碼 `git show HEAD:src/*.mjs` 置 `tmp/head2/src`,mongo-sql 裝於 `tmp/head2/node_modules`)。
- 跑法(並行須各自 `CREATE DATABASE`):`node tmp/cases/gate.mjs v8`(內部即 `run-cases.mjs --src src/WOrmPostgresql.mjs --out … --port 9081 --db wbN --groups <群組>`;群組 `top,scalar,scalar2,inset,logic,field,wsemi,order,pk,cache,tbl,pkname,legacy44,shape,wkeys`;時區子集 `--groups scalar,scalar2,inset,pk --only Date --tz UTC|America/New_York`);歸類 `classify.mjs <基準> <新> --md <輸出>`。
- 歸類規則之判準(run02 強化,外審 opus F1 / minimax 竄改夾具之實證:run02 初版 C1/C4/C9/C10/C11 只看舊結果,新結果可為任意值而仍「未歸類 0」):C1 新結果須等於獨立預言機(ids/刪除集合相同;預言機為 PG 錯誤者須為同 SQLSTATE;無預言機之格須為非文字欄對 $..$ 字串之 22P02/22007 型別錯且資料不變);C2 須為 PG 回報欄不存在(select 42703)且資料不變;C3 訊息須指名該系統欄;C4 須為 PG 回報欄不存在或 $in:[] 之空結果;C5/C5A 須為 `invalid order: unsupported column name`;C7/C8 須與 plain 表同形且 `after` 相同;C9 `pkname:Infinity` 之各格與終表須與 `pkname:time` 之新結果除欄名外相同、`pkname:system` 須為建構拋指名系統欄之訊息且無操作格;C10 訊息須為 `invalid data[k]|createTable: unsupported column name` 且 `after` 與 HEAD 相同;C11 text 主鍵表以 HEAD 種子精確比對(byPk 列、del 殘列、save 終表 x=99 僅該字面主鍵列),其他型別與 `'a'` 同形;INFO 限同 SQLSTATE 且訊息僅為已知措辭差(`column t.c does not exist` → `column "c" does not exist`);讀取類格 `unchanged` 不得為 false(規則命中路徑亦然);C2/C4 之 PG 訊息須指名被查詢之欄(`column "<欄>" does not exist`)、C5/C5A 須指名被拒之 order 鍵、C10 須指名被拒之欄(外審 minimax G1);**wsemi 共用案例表自帶之獨立期望納入閘門**(外審 minimax G2):`expect=REJ` 案須為 `invalid find:` 拒收;OK/ALL 案新結果成功者命中/刪除集合須等於 `want`(`ids.sql`),被拒者僅 `schema:true` 案(15 案)可被 PG 拒。另**全域預言機交叉驗證**:凡有 `orc` 之格,新結果為成功者其命中/刪除集合須等於預言機(含 SAME 格,故「退回 HEAD 缺陷行為」亦會轉紅)。
- 結果:見下〈案例表閘門最終結果〉。
- 閘門自驗(`mk-fixtures.mjs`,28 個竄改夾具,每個都須使未歸類 > 0):evErr 竄改、C11(byPk 他列、byPk x 錯、del 殘列、save 全表、)、新增獨有 id 與 s1:false、C1(sel/del 改整表命中)、C9(ctor 訊息、多餘操作格、Infinity del 刪光、終表被改)、C10(訊息、`after`)、C4(整表命中)、C3(不指名)、C2/HEAD 缺陷重現(由預言機轉紅)、預言機(SAME 格少一列)、S1 不一致、C7 `after`、讀取類 `unchanged:false`、INFO 格 SQLSTATE 改變、C2/C10/C5 指名別的欄/鍵、wsemi 共用案例表獨立期望(OK 案命中集合被改、REJ 案被接受、非 schema 案被拒)。**改 `classify.mjs` 或 runner 之記錄規則後,受影響群組兩邊(HEAD 基準與新結果)都要用同一版 runner 重跑,並重跑自驗**。

## R17 字串良構(第 66 項批 1e;S20–S25)

- 依據:dspec〈一之三〉9.(使用者裁示 D1、D2、D4;主控裁示 D3、D5–D8);系列審計 `C:\opensrcOper\dnow\20261020172106\agent-out\run01-系列審計回應.md` §5.2、§6.2(1e)、§8;wsemi 批 0(1.9.24)帳本 R-ORMSTR-01(`chkOrmStr`、`chkOrmData`、`_cvOrmStrCases`);任務 `C:\opensrcOper\dnow\20261020172106\task.md`,共通要求 `…\review\批1共通要求.md`;建議檔 `建議w-orm-postgresql修正.md`.
- 規則:
  1. **單一擁有者**:良構判定只在 wsemi `chkOrmStr`(單一字串)與 `chkOrmData`(資料走訪);本套件不得有私有複本(原 `cvFind.mjs` 之 `isCleanStr`、孤立代理正則已刪;`unit-wellformed` 掃描 `src`:無 `isCleanStr|isWellFormed|toWellFormed|reLone`、無代理碼元範圍、`chkOrmData` 只在 `WOrmPostgresql.mjs` 且恰 1 處呼叫、`chkOrmStr` 在 `WOrmPostgresql.mjs` 恰 4 處〔`chkName`、`idReasonOf`、`checkKeys` 之孤立代理鍵過濾、`rowErrOf` 之 NUL 頂層鍵前置檢核〕與 `cvWrite.mjs` 恰 2 處〔`cvTable`、`colsOf`〕).
  2. **站點全集**(判準:凡把主鍵值、資料字串/鍵名、儲存位址名稱放進 SQL 或連線字串者皆經檢核;**全數已套**):
     | 站點 | 檢核 | 失敗處置 |
     |---|---|---|
     | 建構 `chkName('url'|'db'|'cl')` | `chkOrmStr`(含 NUL;`isestr` 為真者才檢,非字串用預設;`Object('x')` 包裝為 `not a string`) | 建構 throw `invalid opt.<名>: <原因>`;url、db、cl 先於 pk 檢核 |
     | `idReasonOf(pkv)`(`checkPk`、`rowErrOf`、`del`) | 空字串→`string is empty`;`chkOrmStr`(含 NUL);undefined→`primary key is missing`;NaN、包裝物件、無效/裝飾 Date、其他物件→`unsupported primary key value` | 見下〈處置矩陣〉 |
     | `rowErrOf(v, c, k, needKeys)` → `chkOrmData(c, {root:'data[k]'})` | insert、insertBulk(`checkData`)、save(前置迴圈)對每筆資料之字串值與鍵名(巢狀、陣列、Map/Set 等) | insert/insertBulk 整批 reject;save 逐筆 |
     | `rowErrOf` 之 NUL 頂層鍵前置檢核 | 寫入欄名(頂層自有可列舉且值非 `undefined` 之鍵)含 NUL:`chkOrmStr`;NUL 不屬共用檢核(`chkOrmData` 預設不檢),但令 extended 協定 Parse 截斷;與 `cvWrite.colsOf` 同判準(該處為縱深) | insert/insertBulk 整批 reject、save 逐筆,訊息 `invalid data key: contains NUL at [data[k].<invalid key>]`(不屬共用詞彙,案例表 `free` 組須此) |
     | `checkKeys`(save `autoInsert:false`) | 資料鍵須為識別字(既有 W2);**含孤立代理之鍵不在此檢**,留給 `chkOrmData` 以固定詞彙回報 | 整批 reject(`invalid data[k]: unsupported column name …`) |
     | `cvWrite.cvTable`(createTable 表名)、`colsOf`(資料鍵,縱深) | `chkOrmStr` | `invalid createTable: invalid table name`、`invalid data key` |
  3. **處置矩陣**(與各函數既有「無效主鍵」同形;統一規格 T6、dspec〈一之三〉9.3):
     | 函數 | 主鍵字串含孤立代理/NUL | 資料字串/鍵名含孤立代理 | 未帶有效主鍵(未給、空字串、型別不符) |
     |---|---|---|---|
     | `insert`、`insertBulk` | 整批 reject,不寫任何一筆,reject 前發 1 次 `error` | 同左 | 同左(T6) |
     | `save` | 該筆 `{n:1,nInserted:0,nModified:0,ok:0,err}`,同批其他筆照常,每筆失敗發 1 次 `error`(原為整批 reject,D5) | 同左 | 整批 reject(T6;只改訊息為不回顯值) |
     | `del` | 該筆 `{n:0,nDeleted:0,ok:0,err}`,其餘照常 | (不涉資料) | 同左 |
     | `selectByPk` | 回 `null` | — | 回 `null` |
     | 建構 | url、db、cl 含孤立代理或 NUL → throw | — | — |
     整批性錯誤以**最小索引**者為準(跨筆、跨類:缺主鍵、欄名不合文法);同一筆內順序:主鍵 → 欄名文法(僅 `autoInsert:false`)→ 資料良構,故良構性問題(逐筆)不遮蔽同一筆之整批性錯誤;含孤立代理之鍵名不走欄名文法檢核(其訊息會帶出鍵名)而走 `chkOrmData` 之 `<invalid key>`.
  4. **檢查之值即使用之值、先於連線**:`cloneDeep` 之後、`new PgClient` 之前檢核。`chkOrmData` 會呼叫存取器(含 `cloneDeep` 保留之繼承可列舉 getter)一次,其副作用不得改動其後實際寫入者,故**資料走訪在另一份獨立檢核複本上進行**(`checkData`:`cloneDeep(v)`;save 前置迴圈:`let c = cloneDeep(v)`;兩份複本由同一時刻之 `v` 得來,其間未執行任何呼叫端程式碼,內容相同);主鍵之有效性直接讀 `v`(`chkOrmStr`、Date 內部槽判定不執行呼叫端程式碼).`save`/`del` 之主鍵於檢核當下以 `pkSnapshot` 快照(Date 重建為新 Date),`save` 逐筆事件(`error`、`change(insert)`)交 `cloneDeep(v)`(寫入複本當下之獨立快照,內容即寫入者),使事件回呼無法經共用參照(輸入物件之共享巢狀物件、Date)改動其後各筆之寫入或刪除.insert/insertBulk 之事件在寫入完成後才發出,不需快照.
  5. **全批失敗免連線**:`save`/`del` 各筆皆已於連線前判定為逐筆失敗者(`needConn` 為假)不建立 `PgClient`,逐筆結果與事件不因資料庫可否連線而異;批次中仍有待處理之筆時連線失敗仍整批 reject(不回部分結果).`createTable` 之表名、主鍵名、樣本物件鍵與樣本物件本身亦於連線之前檢核並組成 DDL(外審 minimax #10;原在連線之後),不合者不連線、發 1 次 `error` 並 reject.
  6. **訊息固定詞彙、不回顯值**:`invalid id: <原因> at [data[<k>].<主鍵名>]`、`invalid data: <原因> at [data[<k>].<路徑>]`(不合格鍵名以 `<invalid key>` 標示)、`invalid opt.<名>: <原因>`;原因取 wsemi(`string contains lone surrogate`、`string contains NUL`、`not a string`)加主鍵專屬之 `primary key is missing`、`string is empty`、`unsupported primary key value`.舊訊息 `invalid data[k].<pk>[<值>]`、`invalid <pk>[<值>]` 已移除(D6).
  7. **不隨 `autoGenPk`**:本套件無此選項(主鍵從不補值);案例表 id/single/val/order 以 `autoGenPk:false` 再跑一輪,結果不變.
  8. 既有資料不遷移(D8;PostgreSQL 以 UTF-8 儲存,過去寫入之孤立代理已被改寫為 U+FFFD,無從還原),README 載明檢出與清除;排序規則弱相等(mssql/Jet)與本套件無關.
- 盤點指令(可重跑;判準括號內為預期):
  - `rg -n "chkOrmStr\(" src` (WOrmPostgresql 4、cvWrite 2)、`rg -n "chkOrmData\(" src` (恰 1)、`rg -n "^import chkOrm" src` (3)
  - `rg -n -i "isCleanStr|isWellFormed|toWellFormed|reLone" src` (空)
  - `rg -n "chkName\(" src` (定義 1 + url、db、cl 共 4)
  - `rg -n "rowErrOf\(|checkData\(|pkSnapshot\(|needConn" src/WOrmPostgresql.mjs` (站點全集見上表)
  - `rg -n "emitError\('save', \[|emitChange\('insert', \[" src/WOrmPostgresql.mjs` (皆為 `[cloneDeep(v)]`,5 處)
- 測試與指令:
  - `npx mocha test/unit-wellformed.test.mjs --timeout 180000`(不需 docker:案例表 opt 組 48 案、`src` 單一擁有者掃描、死埠下公開 API 之批次索引/事件/免連線/快照、`cvTable` 完整雙引號名稱).
  - `npx mocha test/api-wellformed.test.mjs --timeout 180000`(需 docker,容器 `worm-test-pg66-wellformed`、埠序號 6;逐案套用 wsemi `_cvOrmStrCases`〔API 層 1257 案,PG 為固定欄位後端:`doc` 能力 200 案、`gfs` 150 案略過,第 1 輪執行 907 案;`autoGenPk:false` 輪 id/single/val/order 1038 案,略過 doc 200、gfs 60,執行 778 案;合計略過 610〕+ 本套件特有案:名稱類誤中他表、各類無效主鍵、檢核先於連線、值(良構形態往返、JSONB 巢狀拒收)、save 整批/逐筆分界與批次索引、檢查之值即使用之值〔繼承 getter 副作用、事件共用參照、Date 主鍵〕、全批失敗免連線、雙引號表名 createTable).
  - 既有測試改動:`api-write-safety`(訊息去回顯 10 處、孤立代理主鍵 `save` 改逐筆、孤立代理資料鍵改走共用檢核)、`unit-cvfind`(`isCleanStr` 測試改為對 wsemi `chkOrmStr`)、`test/tools/pgContainer.mjs`(`PORTS` 登錄 `worm-test-pg66-wellformed`:6).
- **修前紅**(未修 `src` 跑新測試;紅集合重算:`node tmp/red/summ.mjs <log> <out.json>` + `node tmp/red/audit-check.mjs`):API 層案例表 1323 格紅(id 105、single 84、val 432、type 48、toctou 3、order 15,另 `autoGenPk:false` 輪 id 105、single 84、val 432、order 15)+ api 特有案 59 格紅 + unit 66 格紅(opt 組 48 案加 8 特有、單一擁有者掃描 4、死埠 API 6;終版測試對 HEAD `src` 重跑:1448 紅/400 綠/610 略過;證據 `…\agent-out\批1-postgresql-evidence\red\`);審計矩陣「修前紅」對照:**值 MANGLE 20**(審計 5 孤立形態〔≈HI_END、LO_END、REV、HI_MID、LO_LEAD〕× 4 寫入路徑〔insert、insertBulk、save 插入、save 更新〕)全數在紅集合內(20/20),`val:*:name:*` 孤立形態共 72 格全紅、良構形態 0 格紅;**名稱類 `cl` 孤立**:HEAD 實測(`tmp/head66/probe-cl.mjs`)高位、低位孤立之 `cl` 實例 `select` 回名為 `t`+U+FFFD 之他表之列、`delAll` 清空該表(2 格誤中);反序(兩個孤立→兩個 U+FFFD)指向不存在之表而由 DB 報錯;審計第 3 格 `cl='t'+U+FFFD` 本身良構、合法指向該表(對照格,修後照常可用);修後三種孤立 `cl` 皆建構 throw `invalid opt.cl: string contains lone surrogate`,他表原封不動(測試 3 格於 HEAD 因建構不 throw 而紅).
- **變異**(`tmp/mut66/run.mjs`、清單 `tmp/mut66/mutants.mjs`,於 `tmp/mut66/work/` 副本逐項改壞 `src`,須先基準 M00 全綠;最終一次完整重跑:59 個變異(M01–M60 去 M43)中 57 個轉紅,基準 M00 全綠;存活 2 個皆經論證為等價或經公開 API 不可達——M51(`save` 之 `pks` 不快照:寫入複本不外流給任何呼叫端程式碼,保留為縱深防禦)、M55(`genInsert` 失敗站點之事件快照:NUL 鍵改於連線前拒收後該站點經公開 API 不可達,只由 `unit-cvwrite` 直測 `colsOf`);歷程:首輪 36 個,外審後新增 23 個(檢核複本獨立 M44/M45、事件快照 M46/M47/M55/M56、Date 快照 M48/M51、免連線 M49/M50、欄名文法優先序 M27/M28/M52/M53/M54、NUL 鍵前置 M57/M58/M60、createTable 前置 M59、複本 M37–M39、主鍵分支 M40–M42);**測試改動後舊錨點會失配,整輪須重跑並確認輸出無 `anchor count` 行**).
- **外審**:sol(`gpt-6.1-sol` max,18.6 分,額度用盡於收尾前〔22:33,`usage_limit_exceeded`〕,報告 (A)–(E) 已寫出)、minimax(`opencode/minimax-m3.1-flash-free` xhigh,58 分,10 條〔中 6、低 4〕,0 誤報)、agy-flash(`gemini-3.8-flash-high`,16.7 分,3 條;Argon 與 agy-opus 開派前額度 100% 故未派);詳見修正報告〈外審評分表〉(共 19 列:sol 5 條加文件精確度註記 1 列、minimax 10 條、flash 3 條;屬實 18、部分屬實 1〔minimax #1〕、誤報 0).採納而改變實作者:檢核複本獨立於寫入複本(sol #1)、事件交獨立快照與 Date 主鍵快照(sol #2)、全批失敗免連線(sol #3)、欄名文法先於資料良構檢核(sol #4)、事件交寫入複本快照而非檢核複本(flash #1)、單元層補死埠 API 斷言(flash #2)、NUL 資料鍵與 `createTable` 引數改於連線前拒收(minimax #1、#10);僅改文件/帳本者:minimax #3、#4、#6、#7、#8 與 sol 之文件精確度註記;未動者:minimax #2、#5、#9(既有行為,見〈已知限制〉).
- 已知限制:
  1. `toJSON`/`toPostgres` 之輸出不檢查(無法不執行呼叫端程式碼而得;wsemi 已知限制 ①),可輸出未檢核字串而被改寫為 U+FFFD.
  2. `String` 包裝物件含成對代理:本批不解包、不改存放形式(主控複審裁示,wsemi 已知限制 ⑧);作為 `opt.*` 時非空包裝為 `not a string`,空包裝視同未給(`isestr`).
  3. 資料鍵含孤立代理者,即使值為 `undefined` 亦拒收(`chkOrmData` 走訪全部自有可列舉鍵);NUL 鍵維持既有「值非 `undefined` 才檢」,但第 66 項起改於連線前拒收(`rowErrOf`;`genInsert` 之 `colsOf` 為縱深防禦,經公開 API 不可達).
  4. 值之 NUL 不屬共用檢核,由 PostgreSQL 拒收(訊息非共用詞彙);主鍵與位址名稱之 NUL 屬共用檢核(D2、D3 延伸:name 類同拒 NUL,規格只明列孤立代理).
  5. 「兩份複本內容相同」之前提:`cloneDeep` 不執行呼叫端程式碼(自有存取器於第一次 `cloneDeep(input)` 讀一次並轉為資料屬性);若呼叫端於 `cloneDeep` 內以 Proxy trap 等執行有狀態程式碼,屬 wsemi 已知限制 ①(有狀態 getter 須由後端固定,本套件以兩份複本達成).
  6. 成本:每筆多一次 `cloneDeep`(實測 20 欄文件約 9 µs;10 萬筆 +0.9 秒),相對 DB 往返可忽略.
  7. 變異 M51(`save` 之 `pks` 不快照)為等價變異:寫入複本不外流給任何呼叫端程式碼(事件交快照),保留 `pkSnapshot` 為縱深防禦.
  8. 全批失敗免連線:`save`/`del` 在 DB 不可連線時對全無效批次也回逐筆結果(原先為整批連線錯誤 reject).
  9. `chkOrmData` 之走訪(全系列同一規則)含本套件不寫入之繼承可列舉屬性,其含孤立代理者誤拒整筆(共用契約 `type:inherit` 要求,外審 minimax #3);`save` 失敗筆 `n:1`、`del` 失敗筆 `n:0`(各自既有形狀,#7);欄名文法錯誤訊息(`unsupported column name [<名>]`,find/order/save autoInsert:false)仍帶出清除後之欄名,與 `cvOrmFind` 一致(#6).

## R18 診斷輸出與對外錯誤值遮罩(第 153 項、第 161 項;S26–S30;依 dspec〈診斷輸出與遮罩〉與 wsemi R-DIAG-01)

- **本節為摘要**:遮罩、摘要、出口之規則與形態語料由 wsemi 單一擁有——跨套件規格 `C:\opensrcOper\dspec\診斷輸出與遮罩.md`(D1–D5、Q1–Q4、P1–P9、§5 已知限制)、wsemi 帳本 `sgud/rule/rulebook_diag.md` R-DIAG-01(來源 repo `C:\opensrc\開源-JS-002-3-wsemi\wsemi`)、共用語料 `wsemi/src/_diagCases.mjs`.**本套件不得自寫等價實作**(D1);2026-10-29 第 161 項遷移,第 153 項(pg-run01)之自製 `src/getDiag.mjs` 已刪.任務 `C:\opensrcOper\dnow\20261029002013`(session mig-pg),報告 `agent-out\mig-pg-修正報告.md`;設計 `agent-out\diag-run01-設計.md` §4.1、§6.
- 規格句(S26–S28 自第 153 項沿用,S29–S30 為第 161 項新增):
  - S26 診斷輸出預設只含固定標籤與不含個資之摘要(資料值、id、使用者識別、錯誤原文、連線憑證皆不出現).
  - S27 `opt.logDetail`(`true` 才生效)與 `opt.funLog(label, safe, detail)`(取代 console)之語意比照 w-serv-orm;型別錯誤者忽略並用預設;選項於建構時成快照.`logDetail` 輸出為 `console.log(label, 遮罩後細節)`(第 161 項起;原為無標籤之 bare 輸出).
  - S28 連線字串與帳密於任何診斷輸出一律以 `***` 遮罩.
  - S29 對外錯誤值不含連線憑證(D3):reject 值、`'error'` 事件之訊息引數、`save`/`del` 逐筆結果之 `err`,凡含外來值(驅動與後端之錯誤、使用端存取器或 Proxy 陷阱拋出之值)者經 `diag.err`:含憑證者為遮罩副本(同類別,`code` 等非秘密欄位保留),無憑證者為原物件;只遮憑證,不遮單獨帳號與資料值(Q3、P1).
  - S30 本套件自身以固定詞彙組成之錯誤(`invalid …`、`can not select by …`)不經遮罩(對固定字串挖空會讓缺口反推短密碼;D3).
- **本套件之宣告**(全在 `WOrmPostgresql.mjs` 之 `getDiag(opt, cfg)`):`secrets: getDiagSecrets({ urls: [url, connectionString] })`(秘密來源為 `opt.url` 與組成之連線字串,帳密由其導出)、`codes: ['sqlstate']`、`types: ['DatabaseError']`、`safeKeys: ['mode']`;`diag(` 恰 2 站,label 為固定二詞(`change handler threw`、`error handler threw`),safe 恆為 `{ mode, ...diag.brief(e) }`;level 不傳(預設 stdout `console.log`,兩站與修改前一致,**無 stderr 站**);`opt` 原樣交 `getDiag` 讀取(`bare`、`method`、`isErr` 舊參數無).
- 規則:
  1. **單一出口**:`src` 內無任何 `console.*`、`process.stdout|stderr|emitWarning`(`unit-diaglog` 掃描,註解與字串不計);診斷輸出只經 wsemi `getDiag`;`src/getDiag.mjs` 已刪.
  2. **驅動呼叫之單一接縫**:`new PgClient`、`client.connect`、`client.query`、`client.end` 各恰 1 處(`pgClient`、`pgConnect`、`pgRun`、`pgEnd`),驅動與後端之拋出與 reject 一律於接縫經 `diag.err` 後再拋出;各站點之 catch、`.catch((err) => err.message)` 之逐筆 `err`、`emitError` 之訊息引數皆取自接縫已遮罩之值.故 `diag.err` 全檔恰 9 處(接縫 4、四個 `cloneDeep` catch、`createTable` 讀樣本 1),`diag.mask` 0 處(逐筆 `err` 之遮罩即接縫).新增驅動呼叫須經接縫(`unit-diaglog` 〈驅動呼叫之單一接縫〉掃描).
  3. **外來值 vs 固定詞彙之判定**:驅動、後端、使用端存取器/Proxy 陷阱/`toString` 拋出者為外來值(包);本套件以固定詞彙組成者不包.`createTable` 之驗證 catch 以 `ours`(WeakSet,`ownErr` 登記)區分(其讀樣本物件之存取器為使用端程式).
  4. **站點全集**(盤點:`rg -n "Promise\.reject\(|diag\.err\(|throw " src/WOrmPostgresql.mjs`,`Promise.reject` 恰 28 處〔createTable 3、select 4、selectByPk 2、insert 4、insertBulk 4、save 4、del 3、delAll 4,`unit-diaglog` 〈reject站點盤點〉鎖定〕;新增站點須先判外來/自身並補本表;行號為 mig-pg 完成時):

     | # | 站點 | 值之來源 | 處置 | 測試 |
     |---|---|---|---|---|
     | 1 | `pgClient`(`:419`) | `new pg.Client` 同步拋出(驅動解析連線字串,如 Invalid URL) | 外來:接縫 `diag.err` | `unit-diagerr` F1(8 操作) |
     | 2 | `pgConnect`(`:427`) | `client.connect()` reject(8 個操作之連線失敗;getaddrinfo 回顯密碼片段等) | 外來:接縫 | `unit-diagerr` F2;`api-diaglog` PG-R3(真驅動,8 操作) |
     | 3 | `pgRun`(`:437`) | `client.query()` reject:createTable DDL、select、selectByPk、insertBatches 之 BEGIN/INSERT/COMMIT、save 預讀/INSERT/UPDATE、del、delAll | 外來:接縫 | `unit-diagerr` F3;`api-diaglog` 真後端回顯 |
     | 4 | `pgEnd`(`:445`) | `client.end()` reject(`finally` 內) | 外來:接縫 | `unit-diagerr` F4 |
     | 5 | insertBatches 之 `throw err`(`:555`) | ROLLBACK 後重拋 BEGIN/INSERT/COMMIT 之錯誤(已於接縫遮罩) | 沿用接縫之值 | F3 |
     | 6 | insertBatches 之 ROLLBACK `.catch(() => {})` | ROLLBACK 自身之 reject | 吞下,無輸出(不取代原錯誤) | F3 |
     | 7 | insert、insertBulk、save、del 之 `cloneDeep` catch(`:1050`、`:1184`、`:1315`、`:1754`) | 呼叫端物件之存取器/Proxy 陷阱拋出之值 | 外來:`diag.err` | `unit-diagerr` F5 |
     | 8 | createTable 之驗證 catch(`:662`) | 讀樣本物件(存取器、`toString`、Proxy)拋出之值 | 外來:`ours.has(err) ? err : diag.err(err)` | `unit-diagerr` F6 |
     | 9 | createTable 自身之 `obj[…] is not an effective object`、`invalid createTable: …`(`:313`、`:322`、`:327`、`:333`、`:651`) | 本套件固定詞彙 | 不包(`ownErr`) | `unit-diagerr` O1–O4 |
     | 10 | select、delAll 之 cvFind/cvOrder 錯誤(`:776`、`:1942`)與 buildSelect/buildDelete 錯誤(`:794`、`:1952`) | 本套件(含呼叫端欄名與使用端 hook 訊息之回顯,見已知限制 1) | 不包 | O5–O7、O16 |
     | 11 | insert、insertBulk 之 checkData(`:1065`、`:1199`),save 整批檢核(`:1347`),checkKeys(`:255`) | 本套件固定詞彙(`invalid id|data`) | 不包 | O8–O10、O14 |
     | 12 | selectByPk 之 `can not select by pk[…]`(`:946`)、select 之 `can not select by find[…]` | 本套件(含呼叫端輸入回顯) | 不包 | O15 |
     | 13 | save、del 逐筆之 `rowErrs[k]`(`:1396`)、`idErrOf`(`:1820`)、genInsert/genConflict 之 `err.message`(`:1507`)、`'no column to update'`(`:1613`) | 本套件固定詞彙 | 不包 | O11–O13 |
     | 14 | save INSERT/UPDATE、del 逐筆之 `err: err.message`(`:1581`、`:1672`、`:1854`) | 後端錯誤(取自接縫已遮罩之錯誤) | 外來:接縫(逐筆 `err` 建立時即遮) | F3;`api-diaglog` |
     | 15 | createTable、delAll 之 `.catch((err) => res = err.message)`(`:701`、`:2014`) | 後端錯誤(接縫已遮罩) | 外來:接縫 | F3;`api-diaglog` |
     | 16 | `emitError` 之 `ee.emit('error', mode, data, getErrMsg(err))` | 訊息引數由各站點之值組成(外來者已遮罩);`data` 為呼叫端輸入,屬回傳契約 | 本身不遮(同時收固定詞彙錯誤) | F2、O1–O16 之事件斷言 |
     | 17 | emitChange/emitError 之 catch → `diag(…)`(`:390`、`:403`) | 訂閱函數拋出之值 | 診斷輸出:`diag.brief` 摘要、細節經 `maskDiagCopy`(detail 清單) | `unit-diaglog` 語料 wire 子集 |
     | 18 | 建構子 `throw`(`:82`、`:126`) | 本套件固定詞彙(不回顯值) | 不包 | `unit-diaglog` R18-8 |
     | 19 | 未掛 `client.on('error')`(連線建立後被後端非同步中斷之未捕捉例外) | 驅動 | 範圍外(既有缺口,待裁示) | — |
     | 20 | console 出口 | 無(僅 getDiag) | — | 單一出口掃描 |
  5. **回傳契約**:無憑證之值與修改前相同(身分、訊息、事件 payload 與先後);`test/tools/diagScenario.mjs` 情境之結果逐項等於 `test/tools/diagGolden.json`(由修改前 HEAD 產生,第 161 項**未重產**,仍全綠),五種選項組合皆同(`api-diaglog` 〈回傳契約不變〉).含憑證者(S29)為預期之行為變化,見 README〈Breaking changes〉.
- 盤點指令(可重跑;判準括號內為預期):
  - `rg -n "console\.|process\.(stdout|stderr|emitWarning)" src` (僅註解:無程式碼)
  - `rg -n "new PgClient|client\.(connect|query|end)\(" src/WOrmPostgresql.mjs` (程式碼各恰 1,於 `pgClient`、`pgConnect`、`pgRun`、`pgEnd`;其餘為註解)
  - `rg -n "diag\.err\(" src/WOrmPostgresql.mjs` (9 處程式碼,另註解)、`rg -n "diag\(" src/WOrmPostgresql.mjs` (2 處)、`rg -n "from 'wsemi/src/getDiag(Secrets)?\.mjs'" src` (各 1)、`ls src/getDiag.mjs` (不存在)
- 測試與指令:
  - `npx mocha --no-parallel test/unit-diaglog.test.mjs test/unit-diagerr.test.mjs --timeout 180000`(不需 docker,假 `pg.Client`:`test/tools/fakePg.mjs`).`unit-diaglog`:wsemi 語料 wire 子集之接線(DISPOSITION 表逐案處置,日後 wsemi 新增 wire 案即轉紅)、選項與出口、秘密來源接線、單一出口與站點盤點、建構函式訊息;`unit-diagerr`:對外錯誤值之站點矩陣(F1–F6)與固定詞彙原樣(O1–O16).形態類測試(字串、鍵、Symbol、包裝物件、Proxy、二進位、Error、循環、數字秘密、摘要代碼集合、秘密導出)已刪,由 wsemi 語料於 wsemi 內測一次(D5).
  - `npx mocha --no-parallel test/api-diaglog.test.mjs --timeout 180000`(需 docker,容器 `worm-test-pg-diaglog`、埠序號 7):預設/logDetail/funLog 實測 console、回傳契約 golden、憑證不外洩、**真驅動之對外錯誤值**(PG-R3 畸形網址 8 操作;後端回顯資料值等於密碼之 insert/insertBulk/select/delAll/createTable/save/del)。
  - 共用:`test/tools/diagScenario.mjs`、`test/tools/diagGolden.json`、`test/tools/fakePg.mjs`.
- 驗證(mig-pg,2026-10-29):修前紅(新測試跑於 HEAD 之 `src`:unit 120 案中 66 案紅〔其餘 54 案為固定詞彙原樣、建構子訊息、單一出口掃描等 HEAD 亦成立者〕;api 41 案中 7 案紅〔logDetail 格式、畸形網址 reject、PG-R3 8 操作、後端回顯 insert/insertBulk/select、delAll/createTable、save/del 逐筆、save 預讀〕)、變異 64 個(`tmp/mig-pg/mutate.mjs`:接縫 4、各站點繞過接縫 36、cloneDeep 4、createTable 2、誤包固定詞彙 11、宣告 7)全數殺死(1 個僅由盤點掃描殺死:ROLLBACK 之 reject 被吞下,行為等價);api 層(挑 8 個)單獨殺 5/8(未殺者:BEGIN 與 `end` 失敗真驅動難造、createTable 固定詞彙路徑不涉驅動,皆由 unit 層之假驅動殺死).詳見報告.
- 已知限制與待裁示:
  1. **回顯呼叫端自身輸入之訊息不遮**(屬回傳契約;待主控裁示是否同樣遮憑證):`createTable` 樣本非物件之 `obj[<值>]`、`can not select by find|pk[…]`、`cvFind`/`cvOrder` 之欄名回顯與使用端 getter/Proxy 陷阱所拋錯誤之訊息(`cvFind.mjs` 之 `fail('can not read keys: …')`、`invalid find: <hook 訊息> at [find]`);`'error'` 事件之 `data` 引數為呼叫端輸入.
  2. `new PgClient` 未掛 `client.on('error')`:連線建立後被後端非同步中斷為未捕捉例外(既有,範圍外).
  3. `BEGIN/COMMIT/ROLLBACK` 不經 `pgq`(R8 刻意):`Object.prototype.name` 資料型汙染 > 63 字元時 pg 當具名查詢並 `console.error`(pg-protocol serializer;既有,範圍外).
  4. wsemi 規格之已知限制(dspec §5)適用:reject 清單之短密碼(< 4 字元)不遮、單獨帳號於 reject 不遮、私有欄位無法複製至副本、Node < 20.16 無 `util.types` 時 Proxy 不可偵測等;`pg` 之 `DatabaseError` 實例自帶 `name = 'error'`,wsemi 之類別名規則優先取實例 `name`,故真驅動錯誤之 `errType` 為 `Error`(宣告 `types: ['DatabaseError']` 僅對 `name` 未被改寫者生效;已列 `建議wsemi修正.md`).
  5. 驅動/程式庫自身輸出(pg-connection-string 之 sslmode 警告、knex 固定文字警告、`DEBUG=knex:*`)不經單一出口(README 載明);第 153 項之盤點結論不變.

## 案例表閘門最終結果(第 3 次執行 v10:定稿實作 vs HEAD `8133f58`;工具 `tmp/cases/gate.mjs v10`;歷程 v8 → v9〔wsemi 組加註 `schema` 旗標重跑〕→ v10〔外審 sol 後 `src/emitKnex.mjs`、`buildSql.mjs`、`WOrmPostgresql.mjs` 有改,整表重跑;runner 加整表全欄快照 `unchangedFull`、預言機改在 select 之前取得;歸類器 patch 4〕)

- **v10 結果**:13491 格 / 6765 記錄,差異歸類格數與 v8/v9 完全相同(C1 174、C2 57、C3 63、C4 13、C5A 24、C5 2、C11 38、C7 10、C8 1、C9 15、C10 13),INFO sel 82 / del 78,**未歸類 0**;S1 6016 格 0 違反;預言機 4087 格;`unchangedFull` 6333 格 0 為 false;預言機落差帳 O-BOOL 167、O-FIELD 105(外審 sol F02:原敘述「預言機相符」只對新結果成功者成立,此帳把「預言機成功而新結果被拒/SQLSTATE 不同」的 272 格〔含 del〕明文歸類,其餘類別一律未歸類);時區 UTC / New_York 各 1260 格 0 差異;閘門自驗 **36** 個竄改夾具全轉紅(新增 8 個:order 合法鍵被拒、order Infinity 空結果、C1 del 無關錯誤、sel.n 不符、重複 id、del 計數不符、新舊同錯〔預言機落差〕、整表全欄快照改變;其中前 5 個與新舊同錯、全欄快照在舊歸類器下為 0)。以下數字為 v9 時記錄,v10 相同。

- 13491 格(6765 記錄)。差異全落已裁示之變更類(格數;判準見 R16):C1 174、C2 57、C3 63、C4 13、C5A 24、C5 2、C11 38、C7 10、C8 1、C9 15、C10 13(共 410);INFO(僅 PG 訊息措辭差,同 SQLSTATE)sel 82 / del 78;**未歸類 0**。
- **全域獨立預言機**:4087 格有預言機(預期成功 1556、預期 PG 錯誤 2531),新結果成功者之命中/刪除集合皆等於預言機;S1 不變式 6016 格 **0 違反**;UTC 與 America/New_York 各 1260 格對同版 runner 重跑之 HEAD **0 差異**。
- 補充軸 `axes-diff.mjs`(外審 opus 提供,38 案):36 同、2 差(C3、C8 同型)。
- wsemi 共用案例表 255 案之獨立期望(REJ 178、OK 74、ALL 3;schema 允許被 PG 拒 15)全數相符;閘門自驗 28 個竄改夾具全數轉紅;歷程:run02 初版歸類器對 C1/C4/C9/C10/C11 之竄改夾具為「未歸類 0」(外審 opus、minimax 實證),已收緊並加入預言機後重跑(v7 → v8)。邊界案 `params-65535-exact`/`params-65536`/`in-65535-params` 原實為 55535/55536/50002 個參數(標籤誤,外審 opus F7),已改為 65535/65536/65535 並重跑 HEAD 之 logic 組(`out-head-all6.json`)。

## 變異驗證結果(run02;工具 `tmp/mut/run.mjs`、清單 `tmp/mut/mutants.mjs`)

(見下表;每個變異體在 `tmp/mut/<id>/` 之 src/test 副本上施作,先跑 `unit-*`,全綠再跑 `api-*`;任一失敗即「殺死」.)

基準 M00(無變異,同一套件副本與同一跑法):unit 742 過 / 0 敗;api 1072 過 / 0 敗。變異 50 個:殺死 50、存活 0(M01–M46 基準為 unit 742 / api 1072;M47–M50 於第 3 次執行以 1820 案版本施作,基準全綠).

| 變異 | 方案 | 內容 | 結果 | 失敗案數(unit / api)| 首個轉紅之測試 |
|---|---|---|---|---|---|
| M01 | ①+主控 | 拿掉 verifySql(out() 不呼叫) | 殺死 | 2 / 未跑(unit 已紅) | 1) buildSql: no global prototype is touched, and polluted prototypes never change the SQL silently (E7, R2) sh |
| M02 | ② | verifySql 不比對 values(相等判定恆真) | 殺死 | 1 / 未跑(unit 已紅) | 1) verifySql: the statement must be the one derived from the IR (E2, E6) should reject values that differ from |
| M03 | ③ | whereNull 改 where(c,"=",null)(knex 產生 = $1 [null]) | 殺死 | 72 / 未跑(unit 已紅) | 1) buildSql: exact SQL and values per IR node (E4, node semantics table) should build select for [null-eq] (nu |
| M04 | ④ | 布林等值改回 = TRUE/FALSE(運算子重新解析) | 殺死 | 26 / 未跑(unit 已紅) | 1) cvFind: accepted finds produce the hand-written SQL and values (S4) should get the hand-written SQL and val |
| M05 | ⑤+主控 | 取消表別名 "$t" | 殺死 | 201 / 未跑(unit 已紅) | 1) cvFind: accepted finds produce the hand-written SQL and values (S4) should get the hand-written SQL and val |
| M06 | ⑥ | 系統欄清單少 1 個(cmax) | 殺死 | 6 / 未跑(unit 已紅) | 1) cvColumns: data keys of UPDATE must be bare identifiers (W2) should throw unsupported column name for "cmax |
| M07 | ⑦ | 空 in 不產生恆假(改 whereIn(c, [])) | 殺死 | 9 / 未跑(unit 已紅) | 1) cvFind: accepted finds produce the hand-written SQL and values (S4) should get the hand-written SQL and val |
| M08 | ⑧ | maxParams 計數少算 in 元素 | 殺死 | 8 / 未跑(unit 已紅) | 1) lowerFind: bound-parameter counting and opt.maxParams (L6) should count 1 per cmp and 1 per in element, 0 p |
| M09 | ⑨ | lowerFind 以索引指派取代 defineProperty | 殺死 | 2 / 未跑(unit 已紅) | 1) lowerFind: immune to prototype pollution and index setters (L9) should produce the same IR while an Array.p |
| M10 | ⑩ | order 方向未正規化為小寫 | 殺死 | 3 / 未跑(unit 已紅) | 1) cvOrder (S7, S14) should return an ordered array of null-prototype {c, dir, nulls} items (dir lower-cased,  |
| M11 | ⑪+主控 | order 收回接受 ->/->>/#>/::(cvOrder 放行) | 殺死 | 7 / 未跑(unit 已紅) | 1) buildSql: order is built from fixed literals (E5) should not accept JSON-path or cast keys (order keys are  |
| M12 | ⑫ | emitKnex isScalar 恆真 | 殺死 | 1 / 未跑(unit 已紅) | 1) buildSql: emitKnex re-checks identifiers and values (E1, defence in depth) should reject non-scalar values: |
| M13 | ⑬ | cmp 的 != 寫成 = | 殺死 | 82 / 未跑(unit 已紅) | 1) cvFind: accepted finds produce the hand-written SQL and values (S4) should get the hand-written SQL and val |
| M14 | ⑭ | IR 單項不展開(語意等價;IR 契約層應轉紅、公開行為層不應轉紅) | 殺死 | 84 / 未跑(unit 已紅) | 1) lowerFind: node semantics table (hand-written expectations, L1–L5 L10) should lower [eq-string] (cmp eq) to |
| M15 | ⑮ | 63 bytes 欄名檢核移除 | 殺死 | 9 / 未跑(unit 已紅) | 1) cvColumns: data keys of UPDATE must be bare identifiers (W2) should throw unsupported column name for "cccc |
| M16 | 主控 | 系統欄拒收整段移除 | 殺死 | 27 / 未跑(unit 已紅) | 1) cvColumns: data keys of UPDATE must be bare identifiers (W2) should throw unsupported column name for "ctid |
| M17 | ⑳ | verifySql 由詞彙序列改為多重集合(排序後比對) | 殺死 | 5 / 未跑(unit 已紅) | 1) verifySql: the statement must be the one derived from the IR (E2, E6) should reject a tampered statement: r |
| M18 | ⑲ | 建句移到建立 pg.Client 之後(S11) | 殺死 | 0 / 2 | 1) whitelist: a bad find sends nothing to PostgreSQL (S11) should construct, connect and query when the find i |
| M19 | ㉒ | verifySql 對 order 單獨失敗仍報 invalid find | 殺死 | 1 / 未跑(unit 已紅) | 1) verifySql: the statement must be the one derived from the IR (E2, E6) should name order as the failing part |
| M20 | ㉑ | 表名經 knex raw 解析(不用佔位詞) | 殺死 | 1 / 未跑(unit 已紅) | 1) buildSql: table names are never parsed by knex (E4) should render table "we?rd" as "we?rd" with the fixed a |
| M21 | 主控 | 欄位改回帶別名限定("$t"."c")+ verifySql 拿掉(第 76 項機制失效) | 殺死 | 197 / 未跑(unit 已紅) | 1) buildSql: exact SQL and values per IR node (E4, node semantics table) should build select for [eq-string] ( |
| M22 | 主控 | 布林 $ne 未反相(IS TRUE 對 $ne:true) | 殺死 | 67 / 未跑(unit 已紅) | 1) buildSql: exact SQL and values per IR node (E4, node semantics table) should build select for [bool-ne-true |
| M23 | 補 | or 連接誤為 and(orWhere 旗標恆 false) | 殺死 | 82 / 未跑(unit 已紅) | 1) buildSql: exact SQL and values per IR node (E4, node semantics table) should build select for [or] (or): |
| M24 | 第88項 | 測試容器收尾不帶 -v(遺留匿名 volume) | 殺死 | 0 / 2 | 1) container cleanup: anonymous volumes are removed with the container (item 88) should remove every anonymous |
| M25 | R4 | checkPk 重新拒收首尾 $ 主鍵 | 殺死 | 0 / 7 | 1) write: pk values that start and end with "$" are ordinary literal values and never hit other rows (S6, was  |
| M26 | R8 | cvKey 不忽略來源路徑 p | 殺死 | 2 / 未跑(unit 已紅) | 1) cvKey: cache keys distinguish values that JSON.stringify would merge (S8) should ignore the source path p o |
| M27 | R8 | pgq 移除 queryMode extended | 殺死 | 0 / 2 | 1) write: statements use a null-prototype extended-protocol query config (no stacked statements, no polluted p |
| M28 | 補 | $ne:null 誤為 is null(not 恆 false) | 殺死 | 10 / 未跑(unit 已紅) | 1) lowerFind: node semantics table (hand-written expectations, L1–L5 L10) should lower [null-ne] (null not) to |
| M29 | R12 | 宣告之 PG 預設 maxParams 改為 65536(多放 1 個) | 殺死 | 4 / 未跑(unit 已紅) | 1) cvFind: unsupported or untranslatable finds throw (S2 S3 S5) should throw when total bound parameters excee |
| M30 | 補 | withCleanProto 式修改全域原型的反例:建句前清除 Object.prototype 非標準成員且不還原 | 殺死 | 4 / 未跑(unit 已紅) | 1) buildSql: no global prototype is touched, and polluted prototypes never change the SQL silently (E7, R2) sh |
| M31 | 補 | save UPDATE 之 WHERE 改回表限定欄名 | 殺死 | 0 / 1 | 1) write: pk and find conditions are sent with unqualified column names and the table alias "$t" (selectByPk,  |
| M32 | 補 | cvOrder 丟棄 nulls first|last | 殺死 | 7 / 未跑(unit 已紅) | 1) buildSql: order is built from fixed literals (E5) should render direction and nulls placement: |
| M33 | 補 | emitOrder 方向恆為 asc | 殺死 | 56 / 未跑(unit 已紅) | 1) buildSql: order is built from fixed literals (E5) should render direction and nulls placement: |
| M34 | 補 | 恆假 in 改為恆真(falseRaw = true) | 殺死 | 9 / 未跑(unit 已紅) | 1) buildSql: exact SQL and values per IR node (E4, node semantics table) should build select for [in-empty] (i |
| M35 | 補 | in / not in 對調 | 殺死 | 92 / 未跑(unit 已紅) | 1) buildSql: exact SQL and values per IR node (E4, node semantics table) should build select for [in] (in): |
| M36 | 補 | eqNode 布林主鍵誤為 cmp 節點 | 殺死 | 3 / 未跑(unit 已紅) | 1) eqNode: single-column equality IR for primary-key conditions should build cmp eq for string / number / Date |
| M37 | 補 | lowerFind 不呼叫 checkColumn 掛鉤 | 殺死 | 14 / 未跑(unit 已紅) | 1) lowerFind: opt.checkColumn hook (L7) should call the hook for every column key (not for $and/$or) and let i |
| M38 | 補 | maxParams 邊界差一(>= 取代 >) | 殺死 | 6 / 未跑(unit 已紅) | 1) lowerFind: bound-parameter counting and opt.maxParams (L6) should count 1 per cmp and 1 per in element, 0 p |
| M39 | 補 | verifySql 不檢查語句開頭 | 殺死 | 1 / 未跑(unit 已紅) | 1) verifySql: the statement must be the one derived from the IR (E2, E6) should reject a wrong head (table par |
| M40 | 外審(minimax) | save(autoInsert:false) 不再檢核資料鍵為識別字(checkData 第二參數恆 false,回到 HEAD 行為) | 殺死 | 0 / 18 | 1) write: save UPDATE path (autoInsert:false) uses bound parameters (W2) should reject whole batch and write n |
| M41 | 外審(opus) | 驗證後不複製綁定值(Date 實體與 IR 共用,驗證與送出之間可被改動) | 殺死 | 1 / 未跑(unit 已紅) | 1) buildSql: exact SQL and values per IR node (E4, node semantics table) should hand out a snapshot of the ver |
| M42 | 外審(opus F3) | quoteTable 改回 String.prototype.split(Symbol.split 汙染可改寫表名) | 殺死 | 1 / 未跑(unit 已紅) | 1) buildSql: no global prototype is touched, and polluted prototypes never change the SQL silently (E7, R2) sh |
| M43 | 外審(opus F5) | emitKnex 的 isScalar 改為 Number.isFinite(主鍵 ±Infinity 被擋) | 殺死 | 0 / 4 | 1) matrix: column type × operator × value against an independent SQL oracle (S1 S4 S12) column d: $in (1 and 2 |
| M44 | 外審(opus F6) | 移除 out() 對 knex 輸出開頭之逐字檢查(h0) | 殺死 | 1 / 未跑(unit 已紅) | 1) buildSql: no global prototype is touched, and polluted prototypes never change the SQL silently (E7, R2) sh |
| M45 | 外審(minimax T1) | checkPk 接受帶自有屬性之 Date(裝飾過之 Date) | 殺死 | 0 / 3 | 1) write: wrapper objects and decorated Dates are invalid pk values (W3) on a TIMESTAMPTZ pk table |
| M46 | 外審(minimax T1) | ownData 不排除主鍵欄(save 只帶主鍵時變成 UPDATE SET 主鍵) | 殺死 | 0 / 8 | 1) basic should get [{"n":1,"nInserted":0,"nModified":0,"ok":1},{"n":1,"nInserted":0,"nModified":1,"ok":1},{"n |
| M47 | 外審(sol F03) | emitKnex 把 IR 持有的 Date 原物件交給 knex(不給獨立副本): knex 讀屬性時就地改寫會同時改 IR 與 bindings | 殺死 | 1 / 未跑(unit 已紅) | 1) buildSql: exact SQL and values per IR node (E4, node semantics table) should reject, never send, a Date tha |
| M48 | 外審(sol F05) | verifySql 移除值純量防線(IR 與 bindings 持有同一非純量時只靠此防線) | 殺死 | 1 / 未跑(unit 已紅) | 1) verifySql: the statement must be the one derived from the IR (E2, E6) should reject a non-scalar value by t |
| M49 | 外審(sol F06) | returnList 比對: 回傳為 number 時字串輸入不做數值轉換(INTEGER 主鍵 '01' 等逐筆誤報未插入) | 殺死 | 0 / 1 | 1) insert returnList should get [1,0,1,0,1] for insert with returnList by INTEGER pk given as strings ('01', ' |
| M50 | 外審(sol F06) | returnList 比對: 回傳為 boolean 時字串輸入不做布林轉換 | 殺死 | 0 / 1 | 1) insert returnList should get [1,1,0] for insert with returnList by BOOLEAN pk given as strings ('t', '0', ' |

註(M45/M46):`checkPk`、`ownData` 是 `WOrmPostgresql()` 閉包內函式,unit 層構造不到(minimax 以自備 unit 副本施作同型變異而存活);本專案改在 api 層釘住(M45 由 `api-write-safety` W3 案、M46 由 `api-postgresql` 的 save 案殺死),不為此把閉包函式匯出。
註:①M14(IR 單項不展開,方案原預期「語意等價、不應轉紅」)在 IR 契約層(`unit-lowerfind`、`unit-sqlbuild` 精確 SQL)與公開 API 層之「精確 SQL 文字」斷言(`api-write-safety` 3 案)轉紅;**結果集層(`api-matrix` 命中集合、S1 對拍)未紅**——IR 正規形是契約的一部分(單項展開亦決定快取鍵同一性),故契約層轉紅屬刻意.②M01(拿掉 `verifySql`)由 `unit-sqlbuild` 的汙染測試(non-configurable 子行程、`distinct`/`only`/`returning` 等會改寫語句之名稱)與 `api-find` 汙染案殺死;由於已不做原型清除,一般(configurable)汙染亦直接測到 `verifySql`.③M12(`isScalar` 恆真)原本被後援層 `verifySql` 的純量檢查遮蔽而存活於 unit,收緊測試(要求訊息出自發射端 `at [emit]`)後才被殺——縱深各層須各自有測試.④M18(建句移到建立 `pg.Client` 之後)由 `api-find-whitelist` 的 S11 spy 案殺死.⑤不做之變異:方案 ⑯⑰⑱(`withCleanProto` 相關,主控 R2 裁示不採 `withCleanProto`)、㉔(`out()` 之表頭逐字比對:`verifySql` 另有同一表頭檢核,M39 已覆蓋該檢核).

## 盤點指令總表(可重跑;判準括號內為預期)

- `rg -n "mongo" src package.json toolg` (空)
- `rg -n "cvOrmFind\(" src` (恰 1)、`rg -n "cvFind\(" src/WOrmPostgresql.mjs` (2)
- `rg -n "buildSelect\(|buildDelete\(|lowerFindEq\(" src/WOrmPostgresql.mjs` (站點全集,R6:select 1、selectByPk 1、save 預讀 1、del 1、delAll 1;lowerFindEq 3)
- `rg -n "withCleanProto|process\.env" src` (空)
- `rg -n "client\.query\(" src/WOrmPostgresql.mjs` (程式碼恰 1 處,於 `pgRun`;其餘為註解;R18 單一接縫)
- `rg -n "\./lowerFind|eqNode|ir-snapshots|genIrSnapshots|unit-lowerfind|[ (\`]src/lowerFind" src test` (僅 `test/unit-irsemantics.test.mjs` 之 I5 守門碼自身一行;第 94 項①後 `lowerFind`/`lowerFindEq` 皆自 wsemi 引入)、`rg -n "from 'wsemi/src/lowerFind(Eq)?\.mjs'" src` (cvFind 1、WOrmPostgresql 1)
- `node test/tools/pollutionSweep.mjs --all --protos --symbols` (diff 0、leak 0;升版 knex 必跑)
- `node -e "console.log(require('./package.json').dependencies.knex)"` (確切版本字串 `3.3.0`,不含 `^`/`~`;`npm ls knex` 單一版本)
- `docker volume ls -q -f dangling=true | wc -l` 於全套測試前後 (不增)
- 第 153、161 項(R18):`rg -n "console\.|process\.(stdout|stderr|emitWarning)" src` (無程式碼,僅註解)、`rg -n "diag\(" src/WOrmPostgresql.mjs` (2 處)、`rg -n "diag\.err\(" src/WOrmPostgresql.mjs` (9 處程式碼)、`rg -n "from 'wsemi/src/getDiag(Secrets)?\.mjs'" src` (各 1)、`ls src/getDiag.mjs` (不存在)
- 第 66 項(R17):`rg -n "chkOrmStr\(" src` (WOrmPostgresql 4、cvWrite 2)、`rg -n "chkOrmData\(" src` (恰 1)、`rg -n -i "isCleanStr|isWellFormed|toWellFormed|reLone" src` (空)、`rg -n "emitError\('save', \[|emitChange\('insert', \[" src/WOrmPostgresql.mjs` (皆 `[cloneDeep(v)]`,5 處)、`rg -n "needConn" src/WOrmPostgresql.mjs` (save、del 各 3 處)

## 已知限制(文件化)

- **order 的 Proxy 陷阱訊息回顯(外審 sol F04;既有,HEAD 同,刻意保留)**:`readOwn` 在 `Reflect.ownKeys`/`getOwnPropertyDescriptor` 拋錯時把呼叫端 hook 的 `err.message`(經 `clean` 限 200 字、去控制字元)放進 `invalid find|order: can not read keys: … at […]`。依本帳本「其餘例外一律包成新 Error(保留其訊息)」規則,訊息只回到寫了該 hook 的呼叫端,不跨越任何信任邊界(JSON 造得出的物件不會有 Proxy 陷阱);若日後要求固定原因字串,屬主控裁示之破壞性微調,本輪不改。
- **`insert(…, {returnList:true})` 對 BIGINT/NUMERIC 主鍵的字串輸入**:回傳值為字串,輸入須與回傳字串同形(`'01'` 對 BIGINT 欄會逐筆誤報未插入);INTEGER/FLOAT/BOOLEAN 已於第 3 次執行修正(R7)。完整修法需依欄位型別正規化(或由 SQL 回傳輸入序號),屬另案,待主控裁示。

- **第 76 項殘餘(R13)**:①視圖輸出欄若取名 `ctid`/`tableoid`/`xmin`/`xmax`/`cmin`/`cmax`,find/order/`opt.pk` 一律拒收(收窄);②63 bytes 以 UTF-8 計,**非 UTF8 伺服器編碼**下長多位元組欄名可被伺服器截斷而解析到他欄(HEAD 同,非回歸;README 限 UTF8);③支援 PG ≥ 12(`oid` 在 PG ≤ 11 且表帶 OIDS 時為系統欄;實測僅 PG 17);④insert/insertBulk/save(autoInsert:true) 不預先拒收系統欄名(由 PG 回報;寫入路徑無「條件變寬」之危險);⑤`delAll` 遇函數名欄名以 DB 錯誤**字串** reject、遇系統欄名以 `Error`(`invalid find`)reject(既有 Q10 之自然結果);⑥`{c:{$in:[]}}` 不引用欄位,錯欄名在此形狀不被回報(R7 裁示).
- **汙染保證之範圍(R12;外審 opus F2/F3/F4)**:保證涵蓋**資料型汙染**(JSON 造得出之屬性);存取器、函式值、`Symbol` 鍵之汙染需程式碼執行權,不在保證內,惟縱深:表名拆段不用 `String.prototype.split`(`splitDots`;`Symbol.split` 函式可改寫其結果,`pollutionSweep --symbols` 驗證)、驗證通過後之綁定值轉為獨立快照(`snapshotValues`:knex 的 bindings 與 IR 共用 Date 實體,存取器於建句時取得該實體並在連線等待期間改寫即可令送出之值不同於驗證之值,已修並有單元測試)。**連線參數**由 `pg` 自一般物件讀取(`options/host/ssl` 可繼承被汙染之 `Object.prototype`,例如 `options: '-c search_path=other'` 令未限定 schema 之表解析到他 schema):HEAD 同,非回歸,不在本套件控制範圍(`pgq` 只保護 query config)。
- **主鍵三函數(selectByPk/save/del)之建句在連線之後**(逐筆;汙染下建句失敗時 `del` 為整批 reject 而非逐筆 `ok:0`,訊息為 `invalid find: … (statement check)`);select/delAll 則建句先於連線(S11)。
- **knex 版本(主控 2026-10-20 裁示:鎖確切版本)**:`package.json` 之 `knex` 為確切版本 `"3.3.0"`(不帶 `^`;比照 w-maplibregl-vue 鎖 `maplibre-gl`),理由:`verifySql` 之期望序列依 knex 現行輸出格式(括號/運算子/`and` `or` 連接詞),使用端安裝時若取得 3.x 新 minor 而格式改變,所有 select/delAll 會 fail-closed 拒絕。**升版 knex 須**:①改 `package.json` 確切版本並更新 lock;②跑 `unit-sqlbuild` 與 `node test/tools/pollutionSweep.mjs --all --protos --symbols`;③IR/SQL 形狀若有變,更新 `test/tools/irSemantics.mjs` 之 `SQL` 骨架(IR 契約表與快照屬 wsemi,第 94 項①起不在本套件重產);④重跑案例表閘門。`dist/` 由發布流程重建(追蹤中之舊 `dist/` 仍 `require('mongo-sql')`,發布前須重建,本輪以 `tmp/build-dist-run02.mjs` 驗證 UMD 打包與載入可行)。
- **verifySql 與汙染(R12)**:`verifySql` 為與 IR 同源之結構檢查,不是語意證明;`Object.prototype` 等內建原型被資料型汙染了 knex 內部會讀取之名稱時(`join set wrapIdentifier isRawInstance returning using where with only order having offset limit lock waitMode distinct union hintComments distinctOn _tableName` 等,依值而定),`select`/`delAll` 以 `invalid find|order: … (statement check)` fail-closed reject(拒絕服務而非靜默改寫;本套件不改動全域原型);non-configurable 汙染無法被任何程式移除,同樣由 `verifySql` 兜底;汙染掃描之母體為 knex lib 內出現過之名稱(不證明無未知名稱,證明力來自全文序列比對);knex 升版須重跑全量掃描.
- **布林不對稱(R11 裁示維持)**:布林值於 `=`/`$ne`/比較運算子為字面值(`IS TRUE`…),於 `$in`/`$nin` 內為綁定參數(HEAD 即如此):`{s:{$in:[true]}}` 對文字欄可命中 `'true'`,`{s:true}` 為型別錯.IR 移 wsemi 前以此定案.
- **主鍵值 `$..$`(R4 放寬)**:對非 text 主鍵欄為與其他型別不符字串相同之 PG 型別錯(`selectByPk` 回 null、`del` 逐筆 `ok:0`、insert/insertBulk/save 以 PG 錯誤 reject);`save` 逐筆執行、不包交易(既有),故前筆已寫入而後筆型別錯時整批 reject 但前筆已存在.
- **寫入路徑 `save(autoInsert:true)` 於可更新視圖不支援**(`RETURNING (xmax = 0)` 在視圖 42703;HEAD 同).

- 檢核器不查 schema:欄名不存在、大小寫變體(所有路徑皆以雙引號引用欄名,不折疊;含大寫之鍵須與欄名逐字相同)由 PG 回報.`{c:{$in:[]}}` 不引用欄位,錯欄不被回報.
- **第 76 項已解決(R13)**:欄名未限定引用 + 表別名 `"$t"` + 拒收 6 個系統欄名後,錯拼欄名為函數名或與表名同名者由 PG 回報 42703,條件不再對全表成立(舊版 HEAD:`{concat:{$ne:'x'}}`、`{tableoid:{$gt:0}}` 使 `delAll` 刪光全表).殘餘限制見下列「第 76 項殘餘」各條.
- 欄名限識別字(Unicode 字母可);含 `$`、`.`、引號、空白、連字號者不支援(需以 view 或欄別名重新命名).
- 整數超過 2^53 之精度由呼叫端自負(用字串或 bigint);Buffer 值適用 bytea 欄(`api-write-safety` 已測 insert 與 UPDATE).
- 表名(`opt.cl`)為建構設定,視為可信、不檢核:含 `"` 者 `quoteTable` 原樣使用(呼叫端自負之 SQL 片段,不經 `verifySql` 詞彙驗證);主鍵名(`opt.pk`)則於建構時檢核為識別字(R9);`createTable` 之表名為呼叫端參數,經 `cvTable` 檢核(R9).
- 單一 find 之上限:深度 32、`$and/$or` 長度 1000、`$in/$nin` 長度 10000、節點 100000(以上為 wsemi 預設,pg 不下調)、欄名 128 字元(wsemi;pg 另限 63 bytes)、綁定參數 65535(pg 專屬,第二階段).
- **Date 值的序列化屬 `pg` 套件(HEAD 同,外審 opus 三.2/三.3,未處理)**:`pg` 以 `getTimezoneOffset()`(整數分鐘)配當地時間序列化 `Date`,程序時區之歷史偏移含秒(LMT)時送出之時刻偏差數秒至數十秒(實測 `TZ=Africa/Monrovia` 1930-06-01 → −30000 ms;`Asia/Taipei` 無偏差),寫入與 find 同受影響;超出 PG timestamp 範圍之有效 Date 於連線後由伺服器報錯(非 `invalid find`),對 TEXT 欄則以序列化字串比較不報錯.dspec 將 DATE 範圍歸各後端轉譯層,是否於第二階段預檢/改送 UTC ISO 字串待主控裁示.
- `cvOrder` 的欄名鍵自第 58 項起與 find 同文法(僅識別字;JSON 取值鍵與 `::` 轉型鍵 reject,C5/C5A,主控 R3 裁示).
- `cvKey` 仍保留 bigint、Buffer 之快取鍵分支:find 路徑已不可能含此二型別(reject),分支只在 `cvKey` 被直接以含此二型別之物件呼叫時有意義(方案 §4.5「`cvKey` 不動」).
- 頂層 `new Proxy({}, {})` 與回報零鍵之 Proxy(如 Vue 3 `reactive({})`)由「全部」改為 reject(wsemi `cvOrmFind` 規則 16:空即全部須可證明為真實空物件);須傳 `{}`/`undefined`;非空 Proxy 包一般物件照常接受.無可用 `structuredClone` 之環境(Node 17 以下)此項檢核降級(wsemi 已知限制 9).
- (已取消)舊限制「首尾皆 `$` 之字串於 `$gt…$lte` 不支援」隨 mongo-sql 移除:現為字面值.
- delAll 的 PG 錯誤以 `err.message` 字串 reject、select 以 Error 物件 reject(既有,不改;Q10);新檢核之錯誤一律 `Error`.
- 頂層 find 非 `undefined`/一般物件者 reject(裁示 B),見〈條件(find)之支援範圍〉;不再有「維持現況」之項目.
- pg 連線層本身(`pg` 套件內部讀取一般物件之處,如 `Client` 建構設定、型別解析器)不在本套件控制範圍;送出之查詢設定物件已改 null 原型(R8).
- 呼叫端傳入之 `data` 的 `cloneDeep` 若拋例外(getter 拋錯等):已移入 try,reject 前發 1 次 `error` 事件(insert、insertBulk、save、del;外審 opus F13/Argon F7);各函數 `finally` 內 `client.end()` 拋錯會覆蓋原錯誤(既有;主控 run02 複審裁示不修).
- `Object.prototype.get`/`.set` 被資料型汙染:`pg` 套件內部 `defineProperty` 之描述子字面量繼承之而拋 `Getter must be a function`,**所有**函數 reject(fail-closed 之拒絕服務;`new PgClient(...)` 位於 try 之外故 select/selectByPk/del/… 不發 error 事件;HEAD 同,屬 `pg` 套件).本套件自身之描述子已改 null 原型.
- `useCache` 下 select 與寫入併發時,select 完成後才 `setCache` 可能把過期結果存入(期間有寫入呼叫 `clearCache`);HEAD 同,文件載明 useCache 適用單程序操作,但同程序併發 async 亦會觸發;修法為世代計數器(`clearCache` 遞增、`setCache` 僅在世代未變時寫入),列入下輪.
- **不修(主控 run02 複審裁示)**:`selectByPk(true)`/`selectByPk(1e12)` 於 INTEGER 主鍵表由 PG 回 `42804`/`22003` 而 reject(`isErrPkType` 只涵蓋 `22P02`/`22007`)——型別與欄位不符之主鍵值依欄位型別而異,維持 reject(僅訊息為 PG 原文),與 HEAD 相同.
- `save` 預讀比對把值為 `undefined` 之鍵視為變更(`vt` 含 `ownData(v)` 之 `undefined` 鍵,與現值不 `isEqual`):內容實質未變時仍可能走到 UPSERT 而 `nModified` 多報 1(僅計數,資料不變);W5 令 `undefined` 鍵不進 `SET`,故不影響資料.

- 第 66 項(R17)已知限制見 R17〈已知限制〉9 條;另:單一無可列舉鍵之記錄(`insert({})`、`insert([{}])`、`save({})`、`del({})`、單元素陣列含 null/undefined/空字串/NaN)被入口守衛視為空輸入、不進主鍵檢核(R10 既有,外審 minimax #2 指出,維持不修);`selectByPk` 遇 42804 型別錯 reject(既有,外審 minimax #5,維持不修);`order` 欄名含孤立代理時訊息原樣回顯(`cvFind.clean` 只置換 C0 控制字元,條件與欄名屬既有範圍,外審 minimax #9,未動).

## 破壞性變更紀錄(版本 patch,Q9;2026-10-16)

- 凡原本**靜默放行**而今 reject(安全性修正,屬系列最低要求②③):
  - B1 find 任何位置之 `undefined`(欄位值、運算子值、`$in/$nin` 元素、清單元素).
  - B2 `{}`、`[]`、RegExp、Map、Set、包裝物件、類別實例作為欄位值或運算子值.
  - B3 `$nor`(原為 AND/語意反向;`$nor:[]` 原為全表).
  - B4 `$regex(RegExp 值)`、`$jsonSchema:{}`、`$null:{}`/`undefined` 等被丟棄者.
  - B7 `$nin:[]`、`$not` 內空 `$in`(原為全表)、`$nin` 同含 null 與其他值(原命中應排除之列).
  - B8 `$and:[]`、`$or:[]`、`$and:{}`、`$or:{}`、`$or:[{}]`、`$and:[{}]`、`$or:[{},x]`、清單含 undefined/null/純量(原為全表或縮小).
  - B9 欄位物件內巢狀非運算子鍵(原展平,外層欄名被丟).
  - B10 首尾皆 `$` 之字串值(原被當欄引用);主鍵值亦然(`del({time:'$time$'})` 原刪全表).
  - B16 NaN、±Infinity、無效 Date、孤立代理字元、NUL 作為值.
  - B18 Proxy 之存取器/getter、Symbol 鍵、不可列舉、繼承屬性、非一般物件之 find.
  - B20 主鍵字串含 NUL 或孤立代理字元、主鍵為無效 Date(原:NUL 由伺服器回 `invalid byte sequence` 而 selectByPk reject;孤立代理經 UTF-8 變 U+FFFD 而 `del` 誤刪 U+FFFD 列):今為無效主鍵(selectByPk 回 null、del/save 逐筆 `ok:0`、insert 整批 reject).
  - B21 `$and` 內超過 100000 個元素(多為 `{}`)原可繞過節點預算,今 reject;不可列舉之陣列元素原被接受,今 reject.
  - B19(使用者裁示 B)頂層 find 為 `null`、`false`、`true`、`0`、`''`、任何數值、陣列(含 `[]`、`[{…}]`)等:原視為未給條件(**`delAll(null)`、`delAll([])`、`delAll(0)` 原刪全表**,陣列原為 AND)而今整批 reject;僅 `undefined` 與 `{}` 為全部.
- 凡原本**偶然 reject**(PG 欄不存在、TypeError 等)而今明確 reject:訊息與型別改變(delAll 由字串訊息改為 `Error`):B4 其餘未知運算子與 `$regex/$options/$eq/$where/…` 字串值、B5 `$exists/$notExists`.
- 凡原本**可用**而因安全收窄支援範圍(Q1):
  - B5/B6 `$custom*`(原始 SQL)、`$exists/$notExists`、`$in/$nin` 給子查詢物件、`*_ago`(原即語法錯).
  - B11/B14 欄位層 `$and/$or`、`$or` 給物件、表.欄鍵、含 `.` `"` 空白 `*` 之欄名鍵、JSON 片段帶引號或接轉型.
  - B12 order 為字串、陣列、`1/-1`、非 asc/desc 之字串(原為原樣拼接 SQL).
  - B15 `$gt…$ilike` 給 null(原恆無命中).
  - B17 深度>32、綁定參數>65535、節點>100000.
- 寫入路徑(Q6):`insert`/`insertBulk`/`save` 之 INSERT 與 `save(…,{autoInsert:false})` 之 UPDATE 改為手寫參數化 SQL,不再經 mongo-sql 之 `values`/`updates` 輔助:帶 `type` 屬性之物件(含 Date、陣列、Buffer、被汙染之原型)由「當子查詢(失敗或跨表讀取)」改為一般綁定參數(行為修正);含雙引號之資料鍵由「破壞語句」改為正確引用(欄不存在由 PG 回報);主鍵值為包裝物件(`Object(5)`)或帶附加屬性之 Date 者視為無效主鍵(原 `del` 無 where 而刪全表);`save(…,{autoInsert:false})` 之資料鍵 `$inc/$dec/$custom` 與 `$..$` 字串值不再生效(原為原始 SQL/欄引用),非識別字欄名鍵整批 reject.
- run03(原 T3 與「主鍵可來自原型」;2026-10-17;版本 patch,Q9 原裁示不變):
  - B22 `createTable`:欄名鍵與 pk 須為識別字、表名須經 `cvTable` 檢核——不合者於送出任何語句之前整批 reject(原:資料鍵直接內插 DDL,`{time:1,['x int) ; CREATE TABLE vo_pwned(a']:{}}` 實測堆疊建出第二張表);含 `"`、空白、`;`、`.`、`-` 等之欄名鍵今 reject(原:語法錯誤或被內插為額外 DDL);表名含 `"` 而非完整引號識別字、或帶 `->1`/`::型別` 尾巴者今 reject;非字串或空字串表名今 reject(原:`CREATE TABLE undefined …`).DDL 改經 `pgq`,不可堆疊.
    - **HEAD 下原本可運作而今被拒者(外審 opus F2/F4/F5 補記,逐項 HEAD 對照實測)**:①欄名鍵含 `$`(`a$b`)、>63 bytes、非字母之符號字元(emoji、`°`)、`Infinity`——原可建表且 insert 寫得進(PG 對未引號識別字放行這些字元),今 reject(find/UPDATE 欄名文法本即不支援這些鍵);②以「預先加雙引號之欄名鍵」(`{'"userName"': 'x'}`,HEAD 唯一建得出保留大小寫欄之寫法)建表,今 reject——**遷移:改寫 `{userName: 'x'}` 即得 `"userName"` 欄**;③`pk` 參數非識別字(原:不內插、若不在樣本中則建出無主鍵表)今 reject;④表名含空白/關鍵字等 DDL 片段——如 `createTable('IF NOT EXISTS t', …)`(HEAD 以內插而當冪等建表用)、`'TEMP t'`、`'t (a int)'`——今 reject(`invalid table name`),**不再被當 DDL 片段**;一般名稱、`schema.table`、完整雙引號名稱(含 `$`、大寫)不受影響;⑤樣本物件僅有繼承可列舉鍵(`Object.create({time:1})`)原建出零欄表,今 reject(`is not an effective object`).
  - B23 `createTable` 欄名/表名改為雙引號引用,**不再折為小寫**:`{userName:1}` 原得欄 `username`(而 insert/save/find 以 `"userName"` 引用,對不上),今得欄 `userName`;表名 `'MyTable'` 原得 `mytable`(insert 寫 `"MyTable"`,對不上),今得 `"MyTable"`.全小寫者不變.唯一受影響之用法:建表範例物件/表名含大寫、其後 insert/save/find 卻用小寫(原可運作,今 PG 回報欄/表不存在),補救為範例物件改用小寫.
  - B24 `save`(autoInsert:true)之 `ON CONFLICT … DO UPDATE SET`:值為 `undefined` 之鍵不再進 `SET`(原:`k = EXCLUDED.k` 把既有欄清成 NULL/預設值,且 `undefined` 惡意鍵不受 PG 驗證而可跨表讀值);欄名改雙引號引用(原未引號:含大寫/空白/連字號之鍵折疊成他欄或語法錯誤);無可更新欄時 `DO NOTHING`(同原).`insert` 之 `ON CONFLICT (…)`、`returnList` 時之 `RETURNING …` 的 pk 名改雙引號引用(原未引號,大寫 pk 折為小寫而對不上;`insertBulk` 不帶這兩個子句).
  - B25 `opt.pk` 為非空字串但不合識別字文法(含 `"`、空白、`;`、`.`、`-`、`$`、數字開頭、>63 bytes、`__proto__` 等)者,建構(`WOrmPostgresql(opt)`)拋 `Error('invalid opt.pk: …')`(原:接受並內插進 `ON CONFLICT`/`RETURNING`,亦以 `get(v, pk)` 當 lodash 路徑讀).**相容影響**:`opt.pk` 含 `$`(如 `'a$b'`)或 `Infinity` 者原可運作(`$` 為 PG 未引號識別字合法字元,五個函數皆可用;`Infinity` 則被 mongo-sql 視為陣列索引而 where 錯亂),今建構即拋錯;補救為改用不含 `$` 之欄名(需 `ALTER TABLE … RENAME COLUMN`).
  - B26 INSERT 資料鍵(值非 `undefined`)含 NUL 或孤立代理字元:insert/insertBulk 整批 reject、save(autoInsert:true)該筆 `ok:0`,錯誤為 `invalid data key: …`(原:NUL 得協定層錯誤 `insufficient data left in message`;孤立代理字元寫入以 U+FFFD 為名之欄).
  - B27 **主鍵只讀自有可列舉屬性**(R10):`insert`/`insertBulk`/`save`/`del` 之資料元素,主鍵在原型(`Object.create({time:12})`、類別原型 getter、被 `Object.prototype.time` 汙染)者,視為缺主鍵——insert/insertBulk/save 整批 reject(`invalid data[i].time[undefined]`)、del 該筆 `ok:0`(`invalid time[undefined]`);原:讀得繼承值而作用於該值所指之列(資料型汙染下 `del([{}])` 刪掉汙染值所指之列)、或 save 該筆因無自有欄而逐筆 `ok:0 no column to insert`.主鍵須為資料物件之自有可列舉屬性(一般物件、JSON.parse 結果皆是).
- 第 33 項批 1(系列條件白名單;2026-10-19;版本 patch 以全庫慣例,由使用者流程決定,不設過渡期):find 由 wsemi `cvOrmFind` 檢核(R11)後,以下**原本可用**(或靜默放行)者今整批 reject(`invalid find: … at […]`)或改變語意.**「原行為」逐項以 HEAD(1.0.31,`git show HEAD:` 副本於 `tmp/head/src`)對真 PG 17 實跑為準**(探測腳本 `tmp/probe33/probe.mjs`,結果 `tmp/probe33/out-head.json`/`out-head2.json`),非取自方案 §5.1 之敘述:
  - B28 移除運算子 `$like`、`$ilike`(原:LIKE/ILIKE 比對,實跑命中)、`$null`、`$notNull`(原:`is [not] null`)、`$equals`(原:`=`/`is null`;`$eq` 原 reject)、欄位層 `$not`(純量與運算子物件,原:`not …`,NULL 列不命中):今 `unsupported operator`.替代:`$like` 無(select 後記憶體過濾)、`$null:true` → `{col:null}`、`$notNull:true` → `{col:{$ne:null}}`、`$equals` → `$eq`、`$not` → `$ne`/`$nin`/反向比較.
  - B29 `$in`/`$nin` 元素含 null(原:`$in:['x',null]` → `(in or is null)`,`$in:[null]` → `is null`,`$nin:[null]` → `is not null`,`$nin:['x',null]` 原已 reject):今 `null is not allowed here`.替代:`{$or:[{c:'x'},{c:null}]}`、`{c:null}`、`{c:{$ne:null}}`.
  - B30 bigint、Buffer 值(原:bigint 作綁定參數命中,Buffer 比對 bytea 欄命中):今 `unsupported value type`.替代:bigint → 數值字串或數值(PG 依欄型轉換);Buffer 無(改以他欄過濾或記憶體過濾).
  - B31 JSON 取值鍵與 `::` 轉型鍵(原:`js->>k`、`js->k`、`js->a->>b`、`value::text`、`ts::date`+`$gte` 命中;`js->>0` 取 jsonb **陣列**之第 0 個元素而命中〔實測 `js=[7,8]` 之列被 `{'js->>0':'7'}` 命中〕,對 jsonb 物件則命中 0 筆;`js#>>k`、`js#>k` 因 mongo-sql 只輸出單一鍵而 PG 要求陣列字面量,**原即 `malformed array literal` 失敗**):今 `unsupported column name`.替代:select 後記憶體過濾,或以 view/產生欄.(注意:`cvOrder` 的 order 鍵未改,仍接受此二寫法.)
  - B32 `$and` 內 `{}` 元素(原:被丟棄當恆真,`$and:[{name:'aa'},{}]` 命中 name='aa'):今 `empty condition`.
  - B33 **布林 `$ne` 語意改變**(原:`{ok:{$ne:true}}` → `IS NOT TRUE`,**含 NULL 列**;`$ne:false` → `IS NOT FALSE` 亦含 NULL 列;實跑於 8 列種子:`$ne:true` 命中 [2,3,6,8]、`$ne:false` 命中 [1,3,4,5,7,8],其中 3、8 為 `ok IS NULL`):今為 SQL 三值,`$ne:true` → [2,6]、`$ne:false` → [1,4,5,7](不含 NULL 列);**會改變既有查詢之命中集合**.要含 NULL 列:`{$or:[{ok:null},{ok:false}]}`(對應原 `$ne:true`).
  - B34 規模上限(共用預設):`$and/$or` >1000 項(原:實跑 1001 項皆接受,上限只有節點 100000)、`$in/$nin` >10000 元素(原:實跑 10001 與 65535 元素皆接受,上限為綁定參數 65535):今 `array is too large`.欄名上限由 200 字元改 128 字元(pg 63 bytes 原即較嚴,無實質變化,僅訊息改為 `column name is too long (> 128)`).
  - B35 頂層/非頂層原型被改為 `null`/`Object.prototype` 之內建品牌物件(Map、Set、Promise、ArrayBuffer、WeakMap…)與頂層 `new Proxy({}, {})`(原:實跑頂層 `Object.setPrototypeOf(new Map([['name','aa']]), null)` 與 Set 被當**全部**——`delAll` 刪光 8 列;帶自有鍵者被當條件 `{name:'aa'}`,放在 `$or`/運算子物件內亦然;**空的**此類物件放在 `$or`/`$and` 內原即 reject(`empty condition`);`new Proxy({}, {})` 被當全部):今 `condition must be a plain object`/`an empty find must be an ordinary object`(wsemi 1.9.20 規則 2、16).非空 Proxy 包一般物件照常接受.
  - B38 實作面補強(外審 sol F01、F02;非行為破壞):第二階段不再以索引指派建立陣列元素(`Array.prototype` 上之數字索引 accessor 會令指派被吞掉而已檢核之條件被清空,實測 `{$and:[{s:'aa'}]}` 變成 `delete from "t"` 全刪;HEAD 之 `push` 同樣可重現):`$and/$or` 清單、碰撞收集器直接建為 null 原型索引物件,`$in/$nin` 集合以 `setOwn`(defineProperty)定義元素;`$..$` 字串等值原被計 2 個綁定參數(合法的 65535 個參數會被誤拒),今計 1.
  - B36 **新增支援(非破壞)**:`$eq`(原 reject,今譯為 mongo-sql `$equals`);首尾皆 `$` 之字串於等值、`$eq`、`$ne`、`$in`、`$nin` 為字面值(原:等值與 `$ne` reject,`$in/$nin` 元素原已可);`$gt $gte $lt $lte` 給此類字串仍 reject(訊息改為 pg 專屬).
  - B37 錯誤訊息:格式 `invalid find: <原因> at [<路徑>]` 與型別(`select` reject `Error`、`delAll` 之 DB 錯誤仍為字串)不變;原因詞彙改由 `cvOrmFind` 提供(多數相同,如 `unsupported operator [$x]`、`empty condition`;`$..$` 字串之訊息不再回顯值).
- 第 58、76 項(knex 取代 mongo-sql、欄名解析 fail-closed;2026-10-20;版本依發布流程由使用者決定;**「原行為」逐項以 HEAD(1.0.33,`git show HEAD:src/*.mjs` 副本於 `tmp/head2/src`)對真 PG 17 以案例表實跑為準**,歸類代號 C 見 R16):
  - B39 (C2,缺陷修正,第 76 項)欄名恰為函數名(`concat`、`to_json`、`to_jsonb`、`row_to_json`、`pg_typeof`、`num_nulls`、`quote_literal`…)或系統欄:原 HEAD 以整列/系統欄求值,`delAll({concat:{$ne:'x'}})`、`{tableoid:{$gt:0}}`、`{to_jsonb:{$gt:0}}`、`{pg_typeof:{$gt:0}}`、`{quote_literal:{$nin:[…]}}` 等**刪光 14/14 列**;今函數名一律 42703(`select` 為 pg 錯誤物件、`delAll` 為字串),資料不變.
  - B40 (C3)系統欄名(`ctid tableoid xmin xmax cmin cmax`)於 find/order:原「成立或 DB 型別錯」,今 `invalid find|order: unsupported column name [ctid] at […]`;視圖輸出欄同名者一併被拒(收窄).
  - B41 (C1,放寬)首尾皆 `$` 之字串於 `$gt $gte $lt $lte`:原 reject,今為字面值.
  - B42 (C11,放寬,R4)主鍵值首尾皆 `$` 之字串:原視為無效主鍵(`selectByPk` null、`del`/`save` `ok:0`、insert 整批 reject),今為一般字面值——text 主鍵表作用於該字面主鍵之列,其他主鍵型別為 PG 型別錯(見〈已知限制〉).
  - B43 (C8,放寬)表名含 `$`、`+`、`(` 等時 `$nin` 與給首尾 `$` 字串之 `$ne`:原 reject(`ninOk`),今可用.
  - B44 (C4/C9/C10,放寬)欄名 `Infinity`(find、order、`opt.pk`、`createTable`):原 reject/建構拋錯,今為一般欄名(PG 決定欄是否存在);insert/save 之資料鍵本就未拒收 `Infinity`(HEAD 之 `cvColumn` 即接受,外審 sol F07 更正此列原含「`save` 資料鍵」之誤).
  - B45 (C5/C5A,**收窄**,R3)order 鍵含 JSON 取值(`->` `->>`,原可用;`#>` `#>>` 原即 22P02 失敗)或 `::` 轉型:今 `invalid order`;全 `C:\opensrc` 無呼叫端使用.
  - B46 (C7,修正)`opt.cl` 為預引號表名(`'"Po_Q"'`):原 select/selectByPk/save/del/delAll 皆 42601,今皆可用.
  - B47 (C9/C10)`opt.pk` 為系統欄名:原「建構成功但任何表都不可能有此欄」,今建構拋 `invalid opt.pk: system column names (…) are not supported`;`save(autoInsert:false)` 資料鍵/`createTable` 欄名為系統欄名:原由 PG 拒絕(逐筆 ok:0 或 42701),今整批 `invalid`.
  - B48 (INFO)未知欄之 PG 錯誤文字 `column t.c does not exist` → `column "c" does not exist`(皆 42703);`Object.prototype` 等被汙染 knex 內部讀取名稱時 `select`/`delAll` fail-closed reject(R12).
  - B49 (實作面)SQL 產生由 mongo-sql 換 knex(只建 SQL);依賴 `mongo-sql` → `knex`;測試固定埠與容器收尾 `-v`(R15).
- 第 66 項批 1e(字串良構,R17)——凡原本靜默放行或誤中而今拒收/改處置:
  - B50 主鍵字串含孤立代理字元的 `save`:原整批 reject(訊息 `invalid data[k].<pk>[<逸出值>]`),今該筆 `{ok:0,err}`、同批其他筆照常(D5);`insert`/`insertBulk` 仍整批 reject,訊息改為不回顯值之 `invalid id: string contains lone surrogate at [data[k].<pk>]`;`del` 該筆 `ok:0`,`err` 改同詞彙(帶批次索引);`selectByPk` 仍回 `null`.
  - B51 所有無效主鍵之訊息改固定詞彙(`invalid id: <primary key is missing|string is empty|unsupported primary key value|string contains lone surrogate|string contains NUL> at [data[k].<pk>]`),不再回顯值(原 `invalid data[k].<pk>[<值>]`、`invalid <pk>[<值>]`);未帶有效主鍵之 `save` 仍整批 reject(T6).
  - B52 寫入資料之字串值與鍵名(含巢狀物件、陣列元素、Map/Set 等)含孤立代理字元:原被 UTF-8 靜默改寫為 U+FFFD 後寫入(TEXT 欄)或由 JSONB 回報 DB 錯誤,今於連線前拒收(`invalid data: string contains lone surrogate at [data[k].<路徑>]`;insert/insertBulk 整批、save 逐筆);鍵名孤立代理即使值為 `undefined` 亦拒收(原不寫入故不檢).
  - B53 `opt.url`、`opt.db`、`opt.cl` 含孤立代理字元或 NUL:原建構成功(孤立代理經 UTF-8 變 U+FFFD,`cl` 誤中名為 `t`+U+FFFD 之他表並可被 `delAll` 清空),今建構即 `throw Error('invalid opt.<名>: <原因>')`.
  - B54 寫入之頂層資料鍵含 NUL:原連線後、交易內才由 `colsOf` 拒收(訊息 `invalid data key`),今連線前拒收(`invalid data key: contains NUL at [data[k].<invalid key>]`).
  - B55 `createTable` 之表名/主鍵名/樣本物件鍵不合:原連線後才檢核,今連線前(仍 `invalid createTable: …`).
  - B56 `save`/`del` 各筆皆已逐筆失敗者不再連線:DB 不可連線時原整批連線錯誤 reject,今回逐筆結果(批次中仍有待處理之筆時連線失敗仍整批 reject).
  - B57 `save` 之 `error`/`change(insert)` 事件交寫入複本當下之獨立快照(原交待寫入之複本本身);依賴 wsemi ≥ 1.9.24(`chkOrmStr`、`chkOrmData`).
- 不變:`{}`/未給 find 為全部、`$in:[]` 恆假、受支援運算子(`$ne $gt $gte $lt $lte $in $nin` 與欄位等值、`$and`、`$or`)之 SQL 與 values(以 1500 筆隨機白名單 find 差分驗證:HEAD 與現行 mongo-sql 輸入之 SQL/values 逐字相同、命中集合相同,僅限不含 B33/B36 轉譯類者)、Date(`opt.nin` 表名守門為 mongo-sql 時代之性質,第 58 項後已移除,`$nin` 於含 `$` 之表名亦可用,C8).

## 〔delAll 與 find 之頂層語意〕(主控 2026-10-16 依使用者裁示寫入;全系列規格)

- **`delAll()` 不給條件就是全刪;給條件才是部分刪除.**「不給條件」指:未傳 find、傳 `undefined`、或傳空物件 `{}`——三者皆為全部(select 亦同).
- **傳了值但不是條件物件者一律 reject**(使用者裁示 B):`null`、陣列、字串、數值、布林、函數、Date、RegExp、Map、Set、類別實例等,以整批性錯誤 reject,不得視同 `{}` 而全刪.適用於所有接受 find 之函數.
- 規格出處:`C:\opensrcOper\dspec\w-orm系列條件語法支援盤點.md` 〈一之一〉.本條未實作前,本套件之現況若與此不符,屬待修(排程第 33 項),不得以「現況如此」為由維持.
- **本套件實作狀態(run02,2026-10-17)**:已實作——`src/cvFind.mjs` 之 `cvFind`(原 `doFind`)僅接受 `undefined` 與一般物件;`select`、`delAll` 共用;`selectByPk`/`del` 之條件由主鍵值構成,不受影響.對應測試見〈條件(find)之支援範圍〉.

## 〔系列條件白名單〕(使用者 2026-10-17 裁示;主控寫入)

- 全文與定案細節在 `C:\opensrcOper\dspec\w-orm系列條件語法支援盤點.md`〈一之三〉;本節為摘要,兩者不一致時以 dspec 為準.
- **只支援白名單,其他一律不支援(reject,整批性錯誤,不得靜默忽略)**:
  1. 頂層:未給、`undefined`、`{}` 為全部;其餘須為條件物件,否則 reject(〈delAll 與 find 之頂層語意〉).
  2. 欄位直接等值 `{欄: 純量}`,多欄隱含 AND.
  3. 欄位運算子 `$eq $ne $gt $gte $lt $lte`(純量)、`$in $nin`(純量陣列).
  4. 文件層 `$and`、`$or`(條件物件之陣列).
  5. 其餘(`$not $nor $regex $options $exists $where $expr $function $like $ilike $custom`、子查詢、欄位層 `$and/$or`、sequelize `Op` Symbol、函數值等)一律 reject.
- 純量型別、NULL 語意、空 `$in/$nin`、欄名文法、上限等細節由排程第 33 項審計提案、主控複審後定案,回寫 dspec 與本節.
- **delAll 之 JSDoc 須載明使用須知**(使用者 2026-10-17):不給條件(未給、`undefined`、`{}`)即刪除全部;傳非條件物件會 reject;白名單外運算子會 reject;delAll 須審慎使用、非必要不用.經 w-serv-webdata 資料通道呼叫者語意與本套件一致,不另加限制.
- 狀態:**本套件已於第 33 項批 1(2026-10-19)實作**——`cvFind` 第一步為 wsemi `cvOrmFind`(R11),支援範圍見〈條件(find)之支援範圍〉,破壞性變更見〈破壞性變更紀錄〉B28–B37;`delAll`/`select` JSDoc 與 README 〈Condition (find) whitelist〉〈Breaking changes〉已依 dspec 使用須知更新.
- 與 dspec〈一之三〉6. 之對照:純量(字串/有限數值含 -0/布林/有效 Date;bigint、Buffer、NaN、±Infinity、無效 Date、包裝物件、陣列、物件、函數、Symbol、RegExp、undefined reject;字串不含 NUL 與孤立代理)、null(僅欄位等值/`$eq`/`$ne`)、空集合(`$in:[]` 允許,`$nin:[]`、`$and/$or:[]`、`{}` 元素、`{}` 運算子物件 reject)、欄名(共用層 128 字元識別字文法、禁 `__proto__`;pg 再限 63 bytes 與 6 個系統欄名,`Infinity` 自第 58 項起為一般欄名)、上限(32/1000/10000/100000/128;pg 不下調,另有綁定參數 65535)、異常結構與一次讀取(wsemi)、錯誤格式與時序(`isClosed` 不適用本套件;檢核先於連線與送出 SQL)、單一擁有者(wsemi `cvOrmFind` + 案例表),皆已落實;`$ne`/`$nin` 遇 NULL 維持 SQL 式(分族不統一),布林 `$ne` 已改 SQL 三值.
