import fs from 'fs'
import util from 'util'
import assert from 'assert'
import pg from 'pg'
import dc from 'wsemi/src/_diagCases.mjs'
import WOrm from '../src/WOrmPostgresql.mjs'
import { USER, PW, urlOf, fakeOf, build, buildRaw, runOp } from './tools/fakePg.mjs'


//rulebook R18(依dspec〈診斷輸出與遮罩〉與wsemi R-DIAG-01): 診斷輸出由wsemi之getDiag單一擁有, 本檔為「接線測試」(確認本套件之站點與宣告有接上), 不重做形態測試
//  形態類案(字串、鍵、Symbol、包裝物件、Proxy、二進位、Error、循環、數字秘密、摘要代碼集合、秘密導出等)由wsemi共用語料(wsemi/src/_diagCases.mjs)驅動, 於wsemi內測一次;
//  本檔以同一語料之wire子集, 經本套件之真實呼叫點(change與error事件之訂閱函數拋錯 -> diag)與真實對外站點(reject)執行
//對應: 預設只輸出標籤與不含個資之摘要(R18-1)、logDetail輸出遮罩後細節(R18-2)、funLog收完整細節(R18-3)、輸出不得使呼叫端拋錯(R18-4)、
//      憑證遮罩接線(R18-5)、單一出口與站點盤點(R18-7)、建構函式訊息不回顯連線網址與帳密(R18-8); 對外錯誤值遮罩之站點矩陣見unit-diagerr
//不需docker, 不連線(假pg.Client, 見tools/fakePg.mjs)


let ID = 'u-secret-001@example.com'


//cap, 擷取console各方法之輸出(以util.format格式化, 與實際輸出一致), 並記錄所用方法
async function cap(fn) {
    let lines = []
    let calls = []
    let ks = ['log', 'info', 'warn', 'error', 'debug']
    let olds = ks.map((k) => console[k])
    ks.forEach((k) => {
        console[k] = (...a) => {
            calls.push({ m: k, args: a })
            lines.push(util.format(...a))
        }
    })
    try {
        await fn()
    }
    finally {
        ks.forEach((k, i) => {
            console[k] = olds[i]
        })
    }
    return { lines, calls }
}

//fire, 於實例掛上拋錯之error訂閱函數並以表名不合之createTable觸發(本套件自身之整批性錯誤: 不連線, 發error事件, 訂閱函數拋出value)
let fire = async (w, value) => {
    w.on('error', () => {
        throw value
    })
    await w.createTable('bad;name', 'id', { id: 1 }).catch(() => {})
}

//fireChange, 於實例掛上拋錯之change訂閱函數並以成功之insert觸發(change事件站)
let fireChange = async (w, value) => {
    w.on('change', () => {
        throw value
    })
    return w.insert({ id: 'a', v: 1 })
}


