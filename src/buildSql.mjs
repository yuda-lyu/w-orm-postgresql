//buildSql: PostgreSQL 方言 + knex(僅建 SQL, 不連線) + 輸出驗證.
//  - 表一律以別名 "$t" 引用, 欄位不加表限定: 欄名解析只在該表之欄與系統欄中進行
//    (加表限定 "t"."c" 時 PG 會把不存在之欄改以函數記法 c(t) 解析, 如 concat、to_json 令條件對整列求值; 未限定時為 42703;
//     不用別名時欄名等於表名會解析為整列參照; 別名含 $ 不可能是合法欄名鍵, 故整列參照不可達)
//  - 系統欄 ctid tableoid xmin xmax cmin cmax 可被未限定識別子解析(PG 不允許建立同名欄), 於方言檢核拒收
//  - 輸出驗證(verifySql): knex 內部以一般物件承載 limit/schema/only/distinct/returning 等選項並讀取其繼承值,
//    Object.prototype 被資料型汙染時 SQL 會靜默改變(實測), 故對 knex 產出之文字依 IR 做白名單詞法序列驗證, 不符即 throw, 不送出;
//    建句途中 knex 拋出之任何例外亦轉為固定格式之 invalid find/order(不洩漏內部訊息). 不改動全域 Object.prototype/Array.prototype.
import knex from 'knex'
import { emitWhere, emitOrder, valuesOfIr } from './emitKnex.mjs'

let ALIAS = '$t'
let SYSCOLS = new Set(['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax'])
let defProp = Object.defineProperty

/**
 * 是否為 PG 系統欄名(PG 保證不可建立同名欄, 但未限定引用時可被解析)
 *
 * @param {String} c 欄名
 * @returns {Boolean} 回傳是否為系統欄名
 */
export let isSysCol = (c) => SYSCOLS.has(c)

/**
 * PostgreSQL 方言(提供 lowerFind / emitKnex 注入)
 */
export let dialectPg = {
    maxParams: 65535, //pg 協定綁定參數個數為 int16
    checkColumn: (c) => {
        if (Buffer.byteLength(c, 'utf8') > 63) {
            return 'column name is too long (> 63 bytes)' //PG 識別字上限 63 bytes(以 UTF-8 計, 伺服器編碼須為 UTF8), 超過者被伺服器靜默截斷而可能指到他欄
        }
        if (SYSCOLS.has(c)) {
            return `unsupported column name [${c}]` //系統欄: 未限定時可被解析, 條件可能對全表成立
        }
        return ''
    },
    //布林: 等值與不等值用 IS TRUE/IS FALSE(不參與運算子解析; $ne:true 即 IS FALSE, 三值: NULL 列不命中), 其餘比較用運算子字面值
    boolRaw: (c, op, v) => {
        if (op === '=') {
            return { sql: `?? IS ${v ? 'TRUE' : 'FALSE'}`, bindings: [c] }
        }
        if (op === '!=') {
            return { sql: `?? IS ${v ? 'FALSE' : 'TRUE'}`, bindings: [c] }
        }
        return { sql: `?? ${op} ${v ? 'TRUE' : 'FALSE'}`, bindings: [c] }
    },
    falseRaw: 'false', //恆假不引用欄位(IR 契約: 不得影響結果集)
}

//knex 實例: 模組載入時建立(早於任何執行期汙染), 設定為 null 原型(不繼承 Object.prototype 上之 connection、pool 等);
//不給 connection 故不建連線池, 行程可自然結束; 僅用其 queryBuilder/raw 建 SQL, 連線、交易與錯誤皆由 pg 負責
let kx = (() => {
    let cfg = Object.create(null)
    cfg.client = 'pg'
    return knex(cfg)
})()

/**
 * 引用表名: 未含雙引號者以 . 分段各自加雙引號; 含雙引號者視為呼叫端已引用之 SQL 片段, 原樣輸出
 * (opt.cl 為建構時設定之信任輸入, 不經詞彙驗證)
 *
 * @param {String} table 輸入表名
 * @returns {String} 回傳引用後之表名
 */
