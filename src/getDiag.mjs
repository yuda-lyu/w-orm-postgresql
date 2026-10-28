//診斷輸出之單一出口(R18): src內所有console輸出皆經getDiag回傳之diag, 除本檔外不得直接呼叫console
//預設只輸出固定標籤與不含個資之摘要(不含資料值、id、後端錯誤原文); 連線字串與帳密於任何輸出(含logDetail與funLog之細節)一律以***遮罩
//選項名稱與語意比照w-serv-orm: opt.logDetail(還原細節輸出)、opt.funLog(label, safe, detail)(取代console收完整細節)
//不使用Node內建模組(util等): dist由rollup打包, gDistRollup.mjs之external只列events、pg、knex, 內建模組未列者會被當成未解析之外部相依
//(故無法以util.types.isProxy辨識Proxy: Proxy之陷阱函數在判斷原型/自有屬性時可能被執行, 見README〈Diagnostic output〉之限制)


//遮罩字串
const MASK = '***'

//cpMask之上限: 深度, 處理的節點與鍵合計數; 超過者以標記字串代替(不交出原參照)
const CP_DEPTH = 6
const CP_MAX = 2000

//預設摘要之錯誤類別名稱白名單: 內建錯誤類別與pg之DatabaseError; 其餘(使用端自訂類別名稱可能夾帶帳號、員編等識別字)一律列為Error, 完整名稱留給logDetail與funLog
const ERR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'DatabaseError'])