describe('wsemi共用語料之接線(D5): wire子集 x 本套件之真實呼叫點', function() {

    //處置表: wsemi語料中wire為true之每一案在本套件之處置(無空白格; wsemi新增wire案時本表須補, 否則「分類完整」案轉紅)
    //  detail: 訂閱函數拋出make()之值, 經'error handler threw'與'change handler threw'兩站, funLog所收detail須符合語料之期望
    //  reject: 同一值作為驅動之reject值, 對外之reject須符合reject清單之期望(noSecret: 'reject')
    //  adapt:  語料之期望為其call()回傳之形狀, 本套件之呼叫點形狀不同, 以接線版斷言(下方各adapt案)
    //  n/a:    本套件未宣告該來源(儲存路徑、權杖)或未使用該函數
    let DISPOSITION = {
        T01: 'detail+reject',
        T07: 'detail+reject',
        K01: 'detail+reject',
        K09: 'detail+reject',
        V02: 'detail+reject',
        E01: 'detail+reject',
        E07: 'detail+reject',
        P01: 'detail+reject',
        S07: 'detail+reject',
        C01: 'adapt(safe)',
        C14: 'adapt(safe: 本套件宣告types:[DatabaseError], 見C01b)',
        O01: 'adapt(logDetail console)',
        O15: 'adapt(safeKeys宣告)',
        R01: 'adapt(reject身分)',
        R02: 'adapt(等價案: unit-diagerr F2、api-diaglog PG-R3; 語料宣告2個url來源, 本套件之opt.url只有1個)',
        R04: 'adapt(reject字串)',
        R07: 'adapt(unit-diagerr O1-O15)',
        R12: 'adapt(reject不遮帳號、detail遮帳號)',
        R11: 'n/a(本套件未宣告儲存路徑paths)',
        A01: 'n/a(本套件不用genDiagFunLog)',
        A07: 'n/a(本套件不用genDiagFunLog)',
        A11: 'n/a(本套件不用genDiagFunLog)',
        U22: 'n/a(本套件以urls宣告秘密來源, 不用conns)',
    }
    let byId = (id) => dc.cases.find((c) => c.id === id)
    let ctxOf = () => dc.mkCtx({ util: true })
    let urlOfCtx = (ctx) => urlOf(ctx.sec.password, ctx.sec.username)

    it('分類完整: 語料wire案(含wsemi日後新增者)皆已於DISPOSITION表處置', function() {
        let wires = dc.cases.filter((c) => c.wire).map((c) => c.id).sort()
        assert.deepStrictEqual(Object.keys(DISPOSITION).sort(), wires)
        assert.ok(wires.length >= 20, `wire案數 ${wires.length}`)
    })

    let detailIds = Object.keys(DISPOSITION).filter((id) => DISPOSITION[id] === 'detail+reject')

    for (let id of detailIds) {
        let c = byId(id)

        for (let site of ['error', 'change']) {
            it(`${id} ${c.label} -> ${site}事件站之funLog detail符合語料期望(接線)`, async function() {
                let ctx = ctxOf()
                let value = c.make(ctx)
                let got = []
                let w = build(fakeOf(), { funLog: (...a) => got.push(a) }, { url: urlOfCtx(ctx) })
                if (site === 'error') {
                    await fire(w, value)
                }
                else {
                    await fireChange(w, value)
                }
                assert.strictEqual(got.length, 1, 'funLog應恰收1次')
                assert.strictEqual(got[0][0], `${site} handler threw`)
                assert.strictEqual(dc.verify(c, got[0][2], ctx), null, `${id} ${site}`)
            })
        }

        it(`${id} ${c.label} -> 作為驅動之reject值, 對外值不含憑證(reject清單; 存取器不執行)`, async function() {
            let ctx = ctxOf()
            let value = c.make(ctx)
            let r = await runOp(build(fakeOf({ conn: () => value }), {}, { url: urlOfCtx(ctx) }), (w) => w.select({}))
            assert.ok(r.has)
            assert.strictEqual(dc.verify({ expect: { noSecret: 'reject', userCode: c.expect.userCode } }, r.rej, ctx), null, id)
        })
    }

    it('C01(adapt) 摘要代碼: ECONNREFUSED、EAI_AGAIN、E2BIG收; 本套件宣告sqlstate與DatabaseError', async function() {
        let c = byId('C01')
        let ctx = ctxOf()
        let errs = c.make(ctx)
        let got = []
        let w = build(fakeOf(), { funLog: (...a) => got.push(a) })
        let i = 0
        w.on('error', () => {
            throw errs[i++]
        })
        for (let k = 0; k < errs.length; k++) {
            await w.createTable('bad;name', 'id', { id: 1 }).catch(() => {})
        }
        let out = got.map(([, safe]) => {
            let { mode, ...rest } = safe
            return rest
        })
        assert.strictEqual(c.expect.check(out, ctx), true)
        assert.ok(got.every(([, safe]) => safe.mode === 'createTable'))

        //本套件宣告: PostgreSQL之SQLSTATE(sqlstate)與類別名DatabaseError(此處為實例name未被改寫者; 自帶name='error'之真驅動實例見下一案)
        let got2 = []
        let w2 = build(fakeOf(), { funLog: (...a) => got2.push(a) })
        class DatabaseError extends Error {}
        let specs = [
            Object.assign(new DatabaseError('x'), { code: '23505' }),
            Object.assign(new DatabaseError('x'), { code: '3D000' }),
            Object.assign(new Error('x'), { code: '23505' }),
            Object.assign(new Error('x'), { code: 12345 }),
            Object.assign(new Error('x'), { code: 'E123456789' }),
            Object.assign(new Error('x'), { code: 'ER_DUP_ENTRY' }),
            Object.assign(new (class UserAlice01 extends Error {})('x'), { code: 'EAI_AGAIN' }),
        ]
        let j = 0
        w2.on('error', () => {
            throw specs[j++]
        })
        for (let k = 0; k < specs.length; k++) {
            await w2.createTable('bad;name', 'id', { id: 1 }).catch(() => {})
        }
        assert.deepStrictEqual(got2.map(([, s]) => s), [
            { mode: 'createTable', errType: 'DatabaseError', errCode: '23505' },
            { mode: 'createTable', errType: 'DatabaseError', errCode: '3D000' },
            { mode: 'createTable', errType: 'Error', errCode: '23505' },
            { mode: 'createTable', errType: 'Error' },
            { mode: 'createTable', errType: 'Error' },
            { mode: 'createTable', errType: 'Error' },
            { mode: 'createTable', errType: 'Error', errCode: 'EAI_AGAIN' },
        ])
    })

    it('C01b 自帶name之驅動錯誤: pg之DatabaseError實例(name為error)與其類別名宣告types:[DatabaseError]比對建構子名而列為DatabaseError; 自設name之其他類別仍為Error', async function() {
        let got = []
        let w = build(fakeOf(), { funLog: (...a) => got.push(a) })
        class DatabaseError extends Error {}
        let e1 = Object.assign(new pg.DatabaseError('x', 10, 'error'), { code: '23505' }) //真驅動類別, 其name為pg-protocol自帶之'error'
        let e2 = Object.assign(new DatabaseError('x'), { name: 'error', code: '3D000' }) //同形之自製類別
        let e3 = Object.assign(new (class UserAlice01 extends Error {})('x'), { name: 'alice-secret', code: 'EAI_AGAIN' }) //自設name但建構子名不在宣告內
        let e4 = Object.assign(new Error('x'), { name: 'error', code: '23505' }) //自設name且建構子為Error
        let e0 = byId('C14').make() //wsemi共用語料之真驅動形態(同pg-protocol之建構子設this.name=name, 後端錯誤之name為error), code為23505
        let specs = [e1, e2, e3, e4, e0]
        //前提: 真驅動實例自帶name='error', 語料之實例同形
        assert.strictEqual(e1.name, 'error')
        assert.ok(e1 instanceof pg.DatabaseError)
        assert.strictEqual(e0.name, 'error')
        let i = 0
        w.on('error', () => {
            throw specs[i++]
        })
        for (let k = 0; k < specs.length; k++) {
            await w.createTable('bad;name', 'id', { id: 1 }).catch(() => {})
        }
        assert.deepStrictEqual(got.map(([, s]) => s), [
            { mode: 'createTable', errType: 'DatabaseError', errCode: '23505' },
            { mode: 'createTable', errType: 'DatabaseError', errCode: '3D000' },
            { mode: 'createTable', errType: 'Error', errCode: 'EAI_AGAIN' },
            { mode: 'createTable', errType: 'Error', errCode: '23505' },
            { mode: 'createTable', errType: 'DatabaseError', errCode: '23505' },
        ])
    })

    it('O01(adapt) logDetail為true: console.log(label, 遮罩後細節)一行(stdout), 細節為Error副本、憑證為***', async function() {
        let c = byId('O01')
        let ctx = ctxOf()
        let { detail } = c.make(ctx)
        let w = build(fakeOf(), { logDetail: true }, { url: urlOfCtx(ctx) })
        let { calls } = await cap(() => fire(w, detail))
        assert.strictEqual(calls.length, 1)
        assert.strictEqual(calls[0].m, 'log')
        assert.strictEqual(calls[0].args[0], 'error handler threw')
        assert.ok(calls[0].args[1] instanceof Error && calls[0].args[1] !== detail)
        assert.strictEqual(dc.verify({ expect: { noSecret: 'detail' } }, calls, ctx), null)
    })

    it('O15(adapt) safe只含mode、errType、errCode: 套件宣告safeKeys為[mode], 白名單外之鍵(如password)不出現', async function() {
        let got = []
        let w = build(fakeOf(), { funLog: (...a) => got.push(a) })
        await fire(w, Object.assign(new Error('x'), { password: PW, mode: 'POLLUTED', code: 'ECONNREFUSED' }))
        assert.deepStrictEqual(Object.keys(got[0][1]).sort(), ['errCode', 'errType', 'mode'])
        assert.strictEqual(got[0][1].mode, 'createTable')
        let src = fs.readFileSync('./src/WOrmPostgresql.mjs', 'utf8')
        assert.ok(src.indexOf('safeKeys: [\'mode\']') >= 0, 'cfg須宣告safeKeys: [mode]')
    })

    it('R01(adapt) 不含憑證之驅動錯誤: reject為同一原物件(身分不變)', async function() {
        let c = byId('R01')
        let value = c.make(ctxOf())
        let r = await runOp(build(fakeOf({ conn: () => value })), (w) => w.select({}))
        assert.strictEqual(r.rej, value)
    })

    it('R04(adapt) 字串reject含密碼: reject為遮罩後字串, 期望同語料', async function() {
        let c = byId('R04')
        let ctx = ctxOf()
        let value = c.make(ctx)
        let r = await runOp(build(fakeOf({ conn: () => value }), {}, { url: urlOfCtx(ctx) }), (w) => w.select({}))
        assert.strictEqual(dc.verify(c, r.rej, ctx), null)
        assert.strictEqual(r.rej, 'failed ***')
    })

    it('R12(adapt) 單獨帳號出現於後端訊息: reject不遮(身分不變)、診斷輸出之detail遮', async function() {
        let c = byId('R12')
        let ctx = ctxOf()
        let value = c.make(ctx)
        let r = await runOp(build(fakeOf({ conn: () => value }), {}, { url: urlOfCtx(ctx) }), (w) => w.select({}))
        let got = []
        let w2 = build(fakeOf(), { funLog: (...a) => got.push(a) }, { url: urlOfCtx(ctx) })
        await fire(w2, value)
        assert.strictEqual(c.expect.check({ e: value, r: r.rej, c: got[0][2] }, ctx), true)
    })

})


