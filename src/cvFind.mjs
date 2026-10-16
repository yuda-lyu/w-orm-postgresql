//條件(find)與排序(order)於交給mongo-sql之前的白名單檢核與正規化
//
//背景: mongo-sql為SQL builder, 對不認得或怪異之輸入以[丟棄]或[當欄名]處理, 且有原始SQL($custom)、子查詢、
//欄引用($x$)等擴充功能, 套件若直接把呼叫端之find與order交給它, 會令條件靜默縮小(delAll擴大刪除)、語意被曲解或SQL被注入.
//本模組為單一擁有者, 規則見CLAUDE_rulebook.md〈條件(find)之支援範圍〉與R1~R3:
// 1. fail-closed: 不在白名單內者一律throw Error('invalid find: <原因> at [<路徑>]'), 不靜默忽略, 不擴充支援範圍
// 2. 回傳全新之正規化複本: 逐鍵僅讀值一次(getter/Proxy/存取器reject), 一律null原型(免疫Object.prototype汙染),
//    令後續mongo-sql(其以for..in並多次讀取同一屬性)只見到本模組驗過之複本
// 3. 通過檢核者, 交mongo-sql之query與values與原find逐字相同, 不改變既有可用之語意


let MAX_DEPTH = 32 //巢狀深度上限(循環參照亦以此拒收)
let MAX_PARAMS = 65535 //單一語句綁定參數上限(PostgreSQL協定以int16記個數)
let MAX_NODES = 100000 //節點數上限(防共享參照造成之指數展開)
let MAX_KEY = 200 //欄名鍵字元數上限(僅為防禦, 識別字另有63 bytes上限)

//欄位層運算子白名單(單一來源, 帳本與README只引用)
let OPS_CMP = ['$gt', '$gte', '$lt', '$lte'] //值: 非null純量
let OPS_EQ = ['$equals', '$ne'] //值: 純量或null
let OPS_LIKE = ['$like', '$ilike'] //值: 字串
let OPS_SET = ['$in', '$nin'] //值: 純量或null之陣列
let OPS_BOOL = ['$null', '$notNull'] //值: 布林
let OPS_ALL = [...OPS_CMP, ...OPS_EQ, ...OPS_LIKE, ...OPS_SET, ...OPS_BOOL, '$not']

//欄名文法: 字母或底線開頭, 其後字母/數字/底線(可含Unicode字母, PostgreSQL允許非ASCII識別字).
//不含$ " . 空白 * ; 等, 令: $x$欄引用、$開頭之運算子鍵、mongo-sql之JSON/轉型/表.欄解析、
//$nin之RegExp改寫(欄名含$時失配而靜默成$in)皆無從誤判
let reIdent = /^[\p{L}_][\p{L}\p{M}\p{N}_]*$/u