//預設摘要之錯誤代碼白名單(明確常數集合, 不用樣式: 樣式會放行形如員編、郵遞區號之5碼識別碼與ERR_開頭之業務字串; 數值一律不放行)
//Node(libuv)系統錯誤名稱
const SYS_CODES = new Set(['E2BIG', 'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EAGAIN', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME', 'EAI_SERVICE', 'EALREADY', 'EBADF', 'EBUSY', 'ECANCELED', 'ECHILD', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EDEADLK', 'EDESTADDRREQ', 'EDOM', 'EEXIST', 'EFAULT', 'EFBIG', 'EHOSTUNREACH', 'EINTR', 'EINVAL', 'EIO', 'EISCONN', 'EISDIR', 'ELOOP', 'EMFILE', 'EMLINK', 'EMSGSIZE', 'ENAMETOOLONG', 'ENETDOWN', 'ENETUNREACH', 'ENFILE', 'ENOBUFS', 'ENODATA', 'ENODEV', 'ENOENT', 'ENOEXEC', 'ENOMEM', 'ENOPROTOOPT', 'ENOSPC', 'ENOSYS', 'ENOTCONN', 'ENOTDIR', 'ENOTEMPTY', 'ENOTFOUND', 'ENOTSOCK', 'ENOTSUP', 'EPERM', 'EPIPE', 'EPROTO', 'EPROTONOSUPPORT', 'EPROTOTYPE', 'ERANGE', 'EROFS', 'ESHUTDOWN', 'ESPIPE', 'ESRCH', 'ETIMEDOUT', 'ETXTBSY', 'EWOULDBLOCK', 'EXDEV'])
//Node內部與TLS之常見代碼
const NODE_CODES = new Set(['ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE', 'ERR_UNHANDLED_ERROR', 'ERR_SOCKET_CLOSED', 'ERR_SOCKET_BAD_PORT', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'])
//PostgreSQL之SQLSTATE(官方附錄A之錯誤代碼)
const SQLSTATES = new Set([
    '00000 01000 0100C 01008 01003 01007 01006 01004 01P01 02000 02001 03000 08000 08003 08006 08001 08004 08007 08P01 09000 0A000 0B000 0F000 0F001 0L000 0LP01 0P000 0Z000 0Z002 20000 21000',
    '22000 2202E 22021 22008 22012 22005 2200B 22022 22015 2201E 22014 22016 2201F 2201G 22018 22007 22019 2200D 22025 22P06 22010 22023 22013 2201B 2201W 2201X 2202H 2202G 22009 2200C 2200G 22004 22002 22003 2200H 22026 22001 22011 22027 22024 2200F 22P01 22P02 22P03 22P04 22P05 2200L 2200M 2200N 2200S 2200T 22030 22031 22032 22033 22034 22035 22036 22037 22038 22039 2203A 2203B 2203C 2203D 2203E 2203F 2203G',
    '23000 23001 23502 23503 23505 23514 23P01 24000 25000 25001 25002 25008 25003 25004 25005 25006 25007 25P01 25P02 25P03 26000 27000 28000 28P01 2B000 2BP01 2D000 2F000 2F005 2F002 2F003 2F004 34000 38000 38001 38002 38003 38004 39000 39001 39004 39P01 39P02 39P03 3B000 3B001 3D000 3F000',
    '40000 40002 40001 40003 40P01 42000 42601 42501 42846 42803 42P20 42P19 42830 42602 42622 42939 42804 42P18 42809 42703 42883 42P01 42P02 42704 42701 42P03 42P04 42723 42P05 42P06 42P07 42712 42710 42702 42725 42P08 42P09 42P10 42611 42P11 42P12 42P13 42P14 42P15 42P16 42P17 44000',
    '53000 53100 53200 53300 53400 54000 54001 54011 54023 55000 55006 55P02 55P03 55P04 57000 57014 57P01 57P02 57P03 57P04 57P05 58000 58030 58P01 58P02 72000 F0000 F0001',
    'HV000 HV005 HV002 HV010 HV021 HV024 HV007 HV008 HV004 HV006 HV091 HV00B HV00C HV00D HV090 HV00A HV009 HV014 HV001 HV00P HV00J HV00K HV00Q HV00R HV00L HV00M HV00N P0000 P0001 P0002 P0003 P0004 XX000 XX001 XX002'
].join(' ').split(' '))

//連線字串內嵌之帳密(scheme://帳密@主機), 不依賴已知秘密亦遮罩(僅為對「非本實例設定之連線字串」的盡力兜底); 帳密部分含未編碼之@時取至最後一個@(至空白、/或引號為止)
const RE_URL_CRED = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/'"]*@/g

//陣列之索引鍵(其餘自有鍵與Symbol鍵可夾帶憑證, 須遮罩)
const RE_INDEX = /^(?:0|[1-9][0-9]*)$/

//內建錯誤類別(newErr用)
const ERR_CTORS = [Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError]
if (typeof AggregateError === 'function') {
    ERR_CTORS.push(AggregateError) //Node 15起才有
}

//二進位資料byteLength與包裝物件valueOf的內建函數: 以.call套用, 非該型別者拋TypeError(辨識型別但不執行使用端程式)
const BL_AB = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const BL_TA = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get
const BL_DV = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get
const DATE_TIME = Date.prototype.getTime
const UNBOXERS = [String.prototype.valueOf, Number.prototype.valueOf, Boolean.prototype.valueOf, Symbol.prototype.valueOf]
if (typeof BigInt === 'function') {
    UNBOXERS.push(BigInt.prototype.valueOf)
}

//Error的stack於V8為自有存取器, 其getter為同一realm內共用的內建函數: 僅當描述子的getter與此相同才讀取(不執行使用端程式)
const STACK_GETTER = (() => {
    try {
        let d = Object.getOwnPropertyDescriptor(new Error(), 'stack')
        return d !== undefined && !Object.prototype.hasOwnProperty.call(d, 'value') && typeof d.get === 'function' ? d.get : null
    }
    catch (e) {
        return null
    }
})()

//模組載入時之Error.prepareStackTrace: undefined=未定義; 函式=Node內建預設(名稱為ErrorPrepareStackTrace); null=其他(使用端已掛如source-map-support、或存取器), 一律視為不安全
const PREP_STACK = (() => {
    try {
        let d = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
        if (d === undefined) {
            return undefined
        }
        let f = Object.prototype.hasOwnProperty.call(d, 'value') ? d.value : null
        return typeof f === 'function' && Object.getOwnPropertyDescriptor(f, 'name').value === 'ErrorPrepareStackTrace' ? f : null
    }
    catch (e) {
        return null
    }
})()


function getOptLog(opt) {
    //診斷輸出的設定, 供WOrmPostgresql建構時使用, 回傳固定快照{ logDetail, funLog }, 其後各路徑共用此快照, 不再讀取使用端的opt
    //型別錯誤者忽略並用預設(安全輸出), 讀取opt拋錯者亦同, 與本套件其他選項(useCache等型別錯誤即用預設)一致; 各選項分別讀取, 單一getter拋錯只丟該選項
    //logDetail: 須為true才生效, 預設false; true時console輸出還原為含資料值與錯誤原文的完整細節(連線憑證仍遮罩), 供除錯
    //funLog: 須為函數才生效, 預設無; 給予時診斷輸出只交給它(不寫console), detail為完整細節(連線憑證仍遮罩), 供使用端遮罩或轉送
    let logDetail = false
    try {
        logDetail = opt.logDetail === true
    }
    catch (e) {
        //忽略
    }
    let funLog = null
    try {
        let f = opt.funLog
        funLog = typeof f === 'function' ? f : null
    }
    catch (e) {
        //忽略
    }
    return { logDetail, funLog }
}


function getCred(url) {
    //由連線字串取帳號與密碼之候選(供getSecrets): 純函數, 不拋錯
    //pg以WHATWG URL解析: 帳密段取至權限段(第一個/、?、#之前)內的最後一個@, 帳號與密碼以第一個:分隔; 另補「整串取至最後一個@」之寬鬆候選
    //(密碼含未編碼之/、?、#時pg會把其後視為路徑, 但輸出中仍可能出現完整原文), 候選多於實際者只是多遮罩, 不會漏
    //pg亦接受查詢參數user、password(?user=…&password=…): 取原樣與解碼(+視為空白、百分比解碼)兩種形式
    let r = []
    if (typeof url !== 'string') {
        return r
    }
    let add = (username, password) => {
        if (!r.some((v) => v.username === username && v.password === password)) {
            r.push({ username, password })
        }
    }
    let i = url.indexOf('://')
    let rest = i >= 0 ? url.slice(i + 3) : url
    let cut = rest.search(/[/?#]/)
    for (let seg of [cut < 0 ? rest : rest.slice(0, cut), rest]) {
        let at = seg.lastIndexOf('@')
        if (at < 0) {
            continue
        }
        let cred = seg.slice(0, at)
        let c = cred.indexOf(':')
        add(c < 0 ? cred : cred.slice(0, c), c < 0 ? '' : cred.slice(c + 1))
    }
    //畸形網址(權限段之後仍有@, 如密碼含未編碼之/、?、#): pg會把密碼片段解析成主機名或資料庫名, 其錯誤訊息(如getaddrinfo ENOTFOUND <片段>)可能含之,
    //故以@ / : ? #分段之各片段(至少3字元)亦列為候選; 合格網址不走此路(主機名仍可見於輸出)
    if (cut >= 0 && rest.indexOf('@', cut) >= 0) {
        for (let tok of rest.split(/[@/:?#]/)) {
            if (tok.length >= 3) {
                add(tok, '')
            }
        }
    }
    //查詢參數user、password
    let q = url.indexOf('?')
    if (q >= 0) {
        let qs = url.slice(q + 1)
        let h = qs.indexOf('#')
        let user = null
        let pw = null
        for (let part of (h >= 0 ? qs.slice(0, h) : qs).split('&')) {
            let e = part.indexOf('=')
            let k = e < 0 ? part : part.slice(0, e)
            if (e >= 0 && (k === 'user' || k === 'password')) {
                if (k === 'user') {
                    user = part.slice(e + 1)
                }
                else {
                    pw = part.slice(e + 1)
                }
            }
        }
        let dec = (s) => {
            try {
                return s === null ? null : decodeURIComponent(s.replace(/\+/g, ' '))
            }
            catch (e2) {
                return s
            }
        }
        if (user !== null || pw !== null) {
            add(user === null ? '' : user, pw === null ? '' : pw)
            add(user === null ? '' : dec(user), pw === null ? '' : dec(pw))
        }
    }
    return r
}


function getUrlParts(cs) {
    //以pg相同之方式(WHATWG URL, 解析失敗時以假主機重試)解析連線字串, 取其帳號與密碼(皆為URL儲存之編碼形式); 解析失敗者回空
    if (typeof URL !== 'function' || typeof cs !== 'string') {
        return []
    }
    try {
        let u = null
        try {
            u = new URL(cs, 'postgres://base')
        }
        catch (e) {
            u = new URL(cs.replace('@/', '@___DUMMY___/'), 'postgres://base')
        }
        return [u.username, u.password]
    }
    catch (e) {
        return []
    }
}


function variantsOf(s) {
    //一個秘密之各種輸出形式: 原樣與URL解碼(pg會對帳密decodeURIComponent)後, 各取原樣、單引號加倍(SQL字串字面值)、JSON跳脫、URL編碼(大寫與小寫十六進位)
    let bases = [s]
    try {
        bases.push(decodeURIComponent(s))
    }
    catch (e) {
        //非合法百分比編碼, 略過
    }
    let all = []
    for (let b of bases) {
        all.push(b, b.replace(/'/g, '\'\''), JSON.stringify(b).slice(1, -1))
        try {
            let enc = encodeURIComponent(b)
            let strict = enc.replace(/[!'()*]/g, (m) => `%${m.charCodeAt(0).toString(16).toUpperCase()}`) //RFC 3986嚴格編碼(encodeURIComponent不編碼! ' ( ) *)
            for (let x of [enc, strict]) {
                all.push(x, x.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()))
            }
        }
        catch (e) {
            //孤立代理碼元無法編碼, 略過
        }
    }
    return all
}


function getSecrets(urls, username, password) {
    //連線憑證清單: 連線字串(可給多個, 如opt.url與組合後之連線字串)、帳號、密碼、帳號:密碼, 各取variantsOf之各形式; 長者在前
    //註: 帳號單獨出現時至少3字元才遮罩(如sa、u之類過短者會把無關文字一併吞掉); 其與密碼並列之形式(帳號:密碼、連線字串)不受此限
    let isOk = (s) => typeof s === 'string' && s !== ''
    let base = [].concat(urls)
    if (isOk(username) || isOk(password)) {
        base.push(password, `${username}:${password}`)
        if (isOk(username) && username.length >= 3) {
            base.push(username)
        }
    }
    let all = []
    for (let s of base) {
        if (isOk(s)) {
            all.push(...variantsOf(s))
        }
    }
    return all.filter((s, k) => isOk(s) && all.indexOf(s) === k).sort((a, b) => b.length - a.length)
}


function getSecretsOfUrl(url, connectionString) {
    //由opt.url與組合後之連線字串推得全部連線憑證: 兩字串本身、由兩者手動解析之帳號與密碼候選(getCred)、以pg相同方式(URL)解析所得之帳號與密碼
    let ss = []
    for (let s of [url, connectionString]) {
        for (let { username, password } of getCred(s)) {
            ss.push(...getSecrets([], username, password))
        }
    }
    let [username, password] = getUrlParts(connectionString)
    if (username !== undefined) {
        ss.push(...getSecrets([], username, password))
    }
    ss.push(...getSecrets([url, connectionString]))
    return ss.filter((s, k) => ss.indexOf(s) === k).sort((a, b) => b.length - a.length)
}


function getNums(secrets) {
    //秘密中純數字且至少4位者(如數字密碼): 數值型別之同值亦須遮罩; 過短者(如1)遮罩會吞掉大量無關數值, 不納入
    return new Set(secrets.filter((s) => /^[0-9]{4,}$/.test(s)))
}


function maskText(s, secrets = []) {
    //字串中之憑證以***取代: 已知秘密(getSecrets)、scheme://帳密@(帳密含@時取至最後一個@)
    //已知秘密先在原字串上找出全部命中區間, 相交者合併後一次取代(逐一取代時較長秘密會吃掉與它首尾重疊之較短秘密的前綴, 留下可還原的片段)
    if (typeof s !== 'string') {
        return s
    }
    let ivs = []
    for (let sec of secrets) {
        if (sec === '') {
            continue
        }
        for (let i = s.indexOf(sec); i >= 0; i = s.indexOf(sec, i + 1)) {
            ivs.push([i, i + sec.length])
        }
    }
    let r = s
    if (ivs.length > 0) {
        ivs.sort((a, b) => a[0] - b[0] || b[1] - a[1])
        let out = ''
        let pos = 0
        let cs = ivs[0][0]
        let ce = ivs[0][1]
        for (let k = 1; k <= ivs.length; k++) {
            if (k < ivs.length && ivs[k][0] < ce) {
                ce = Math.max(ce, ivs[k][1])
                continue
            }
            out += s.slice(pos, cs) + MASK
            pos = ce
            if (k < ivs.length) {
                cs = ivs[k][0]
                ce = ivs[k][1]
            }
        }
        r = out + s.slice(pos)
    }
    return r.replace(RE_URL_CRED, `$1${MASK}@`)
}


function maskKey(k, c) {
    //屬性鍵之遮罩: 字串鍵與Symbol之描述文字皆可能含憑證
    if (typeof k === 'string') {
        return maskText(k, c.secrets)
    }
    let d = k.description
    let m = typeof d === 'string' ? maskText(d, c.secrets) : d
    return m === d ? k : Symbol(m)
}


function tryCall(fn, v) {
    //以內建函數辨識型別: 非該型別者拋TypeError, 回傳undefined; 不執行使用端程式
    try {
        return fn.call(v)
    }
    catch (e) {
        return undefined
    }
}


function newErr(v) {
    //Error副本的空殼: 原錯誤的原型恰為內建錯誤類別(Error、TypeError等)者建同類別之實例(使util.inspect輸出與原物件一致, 如TypeError: …而非Error [TypeError]: …),
    //其餘(使用端自訂類別等)一律為Error(不沿用使用端的原型); 只呼叫內建建構子, 不執行使用端程式
    let proto = Object.getPrototypeOf(v)
    for (let C of ERR_CTORS) {
        if (C.prototype === proto) {
            return C.name === 'AggregateError' ? new C([]) : new C()
        }
    }
    return new Error()
}


function stackReadable(v) {
    //讀stack是否不會執行使用端程式: V8在首次讀stack時才格式化, 會讀name與message(使用端存取器會被執行)並呼叫Error.prepareStackTrace(使用端函數會被執行)
    //故要求: Error.prepareStackTrace仍是載入時之內建預設(或一直未定義)、v及其原型鏈(至Error.prototype前)上之name與message皆非存取器
    try {
        let d = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
        if (PREP_STACK === null || (d === undefined) !== (PREP_STACK === undefined) || (d !== undefined && d.value !== PREP_STACK)) {
            return false
        }
        for (let x = v; x !== null && x !== Error.prototype; x = Object.getPrototypeOf(x)) {
            for (let k of ['name', 'message']) {
                let e = Object.getOwnPropertyDescriptor(x, k)
                if (e !== undefined && !Object.prototype.hasOwnProperty.call(e, 'value')) {
                    return false
                }
            }
        }
        return true
    }
    catch (e) {
        return false
    }
}


function cp(v, c, depth) {
    //遞迴複製並遮罩, 不執行使用端程式(不呼叫getter、實例方法、建構子), 不交出原參照; 副本原型一律為內建原型(不沿用使用端的原型: 其繼承屬性未遮罩、util.inspect.custom會在格式化時執行)
    if (typeof v === 'string') {
        return maskText(v, c.secrets)
    }
    if (typeof v === 'number' || typeof v === 'bigint') {
        return c.nums.has(String(v)) ? MASK : v
    }
    if (typeof v === 'symbol') {
        return maskKey(v, c)
    }
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) {
        return v
    }
    if (typeof v === 'function') {
        return '[Function]'
    }
    if (depth >= CP_DEPTH || c.n >= CP_MAX) {
        return '[Truncated]'
    }
    if (c.seen.has(v)) {
        return c.seen.get(v)
    }
    c.n++
    try {
        //包裝物件(new String(憑證)等): 取其內部原始值再遮罩(否則逐字元攤開, 繞過字串遮罩)
        for (let f of UNBOXERS) {
            let p = tryCall(f, v)
            if (p !== undefined) {
                return cp(p, c, depth)
            }
        }
        //二進位資料: 以內建getter取長度, 不讀使用端可覆寫之byteLength
        for (let f of [BL_TA, BL_DV, BL_AB]) {
            let n = tryCall(f, v)
            if (typeof n === 'number') {
                return `[Binary ${n} bytes]`
            }
        }
        let t = tryCall(DATE_TIME, v)
        if (t !== undefined) {
            return new Date(t)
        }
        if (v instanceof Map || v instanceof Set || v instanceof WeakMap || v instanceof WeakSet || v instanceof RegExp || v instanceof Promise) {
            return '[Object]' //無法複製的內建物件
        }
        let isArr = Array.isArray(v)
        let isErr = v instanceof Error //不用Object.prototype.toString(會執行Symbol.toStringTag之getter)
        let r = isArr ? new Array(v.length) : (isErr ? newErr(v) : {})
        c.seen.set(v, r)
        for (let k of Reflect.ownKeys(v)) {
            if (c.n >= CP_MAX) {
                break
            }
            if (k === 'length' && isArr) {
                continue
            }
            let d = Object.getOwnPropertyDescriptor(v, k)
            if (d === undefined) {
                continue
            }
            c.n++
            let val = '[Getter/Setter]'
            if (Object.prototype.hasOwnProperty.call(d, 'value')) {
                val = cp(d.value, c, depth + 1)
            }
            else if (isErr && k === 'stack' && STACK_GETTER !== null && d.get === STACK_GETTER && stackReadable(v)) {
                //stack於V8為內建存取器: 僅當其getter嚴格等於同realm共用之內建getter、且讀取不會執行使用端程式(stackReadable)才讀取
                let s = STACK_GETTER.call(v)
                val = typeof s === 'string' ? maskText(s, c.secrets) : val
            }
            //陣列只有索引鍵原樣保留, 其餘自有字串鍵與Symbol鍵可夾帶憑證須遮罩
            let key = isArr && typeof k === 'string' && RE_INDEX.test(k) ? k : maskKey(k, c)
            Object.defineProperty(r, key, { value: val, writable: true, enumerable: d.enumerable, configurable: true })
        }
        if (isErr && !Object.prototype.hasOwnProperty.call(r, 'name')) {
            //類別名稱常在原型上(class MyError extends Error): 取原型鏈上第一個資料屬性name, 副本才保有類別名稱
            for (let x = Object.getPrototypeOf(v); x !== null; x = Object.getPrototypeOf(x)) {
                let d = Object.getOwnPropertyDescriptor(x, 'name')
                if (d !== undefined) {
                    if (Object.prototype.hasOwnProperty.call(d, 'value') && typeof d.value === 'string') {
                        Object.defineProperty(r, 'name', { value: maskText(d.value, c.secrets), writable: true, enumerable: false, configurable: true })
                    }
                    break
                }
            }
        }
        return r
    }
    catch (e) {
        return '[Uncopyable]'
    }
}


function cpMask(v, secrets = []) {
    //交給console或funLog之完整細節的遮罩拷貝: 憑證以***取代(值、屬性鍵、Symbol值與描述、包裝物件內的值、同值數字), 不改動呼叫端的原物件(細節若與其後仍要使用的物件共用, 使用端原地遮罩會改變結果)
    //複製: 純物件與類別實例(複製自有屬性成普通物件, 不保留原型)、陣列(含自有非索引鍵)、原生Error(含message、stack、cause、類別名稱name)、Date、包裝物件(解為原始值); 標記字串代替: 函數、二進位資料、Map與Set等內建物件、存取器、過深或過大者
    return cp(v, { secrets, nums: getNums(secrets), n: 0, seen: new WeakMap() }, 0)
}


function noop() {
    //吞下funLog回傳之promise的reject
}


function swallow(r) {
    //funLog的回傳若為promise或thenable, 附上reject處理, 使其reject不成為unhandledRejection; 全程不使診斷輸出拋錯
    try {
        if (r !== null && (typeof r === 'object' || typeof r === 'function')) {
            let t = r.then
            if (typeof t === 'function') {
                let x = t.call(r, undefined, noop)
                if (x !== null && (typeof x === 'object' || typeof x === 'function') && typeof x.then === 'function') {
                    x.then(undefined, noop)
                }
            }
        }
    }
    catch (e) {
        //放棄
    }
}


function getDiag(optLog, secrets = []) {
    //回傳診斷輸出函數diag(label, safe, getDetail, bare), 所有診斷輸出皆經此(R18)
    //label: 固定標籤; safe: 不含資料值、id與錯誤原文的摘要(預設輸出; 由本套件以固定詞彙組成〔操作別、白名單類別名與代碼〕, 不做子字串遮罩:
    //  對固定常數挖空反而會讓輸出的缺口洩漏短密碼之內容), 無則undefined; getDetail: 回傳完整細節的函數(只在有消費者時才呼叫), 無細節則undefined
    //bare: 為true者, logDetail還原時只輸出細節而不加label(舊版該站即為console.log(細節))
    //輸出不得使呼叫端的流程拋錯: 細節的取得、console與funLog的拋錯一律吞下; funLog回傳的promise之reject亦吞下
    let { logDetail, funLog } = optLog === undefined ? getOptLog(undefined) : optLog
    return (label, safe, getDetail, bare = false) => {

        //getArgs, 完整細節(憑證遮罩後); 僅在需要時取得
        let getArgs = () => {
            if (getDetail === undefined) {
                return []
            }
            try {
                return [cpMask(getDetail(), secrets)]
            }
            catch (e) {
                return ['(unprintable)']
            }
        }

        //funLog, 取代console輸出
        if (funLog !== null) {
            try {
                swallow(funLog(label, safe, ...getArgs()))
            }
            catch (e) {
                //放棄輸出
            }
            return
        }

        //console, 預設為安全摘要; logDetail為true時還原完整細節
        try {
            if (logDetail) {
                console.log(...(bare ? [] : [label]), ...getArgs())
            }
            else if (safe === undefined) {
                console.log(label)
            }
            else {
                console.log(label, safe)
            }
        }
        catch (e) {
            try {
                console.log(label, '(unprintable)')
            }
            catch (e2) {
                //放棄輸出
            }
        }
    }
}


function ownData(o, k) {
    //取o自有資料屬性k之值, 不執行getter; 非資料屬性或無則undefined
    try {
        if (o === null || (typeof o !== 'object' && typeof o !== 'function')) {
            return undefined
        }
        let d = Object.getOwnPropertyDescriptor(o, k)
        return d !== undefined && Object.prototype.hasOwnProperty.call(d, 'value') ? d.value : undefined
    }
    catch (e) {
        return undefined
    }
}


function isErrCode(c) {
    //錯誤代碼是否為白名單內之機器代碼(系統錯誤名稱、Node內部/TLS代碼、PostgreSQL之SQLSTATE); 數值與其他字串一律不放行
    //(pg與Node之錯誤代碼皆為字串, 訂閱函數自行拋出之code可能是使用者識別、員編、郵遞區號等資料)
    return typeof c === 'string' && (SYS_CODES.has(c) || NODE_CODES.has(c) || SQLSTATES.has(c))
}


function getBriefErr(e) {
    //錯誤(後端或訂閱函數拋出的值)的摘要: 只列類別與代碼, 不含訊息文字; 不執行getter(自有資料屬性)
    //字串列為string; Error取其建構子名稱, 僅白名單(ERR_TYPES)內者照列, 其餘列為Error; 代碼取自有資料屬性code, 限白名單
    //限制: 判斷是否為Error與原型時, Proxy之陷阱函數可能被執行(本檔不用Node內建模組, 無法預先辨識Proxy)
    try {
        if (typeof e === 'string') {
            return { errType: 'string' }
        }
        if (e === null || (typeof e !== 'object' && typeof e !== 'function')) {
            return { errType: e === null ? 'null' : typeof e }
        }
        let errType = typeof e === 'function' ? 'function' : 'object'
        if (e instanceof Error) { //不用Object.prototype.toString(會執行Symbol.toStringTag之getter)
            let cname
            for (let x = e; x !== null && cname === undefined; x = Object.getPrototypeOf(x)) {
                let ctor = ownData(x, 'constructor')
                if (typeof ctor === 'function') {
                    cname = ownData(ctor, 'name')
                    break
                }
            }
            errType = typeof cname === 'string' && ERR_TYPES.has(cname) ? cname : 'Error'
        }
        let c = ownData(e, 'code')
        //以物件字面值一次建成(不對新物件逐鍵賦值: Object.prototype上若有同名之唯讀屬性或setter, 賦值會拋錯或被攔截)
        return isErrCode(c) ? { errType, errCode: c } : { errType }
    }
    catch (e2) {
        return { errType: 'unknown' }
    }
}


export { getOptLog, getCred, getSecrets, getSecretsOfUrl, maskText, cpMask, getDiag, getBriefErr }