export let quoteTable = (table) => {
    let t = String(table)
    if (t.indexOf('"') !== -1) {
        return t
    }
    let segs = splitDots(t)
    let s = '"'
    for (let i = 0; i < segs.length; i++) {
        s += (i > 0 ? '"."' : '') + segs[i]
    }
    return `${s}"`
}

/**
 * 依 . 拆段(以 indexOf/slice 手動拆, 不用 String.prototype.split: 以字串為分隔符時 split 會查 separator[Symbol.split],
 * 內建原型被加上 Symbol.split 函式時結果可被改寫; 外審 opus F3)
 *
 * @param {String} t 輸入字串
 * @returns {Array} 回傳各段陣列(至少 1 段)
 */
export let splitDots = (t) => {
    let out = []
    let from = 0
    for (;;) {
        let i = t.indexOf('.', from)
        let seg = i === -1 ? t.slice(from) : t.slice(from, i)
        defProp(out, out.length, { __proto__: null, value: seg, enumerable: true, writable: true, configurable: true })
        if (i === -1) {
            break
        }
        from = i + 1
    }
    return out
}

//表名不交 knex 解析(其 raw 對 ? 另行處理: 表名含 ? 者會被改為 $1; 表名字串之 . 與 as 亦會被解析): 以不可能是欄名之佔位詞 "$tbl$" 建 builder,
//編譯後再把開頭之佔位詞換成 quoteTable(table)(換後整句仍須通過 verifySql)
let TOK = '"$tbl$"'
let from = () => {
    return kx.queryBuilder().from(kx.raw(`${TOK} as "${ALIAS}"`))
}