describe('診斷輸出之選項與出口(接線)', function() {

    it('R18-1 預設: 只輸出標籤與摘要一行(stdout, 兩站皆console.log), 不含資料值、id、訂閱函數之錯誤原文、憑證; 不取細節', async function() {
        let w = build(fakeOf())
        let e = new Error(`listener ${ID} ${urlOf()}/app ${USER}:${PW}`)
        let { lines, calls } = await cap(() => fire(w, e))
        assert.deepStrictEqual(lines, ['error handler threw { mode: \'createTable\', errType: \'Error\' }'])
        let w2 = build(fakeOf())
        let c2 = await cap(() => fireChange(w2, e))
        assert.deepStrictEqual(c2.lines, ['change handler threw { mode: \'insert\', errType: \'Error\' }'])
        assert.ok(calls.concat(c2.calls).every((x) => x.m === 'log'), '兩站皆為stdout(console.log)')
    })

    it('R18-2 logDetail為true: console.log(label, 細節), 細節為遮罩後之副本, 其餘細節(id、錯誤原文)保留; funLog並給時funLog取代console', async function() {
        let w = build(fakeOf(), { logDetail: true })
        let e = new Error(`listener ${ID} ${urlOf()}/app ${USER}:${PW}`)
        let { lines } = await cap(() => fire(w, e))
        assert.strictEqual(lines.length, 1)
        assert.ok(lines[0].startsWith('error handler threw Error: listener '), lines[0].slice(0, 80))
        assert.ok(lines[0].indexOf(ID) >= 0 && lines[0].indexOf('***') >= 0)
        for (let s of [PW, `${USER}:${PW}`, urlOf()]) {
            assert.ok(lines[0].indexOf(s) < 0, `含憑證[${s}]`)
        }
        let got = []
        let w2 = build(fakeOf(), { logDetail: true, funLog: (...a) => got.push(a) })
        let c2 = await cap(() => fire(w2, e))
        assert.deepStrictEqual(c2.lines, [])
        assert.strictEqual(got.length, 1)
    })

    it('R18-3 funLog收(label, safe, detail), 不寫console', async function() {
        let got = []
        let w = build(fakeOf(), { funLog: (...a) => got.push(a) })
        let e = new Error(`listener ${ID} ${PW}`)
        let { lines } = await cap(() => fire(w, e))
        assert.deepStrictEqual(lines, [])
        assert.strictEqual(got.length, 1)
        let [label, safe, detail] = got[0]
        assert.strictEqual(label, 'error handler threw')
        assert.deepStrictEqual(safe, { mode: 'createTable', errType: 'Error' })
        assert.ok(detail instanceof Error && detail.message.indexOf(ID) >= 0 && detail.message.indexOf(PW) < 0)
    })

    it('R18-3 選項型別錯誤者忽略並用預設(不拋錯、不洩漏); 讀取選項拋錯者忽略該選項、不連累另一個', async function() {
        for (let ex of [{ logDetail: 'true' }, { logDetail: 1 }, { logDetail: {} }, { funLog: 'x' }, { funLog: {} }, { funLog: null }, { logDetail: 'yes', funLog: 123 }]) {
            let { lines } = await cap(() => fire(build(fakeOf(), ex), new Error(`listener ${ID}`)))
            assert.deepStrictEqual(lines, ['error handler threw { mode: \'createTable\', errType: \'Error\' }'], JSON.stringify(ex))
        }
        let base = { url: urlOf(), db: 'app', cl: 'tdiag', pk: 'id' }
        let f = []
        let o1 = Object.defineProperty({ ...base, funLog: (...a) => f.push(a) }, 'logDetail', {
            get() {
                throw new Error('x')
            },
            enumerable: true
        })
        await fire(buildRaw(fakeOf(), o1), new Error('e'))
        assert.strictEqual(f.length, 1, 'logDetail之getter拋錯不連累funLog')
        let o2 = Object.defineProperty({ ...base, logDetail: true }, 'funLog', {
            get() {
                throw new Error('x')
            },
            enumerable: true
        })
        let { lines } = await cap(() => fire(buildRaw(fakeOf(), o2), new Error('e2')))
        assert.strictEqual(lines.length, 1)
        assert.ok(lines[0].startsWith('error handler threw Error: e2'), 'funLog之getter拋錯不連累logDetail')
    })

    it('R18-3 選項快照於建構時固定: 建構後改動opt, 選項之getter只被讀取一次', async function() {
        let n = 0
        let opt = {
            url: urlOf(),
            db: 'app',
            cl: 'tdiag',
            pk: 'id',
            get logDetail() {
                n++
                return n === 1
            }
        }
        let w = buildRaw(fakeOf(), opt)
        let { lines } = await cap(async () => {
            await fire(w, new Error('first'))
            await w.createTable('bad;name', 'id', { id: 1 }).catch(() => {})
        })
        assert.strictEqual(n, 1, 'logDetail只應被讀取一次')
        assert.strictEqual(lines.length, 2)
        assert.ok(lines.every((l) => l.startsWith('error handler threw Error: first')), '兩次皆為建構時之快照(logDetail為true)')
    })

    it('R18-4 funLog拋錯、回傳reject之Promise、回傳會reject之thenable: 不影響操作結果, 不成為unhandledRejection', async function() {
        let bad = []
        let fn = (e) => bad.push(e)
        process.on('unhandledRejection', fn)
        try {
            for (let funLog of [() => {
                throw new Error('x')
            }, () => Promise.reject(new Error('rej')), () => ({ then: () => Promise.reject(new Error('rej2')) })]) {
                let w = build(fakeOf(), { funLog })
                let r = await fireChange(w, new Error('listener'))
                assert.deepStrictEqual(r, { n: 1, nInserted: 0, ok: 1 })
            }
            await new Promise((resolve) => setTimeout(resolve, 30))
        }
        finally {
            process.off('unhandledRejection', fn)
        }
        assert.deepStrictEqual(bad.map(String), [])
    })

    it('R18-4 Object.prototype被資料型汙染(mode、errType、errCode、code): 摘要不採用繼承值, 輸出與操作結果不變', async function() {
        let names = ['mode', 'errType', 'errCode', 'code']
        for (let n of names) {
            // eslint-disable-next-line no-extend-native
            Object.defineProperty(Object.prototype, n, { value: 'POLLUTED', writable: true, enumerable: true, configurable: true })
        }
        let got = null
        try {
            let r1 = await cap(async () => fireChange(build(fakeOf()), new Error('l1')))
            let r2 = await cap(() => fire(build(fakeOf()), new Error('l2')))
            got = JSON.stringify([r1.lines, r2.lines])
        }
        finally {
            for (let n of names) {
                delete Object.prototype[n]
            }
        }
        assert.deepStrictEqual(JSON.parse(got), [['change handler threw { mode: \'insert\', errType: \'Error\' }'], ['error handler threw { mode: \'createTable\', errType: \'Error\' }']], got)
    })

    it('R18-4 訂閱函數拋出非Error值(字串含url、數值、null、undefined、物件、Symbol): 預設只列型別(不執行其程式、不洩漏)', async function() {
        let cases = [
            [`str ${urlOf()}/app ${USER}:${PW} ${ID}`, 'string'],
            [12345, 'number'],
            [null, 'null'],
            [undefined, 'undefined'],
            [{ message: ID, code: ID, url: urlOf() }, 'object'],
            [Symbol(`${ID} ${PW}`), 'symbol'],
        ]
        for (let [v, errType] of cases) {
            let { lines } = await cap(() => fire(build(fakeOf()), v))
            assert.deepStrictEqual(lines, [`error handler threw { mode: 'createTable', errType: '${errType}' }`], errType)
        }
    })

    it('R18-1 無拋錯之訂閱函數: 成功與失敗之操作皆無任何console輸出', async function() {
        let { lines } = await cap(async () => {
            let w = build(fakeOf())
            await w.insert({ id: 'a', v: 1 })
            await w.createTable('bad;name', 'id', { id: 1 }).catch(() => {})
            let w2 = build(fakeOf({ conn: () => new Error('x') }))
            await w2.select({}).catch(() => {})
        })
        assert.deepStrictEqual(lines, [])
    })

})


