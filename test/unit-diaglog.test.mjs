import fs from 'fs'
import util from 'util'
import assert from 'assert'
import WOrm from '../src/WOrmPostgresql.mjs'
import { getOptLog, getCred, getSecrets, getSecretsOfUrl, maskText, cpMask, getDiag, getBriefErr } from '../src/getDiag.mjs'


//rulebook R18: 診斷輸出單一出口(src/getDiag.mjs)之純函數測試, 不連線、不需docker
//對應: 預設只輸出標籤與不含個資之摘要(R18-1)、logDetail還原細節且憑證遮罩(R18-2)、funLog收完整細節(R18-3)、輸出不得使呼叫端拋錯(R18-4)、
//      憑證遮罩之完整性(R18-5)、單一出口(R18-7)、建構函式訊息不回顯連線網址與帳密(R18-8)


let PW = 'S3cretPw'
let USER = 'tuser'
let URL = `postgresql://${USER}:${PW}@db.example.local:5432`
let ID = 'u-secret-001@example.com'


//cap, 擷取console各方法之輸出
function cap(fn) {
    let lines = []
    let ks = ['log', 'info', 'warn', 'error', 'debug']
    let olds = ks.map((k) => console[k])
    ks.forEach((k) => {
        console[k] = (...a) => lines.push(util.format(...a)) //與console.log實際輸出一致(Error顯示message與stack、Symbol鍵與陣列附加屬性亦顯示)
    })
    try {
        fn()
    }
    finally {
        ks.forEach((k, i) => {
            console[k] = olds[i]
        })
    }
    return lines
}


describe('getOptLog', function() {

    it('R18-3 未給或型別錯誤者忽略並用預設(與本套件其他選項型別錯誤之處理一致: 不拋錯)', function() {
        for (let o of [undefined, null, {}, 1, 'x', { logDetail: 'true' }, { logDetail: 1 }, { logDetail: {} }, { funLog: 'x' }, { funLog: {} }, { funLog: null }]) {
            assert.deepStrictEqual(getOptLog(o), { logDetail: false, funLog: null }, JSON.stringify(o))
        }
    })

    it('R18-3 logDetail為true、funLog為函數才生效', function() {
        let f = () => {}
        assert.deepStrictEqual(getOptLog({ logDetail: true, funLog: f }), { logDetail: true, funLog: f })
        assert.deepStrictEqual(getOptLog({ logDetail: false }), { logDetail: false, funLog: null })
    })

    it('R18-3 讀取選項拋錯者忽略該選項, 不連累另一個有效選項', function() {
        let f = () => {}
        let o1 = {
            get logDetail() {
                throw new Error('x')
            },
            funLog: f
        }
        assert.deepStrictEqual(getOptLog(o1), { logDetail: false, funLog: f })
        let o2 = {
            logDetail: true,
            get funLog() {
                throw new Error('x')
            }
        }
        assert.deepStrictEqual(getOptLog(o2), { logDetail: true, funLog: null })
    })

    it('R18-3 回傳固定快照: 其後改動opt不影響; 選項之getter只被讀取一次', function() {
        let n = 0
        let o = {
            get logDetail() {
                n++
                return n === 1
            }
        }
        let snap = getOptLog(o)
        assert.strictEqual(snap.logDetail, true)
        assert.strictEqual(n, 1)
        let diag = getDiag(snap)
        let lines = cap(() => diag('L', { a: 1 }, () => 'd', true))
        assert.deepStrictEqual(lines, ['d'])
        assert.strictEqual(n, 1)
    })

})