//JSON取值鍵(mongo-sql之功能, JSONB欄唯一之過濾寫法): 欄(->|->>|#>|#>>)片段...
//片段僅限[識別字樣式]或[無前導零之整數]: mongo-sql以parseInt是否為NaN決定片段是否加引號,
//數字開頭但非純數字者(1abc)會被原樣輸出; 前導零者(007)被PostgreSQL當整數7而非鍵"007"
let reJsonPath = /^[\p{L}_][\p{L}\p{M}\p{N}_]*(?:(?:->>|->|#>>|#>)(?:[\p{L}_][\p{L}\p{M}\p{N}_]*|0|[1-9][0-9]*))+$/u

//轉型鍵: 欄::型別. mongo-sql把::型別黏在JSON路徑最後一個片段上, 與PostgreSQL之運算子優先序不符, 故JSON路徑不接轉型
let reCast = /::[A-Za-z_][A-Za-z0-9_]*$/

//孤立代理字元(UTF-8編碼時會變為U+FFFD, 令送出之值與呼叫端給的不同)
let reLone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * 字串是否不含NUL與孤立代理字元(兩者經UTF-8送出時被伺服器拒絕或被改為U+FFFD, 令送出之值與呼叫端給的不同)
 *
 * @param {String} s 輸入字串
 * @returns {Boolean} 回傳布林
 */
export let isCleanStr = (s) => (typeof s.isWellFormed === 'function' ? s.isWellFormed() : !reLone.test(s)) && !s.includes('\u0000')

let isObjLike = (v) => v !== null && typeof v === 'object'
let tag = (v) => Object.prototype.toString.call(v)

//以內部槽判定Date與Buffer(不受Symbol.toStringTag、instanceof、原型偽造影響), 且不經可被覆寫之實例方法
let dateGetTime = Date.prototype.getTime
let u8Tag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get
//copyBuf, 以TypedArray內建getter(內部槽)取buffer/byteOffset/byteLength後複製, 不經呼叫端可覆寫之valueOf、length等
let taProto = Object.getPrototypeOf(Uint8Array.prototype)
let gTaBuffer = Object.getOwnPropertyDescriptor(taProto, 'buffer').get
let gTaOffset = Object.getOwnPropertyDescriptor(taProto, 'byteOffset').get
let gTaLength = Object.getOwnPropertyDescriptor(taProto, 'byteLength').get
let copyBuf = (v) => Buffer.from(new Uint8Array(gTaBuffer.call(v), gTaOffset.call(v), gTaLength.call(v)))

let getTime = (v) => {
    if (!isObjLike(v)) {
        return undefined
    }
    try {
        return dateGetTime.call(v)
    }
    catch (err) {
        return undefined
    }
}

/**
 * 是否為Date物件(含無效Date)
 *
 * @param {*} v 輸入值
 * @returns {Boolean} 回傳布林
 */
export let isDateValue = (v) => getTime(v) !== undefined

/**
 * 以內部槽取Date之時間值(毫秒), 非Date回傳undefined; 無效Date回傳NaN
 *
 * @param {*} v 輸入值
 * @returns {Number|undefined} 回傳時間值
 */
export let dateTimeOf = (v) => getTime(v)

/**
 * 是否為Buffer
 *
 * @param {*} v 輸入值
 * @returns {Boolean} 回傳布林
 */
export let isBufferValue = (v) => isObjLike(v) && typeof Buffer !== 'undefined' && Buffer.isBuffer(v) && u8Tag.call(v) === 'Uint8Array'

/**
 * 是否為一般物件(原型為Object.prototype或null)
 *
 * @param {*} v 輸入值
 * @returns {Boolean} 回傳布林
 */
export let isPlainObject = (v) => {
    if (!isObjLike(v) || Array.isArray(v)) {
        return false
    }
    if (tag(v) !== '[object Object]') {
        return false
    }
    let p = Object.getPrototypeOf(v)
    return p === Object.prototype || p === null
}

//mongo-sql之parameterize將首尾皆為$之字串(含單一$)視為欄引用
let isColRef = (s) => s.length > 0 && s[0] === '$' && s[s.length - 1] === '$'

//msgOf, 取例外之訊息字串; 呼叫端鉤子拋出之物件可能令讀取message或轉字串本身再拋錯, 一律收斂
let msgOf = (err) => {
    try {
        return err && err.message !== undefined ? String(err.message) : String(err)
    }
    catch (err2) {
        return 'unknown error thrown by caller hook'
    }
}

//clean, 清除控制字元並限長, 供訊息使用
let clean = (s, n) => {
    // eslint-disable-next-line no-control-regex
    let t = String(s).replace(/[\u0000-\u001f\u007f]/g, '?')
    return t.length > n ? `${t.slice(0, n)}...` : t
}

//ours, 本模組fail()所建之Error(模組私有): 呼叫端鉤子拋出之物件即使訊息以'invalid find: '開頭也不得原樣重拋
let ours = new WeakSet()

let fail = (msg, path) => {
    let p = clean(path, 400)
    p = p.length > 120 ? `...${p.slice(-100)}` : p
    let e = new Error(`invalid find: ${clean(msg, 200)} at [${p}]`)
    ours.add(e)
    throw e
}

//budget, 單次cvFind之節點與綁定參數預算
let budget = { nodes: 0, params: 0 }

//ctx, 單次cvFind之選項(opt.nin為false表示本實例之表名令$nin改寫失配, 須拒收$nin)
let ctx = { nin: true }
let spend = (isParam, path) => {
    budget.nodes += 1
    if (budget.nodes > MAX_NODES) {
        fail('condition is too large', path)
    }
    if (isParam) {
        budget.params += 1
        if (budget.params > MAX_PARAMS) {
            fail(`too many bound parameters (> ${MAX_PARAMS})`, path)
        }
    }
}

//輸出物件一律為null原型, 令mongo-sql之for..in不會看到Object.prototype上之可列舉屬性
let newObj = () => Object.create(null)
let setOwn = (o, k, v) => {
    //描述子為null原型: 一般物件字面量會繼承被汙染之Object.prototype.get/set, 令defineProperty拋Getter must be a function
    Object.defineProperty(o, k, { __proto__: null, value: v, enumerable: true, writable: true, configurable: true })
}

//chkIdent, 識別字型欄名(供資料鍵與find共用)
let chkIdent = (k) => {
    if (typeof k !== 'string' || k === '__proto__' || k.length > MAX_KEY || !reIdent.test(k)) {
        return `unsupported column name [${clean(k, 60)}]`
    }
    if (Buffer.byteLength(k, 'utf8') > 63) {
        //PostgreSQL識別字上限63 bytes, 超過者被伺服器靜默截斷而可能指到他欄
        return 'column name is too long (> 63 bytes)'
    }
    return ''
}

/**
 * 檢核單一欄名為識別字(寫入路徑之資料鍵使用, 不接受JSON取值鍵與轉型鍵)
 *
 * @param {String} k 輸入欄名
 * @throws {Error} 不合文法時拋出Error('unsupported column name [k]')
 */
export function cvColumn(k) {
    let m = chkIdent(k)
    if (m) {
        throw new Error(m)
    }
}

//chkKey, find/order之欄名鍵: 識別字、JSON取值鍵、末尾單一轉型
let chkKey = (k, path) => {
    if (typeof k !== 'string') {
        fail('symbol key is not allowed', path)
    }
    if (k.startsWith('$')) {
        fail(`unsupported operator [${clean(k, 30)}]`, path)
    }
    if (k.length > MAX_KEY) {
        fail('column name is too long', path)
    }
    if (+k >= 0) {
        //mongo-sql以+key>=0判定為陣列索引(如Infinity), 欄名會被丟失而產生字面undefined
        fail(`unsupported column name [${clean(k, 30)}]`, path)
    }
    let base = k.replace(reCast, '')
    let hasCast = base !== k
    let colPart = base.split(/->|#>/)[0]
    let m = chkIdent(colPart)
    if (m) {
        fail(m, path)
    }
    if (reIdent.test(base)) {
        return
    }
    if (reJsonPath.test(base)) {
        if (hasCast) {
            fail('cast on JSON path is not supported', path)
        }
        return
    }
    fail(`unsupported column name [${clean(k, 60)}]`, path)
}

//chkScalar, 純量值: 字串(非$..$)、有限數值、布林、bigint、有效Date、Buffer; null依allowNull
let chkScalar = (v, path, allowNull, allowDollar = false) => {
    if (v === undefined) {
        fail('undefined is not allowed', path)
    }
    spend(true, path)
    if (v === null) {
        if (!allowNull) {
            fail('null is not allowed here', path)
        }
        return v
    }
    let t = typeof v
    if (t === 'string') {
        if (!allowDollar && isColRef(v)) {
            fail(`string [${clean(v, 20)}] begins and ends with "$" (reserved by mongo-sql as column reference, use $in)`, path)
        }
        if (typeof v.isWellFormed === 'function' ? !v.isWellFormed() : reLone.test(v)) {
            fail('string contains lone surrogate', path)
        }
        if (v.includes('\u0000')) {
            fail('string contains NUL', path)
        }
        return v
    }
    if (t === 'number') {
        if (!Number.isFinite(v)) {
            fail(`invalid number [${v}]`, path)
        }
        return v
    }
    if (t === 'boolean' || t === 'bigint') {
        return v
    }
    let ms = getTime(v)
    if (ms !== undefined) {
        if (Number.isNaN(ms)) {
            fail('invalid Date', path)
        }
        return new Date(ms)
    }
    if (isBufferValue(v)) {
        return copyBuf(v) //複製, 令mongo-sql與pg只見本模組驗過之位元組
    }
    fail(`unsupported value type [${t === 'object' ? tag(v) : t}]`, path)
}

//readOwn, 逐鍵僅讀值一次; 拒絕Symbol鍵、不可列舉、存取器
let readOwn = (obj, path) => {
    let out = []
    let keys
    try {
        keys = Reflect.ownKeys(obj)
    }
    catch (err) {
        fail(`can not read keys: ${err.message}`, path)
    }
    for (let k of keys) {
        let d
        try {
            d = Object.getOwnPropertyDescriptor(obj, k)
        }
        catch (err) {
            fail(`can not read property [${clean(String(k), 30)}]: ${err.message}`, path)
        }
        if (typeof k === 'symbol') {
            fail('symbol key is not allowed', path)
        }
        if (!d || !d.enumerable) {
            fail(`non-enumerable property [${clean(k, 30)}] is not allowed`, path)
        }
        if (!Object.prototype.hasOwnProperty.call(d, 'value')) { //不用 'value' in d, 以免受Object.prototype.value汙染
            fail(`accessor property [${clean(k, 30)}] is not allowed`, path)
        }
        out.push([k, d.value])
    }
    return out
}

//chkArrayShape, 陣列須為純索引陣列(不得帶非索引自有屬性, 否則直接走訪者與本模組所見不同); n為呼叫端僅讀一次之length
let chkArrayShape = (arr, n, path) => {
    if (Reflect.ownKeys(arr).length !== n + 1) {
        fail('array carries extra properties', path)
    }
}

//readElem, 讀陣列元素(僅讀一次, 拒絕洞、不可列舉與存取器)
let readElem = (arr, i, path) => {
    let d = Object.getOwnPropertyDescriptor(arr, i)
    if (!d) {
        fail(`sparse array hole at index ${i}`, path)
    }
    if (!d.enumerable) {
        fail('non-enumerable element is not allowed', `${path}[${i}]`)
    }
    if (!Object.prototype.hasOwnProperty.call(d, 'value')) {
        fail('accessor element is not allowed', `${path}[${i}]`)
    }
    return d.value
}

//chkSet, $in/$nin之陣列; inNot表位於$not之內
let chkSet = (op, arr, path, inNot) => {
    if (op === '$nin' && ctx.nin === false) {
        //mongo-sql以RegExp(含表名)改寫$nin, 表名含正規式特殊字元(如$)時改寫失配, $nin會靜默變成$in
        fail('$nin is not supported with this table name (it contains characters that break the $nin rewrite of mongo-sql)', path)
    }
    if (!Array.isArray(arr)) {
        fail('value must be an array', path)
    }
    let n = arr.length
    if (n > MAX_PARAMS) {
        fail(`array is too large (${n} > ${MAX_PARAMS})`, path)
    }
    chkArrayShape(arr, n, path)
    let out = []
    let hasNull = false
    let hasVal = false
    for (let i = 0; i < n; i++) {
        //$in/$nin之元素由mongo-sql直接以綁定參數送出(不經parameterize), 故$..$字串於此為字面值, 允許
        let v = chkScalar(readElem(arr, i, path), `${path}[${i}]`, true, true)
        if (v === null) {
            hasNull = true
        }
        else {
            hasVal = true
        }
        out.push(v)
    }
    if (n === 0) {
        if (op === '$nin') {
            //恆真且不引用欄位: delAll會刪全表
            fail('$nin with empty array is always true (would match all rows)', path)
        }
        if (inNot) {
            fail('$in with empty array inside $not is always true (would match all rows)', path)
        }
    }
    if (op === '$nin' && hasNull && hasVal) {
        //mongo-sql以replace改寫為 (not in(..) or is not null), 語意錯誤(命中應排除之列)
        fail('$nin containing both null and other values is not supported, use $notNull with $nin', path)
    }
    return out
}

//chkOpObj, 欄位層運算子物件; inNot表位於$not之內
let chkOpObj = (obj, path, depth, inNot) => {
    if (depth > MAX_DEPTH) {
        fail('nesting is too deep', path)
    }
    if (!isPlainObject(obj)) {
        fail(`operator object must be a plain object, got [${isObjLike(obj) ? tag(obj) : typeof obj}]`, path)
    }
    spend(false, path)
    let ents = readOwn(obj, path)
    if (ents.length === 0) {
        fail('empty operator object', path)
    }
    let out = newObj()
    for (let [k, v] of ents) {
        let p = `${path}.${clean(k, 30)}`
        if (!OPS_ALL.includes(k)) {
            if (k.startsWith('$')) {
                fail(`unsupported operator [${clean(k, 30)}]`, p)
            }
            fail(`unexpected key [${clean(k, 30)}] in operator object (nested conditions are not supported)`, p)
        }
        if (OPS_EQ.includes(k)) {
            setOwn(out, k, chkScalar(v, p, true))
        }
        else if (OPS_CMP.includes(k)) {
            setOwn(out, k, chkScalar(v, p, false))
        }
        else if (OPS_LIKE.includes(k)) {
            if (typeof v !== 'string') {
                fail('value must be a string', p)
            }
            setOwn(out, k, chkScalar(v, p, false))
        }
        else if (OPS_BOOL.includes(k)) {
            if (typeof v !== 'boolean') {
                fail('value must be a boolean', p)
            }
            setOwn(out, k, v)
        }
        else if (OPS_SET.includes(k)) {
            setOwn(out, k, chkSet(k, v, p, inNot))
        }
        else {
            //$not
            if (isObjLike(v) && !isDateValue(v) && !isBufferValue(v)) {
                setOwn(out, k, chkOpObj(v, p, depth + 1, true))
            }
            else {
                setOwn(out, k, chkScalar(v, p, false))
            }
        }
    }
    return out
}

//chkFieldCond, 欄位條件: 純量/null 或 運算子物件
let chkFieldCond = (v, path, depth) => {
    if (v === undefined) {
        fail('undefined is not allowed', path)
    }
    if (isObjLike(v) && !isDateValue(v) && !isBufferValue(v)) {
        if (Array.isArray(v)) {
            fail('array value is not supported, use $in', path)
        }
        return chkOpObj(v, path, depth + 1, false)
    }
    return chkScalar(v, path, true)
}

//chkDoc, 文件層: 欄名鍵 / $and / $or
let chkDoc = (obj, path, depth, allowEmpty) => {
    if (depth > MAX_DEPTH) {
        fail('nesting is too deep', path)
    }
    if (!isPlainObject(obj)) {
        fail(`condition must be a plain object, got [${obj === null ? 'null' : Array.isArray(obj) ? 'array' : isObjLike(obj) ? tag(obj) : typeof obj}]`, path)
    }
    spend(false, path)
    let ents = readOwn(obj, path)
    if (ents.length === 0 && !allowEmpty) {
        fail('empty condition', path)
    }
    let out = newObj()
    for (let [k, v] of ents) {
        let p = `${path}.${clean(k, 30)}`
        if (k === '$and' || k === '$or') {
            setOwn(out, k, chkList(k, v, p, depth + 1))
        }
        else {
            chkKey(k, p)
            setOwn(out, k, chkFieldCond(v, p, depth))
        }
    }
    return out
}

//toList, 將已檢核之文件陣列轉為null原型之{0:..,1:..}
//mongo-sql僅以for..in走訪且索引鍵升冪, 輸出之SQL與陣列相同, 且免疫Array.prototype汙染
let toList = (items) => {
    let out = newObj()
    items.forEach((x, i) => setOwn(out, String(i), x))
    return out
}

//chkList, $and/$or之清單: 非空陣列, 元素為非空文件; $and允許以{}為恆真元素(丟棄, 須至少留一個非空元素)
let chkList = (op, arr, path, depth) => {
    if (!Array.isArray(arr)) {
        fail('value must be an array', path)
    }
    let n = arr.length //僅讀一次(Proxy陣列不得令驗證期與複製期所見長度不同)
    if (n === 0) {
        fail(`${op} with empty array`, path)
    }
    chkArrayShape(arr, n, path)
    let items = []
    for (let i = 0; i < n; i++) {
        let v = readElem(arr, i, path)
        if (op === '$and' && isPlainObject(v) && Reflect.ownKeys(v).length === 0) {
            spend(false, `${path}[${i}]`) //被丟棄之{}亦計入節點預算
            continue
        }
        items.push(chkDoc(v, `${path}[${i}]`, depth, false))
    }
    if (items.length === 0) {
        fail(`${op} has no effective condition`, path)
    }
    return toList(items)
}

/**
 * 檢核並正規化find
 *
 * undefined、{}視為未給條件(全部). 傳了值卻不是條件物件者(null、陣列、字串、數值、布林、函數、Date等)一律reject
 * (使用者裁示B: 不得視同{}而全刪).
 *
 * 驗證過程中任何例外(含呼叫端物件之getter、Proxy trap、Symbol.toStringTag拋錯)一律轉為invalid find.
 * 可重入(呼叫端之trap再呼叫本函數亦不致重置外層之預算).
 *
 * @param {*} find 輸入條件
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Boolean} [opt.nin=true] 輸入是否允許$nin, 預設true; 表名令mongo-sql之$nin改寫失配者須給false
 * @returns {Object} 回傳全新之正規化find(null原型), 可交mongo-sql
 * @throws {Error} 不支援或無法轉譯者拋出Error('invalid find: <原因> at [<路徑>]')
 */
export function cvFind(find, opt = {}) {
    let savedBudget = budget
    let savedCtx = ctx
    budget = { nodes: 0, params: 0 }
    ctx = { nin: !opt || opt.nin !== false }
    try {
        return doFind(find)
    }
    catch (err) {
        if (ours.has(err)) {
            throw err
        }
        throw new Error(`invalid find: ${clean(msgOf(err), 200)} at [find]`)
    }
    finally {
        budget = savedBudget
        ctx = savedCtx
    }
}

//doFind, 頂層: 僅接受undefined(= 未給條件 = 全部)與一般物件({}亦為全部);
//傳了值卻不是條件物件(null、陣列、字串、數值、布林、函數、Date、RegExp、Map、Set、類別實例等)一律reject,
//不得視同{}而全刪(使用者裁示B, 見dspec〈一之一〉)
let doFind = (find) => {
    if (find === undefined) {
        return newObj()
    }
    return chkDoc(find, 'find', 0, true)
}

/**
 * 檢核並正規化order
 *
 * 僅接受undefined、null、{}或一般物件, 鍵依欄名文法, 值為asc|desc(不分大小寫, 可接nulls first|last).
 *
 * @param {*} order 輸入排序
 * @returns {Object} 回傳全新之order物件(null原型)
 * @throws {Error} 不支援者拋出Error('invalid order: <原因> at [<路徑>]')
 */
export function cvOrder(order) {
    if (order === undefined || order === null) {
        return newObj()
    }
    try {
        if (!isPlainObject(order)) {
            fail('order must be a plain object', 'order')
        }
        let out = newObj()
        for (let [k, v] of readOwn(order, 'order')) {
            let p = `order.${clean(k, 30)}`
            chkKey(k, p)
            if (typeof v !== 'string' || !/^(asc|desc)(\s+nulls\s+(first|last))?$/i.test(v)) {
                fail('direction must be asc or desc (optionally followed by nulls first|last)', p)
            }
            setOwn(out, k, v)
        }
        return out
    }
    catch (err) {
        if (ours.has(err)) {
            throw new Error(err.message.replace(/^invalid find/, 'invalid order'))
        }
        throw new Error(`invalid order: ${clean(msgOf(err), 200)} at [order]`)
    }
}

/**
 * 以正規化find與order產生快取鍵(區分Date、bigint、Buffer與字串, 以免JSON.stringify混同)
 *
 * @param {Object} find 已正規化之find, 或形如{[pk]: 主鍵值}之簡單條件
 * @param {Object} order 已正規化之order
 * @returns {String} 回傳快取鍵
 */
export function cvKey(find, order) {
    let rep = function(k, v) {
        let raw = this[k]
        if (typeof raw === 'bigint') {
            return { $bigint: String(raw) }
        }
        if (typeof raw === 'number' && !Number.isFinite(raw)) {
            return { $num: String(raw) } //NaN、Infinity於JSON.stringify皆為null, 會與null混同
        }
        let ms = getTime(raw)
        if (ms !== undefined) {
            return { $date: ms }
        }
        if (isBufferValue(raw)) {
            return { $buf: raw.toString('hex') }
        }
        return v
    }
    return JSON.stringify({ find, order }, rep)
}
