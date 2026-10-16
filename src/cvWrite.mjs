//寫入路徑(insert、insertBulk、save)與DDL(createTable)之SQL產生與名稱檢核, 規則見CLAUDE_rulebook.md R7、R9, 規格句W1、W2、W4~W7:
// 1. INSERT改為手寫參數化SQL(不經mongo-sql之values輔助): mongo-sql之insert/update以'type' in value判定物件值為子查詢,
//    令含type鍵之物件(如GeoJSON)無法寫入, 且可令他表之值被寫入可讀列; 該判定對Date、陣列、Buffer(含自有或繼承之type屬性)亦成立.
//    所有值皆以綁定參數送出, 物件值由pg序列化(JSON.stringify, 或其toPostgres), 與先前不帶type鍵之物件值之行為相同
// 2. 欄名於INSERT以雙引號引用並將內含之雙引號加倍(mongo-sql逐字拼接, 含雙引號之鍵會破壞語句); 含NUL或孤立代理字元之鍵為檢核錯誤
// 3. UPDATE(save之autoInsert:false)之資料鍵須為識別字, 不得為$inc/$dec/$custom等mongo-sql更新輔助(原始SQL)或帶引號/點/空白之鍵
// 4. ON CONFLICT之主鍵名與更新欄一律雙引號引用, 更新欄與INSERT欄單同一來源(colsOf), 且略過值為undefined之鍵
// 5. createTable之表名須為引用後僅由雙引號識別字構成者(cvTable), 欄名/主鍵名須為識別字(isColumnName)
import mongoSql from 'mongo-sql'
import { cvColumn, isCleanStr } from './cvFind.mjs'


let isOwnEnum = Object.prototype.propertyIsEnumerable

/**
 * 引用表名, 規則同mongo-sql之table輔助: 已含雙引號者原樣使用, 否則依quoteObject(可含schema)
 *
 * @param {String} table 輸入表名
 * @returns {String} 回傳引用後之表名
 */
export let quoteTable = (table) => (String(table).indexOf('"') === -1 ? mongoSql.quoteObject(table) : String(table))

/**
 * 引用欄名(或主鍵名): 加雙引號並將內含雙引號加倍
 *
 * @param {String} k 輸入名稱
 * @returns {String} 回傳引用後之名稱
 */
export let quoteKey = (k) => `"${String(k).replace(/"/g, '""')}"`