//---- 輸出驗證
//詞彙: 空白、"識別子"、$n、比較運算子、括號、逗號、英文單字; 其餘字元(數字字面值、單引號字串、註解、分號、::、-> 等)一律不認
let reTok = /\s+|"(?:[^"]|"")+"|\$\d+|<>|!=|>=|<=|=|>|<|\(|\)|,|[A-Za-z]+/y
let OPSQL = Object.assign(Object.create(null), { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' })

//expectedTokens: 由 IR 與 order 導出「應出現之詞彙序列」(依 knex 對各節點之固定輸出格式); 與實際文字之詞彙序列須逐一相等。
//詞彙之正規化: 英文單字轉小寫、$n 一律為 '$'、其餘原樣。knex 升版而輸出格式改變時此處不等 => fail-closed, 由測試揭露。
//回傳 { m: 詞彙序列, orderAt: order 子句起點之索引(無 order 為 m.length) }
let expectedTokens = (ir, order) => {
    let m = []
    let add = (k) => {
        defProp(m, m.length, { __proto__: null, value: k, enumerable: true, writable: true, configurable: true })
    }
    let q = (c) => `"${String(c).replace(/"/g, '""')}"`
    let node = (n, root) => {
        if (n.t === 'and' || n.t === 'or') {
            if (!(root && n.t === 'and')) {
                add('(')
            }
            for (let i = 0; i < n.a.length; i++) {
                if (i > 0) {
                    add(n.t)
                }
                node(n.a[i], false)
            }
            if (!(root && n.t === 'and')) {
                add(')')
            }
            return
        }
        if (n.t === 'cmp') {
            add(q(n.c))
            add(OPSQL[n.op])
            add('$')
        }
        else if (n.t === 'bool') {
            add(q(n.c))
            if (n.op === 'eq' || n.op === 'ne') {
                add('is')
                add((n.op === 'eq') === n.v ? 'true' : 'false')
            }
            else {
                add(OPSQL[n.op])
                add(n.v ? 'true' : 'false')
            }
        }
        else if (n.t === 'null') {
            add(q(n.c))
            add('is')
            if (n.not) {
                add('not')
            }
            add('null')
        }
        else if (n.t === 'in') {
            if (n.vs.length === 0 && !n.not) {
                add('false')
                return
            }
            add(q(n.c))
            if (n.not) {
                add('not')
            }
            add('in')
            add('(')
            for (let i = 0; i < n.vs.length; i++) {
                if (i > 0) {
                    add(',')
                }
                add('$')
            }
            add(')')
        }
    }
    if (ir !== null) {
        add('where')
        node(ir, true)
    }
    let orderAt = m.length
    if (order.length > 0) {
        add('order')
        add('by')
        for (let i = 0; i < order.length; i++) {
            let o = order[i]
            if (i > 0) {
                add(',')
            }
            add(q(o.c))
            add(o.dir)
            if (o.nulls) {
                add('nulls')
                add(o.nulls)
            }
        }
    }
    return { m, orderAt }
}

let isScalarVal = (v) => {
    let t = typeof v
    if (t === 'string' || t === 'boolean') {
        return true
    }
    if (t === 'number') {
        return !Number.isNaN(v) //±Infinity 僅主鍵路徑可達(float8 主鍵可有此值)
    }
    if (v !== null && t === 'object') {
        try {
            return !Number.isNaN(Date.prototype.getTime.call(v))
        }
        catch (err) {
            return false
        }
    }
    return false
}

//timeOf: Date 的時間值(經內建方法 call 取得, 不查屬性; 非 Date 或無效日期回 null)
let timeOf = (v) => {
    if (v === null || typeof v !== 'object') {
        return null
    }
    try {
        let ms = Date.prototype.getTime.call(v)
        return Number.isNaN(ms) ? null : ms
    }
    catch (err) {
        return null
    }
}

//錯誤訊息前綴維持 invalid find / invalid order(帳本 S5), 並以 (statement check) 標明為建句後之內部檢查; 不回顯值
let stmtError = (kind, m) => new Error(`invalid ${kind}: internal statement check failed (statement check): ${m} at [${kind}]`)

//verifySql: 檢查 knex 產出之文字與值確為由 IR(與 order)導出者。注意此為「與 IR 結構一致」之檢查, 不是對 IR 本身(lowerFind)語意之驗證,
//語意由案例表與規格句測試守住。前綴: 差異落在 order 子句者歸 invalid order, 其餘歸 invalid find。
export let verifySql = (text, values, head, ir, order) => {
    let kind = ir === null && order.length > 0 ? 'order' : 'find'
    let bad = (m) => {
        throw stmtError(kind, m)
    }
    if (typeof text !== 'string' || !text.startsWith(head)) {
        bad('unexpected statement head')
    }
    if (!Array.isArray(values)) {
        bad('values do not match the condition')
    }
    let rest = text.slice(head.length)
    let pos = 0
    let nextParam = 1
    let got = []
    while (pos < rest.length) {
        reTok.lastIndex = pos
        let m = reTok.exec(rest)
        if (m === null || m.index !== pos) {
            bad(`unexpected character at ${pos}`)
        }
        let tk = m[0]
        pos += tk.length
        if (/^\s+$/.test(tk)) {
            continue
        }
        let key = tk
        if (tk[0] === '$') {
            if (Number(tk.slice(1)) !== nextParam) {
                bad('placeholder out of order')
            }
            nextParam += 1
            key = '$'
        }
        else if (/^[A-Za-z]+$/.test(tk)) {
            key = tk.toLowerCase()
        }
        defProp(got, got.length, { __proto__: null, value: key, enumerable: true, writable: true, configurable: true })
    }
    if (nextParam - 1 !== values.length) {
        bad('placeholder count does not match values')
    }
    let { m: want, orderAt } = expectedTokens(ir, order)
    let n = Math.min(want.length, got.length)
    let at = -1
    for (let i = 0; i < n; i++) {
        if (want[i] !== got[i]) {
            at = i
            break
        }
    }
    if (at === -1 && want.length !== got.length) {
        at = n
    }
    if (at !== -1) {
        kind = order.length > 0 && at >= orderAt ? 'order' : 'find'
        bad('statement does not match the condition')
    }
    let wv = valuesOfIr(ir)
    if (wv.length !== values.length) {
        bad('values do not match the condition')
    }
    for (let i = 0; i < wv.length; i++) {
        let x = wv[i]
        let y = values[i]
        if (!isScalarVal(y)) {
            bad('value is not a scalar')
        }
        let same = x === y
        if (!same) {
            //Date: emitKnex 交給 knex 的是獨立副本, 以時間值比對(不經屬性/原型鏈查找: 內建方法經 call 呼叫, 非 Date 者拋錯視為不同)
            let tx = timeOf(x)
            same = tx !== null && tx === timeOf(y)
        }
        if (!same) {
            bad('values do not match the condition')
        }
    }
}

//snapshotValues: 驗證通過後把綁定值轉為獨立快照(Date 以時間值重建新實體, 其餘純量本即不可變):
//emitKnex 交給 knex 的 Date 已是獨立副本(建句途中被改寫者會在 verifySql 因時間值不等而拒收), 但 knex 的 bindings 仍持有該副本;
//若不再複製, 驗證與送出之間(連線等待期間)該副本被改動則送出之值不是驗證之值(檢查之值即使用之值)
let snapshotValues = (values) => {
    let out = []
    for (let i = 0; i < values.length; i++) {
        let v = values[i]
        let ms = null
        if (v !== null && typeof v === 'object') {
            try {
                ms = Date.prototype.getTime.call(v)
            }
            catch (err) {
                ms = null
            }
        }
        defProp(out, out.length, { __proto__: null, value: ms === null ? v : new Date(ms), enumerable: true, writable: true, configurable: true })
    }
    return out
}

//msgOf: 取錯誤訊息(不信任拋出值之形狀)
let msgOf = (err) => {
    try {
        return err !== null && typeof err === 'object' && typeof err.message === 'string' ? err.message : ''
    }
    catch (err2) {
        return ''
    }
}

//out: 編譯 builder 並驗證; 建句途中任何例外(含 knex 內部 TypeError)轉為固定格式之錯誤, 本模組與發射器所拋之 invalid find/order 原樣保留
let out = (build, verb, table, ir, order) => {
    let kind = ir === null && order.length > 0 ? 'order' : 'find'
    try {
        let b = build()
        let s = b.toSQL().toNative()
        let h0 = `${verb} ${TOK} as "${ALIAS}"`
        if (typeof s.sql !== 'string' || !s.sql.startsWith(h0)) {
            throw stmtError(kind, 'unexpected statement head')
        }
        let head = `${verb} ${quoteTable(table)} as "${ALIAS}"`
        let r = Object.create(null)
        r.query = head + s.sql.slice(h0.length)
        r.values = s.bindings
        verifySql(r.query, r.values, head, ir, order)
        r.values = snapshotValues(r.values)
        return r
    }
    catch (err) {
        if (/^invalid (find|order): /.test(msgOf(err))) {
            throw err
        }
        throw stmtError(kind, 'the statement could not be built')
    }
}

/**
 * 組 SELECT(全欄)
 *
 * @param {String} table 表名(opt.cl)
 * @param {Object|null} ir lowerFind 之輸出
 * @param {Array} [order=[]] cvOrder 之輸出
 * @returns {Object} { query, values }
 */
export function buildSelect(table, ir, order = []) {
    return out(() => {
        let b = from().select('*')
        emitWhere(b, ir, dialectPg)
        emitOrder(b, order, dialectPg)
        return b
    }, 'select * from', table, ir, order)
}

/**
 * 組 DELETE
 *
 * @param {String} table 表名(opt.cl)
 * @param {Object|null} ir lowerFind 之輸出
 * @returns {Object} { query, values }
 */
export function buildDelete(table, ir) {
    return out(() => {
        let b = from()
        emitWhere(b, ir, dialectPg)
        b.del()
        return b
    }, 'delete from', table, ir, [])
}