describe('連線憑證之遮罩接線(R18-5): 本套件宣告之秘密來源(opt.url與組成之連線字串)', function() {

    let textOf = (v) => util.inspect(v, { depth: null, showHidden: true })

    //detailOf, 以funLog取得訂閱函數拋出value時之detail(error事件站)
    let detailOf = async (url, value, ex = {}) => {
        let got = []
        let w = build(fakeOf(), { funLog: (...a) => got.push(a), ...ex }, { url })
        await fire(w, value)
        return got[0][2]
    }

    it('url之帳號與密碼、帳號:密碼、url與url/db之整串皆遮罩', async function() {
        let url = urlOf('Pw9xQz7k')
        let d = await detailOf(url, new Error(`a Pw9xQz7k b ${USER}:Pw9xQz7k c ${url}/app d ${url} e`))
        assert.strictEqual(d.message, 'a *** b *** c *** d *** e')
    })

    it('密碼以百分比編碼寫入url: 編碼形式與解碼後之形式皆遮罩', async function() {
        let url = `postgresql://${USER}:p%40ss%2Fw0rd%3Fx@db.example.com:5432`
        let d = await detailOf(url, new Error('dec p@ss/w0rd?x enc p%40ss%2Fw0rd%3Fx lower p%40ss%2fw0rd%3fx end'))
        assert.strictEqual(d.message, 'dec *** enc *** lower *** end')
    })

    it('畸形網址(密碼含未編碼之@與/): 驅動把片段當主機名或資料庫名, 其片段亦遮罩(診斷輸出與對外reject皆是)', async function() {
        let url = `postgresql://${USER}:p@S3cretHostPw/rest@127.0.0.1:1`
        let d = await detailOf(url, new Error('getaddrinfo ENOTFOUND S3cretHostPw and rest'))
        assert.ok(d.message.indexOf('S3cretHostPw') < 0, d.message)
        let e = Object.assign(new Error('getaddrinfo ENOTFOUND S3cretHostPw'), { code: 'ENOTFOUND', hostname: 'S3cretHostPw' })
        let r = await runOp(build(fakeOf({ conn: () => e }), {}, { url }), (w) => w.select({}))
        assert.ok(r.rej.message.indexOf('S3cretHostPw') < 0 && r.rej.hostname.indexOf('S3cretHostPw') < 0, textOf(r.rej))
        assert.strictEqual(r.rej.code, 'ENOTFOUND')
        assert.strictEqual(r.evs[0].e.indexOf('S3cretHostPw'), -1, r.evs[0].e)
    })

    it('查詢參數帶帳密(?user=&password=): 原樣與解碼形式皆遮罩', async function() {
        let url = `postgresql://db.example.com:5432?user=qa_user&password=Qp%40ss%2B1`
        let d = await detailOf(url, new Error('p Qp@ss+1 q Qp%40ss%2B1 r'))
        assert.strictEqual(d.message, 'p *** q *** r')
    })

    it('url密碼為純數字: 字串、數值、bigint同值皆遮罩(診斷輸出); 數值型之錯誤代碼不進摘要', async function() {
        let url = `postgresql://numuser:123456@127.0.0.1:1`
        let got = []
        let w = build(fakeOf(), { funLog: (...a) => got.push(a) }, { url })
        let e = Object.assign(new Error('listener 123456 numuser'), { code: 123456, n: 123456, b: 123456n })
        await fire(w, e)
        assert.deepStrictEqual(got[0][1], { mode: 'createTable', errType: 'Error' })
        assert.strictEqual(got[0][2].message, 'listener *** ***')
        assert.strictEqual(got[0][2].n, '***')
        assert.strictEqual(got[0][2].b, '***')
        assert.strictEqual(got[0][2].code, '***')
    })

    it('預設url(未給opt.url: postgresql://user:password@127.0.0.1:5432)之帳號與密碼二字於診斷輸出遮罩', async function() {
        let got = []
        let old = pg.Client
        pg.Client = fakeOf()
        let w = null
        try {
            w = WOrm({ funLog: (...a) => got.push(a) })
        }
        finally {
            pg.Client = old
        }
        await fire(w, new Error('a user b password c'))
        assert.strictEqual(got[0][2].message, 'a *** b *** c')
    })

})