describe('getDiag', function() {

    it('R18-1 預設只輸出標籤與摘要, 不呼叫getDetail(細節在預設路徑不被取得)', function() {
        let n = 0
        let diag = getDiag(getOptLog({}))
        let lines = cap(() => {
            diag('L1', { mode: 'insert', errType: 'Error' }, () => {
                n++
                return `detail ${ID}`
            })
            diag('L2', undefined, () => {
                n++
                return ID
            })
            diag('L3')
        })
        assert.deepStrictEqual(lines, ['L1 { mode: \'insert\', errType: \'Error\' }', 'L2', 'L3'])
        assert.strictEqual(n, 0)
    })

    it('R18-2 logDetail為true時還原細節: 標籤加細節; bare者只輸出細節(與舊版該站之console.log(細節)相同)', function() {
        let diag = getDiag(getOptLog({ logDetail: true }))
        let lines = cap(() => {
            diag('L1', { a: 1 }, () => `detail ${ID}`)
            diag('L2', { a: 1 }, () => `bare ${ID}`, true)
            diag('L3', undefined)
        })
        assert.deepStrictEqual(lines, [`L1 detail ${ID}`, `bare ${ID}`, 'L3'])
    })

    it('R18-3 funLog收(label, safe, detail), 不寫console; 無細節者只收兩個引數', function() {
        let got = []
        let diag = getDiag(getOptLog({ funLog: (...a) => got.push(a) }))
        let lines = cap(() => {
            diag('L1', { a: 1 }, () => ({ id: ID }))
            diag('L2', undefined)
        })
        assert.deepStrictEqual(lines, [])
        assert.strictEqual(got.length, 2)
        assert.deepStrictEqual(got[0], ['L1', { a: 1 }, { id: ID }])
        assert.strictEqual(got[1].length, 2)
        assert.deepStrictEqual(got[1], ['L2', undefined])
    })

    it('R18-1 摘要(safe)為固定詞彙, 不做子字串遮罩: 短密碼恰為固定常數之子字串時, 缺口不得洩漏密碼內容(外審 B-7)', function() {
        //摘要之值只可能來自操作別、白名單類別名與白名單代碼(公開常數); 若對其挖空, 輸出的缺口會讓人由已知常數反推出短密碼
        for (let pw of ['ert', 'e', 'insert', '235', 'Typ', 'rror']) {
            let u = `postgresql://tuser:${pw}@db.example.local:5432`
            let secrets = getSecretsOfUrl(u, `${u}/worm`)
            let got = []
            let diag = getDiag(getOptLog({ funLog: (...a) => got.push(a) }), secrets)
            let safe = { mode: 'insert', errType: 'TypeError', errCode: '23505' }
            diag('L', safe)
            assert.deepStrictEqual(got[0][1], safe, pw)
            let lines = cap(() => {
                getDiag(getOptLog({}), secrets)('L', safe)
            })
            assert.deepStrictEqual(lines, ['L { mode: \'insert\', errType: \'TypeError\', errCode: \'23505\' }'], pw)
        }
    })

    it('R18-3 funLog存在時logDetail不另寫console(funLog取代console)', function() {
        let got = []
        let diag = getDiag(getOptLog({ logDetail: true, funLog: (...a) => got.push(a) }))
        let lines = cap(() => {
            diag('L1', { a: 1 }, () => 'd')
        })
        assert.deepStrictEqual(lines, [])
        assert.deepStrictEqual(got, [['L1', { a: 1 }, 'd']])
    })

    it('R18-4 Object.prototype上有唯讀屬性或拋錯setter(mode、errType、errCode): 診斷輸出不拋錯(摘要不經賦值), 輸出不變(外審 D-1)', function() {
        let names = ['mode', 'errType', 'errCode']
        let lines = null
        let got = []
        let err = null
        for (let n of names) {
            // eslint-disable-next-line no-extend-native
            Object.defineProperty(Object.prototype, n, {
                get() {
                    return 'POLLUTED'
                },
                set() {
                    throw new Error('setter boom')
                },
                configurable: true
            })
        }
        try {
            let safe = { mode: 'insert', ...getBriefErr(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })) }
            lines = cap(() => getDiag(getOptLog({ logDetail: true }), getSecretsOfUrl(URL, `${URL}/worm`))('L', safe, () => 1, true))
            getDiag(getOptLog({ funLog: (...a) => got.push(a) }))('L', safe)
            lines.push(...cap(() => getDiag(getOptLog({}))('L', safe)))
        }
        catch (e) {
            err = e
        }
        finally {
            for (let n of names) {
                delete Object.prototype[n]
            }
        }
        assert.strictEqual(err, null, String(err))
        assert.deepStrictEqual(lines, ['1', 'L { mode: \'insert\', errType: \'Error\', errCode: \'ECONNREFUSED\' }'])
        assert.deepStrictEqual(got.map((v) => v[1]), [{ mode: 'insert', errType: 'Error', errCode: 'ECONNREFUSED' }])
    })

    it('R18-4 輸出不得使呼叫端拋錯: funLog拋錯、getDetail拋錯、console拋錯皆吞下', function() {
        let diag1 = getDiag(getOptLog({
            funLog: () => {
                throw new Error('x')
            }
        }))
        diag1('L', { a: 1 }, () => 'd')

        let got = []
        let diag2 = getDiag(getOptLog({ logDetail: true }))
        let lines = cap(() => {
            diag2('L', { a: 1 }, () => {
                throw new Error('boom')
            })
        })
        got.push(...lines)
        assert.deepStrictEqual(got, ['L (unprintable)'])

        let diag3 = getDiag(getOptLog({ funLog: (l, s, d) => got.push(d) }))
        diag3('L', undefined, () => {
            throw new Error('boom')
        })
        assert.strictEqual(got[got.length - 1], '(unprintable)')

        let diag4 = getDiag(getOptLog({}))
        let old = console.log
        console.log = () => {
            throw new Error('console broken')
        }
        try {
            diag4('L', { a: 1 })
        }
        finally {
            console.log = old
        }
    })

    it('R18-4 funLog回傳reject之promise不成為unhandledRejection', async function() {
        let bad = []
        let fn = (e) => bad.push(e)
        process.on('unhandledRejection', fn)
        try {
            let diag = getDiag(getOptLog({ funLog: () => Promise.reject(new Error('rej')) }))
            diag('L', { a: 1 }, () => 'd')
            let diag2 = getDiag(getOptLog({ funLog: () => ({ then: (a, b) => Promise.reject(new Error('rej2')) }) }))
            diag2('L', { a: 1 }, () => 'd')
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        finally {
            process.off('unhandledRejection', fn)
        }
        assert.deepStrictEqual(bad.map((v) => v.message), [])
    })

    it('R18-2 憑證遮罩: 細節(console與funLog)中之密碼、帳密、連線字串一律以***取代, 其餘細節保留', function() {
        let secrets = getSecretsOfUrl(URL, `${URL}/worm`)
        let err = new Error(`connect ${URL}/worm failed for ${USER}:${PW} id=${ID}`)
        err.code = 'ECONNREFUSED'
        err.original = { message: `pw=${PW}`, nested: [PW, { deep: `x${PW}y` }] }

        let got = []
        let diag1 = getDiag(getOptLog({ funLog: (...a) => got.push(a) }), secrets)
        diag1('L', { a: 1 }, () => ({ state: 'error', msg: err }))
        let d = got[0][2]
        let s = JSON.stringify(d) + String(d.msg.message) + String(d.msg.stack)
        assert.ok(s.indexOf(PW) < 0, '密碼未遮罩')
        assert.ok(s.indexOf(`${USER}:${PW}`) < 0 && s.indexOf(URL) < 0, '帳密或連線字串未遮罩')
        assert.ok(d.msg.message.indexOf(ID) >= 0, '非憑證之細節被誤遮')
        assert.strictEqual(d.msg.code, 'ECONNREFUSED')
        assert.ok(d.msg instanceof Error && d.msg !== err)
        assert.strictEqual(err.message.indexOf('***'), -1, '不得改動呼叫端之原物件')
        assert.ok(err.message.indexOf(PW) >= 0)

        let diag2 = getDiag(getOptLog({ logDetail: true }), secrets)
        let lines = cap(() => {
            diag2('L', { a: 1 }, () => ({ state: 'error', msg: err }))
            diag2('L', { a: 1 }, () => `connect ${URL}/worm pw = '${PW}'`, true)
        })
        let all = lines.join('\n')
        assert.ok(all.indexOf(PW) < 0, `console輸出含密碼: ${all.slice(0, 300)}`)
        assert.ok(all.indexOf('***') >= 0)
    })

    it('R18-2 logDetail輸出格式與舊版一致: 無憑證之Error以util.format輸出與原物件逐字相同(訊息、堆疊、自有屬性)', function() {
        let e1 = new Error(`listener ${ID}`)
        let e2 = new TypeError('tt')
        e2.code = 'ERR_X'
        e2.extra = { a: 1, b: [1, 2] }
        let e3 = new Error('outer', { cause: new Error('inner') })
        let e4 = new RangeError('rr')
        let e5 = new AggregateError([new Error('a1'), new TypeError('a2')], 'agg')
        for (let e of [e1, e2, e3, e4, e5, 'plain string', { a: 1, b: [2] }, 5, null]) {
            let old = util.format(e) //舊版之console.log(e)
            let lines = []
            let diag = getDiag(getOptLog({ logDetail: true }), getSecretsOfUrl(URL, `${URL}/worm`))
            let o = console.log
            console.log = (...a) => lines.push(util.format(...a))
            try {
                diag('L', undefined, () => e, true)
            }
            finally {
                console.log = o
            }
            assert.deepStrictEqual(lines, [old])
        }
    })

})