//reQuoted, 引用後之表名須全由雙引號識別字以.相接而成(內含之雙引號須成對加倍); 兩種選項互斥(首字元不同), 無回溯風險
let reQuoted = /^"(?:[^"]|"")+"(?:\."(?:[^"]|"")+")*$/

//reBareSeg, 未加引號表名之一段(以.分隔): PostgreSQL未引號識別字形(字母或底線開頭, 其後字母/組合符號/數字/底線/$), 至多63 bytes
let reBareSeg = /^[\p{L}_][\p{L}\p{M}\p{N}_$]*$/u

/**
 * 檢核並引用createTable之表名
 *
 * 兩種形式擇一: ①未含雙引號者, 以.分隔之每一段須為識別字形(reBareSeg, 至多63 bytes), 即一般名稱或schema.table
 * (含空白、連字號、分號、關鍵字等者一律拒絕, 如'IF NOT EXISTS t'不再被當成DDL片段);
 * ②含雙引號者須為完整雙引號名稱(內含之雙引號成對加倍, 以.相接).
 * 兩者經quoteTable(與insert、save等路徑同法)引用後, 須全由雙引號識別字以.相接而成;
 * 否則(含未成對之雙引號、被mongo-sql原樣輸出之JSON取值運算子或::轉型尾巴、空片段、.*)一律拒絕.
 * 不接受非字串、空字串、含NUL或孤立代理字元者.
 *
 * @param {String} table 輸入表名
 * @returns {String} 回傳引用後之表名
 * @throws {Error} 不合時拋出Error('invalid table name'), 訊息不回顯表名
 */
export function cvTable(table) {
    if (typeof table !== 'string' || table === '' || !isCleanStr(table)) {
        throw new Error('invalid table name')
    }
    if (!table.includes('"') && !table.split('.').every((s) => reBareSeg.test(s) && Buffer.byteLength(s, 'utf8') <= 63)) {
        throw new Error('invalid table name')
    }
    let q = null
    try {
        q = quoteTable(table)
    }
    catch (err) {
        throw new Error('invalid table name')
    }
    if (!reQuoted.test(q)) {
        throw new Error('invalid table name')
    }
    return q
}

/**
 * 是否為識別字型欄名(同find與UPDATE資料鍵之文法: Unicode字母/底線開頭, 其後字母/組合符號/數字/底線, 至多63 bytes)
 *
 * 另排除mongo-sql以+key>=0判定為陣列索引之名稱(即Infinity): 該名稱無法作為find/主鍵where條件之欄名(同find之欄名文法)
 *
 * @param {*} k 輸入名稱
 * @returns {Boolean} 回傳布林值
 */
export let isColumnName = (k) => {
    try {
        cvColumn(k)
    }
    catch (err) {
        return false
    }
    return !(+k >= 0)
}

//colsOf, 一筆數據將被寫入之欄名: 自有可列舉且值非undefined之鍵(INSERT欄單與ON CONFLICT更新欄之唯一來源);
//含NUL或孤立代理字元者拋檢核錯誤(NUL令extended協定之Parse截斷, 孤立代理字元經UTF-8變為U+FFFD而指到他欄); 訊息不回顯該鍵
let colsOf = (r) => {
    let ks = []
    for (let k of Object.keys(r)) {
        if (r[k] !== undefined) {
            if (!isCleanStr(k)) {
                throw new Error('invalid data key: contains NUL or an unpaired surrogate')
            }
            ks.push(k)
        }
    }
    return ks
}

/**
 * 產生INSERT語句(參數化)
 *
 * 輸出格式與mongo-sql相同: insert into "表" ("k1", "k2") values ($1, $2), ($3, DEFAULT).
 * 欄位為各筆值非undefined之鍵的聯集(依首次出現順序), 該筆無值者填DEFAULT, null填null, 其餘為綁定參數.
 *
 * @param {String} table 輸入表名(依mongo-sql規則引用, 可含schema)
 * @param {Array} rows 輸入數據物件陣列
 * @returns {Object} 回傳{query,values}
 * @throws {Error} 沒有任何可寫入之欄位時拋出Error('no column to insert'); 欄名含NUL或孤立代理字元時拋出Error('invalid data key: ...')
 */
export function genInsert(table, rows) {
    let ks = []
    let seen = new Set()
    for (let r of rows) {
        for (let k of colsOf(r)) {
            if (!seen.has(k)) {
                seen.add(k)
                ks.push(k)
            }
        }
    }
    if (ks.length === 0) {
        throw new Error('no column to insert')
    }
    let values = []
    let tuples = rows.map((r) => {
        let cs = ks.map((k) => {
            let v = isOwnEnum.call(r, k) ? r[k] : undefined //僅取自有可列舉屬性(同colsOf): 某列缺少之鍵不得讀到被汙染之Object.prototype, 亦不讀自有不可列舉屬性
            if (v === undefined) {
                return 'DEFAULT'
            }
            if (v === null) {
                return 'null'
            }
            values.push(v)
            return `$${values.length}`
        })
        return `(${cs.join(', ')})`
    })
    let query = `insert into ${quoteTable(table)} (${ks.map(quoteKey).join(', ')}) values ${tuples.join(', ')}`
    return { query, values }
}

/**
 * 產生ON CONFLICT子句(主鍵衝突時更新或跳過)
 *
 * 更新欄為該筆數據將被INSERT(同colsOf)且非主鍵之欄: ON CONFLICT ("pk") DO UPDATE SET "k" = EXCLUDED."k", ...;
 * 值為undefined之鍵不在INSERT欄單內, 不更動既有欄亦不被引用; 無更新欄(或未給數據)時為DO NOTHING.
 * 主鍵名與欄名皆以quoteKey引用.
 *
 * @param {String} pk 輸入主鍵名
 * @param {Object} [row] 輸入數據物件, 未給時為DO NOTHING
 * @returns {String} 回傳ON CONFLICT子句
 * @throws {Error} 欄名含NUL或孤立代理字元時拋出Error('invalid data key: ...')
 */
export function genConflict(pk, row) {
    let c = `ON CONFLICT (${quoteKey(pk)})`
    let ks = row ? colsOf(row).filter((k) => k !== pk) : []
    if (ks.length === 0) {
        return `${c} DO NOTHING`
    }
    return `${c} DO UPDATE SET ${ks.map((k) => `${quoteKey(k)} = EXCLUDED.${quoteKey(k)}`).join(', ')}`
}

/**
 * 檢核UPDATE之欄名鍵須為識別字
 *
 * @param {Array} ks 輸入欄名陣列
 * @throws {Error} 不合文法時拋出Error('unsupported column name [k]')
 */
export function cvColumns(ks) {
    for (let k of ks) {
        cvColumn(k)
    }
}