describe('單一出口與站點盤點(R18-7、R-DIAG-01)', function() {

    //codeLines, 去除區塊註解、字串字面值與單行註解後逐行回傳(字串內含//如網址時不致把同行後方的程式碼誤當註解而漏掃)
    let codeLines = (src) => {
        let s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        return s.split(/\r?\n/).map((line) => line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""').replace(/\/\/.*$/, ''))
    }
    let reOut = /\b(?:globalThis\s*\.\s*)?console\s*[.[]|\bprocess\s*\.\s*(?:stdout|stderr|emitWarning)\b|\bprocess\s*\[/
    let srcOf = (f) => fs.readFileSync(`./src/${f}`, 'utf8')
    let mainCode = () => codeLines(srcOf('WOrmPostgresql.mjs'))
    let count = (re) => mainCode().filter((l) => re.test(l)).length

    it('R18-7 本套件不再自寫診斷輸出: src/getDiag.mjs已刪, 只由wsemi引入getDiag與getDiagSecrets', function() {
        assert.ok(!fs.existsSync('./src/getDiag.mjs'))
        for (let f of fs.readdirSync('./src')) {
            assert.ok(!/^getDiag/.test(f), f)
        }
        let src = srcOf('WOrmPostgresql.mjs')
        assert.ok(/import getDiag from 'wsemi\/src\/getDiag\.mjs'/.test(src))
        assert.ok(/import getDiagSecrets from 'wsemi\/src\/getDiagSecrets\.mjs'/.test(src))
        assert.ok(!/maskText|cpMask|getOptLog|getSecretsOfUrl|getBriefErr|\.\/getDiag/.test(codeLines(src).join('\n')), '不得殘留自寫遮罩函數之引用')
    })

    it('R18-7 src內任何檔皆不得直接呼叫console或寫process.stdout/stderr/emitWarning(所有診斷輸出經wsemi之getDiag)', function() {
        let bads = []
        let n = 0
        for (let f of fs.readdirSync('./src')) {
            if (!/\.(mjs|js)$/.test(f)) {
                continue
            }
            n++
            let raw = srcOf(f).split(/\r?\n/)
            codeLines(srcOf(f)).forEach((code, k) => {
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

    it('R-DIAG-01 diag(站點恰3處: label為字串字面值、safe只含mode與diag.brief展開; 不傳bare等舊參數(第4參數level不用, 預設stdout))', function() {
        let src = srcOf('WOrmPostgresql.mjs')
        let ms = [...src.matchAll(/^\s*diag\('([^']+)', ([^\n]*)\)\s*$/gm)]
        assert.deepStrictEqual(ms.map((m) => m[1]), ['change handler threw', 'error handler threw', 'client error'])
        for (let m of ms) {
            let v = m[2].match(/^\{ mode, \.\.\.diag\.brief\((\w+)\) \}, \(\) => (\w+)$/)
            assert.ok(v !== null && v[1] === v[2], `呼叫點之safe與getDetail形狀: ${m[2]}`)
        }
        assert.strictEqual(count(/\bdiag\(/), 3, 'diag(站點須恰3處, 新增者先審label與safe是否為固定詞彙並補規則帳本站點表')
    })

    it('R-DIAG-01 本套件之宣告: secrets來源為opt.url與組成之連線字串, codes為sqlstate, types為DatabaseError, safeKeys為mode', function() {
        let src = srcOf('WOrmPostgresql.mjs')
        for (let s of ['getDiagSecrets({ urls: [url, connectionString] })', 'codes: [\'sqlstate\']', 'types: [\'DatabaseError\']', 'safeKeys: [\'mode\']']) {
            assert.ok(src.indexOf(s) >= 0, `缺宣告: ${s}`)
        }
    })

    it('R-DIAG-01 驅動呼叫之單一接縫: new PgClient、client.connect、client.query、client.end各恰1處(pgClient、pgConnect、pgRun、pgEnd內); diag.err恰9處(接縫4、cloneDeep之catch 4、createTable讀樣本1), 無diag.mask(逐筆err與事件之訊息皆源自接縫)', function() {
        assert.strictEqual(count(/new PgClient\(/), 1)
        assert.strictEqual(count(/\bclient\.connect\(/), 1)
        assert.strictEqual(count(/\bclient\.query\(/), 1)
        assert.strictEqual(count(/\bclient\.end\(/), 1)
        let lines = mainCode()
        let idx = (re) => lines.findIndex((l) => re.test(l))
        //四個接縫函數: 驅動呼叫與其後之diag.err在同一個函數內
        for (let [fn, call] of [['pgClient', /new PgClient\(/], ['pgConnect', /client\.connect\(/], ['pgRun', /client\.query\(/], ['pgEnd', /client\.end\(/]]) {
            let a = idx(new RegExp(`\\bfunction ${fn}\\(`))
            let b = idx(call)
            assert.ok(a >= 0 && b > a && b - a <= 4, `${fn}之驅動呼叫應緊接於函數開頭`)
            assert.ok(/diag\.err\(err\)/.test(lines.slice(b, b + 5).join('\n')), `${fn}之catch須經diag.err`)
        }
        assert.strictEqual(count(/\bdiag\.err\(/), 9)
        assert.strictEqual(count(/\bdiag\.mask\(/), 0)
    })

    it('R-DIAG-01 reject站點盤點: Promise.reject恰28處(createTable 3、select 4、selectByPk 2、insert 4、insertBulk 4、save 4、del 3、delAll 4); 新增者須先判定外來值或固定詞彙並補規則帳本站點表', function() {
        assert.strictEqual(count(/\bPromise\.reject\(/), 28)
        //各操作之Promise.reject數(以function宣告區段分段)
        let lines = mainCode()
        let names = ['createTable', 'select', 'selectByPk', 'insert', 'insertBulk', 'save', 'del', 'delAll']
        let starts = names.map((n) => lines.findIndex((l) => new RegExp(`^\\s*async function ${n}\\(`).test(l)))
        assert.ok(starts.every((s) => s >= 0), starts.join())
        let got = names.map((n, i) => lines.slice(starts[i], i + 1 < names.length ? starts[i + 1] : lines.length).filter((l) => /\bPromise\.reject\(/.test(l)).length)
        assert.deepStrictEqual(got, [3, 4, 2, 4, 4, 4, 3, 4])
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
                WOrm({ url: urlOf(), ...ex })
            }
            catch (e) {
                err = e
            }
            assert.ok(err instanceof Error, JSON.stringify(ex))
            assert.strictEqual(err.message, msg)
            assert.ok(err.message.indexOf(PW) < 0 && err.message.indexOf(USER) < 0)
        }
    })

    it('R18-8 合格之url(含帳密)建構成功, logDetail與funLog選項型別不合者不使建構拋錯; opt本身不是物件亦不拋錯', function() {
        for (let ex of [{}, { logDetail: true }, { logDetail: 'x' }, { funLog: () => {} }, { funLog: 'x' }, { logDetail: 1, funLog: {} }]) {
            let w = WOrm({ url: urlOf(), db: 'worm', cl: 't', ...ex })
            assert.strictEqual(typeof w.select, 'function')
        }
        assert.doesNotThrow(() => WOrm(null))
        assert.doesNotThrow(() => WOrm(5))
    })

})