describe('getBriefErr', function() {

    it('R18-1 只列類別與機器代碼, 不含訊息文字', function() {
        let e = new Error(`failed for ${ID} ${PW}`)
        assert.deepStrictEqual(getBriefErr(e), { errType: 'Error' })
        class DatabaseError extends Error {}
        let e2 = new DatabaseError(`dup ${ID}`)
        e2.code = '23505'
        assert.deepStrictEqual(getBriefErr(e2), { errType: 'DatabaseError', errCode: '23505' })
        assert.deepStrictEqual(getBriefErr(new TypeError(ID)), { errType: 'TypeError' })
        assert.deepStrictEqual(getBriefErr(new RangeError(ID)), { errType: 'RangeError' })
        let e3 = new Error('x')
        e3.code = 'ECONNREFUSED'
        assert.deepStrictEqual(getBriefErr(e3), { errType: 'Error', errCode: 'ECONNREFUSED' })
    })

    it('R18-1 字串或非物件之值只列型別(字串內容可能夾帶資料)', function() {
        assert.deepStrictEqual(getBriefErr(`fail ${ID}`), { errType: 'string' })
        assert.deepStrictEqual(getBriefErr(null), { errType: 'null' })
        assert.deepStrictEqual(getBriefErr(undefined), { errType: 'undefined' })
        assert.deepStrictEqual(getBriefErr(12), { errType: 'number' })
        assert.deepStrictEqual(getBriefErr({ message: ID }), { errType: 'object' })
    })

    it('R18-1 code須為明確白名單(系統錯誤名稱、Node/TLS代碼、PostgreSQL SQLSTATE), 資料值樣式者不列(含數值、電郵、員編、郵遞區號樣式之5碼、ERR_開頭之業務字串)', function() {
        for (let c of [ID, 'alice', 'U-0001', 99999999, 12345, 18456, 0, -1, 1.5, NaN, {}, [], 'E', 'ERR_', 'enoent', '', 'a'.repeat(60), 'E12345', 'EMP001', 'EMPLOYEE1', 'USER1', 'AB123', '99999', 'A0001', 'sqlite_busy',
            'ERR_USER_ALICE_9901', 'ERR_ID_A123456789', 'ERR_EMAIL_BOB_AT_CORP_COM', 'P0123', '20261', '08999', 'XX999', 'F0ABC', '23999', '42ABC']) {
            let e = new Error('x')
            e.code = c
            assert.deepStrictEqual(getBriefErr(e), { errType: 'Error' }, String(c))
        }
        for (let c of ['ENOENT', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE', 'CERT_HAS_EXPIRED', '23505', '28P01', '3D000', '42P01', '08006', '57P01', '0A000', '22P02', '53300', 'P0001', 'XX000']) {
            let e = new Error('x')
            e.code = c
            assert.deepStrictEqual(getBriefErr(e), { errType: 'Error', errCode: c }, String(c))
        }
    })

    it('R18-1 類別名稱須在白名單(內建錯誤類別、DatabaseError), 其餘列為Error: 自訂類別名稱、實例自有constructor屬性皆不得把識別字帶入預設摘要(外審 C-1)', function() {
        let DynErr = { alice_smith_1990: class extends Error {} }.alice_smith_1990
        assert.deepStrictEqual(getBriefErr(new DynErr('boom')), { errType: 'Error' })
        for (let name of ['alice', 'EMP001', 'user_alice_smith_1990', 'E12345', 'USER1']) {
            let e = new Error('x')
            e.constructor = { [name]() {} }[name]
            assert.deepStrictEqual(getBriefErr(e), { errType: 'Error' }, name)
        }
        let e = new Error('x')
        function Weird() {}
        Object.defineProperty(Weird, 'name', { value: `bad name ${ID}` })
        Object.defineProperty(e, 'constructor', { value: Weird, configurable: true })
        assert.deepStrictEqual(getBriefErr(e), { errType: 'Error' })
        function TypeError2() {}
        Object.defineProperty(e, 'constructor', { value: TypeError2, configurable: true })
        assert.deepStrictEqual(getBriefErr(e), { errType: 'Error' })

        let called = 0
        let e2 = new Error('x')
        Object.defineProperty(e2, 'code', {
            get() {
                called++
                return 'ENOENT'
            },
            configurable: true
        })
        assert.deepStrictEqual(getBriefErr(e2), { errType: 'Error' })
        assert.strictEqual(called, 0)
    })

    it('R18-4 Proxy與陷阱拋錯之值不使其拋錯', function() {
        let p = new Proxy({}, {
            getOwnPropertyDescriptor() {
                throw new Error('trap')
            },
            getPrototypeOf() {
                throw new Error('trap')
            }
        })
        let r = getBriefErr(p)
        assert.ok(r !== null && typeof r === 'object' && typeof r.errType === 'string')
        assert.ok(JSON.stringify(r).indexOf('trap') < 0)
    })

})


describe('getCred 與 getSecrets', function() {

    it('R18-5 getCred: 取最後一個@之前為帳密(帳號:第一個冒號前, 密碼:其後), 另補整串寬鬆候選; 非字串或無@者空', function() {
        assert.deepStrictEqual(getCred(URL), [{ username: USER, password: PW }])
        assert.deepStrictEqual(getCred('postgresql://u:p@ss@h:1'), [{ username: 'u', password: 'p@ss' }])
        assert.deepStrictEqual(getCred('postgresql://u:p:q@h:1'), [{ username: 'u', password: 'p:q' }])
        assert.deepStrictEqual(getCred('postgresql://u@h:1'), [{ username: 'u', password: '' }])
        assert.deepStrictEqual(getCred('postgresql://:pw@h:1'), [{ username: '', password: 'pw' }])
        assert.deepStrictEqual(getCred('u:p@h:1'), [{ username: 'u', password: 'p' }])
        //密碼含/與?: 權限段內之候選(pg實際解析)與整串之寬鬆候選並列
        let r = getCred('postgresql://u:pa/ss@h:1')
        assert.ok(r.some((v) => v.password === 'pa/ss'), JSON.stringify(r))
        assert.deepStrictEqual(getCred('postgresql://h:1'), [])
        for (let v of [undefined, null, 1, {}, []]) {
            assert.deepStrictEqual(getCred(v), [])
        }
    })

    it('R18-5 畸形網址(權限段之後仍有@, 密碼含未編碼之/?#): pg會把密碼片段解析成主機名/資料庫名而出現在後端錯誤訊息, 各片段亦遮罩; 合格網址不走此路(主機名保留)', function() {
        let bad = [
            ['postgresql://tuser:p@S3cretHostPw/rest@127.0.0.1:5432', 'getaddrinfo ENOTFOUND S3cretHostPw', 'S3cretHostPw'],
            ['postgresql://tuser:p@S3cretHostPw?rest@127.0.0.1:5432', 'getaddrinfo ENOTFOUND S3cretHostPw', 'S3cretHostPw'],
            ['postgresql://tuser:p@S3cretHostPw#rest@127.0.0.1:5432', 'getaddrinfo ENOTFOUND S3cretHostPw', 'S3cretHostPw'],
            ['postgresql://tuser:1234/S3cretDbPw@127.0.0.1:5432', 'database "S3cretDbPw@127.0.0.1:5432/worm" does not exist', 'S3cretDbPw'],
        ]
        for (let [url, msg, frag] of bad) {
            let r = cpMask(msg, getSecretsOfUrl(url, `${url}/worm`))
            assert.ok(r.indexOf(frag) < 0, `${url} -> ${r}`)
            assert.ok(r.indexOf('***') >= 0)
        }
        //合格網址: 帳號、密碼遮罩, 主機名與port保留
        let ok = 'postgresql://tuser:S3cretPw@db.example.local:5432'
        assert.strictEqual(cpMask('connect ENOTFOUND db.example.local port 5432 tuser S3cretPw', getSecretsOfUrl(ok, `${ok}/worm`)), 'connect ENOTFOUND db.example.local port 5432 *** ***')
        assert.deepStrictEqual(getCred(ok), [{ username: 'tuser', password: 'S3cretPw' }])
    })

    it('R18-5 getSecrets: 略過空值, 含連線字串、帳密、密碼與其URL編碼/解碼、單引號加倍形式, 長者在前', function() {
        assert.deepStrictEqual(getSecrets('', '', ''), [])
        assert.deepStrictEqual(getSecrets([], '', ''), [])
        let ss = getSecrets(URL, USER, PW)
        for (let v of [URL, USER, PW, `${USER}:${PW}`]) {
            assert.ok(ss.includes(v), v)
        }
        let enc = getSecrets('x://a b:p@ss@h:1', 'a b', 'p@ss')
        assert.ok(enc.includes(encodeURIComponent('p@ss')))
        let dec = getSecrets('x://u:p%40ss@h:1', 'u', 'p%40ss')
        assert.ok(dec.includes('p@ss'), JSON.stringify(dec)) //pg會對帳密decodeURIComponent, 輸出中可能是解碼後之形式
        let q = getSecrets('x://u:pa\'ss@h:1', 'u', 'pa\'ss')
        assert.ok(q.includes('pa\'\'ss'), JSON.stringify(q))
        assert.strictEqual(maskText('SELECT \'pa\'\'ss\' FROM t', q), 'SELECT \'***\' FROM t')
        for (let k = 1; k < ss.length; k++) {
            assert.ok(ss[k - 1].length >= ss[k].length)
        }
        //帳號單獨出現時至少3字元才遮罩
        assert.ok(!getSecrets('x://u:pw@h:1', 'u', 'pw').includes('u'))
        assert.ok(getSecrets('x://usr:pw@h:1', 'usr', 'pw').includes('usr'))
    })

    it('R18-5 getSecretsOfUrl: 由opt.url與組合後之連線字串推得帳號、密碼、帳密與兩個字串; 無帳密者仍列連線字串', function() {
        let cs = `${URL}/worm`
        let ss = getSecretsOfUrl(URL, cs)
        for (let v of [URL, cs, USER, PW, `${USER}:${PW}`]) {
            assert.ok(ss.includes(v), v)
        }
        let nc = getSecretsOfUrl('postgresql://127.0.0.1:5432', 'postgresql://127.0.0.1:5432/worm')
        assert.ok(nc.includes('postgresql://127.0.0.1:5432') && nc.every((v) => v !== ''), JSON.stringify(nc))
        assert.strictEqual(maskText('connect postgresql://127.0.0.1:5432 failed', nc), 'connect *** failed')
        //url含未編碼之@: 密碼取至最後一個@
        let at = getSecretsOfUrl('postgresql://u:p@ss@h:1', 'postgresql://u:p@ss@h:1/worm')
        assert.ok(at.includes('p@ss'))
        assert.ok(!at.includes('p'), '不得把被@截斷之前半段單獨當密碼(會吞掉無關文字)')
        //非字串url不拋錯
        assert.doesNotThrow(() => getSecretsOfUrl(undefined, 'undefined/worm'))
    })

})


describe('maskText', function() {

    it('R18-5 連線字串內嵌之帳密、含@之URL亦遮罩(不依賴已知秘密)', function() {
        assert.strictEqual(maskText(`a ${URL} b`, getSecretsOfUrl(URL, `${URL}/worm`)), 'a *** b')
        assert.strictEqual(maskText('connect postgres://who:pw@host:5432/db now', []), 'connect postgres://***@host:5432/db now')
        assert.strictEqual(maskText('plain text no secret', getSecretsOfUrl(URL, `${URL}/worm`)), 'plain text no secret')
        assert.strictEqual(maskText(12, getSecretsOfUrl(URL, `${URL}/worm`)), 12)
    })

    it('R18-5 帳密含未編碼之@時取至最後一個@(不留密碼後半段); 不吞掉其後以空白分隔之文字', function() {
        assert.strictEqual(maskText('connect postgres://alice:secret@part@host/db', []), 'connect postgres://***@host/db')
        assert.strictEqual(maskText('see http://example.com:80 and mail me@x.com', []), 'see http://example.com:80 and mail me@x.com')
    })

})


describe('cpMask', function() {

    it('R18-5 不改動原物件, 循環參照與過深/過大結構有界, 函數與二進位以標記字串代替', function() {
        let a = { name: ID, pw: PW, list: [PW, 1, null, undefined], fn() {}, buf: Buffer.from(PW), d: new Date(0) }
        a.self = a
        let deep = { v: PW }
        let cur = deep
        for (let k = 0; k < 30; k++) {
            cur.next = { v: PW }
            cur = cur.next
        }
        a.deep = deep
        let secrets = getSecretsOfUrl(URL, `${URL}/worm`)
        let r = cpMask(a, secrets)
        assert.notStrictEqual(r, a)
        assert.strictEqual(a.pw, PW)
        assert.strictEqual(r.name, ID)
        assert.strictEqual(r.pw, '***')
        assert.deepStrictEqual(r.list, ['***', 1, null, undefined])
        assert.strictEqual(r.fn, '[Function]')
        assert.ok(String(r.buf).startsWith('[Binary'))
        assert.strictEqual(r.d.getTime(), 0)
        assert.strictEqual(r.self, r)
        let n = 0
        for (let x = r.deep; typeof x === 'object' && x !== null; x = x.next) {
            n++
            assert.ok(JSON.stringify(x.v).indexOf(PW) < 0)
        }
        assert.ok(n < 30, `過深結構未截斷: ${n}`)
        assert.ok(JSON.stringify(r, (k, v) => (k === 'self' ? undefined : v)).indexOf(PW) < 0)
    })

    it('R18-5 Error之副本仍為Error: message、stack、cause、自有屬性皆遮罩', function() {
        let e = new Error(`m ${PW}`, { cause: new Error(`c ${PW}`) })
        e.extra = `x ${PW}`
        let r = cpMask(e, getSecretsOfUrl(URL, `${URL}/worm`))
        assert.ok(r instanceof Error)
        assert.strictEqual(r.message, 'm ***')
        assert.ok(typeof r.stack === 'string' && r.stack.indexOf(PW) < 0 && r.stack.indexOf('m ***') >= 0)
        assert.strictEqual(r.cause.message, 'c ***')
        assert.strictEqual(r.extra, 'x ***')
        assert.strictEqual(e.message, `m ${PW}`)
    })

    it('R18-5 密碼含多個@: 密碼原文與含該密碼之連線字串皆遮罩(不留後半段)', function() {
        let url = 'postgresql://tuser:Zp@ss7@db.example.local:5432'
        let secrets = getSecretsOfUrl(url, `${url}/worm`)
        let r = cpMask({ m: `connect ${url}/worm failed`, n: 'pw Zp@ss7 here', o: 'half ss7@db' }, secrets)
        let s = JSON.stringify(r)
        assert.ok(s.indexOf('Zp@ss7') < 0 && s.indexOf('tuser:') < 0, s)
        assert.strictEqual(r.n, 'pw *** here')
        assert.ok(r.m.indexOf('Zp') < 0 && r.m.indexOf('ss7') < 0, r.m) //RE_URL_CRED 兜底: 取至最後一個@
    })

    it('R18-5 單引號: 密碼含單引號時, SQL字串字面值形式(單引號加倍)亦遮罩', function() {
        let url = 'postgresql://tuser:pa\'ss9@h:5432'
        let secrets = getSecretsOfUrl(url, `${url}/worm`)
        let r = cpMask(`SELECT 'pa''ss9' , 'pa'ss9'`, secrets)
        assert.ok(r.indexOf('pa\'\'ss9') < 0 && r.indexOf('ss9') < 0, r)
    })

    it('R18-5 URL編碼/解碼: 密碼以百分比編碼寫入url時, 編碼形式與pg解碼後之形式皆遮罩', function() {
        let url = 'postgresql://tuser:p%40ss%2F9@h:5432'
        let secrets = getSecretsOfUrl(url, `${url}/worm`)
        let r = cpMask({ a: 'p%40ss%2F9', b: 'p@ss/9', c: 'x p@ss/9 y' }, secrets)
        assert.strictEqual(JSON.stringify(r).indexOf('ss'), -1, JSON.stringify(r))
    })

    it('R18-5 屬性鍵與Symbol描述含憑證者亦遮罩', function() {
        let e = new Error('x')
        e[PW] = 'v'
        e[Symbol(PW)] = 'w'
        e[Symbol('plain')] = 'z'
        let r = cpMask(e, getSecretsOfUrl(URL, `${URL}/worm`))
        let keys = Reflect.ownKeys(r).map((k) => String(k))
        assert.ok(keys.every((k) => k.indexOf(PW) < 0), keys.join('|'))
        assert.ok(keys.includes('***') && keys.includes('Symbol(***)') && keys.includes('Symbol(plain)'), keys.join('|'))
    })

    it('R18-5 數字密碼: 至少4位之數字密碼, 同值之number與bigint與字串皆遮罩; 過短者不遮罩; 摘要之數值亦同', function() {
        let url = 'postgresql://u:12345@h:5432'
        let secrets = getSecretsOfUrl(url, `${url}/worm`)
        let r2 = cpMask({ password: 12345, count: 7, big: 12345n, s: '12345', arr: [12345, 54321] }, secrets)
        assert.deepStrictEqual(r2, { password: '***', count: 7, big: '***', s: '***', arr: ['***', 54321] })
        let short = getSecretsOfUrl('postgresql://u:123@h:5432', 'postgresql://u:123@h:5432/worm')
        assert.deepStrictEqual(cpMask({ n: 123, s: '123' }, short), { n: 123, s: '***' })
    })

    it('R18-5 副本不沿用原型: 繼承屬性不外帶, 繼承之util.inspect.custom不被執行; Error之name取原型鏈上之資料屬性', function() {
        class MyErr extends Error {}
        MyErr.prototype.token = PW
        MyErr.prototype.name = 'MyErrName'
        MyErr.prototype[Symbol.for('nodejs.util.inspect.custom')] = () => `PW=${PW}`
        let secrets = getSecretsOfUrl(URL, `${URL}/worm`)
        let r = cpMask(new MyErr('m'), secrets)
        assert.ok(r instanceof Error)
        assert.strictEqual(r.token, undefined)
        assert.strictEqual(r.name, 'MyErrName')
        assert.ok(!util.inspect(r).includes(PW), util.inspect(r))
        class Foo {
            constructor() {
                this.a = 1
            }
        }
        Foo.prototype.b = PW
        Foo.prototype[Symbol.for('nodejs.util.inspect.custom')] = () => `PW=${PW}`
        let r2 = cpMask(new Foo(), secrets)
        assert.deepStrictEqual(r2, { a: 1 })
        assert.ok(!util.inspect(r2).includes(PW))
    })

    it('R18-4 不執行使用端程式: Symbol.toStringTag之getter、自訂stack與message存取器皆不被執行', function() {
        let called = []
        let e = new Error('m')
        Object.defineProperty(e, Symbol.toStringTag, {
            get() {
                called.push('tag')
                return 'Error'
            }
        })
        Object.defineProperty(e, 'stack', {
            get() {
                called.push('stack')
                return `stack ${PW}`
            },
            configurable: true
        })
        Object.defineProperty(e, 'message', {
            get() {
                called.push('message')
                return `msg ${PW}`
            },
            configurable: true
        })
        let r = cpMask(e, getSecretsOfUrl(URL, `${URL}/worm`))
        assert.ok(r instanceof Error)
        assert.deepStrictEqual(called, [])
        assert.ok(!util.inspect(r).includes(PW))
        assert.deepStrictEqual(getBriefErr(e), { errType: 'Error' })
        assert.deepStrictEqual(called, [])
    })

    it('R18-4 getter不被執行(以標記字串代替), 拋錯之getter不使其拋錯', function() {
        let called = 0
        let o = {
            get a() {
                called++
                return PW
            },
            b: 1
        }
        let r = cpMask(o, getSecretsOfUrl(URL, `${URL}/worm`))
        assert.strictEqual(called, 0)
        assert.strictEqual(r.a, '[Getter/Setter]')
        assert.strictEqual(r.b, 1)
    })

})


describe('遮罩之補強(外審 B-1~B-8)', function() {

    let STD = 'postgresql://tuser:S3cretPw@db.example.local:5432'
    let sec = () => getSecretsOfUrl(STD, `${STD}/worm`)
    let dump = (v) => util.inspect(v, { depth: 10, showHidden: true })

    it('R18-5 Symbol作為值(屬性值、陣列元素、直接拋出)亦遮罩其描述', function() {
        let r = cpMask({ tok: Symbol(PW), urlSym: Symbol(STD), arr: [Symbol(PW)] }, sec())
        assert.ok(dump(r).indexOf(PW) < 0, dump(r))
        assert.ok(dump(r).indexOf('Symbol(***)') >= 0, dump(r))
        assert.strictEqual(cpMask(Symbol(PW), sec()).description, '***')
        assert.strictEqual(cpMask(Symbol('plain'), sec()).description, 'plain')
        assert.strictEqual(cpMask(Symbol(undefined), sec()).description, undefined)
    })

    it('R18-5 陣列之自有非索引鍵與Symbol鍵亦遮罩; 索引鍵原樣保留', function() {
        let arr = ['ok', PW]
        arr[PW] = 'v1'
        arr[`k_${STD}`] = 'v2'
        arr[Symbol(PW)] = 'v3'
        arr.plain = 'v4'
        let r = cpMask(arr, sec())
        assert.ok(dump(r).indexOf(PW) < 0, dump(r))
        assert.ok(Array.isArray(r) && r[0] === 'ok' && r[1] === '***' && r.length === 2)
        assert.strictEqual(r.plain, 'v4')
        assert.strictEqual(r['***'], 'v1')
    })

    /* eslint-disable no-new-wrappers */
    it('R18-5 包裝物件(new String/Number/Boolean/Object(Symbol)/Object(1n))取其內部原始值遮罩, 不逐字元攤開', function() {
        let r = cpMask({ s: new String(`conn=${STD} pw=${PW}`), n: new Number(1), b: new Boolean(false), y: Object(Symbol(PW)), g: Object(12345n) }, sec())
        assert.ok(dump(r).indexOf(PW) < 0, dump(r))
        assert.strictEqual(r.s, 'conn=*** pw=***')
        assert.strictEqual(r.n, 1)
        assert.strictEqual(r.b, false)
        assert.strictEqual(r.y.description, '***')
        let nums = getSecretsOfUrl('postgresql://u:12345@h:1', 'postgresql://u:12345@h:1/worm')
        assert.deepStrictEqual(cpMask({ n: new Number(12345), g: Object(12345n), s: new String('12345') }, nums), { n: '***', g: '***', s: '***' })
    })
    /* eslint-enable no-new-wrappers */

    it('R18-5 Map、Set、RegExp、Promise內含憑證者不展開, 以標記字串代替(內容不外洩)', function() {
        let r = cpMask({ m: new Map([[PW, STD]]), s: new Set([PW]), re: new RegExp(PW), p: Promise.resolve(PW) }, sec())
        assert.deepStrictEqual(r, { m: '[Object]', s: '[Object]', re: '[Object]', p: '[Object]' })
    })

    it('R18-5 查詢參數帶帳密(?user=…&password=…): url與錯誤訊息中之原樣、URL編碼與+空白形式皆遮罩', function() {
        let u = 'postgresql://db.example.local:5432?user=tuser&password=S3cret%2BPw+9'
        let ss = getSecretsOfUrl(u, `${u}/worm`)
        let r = cpMask({ a: 'auth failed password=S3cret%2BPw+9 user=tuser', b: 'pw is S3cret+Pw 9', c: 'u=tuser' }, ss)
        let s = JSON.stringify(r)
        assert.ok(s.indexOf('S3cret') < 0 && s.indexOf('tuser') < 0, s)
        assert.deepStrictEqual(getCred('postgresql://h:1?x=1&user=a&password=b#f'), [{ username: 'a', password: 'b' }])
        assert.ok(getCred('postgresql://h:1?user=a%20b&password=c+d').some((v) => v.username === 'a b' && v.password === 'c d'))
    })

    it('R18-5 編碼形式: 解碼後單引號加倍、URL編碼大小寫十六進位、WHATWG URL儲存之編碼形式、JSON跳脫形式皆遮罩', function() {
        let cases = [
            ['postgresql://tuser:pa%27ss9@db.example.local:5432', 'SELECT \'pa\'\'ss9\'', 'ss9'],
            ['postgresql://tuser:S3cret%2fpw@db.example.local:5432', 'pw=S3cret%2Fpw', 'S3cret'],
            ['postgresql://tuser:S3cret/pw@db.example.local:5432', 'pw=S3cret%2fpw', 'S3cret'],
            ['postgresql://tuser:pa\'ss9@db.example.local:5432', 'pw=pa%27ss9', 'ss9'],
            ['postgresql://tuser:S3cret+Pw 9@db.example.local:5432', 'pw=S3cret+Pw%209', 'S3cret'],
            ['postgresql://tuser:Sec ret+Pw@db.example.local:5432', 'pw=Sec%20ret%2bPw', 'Sec'], //小寫十六進位(encodeURIComponent只產大寫)
            ['postgresql://tuser:Sec ret+Pw@db.example.local:5432', 'pw=Sec%20ret%2BPw', 'Sec'],
            ['postgresql://tuser:pa%22ss%5C9@db.example.local:5432', JSON.stringify({ pw: 'pa"ss\\9' }), 'ss'],
        ]
        for (let [u, text, frag] of cases) {
            let r = maskText(text, getSecretsOfUrl(u, `${u}/worm`))
            assert.ok(r.indexOf(frag) < 0, `${u} :: ${text} -> ${r}`)
        }
    })

    it('R18-5 首尾重疊之秘密: 相交之命中區間合併後一次取代, 不留可還原的片段', function() {
        let u = 'postgresql://my_app_user_prod:prod_S3cret9@db.example.local:5432'
        let r = maskText('key=my_app_user_prod_S3cret9', getSecretsOfUrl(u, `${u}/worm`))
        assert.strictEqual(r, 'key=***')
        assert.strictEqual(maskText('aXbXc', ['X']), 'a***b***c')
        assert.strictEqual(maskText('xabcabcx', ['abcabc', 'cab']), 'x***x')
        assert.strictEqual(maskText('no hit', ['zz']), 'no hit')
        assert.strictEqual(maskText('aaa', ['aa']), '***')
    })

    it('R18-4 二進位資料以內建getter取長度: 使用端覆寫byteLength(存取器或資料屬性)不被執行、不外洩', function() {
        let called = 0
        let buf = Buffer.from('abcd')
        Object.defineProperty(buf, 'byteLength', {
            get() {
                called++
                return PW
            }
        })
        let buf2 = Buffer.from('abcd')
        Object.defineProperty(buf2, 'byteLength', { value: PW })
        let r = cpMask({ buf, buf2, u8: new Uint8Array(3), ab: new ArrayBuffer(5), dv: new DataView(new ArrayBuffer(2)) }, sec())
        assert.strictEqual(called, 0)
        assert.deepStrictEqual(r, { buf: '[Binary 4 bytes]', buf2: '[Binary 4 bytes]', u8: '[Binary 3 bytes]', ab: '[Binary 5 bytes]', dv: '[Binary 2 bytes]' })
    })

    it('R18-4 讀stack不執行使用端程式: 實例上自訂name/message存取器、原型上的存取器、掛上Error.prepareStackTrace皆不被執行', function() {
        let called = []
        let e = new Error('init')
        Object.defineProperty(e, 'name', {
            get() {
                called.push('name')
                return 'CustomName'
            }
        })
        Object.defineProperty(e, 'message', {
            get() {
                called.push('message')
                return `msg ${PW}`
            }
        })
        let r = cpMask(e, sec())
        assert.deepStrictEqual(called, [])
        assert.ok(r instanceof Error && dump(r).indexOf(PW) < 0)

        class E2 extends Error {
            get message() {
                called.push('proto-message')
                return PW
            }
        }
        cpMask(new E2('x'), sec())
        assert.deepStrictEqual(called, [])

        //原生Error仍保有stack(讀取不會執行使用端程式時)
        let plain = cpMask(new Error(`m ${PW}`), sec())
        assert.ok(typeof plain.stack === 'string' && plain.stack.indexOf('m ***') >= 0 && plain.stack.indexOf(PW) < 0)

        //Error.prepareStackTrace被使用端掛上: 載入後才掛的函數不得被執行(stack以標記字串代替)
        let old = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
        Error.prepareStackTrace = () => {
            called.push('prepare')
            return 'x'
        }
        try {
            let r2 = cpMask(new Error(`m ${PW}`), sec())
            assert.deepStrictEqual(called, [])
            assert.strictEqual(r2.stack, '[Getter/Setter]')
        }
        finally {
            if (old === undefined) {
                delete Error.prepareStackTrace
            }
            else {
                Object.defineProperty(Error, 'prepareStackTrace', old)
            }
        }
    })

})


describe('單一出口(R18-7)', function() {

    //codeLines, 去除區塊註解、字串字面值與單行註解後逐行回傳(字串內含//如網址時不致把同行後方的程式碼誤當註解而漏掃)
    let codeLines = (src) => {
        let s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        return s.split(/\r?\n/).map((line) => line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""').replace(/\/\/.*$/, ''))
    }
    let reOut = /\b(?:globalThis\s*\.\s*)?console\s*[.[]|\bprocess\s*\.\s*(?:stdout|stderr|emitWarning)\b|\bprocess\s*\[/

    it('R18-7 src內除getDiag.mjs外不得直接呼叫console或寫process.stdout/stderr/emitWarning(所有診斷輸出經單一出口)', function() {
        let bads = []
        let n = 0
        for (let f of fs.readdirSync('./src')) {
            if (!/\.(mjs|js)$/.test(f) || f === 'getDiag.mjs') {
                continue
            }
            n++
            let raw = fs.readFileSync(`./src/${f}`, 'utf8').split(/\r?\n/)
            codeLines(fs.readFileSync(`./src/${f}`, 'utf8')).forEach((code, k) => {
                if (reOut.test(code)) {
                    bads.push(`${f}:${k + 1} ${raw[k].trim().slice(0, 80)}`)
                }
            })
        }
        assert.ok(n >= 5, `掃描檔數過少: ${n}`)
        assert.deepStrictEqual(bads, [], `下列站點未經單一出口:\n${bads.join('\n')}`)
    })

    it('R18-7 掃描器自身: 同行字串含//之網址、globalThis.console、process[\'stdout\']皆能辨出; 註解與字串內之console不誤報', function() {
        let hit = (code) => codeLines(code).some((l) => reOut.test(l))
        assert.ok(hit('const u = \'http://x\'; console.log(u)'))
        assert.ok(hit('globalThis.console.log(1)'))
        assert.ok(hit('process["stdout"].write(1)'))
        assert.ok(hit('process.emitWarning(\'x\')'))
        assert.ok(hit('console["log"](1)'))
        assert.ok(!hit('// console.log(1)'))
        assert.ok(!hit('/* console.log(1) */ let a = 1'))
        assert.ok(!hit('let s = \'console.log(1)\''))
    })

    it('R18-7 getDiag.mjs內console站點恰4處且皆為console.log(預設與logDetail各一, 其兜底各一; 新增站點須先審其是否經遮罩)', function() {
        let lines = codeLines(fs.readFileSync('./src/getDiag.mjs', 'utf8')).filter((line) => /\bconsole\s*\./.test(line))
        assert.strictEqual(lines.length, 4, lines.join('\n'))
        assert.ok(lines.every((v) => /console\.log\(/.test(v)))
    })

})


describe('建構函式訊息不回顯連線網址與帳密(R18-8)', function() {

    it('R18-8 opt.url含孤立代理字元或NUL: 訊息為固定詞彙, 前綴與Error型態不變, 不含url與帳密', function() {
        let url = `postgresql://${USER}:${PW}@127.0.0.1:1`
        for (let [bad, reason] of [['\ud800', 'string contains lone surrogate'], ['\udc00', 'string contains lone surrogate'], ['\u0000', 'string contains NUL']]) {
            for (let u of [`${url}${bad}`, `${bad}${url}`, `${url.slice(0, 20)}${bad}${url.slice(20)}`]) {
                let err = null
                try {
                    WOrm({ url: u, db: 'worm', cl: 't' })
                }
                catch (e) {
                    err = e
                }
                assert.ok(err instanceof Error && Object.getPrototypeOf(err) === Error.prototype, '型態須為Error')
                assert.strictEqual(err.message, `invalid opt.url: ${reason}`)
                assert.ok(String(err.stack).indexOf(PW) < 0 && String(err.stack).indexOf(USER) < 0, 'stack含帳密')
            }
        }
    })

    it('R18-8 opt.db、opt.cl、opt.pk不合格: 訊息固定詞彙, 不回顯該值(db、cl、pk可能夾帶帳密)', function() {
        let cases = [
            [{ db: `w${PW}\ud800` }, 'invalid opt.db: string contains lone surrogate'],
            [{ cl: `t${PW}\ud800` }, 'invalid opt.cl: string contains lone surrogate'],
            [{ cl: `t${PW}\u0000` }, 'invalid opt.cl: string contains NUL'],
            [{ pk: `${PW} bad` }, 'invalid opt.pk: must be a plain identifier (letters, digits, underscore; not starting with a digit; up to 63 bytes)'],
        ]
        for (let [ex, msg] of cases) {
            let err = null
            try {
                WOrm({ url: URL, ...ex })
            }
            catch (e) {
                err = e
            }
            assert.ok(err instanceof Error, JSON.stringify(ex))
            assert.strictEqual(err.message, msg)
            assert.ok(err.message.indexOf(PW) < 0 && err.message.indexOf(USER) < 0)
        }
    })

    it('R18-8 合格之url(含帳密)建構成功, logDetail與funLog選項型別不合者不使建構拋錯', function() {
        for (let ex of [{}, { logDetail: true }, { logDetail: 'x' }, { funLog: () => {} }, { funLog: 'x' }, { logDetail: 1, funLog: {} }]) {
            let w = WOrm({ url: URL, db: 'worm', cl: 't', ...ex })
            assert.strictEqual(typeof w.select, 'function')
        }
        //opt本身不是物件亦不拋錯(沿用既有行為: 以預設值建構)
        assert.doesNotThrow(() => WOrm(null))
        assert.doesNotThrow(() => WOrm(5))
    })

})
