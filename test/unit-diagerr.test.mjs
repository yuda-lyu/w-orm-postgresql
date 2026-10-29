import util from 'util'
import assert from 'assert'
import { USER, PW, urlOf, leakErr, fakeOf, build, runOp } from './tools/fakePg.mjs'


//rulebook R18(依dspec〈診斷輸出與遮罩〉D3、wsemi R-DIAG-01): 對外錯誤值不含連線憑證之接線測試, 不連線、不需docker(假pg.Client逐一觸發各接縫與站點)
//  D3-a 外來值(驅動與後端之錯誤、使用端存取器拋出之值)經diag.err: 含憑證者為遮罩後之同類別副本(code等非秘密欄位保留), 無憑證者為原物件(身分不變); 單獨帳號不遮
//  D3-b 本套件自身以固定詞彙組成之錯誤不經遮罩(對固定字串挖空會讓缺口反推短密碼): 密碼恰為其子字串時仍原樣
//  D3-c save與del逐筆結果之err、error事件之訊息引數皆與reject同源(接縫遮罩後之值), 不含憑證
//站點全集見sgud/rule/rulebook.md〈R18〉之站點表; 下列各describe之編號(F1..F6、O1..)對應該表


let OPS = [
    ['createTable', (w) => w.createTable('tdiag', 'id', { id: 'x', v: 1 })],
    ['select', (w) => w.select({ id: 'a' })],
    ['selectByPk', (w) => w.selectByPk('a')],
    ['insert', (w) => w.insert({ id: 'a', v: 1 })],
    ['insertBulk', (w) => w.insertBulk([{ id: 'a', v: 1 }])],
    ['save', (w) => w.save({ id: 'a', v: 1 })],
    ['del', (w) => w.del({ id: 'a' })],
    ['delAll', (w) => w.delAll({ id: 'a' })],
]

let isTx = (t) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(t)
let isSelect = (t) => /^\s*select/i.test(t)

//textOf, 值之全部可見文字(含stack、自有屬性、不可列舉屬性), 供斷言不含憑證
let textOf = (v) => util.inspect(v, { depth: null, showHidden: true })

//noLeak, 不含密碼、帳號:密碼、整串連線字串(帳號單獨出現於對外錯誤值不遮, 故不檢)
let noLeak = (v, msg = '') => {
    let t = textOf(v)
    for (let s of [PW, `${USER}:${PW}`, urlOf()]) {
        assert.ok(t.indexOf(s) < 0, `${msg} 含憑證[${s}]: ${t.slice(0, 300)}`)
    }
}

//isLeakMasked, 遮罩後之副本: 同類別、code等非秘密欄位保留、帳號保留、憑證為***、非原物件
let isLeakMasked = (v, orig, msg = '') => {
    assert.ok(v instanceof Error && v !== orig, `${msg} 應為遮罩後之副本: ${textOf(v).slice(0, 200)}`)
    assert.strictEqual(v.code, '28P01', msg)
    assert.strictEqual(v.severity, 'FATAL', msg)
    assert.ok(v.message.indexOf('***') >= 0 && v.message.indexOf(`for user "${USER}"`) >= 0, `${msg} ${v.message}`)
    noLeak(v, msg)
}

//isLeakMaskedStr, 字串形態(createTable與delAll之資料庫錯誤以訊息字串reject)
let isLeakMaskedStr = (v, msg = '') => {
    assert.strictEqual(typeof v, 'string', msg)
    assert.ok(v.indexOf('***') >= 0 && v.indexOf(`for user "${USER}"`) >= 0, `${msg} ${v}`)
    noLeak(v, msg)
}


describe('F1 pgClient: new pg.Client之同步拋出(驅動解析連線字串)為外來值', function() {

    for (let [name, run] of OPS) {
        it(`[${name}] 含憑證者reject遮罩副本、無error事件(沿用既有: 建構失敗不發事件); 無憑證者原物件`, async function() {
            let orig = leakErr()
            let r = await runOp(build(fakeOf({ nw: () => orig })), run)
            assert.ok(r.has, 'should reject')
            isLeakMasked(r.rej, orig, name)
            assert.deepStrictEqual(r.evs, [], '建構失敗不發error事件(同修改前)')
            let plain = new TypeError('Invalid URL')
            let r2 = await runOp(build(fakeOf({ nw: () => plain })), run)
            assert.strictEqual(r2.rej, plain, `${name} 無憑證者須為原物件`)
        })
    }

})


describe('F2 pgConnect: client.connect()之reject為外來值', function() {

    for (let [name, run] of OPS) {
        it(`[${name}] 含憑證之Error: reject與error事件之訊息皆遮罩, code保留; 無憑證者原物件; 字串reject亦遮罩`, async function() {
            let orig = leakErr()
            let r = await runOp(build(fakeOf({ conn: () => orig })), run)
            isLeakMasked(r.rej, orig, name)
            assert.strictEqual(r.evs.length, 1, `${name} error事件`)
            assert.strictEqual(typeof r.evs[0].e, 'string')
            assert.ok(r.evs[0].e.indexOf('***') >= 0, r.evs[0].e)
            noLeak(r.evs[0].e, `${name} 事件`)
            assert.strictEqual(r.evs[0].m, name)

            let plain = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
            let r2 = await runOp(build(fakeOf({ conn: () => plain })), run)
            assert.strictEqual(r2.rej, plain, `${name} 無憑證者須為原物件(身分不變)`)

            let r3 = await runOp(build(fakeOf({ conn: () => `failed ${PW} ${urlOf()}/app` })), run)
            assert.strictEqual(typeof r3.rej, 'string')
            assert.ok(r3.rej.indexOf('***') >= 0 && r3.rej.indexOf('failed') === 0, r3.rej)
            noLeak(r3.rej, `${name} 字串`)
        })
    }

})


describe('F3 pgRun: client.query()之reject為外來值', function() {

    //首個非交易語句reject: createTable與delAll之資料庫錯誤以訊息字串reject, del為逐筆結果之err(resolve), 其餘為Error物件
    let shapes = { createTable: 'str', select: 'err', selectByPk: 'err', insert: 'err', insertBulk: 'err', save: 'err', del: 'row', delAll: 'str' }

    for (let [name, run] of OPS) {
        it(`[${name}] 首個語句reject含憑證之錯誤(${shapes[name]}): 對外值與error事件皆遮罩`, async function() {
            let orig = leakErr()
            let r = await runOp(build(fakeOf({ query: (t) => (isTx(t) ? undefined : { throws: orig }) })), run)
            if (shapes[name] === 'row') {
                assert.ok(!r.has, 'del之資料庫錯誤為逐筆結果, 不reject')
                assert.strictEqual(r.ok.length, 1)
                assert.strictEqual(r.ok[0].ok, 0)
                isLeakMaskedStr(r.ok[0].err, `${name} 逐筆err`)
                assert.strictEqual(r.evs.length, 1)
                assert.strictEqual(r.evs[0].e, r.ok[0].err, '事件之訊息與逐筆err同源')
                return
            }
            assert.ok(r.has, 'should reject')
            if (shapes[name] === 'str') {
                isLeakMaskedStr(r.rej, name)
            }
            else {
                isLeakMasked(r.rej, orig, name)
            }
            assert.strictEqual(r.evs.length, 1)
            assert.strictEqual(typeof r.evs[0].e, 'string')
            noLeak(r.evs[0].e, `${name} 事件`)
            assert.ok(r.evs[0].e.indexOf('***') >= 0, r.evs[0].e)
        })
    }

    it('insert、insertBulk之BEGIN失敗: reject為遮罩副本(交易控制語句亦為驅動呼叫)', async function() {
        for (let run of [OPS[3][1], OPS[4][1]]) {
            let orig = leakErr()
            let r = await runOp(build(fakeOf({ query: (t) => (t === 'BEGIN' ? { throws: orig } : undefined) })), run)
            isLeakMasked(r.rej, orig, 'BEGIN')
            noLeak(r.evs[0].e, 'BEGIN事件')
        }
    })

    it('insert、insertBulk之COMMIT失敗: ROLLBACK照送, reject為遮罩副本; ROLLBACK自身reject含憑證者被吞下(不成為unhandledRejection, 不取代原錯誤)', async function() {
        let bad = []
        let fn = (e) => bad.push(e)
        process.on('unhandledRejection', fn)
        try {
            for (let run of [OPS[3][1], OPS[4][1]]) {
                let orig = leakErr()
                let Fake = fakeOf({ query: (t) => (t === 'COMMIT' ? { throws: orig } : t === 'ROLLBACK' ? { throws: leakErr() } : undefined) })
                let r = await runOp(build(Fake), run)
                isLeakMasked(r.rej, orig, 'COMMIT')
                assert.ok(Fake.calls.includes('ROLLBACK'))
            }
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        finally {
            process.off('unhandledRejection', fn)
        }
        assert.deepStrictEqual(bad.map(String), [])
    })

    it('save: 預讀之select失敗為整批reject(遮罩副本); 預讀成功而寫入失敗為逐筆err(autoInsert為true之INSERT與為false之UPDATE兩路徑), 皆遮罩且與error事件同源', async function() {
        let orig = leakErr()
        let r = await runOp(build(fakeOf({ query: (t) => (isSelect(t) ? { throws: orig } : undefined) })), (w) => w.save({ id: 'a', v: 1 }))
        isLeakMasked(r.rej, orig, 'save預讀')

        //autoInsert為true: 預讀查無列, INSERT ... ON CONFLICT失敗
        let r2 = await runOp(build(fakeOf({ query: (t) => (isSelect(t) ? undefined : { throws: leakErr() }) })), (w) => w.save([{ id: 'a', v: 1 }, { id: 'b', v: 2 }]))
        assert.ok(!r2.has)
        assert.strictEqual(r2.ok.length, 2)
        for (let x of r2.ok) {
            assert.strictEqual(x.ok, 0)
            isLeakMaskedStr(x.err, 'save INSERT逐筆err')
        }
        assert.deepStrictEqual(r2.evs.map((v) => v.e), r2.ok.map((x) => x.err), '事件之訊息與逐筆err同源')

        //autoInsert為false: 預讀有列且內容不同, UPDATE失敗
        let Fake = fakeOf({ query: (t) => (isSelect(t) ? { rows: [{ id: 'a', v: 0 }], rowCount: 1 } : { throws: leakErr() }) })
        let r3 = await runOp(build(Fake), (w) => w.save({ id: 'a', v: 1 }, { autoInsert: false }))
        assert.ok(!r3.has)
        assert.strictEqual(r3.ok[0].ok, 0)
        isLeakMaskedStr(r3.ok[0].err, 'save UPDATE逐筆err')
        assert.ok(Fake.calls.some((t) => /^update/i.test(t)), '應走UPDATE路徑')
        assert.strictEqual(r3.evs[0].e, r3.ok[0].err)
    })

    it('逐筆err之無憑證錯誤原文保留(不誤遮); 帳號單獨出現不遮(只遮憑證)', async function() {
        let r = await runOp(build(fakeOf({ query: (t) => (isTx(t) ? undefined : { throws: Object.assign(new Error(`role "${USER}" does not exist`), { code: '28000' }) }) })), (w) => w.del({ id: 'a' }))
        assert.strictEqual(r.ok[0].err, `role "${USER}" does not exist`)
    })

})


describe('F4 pgEnd: client.end()之reject為外來值', function() {

    for (let [name, run] of OPS) {
        it(`[${name}] finally中end()reject含憑證之錯誤: reject為遮罩副本(與修改前一樣以其取代結果)`, async function() {
            let orig = leakErr()
            let r = await runOp(build(fakeOf({ end: () => orig })), run)
            assert.ok(r.has, `${name} end失敗須reject`)
            isLeakMasked(r.rej, orig, name)
        })
    }

})


describe('F5 cloneDeep之catch: 使用端物件之存取器或Proxy陷阱拋出之值為外來值', function() {

    let leakGetter = () => ({
        id: 'a',
        get v() {
            throw leakErr()
        }
    })
    let cases = [
        ['insert', (w) => w.insert(leakGetter())],
        ['insertBulk', (w) => w.insertBulk([leakGetter()])],
        ['save', (w) => w.save(leakGetter())],
        ['del', (w) => w.del(leakGetter())],
    ]
    for (let [name, run] of cases) {
        it(`[${name}] 存取器拋出含憑證之錯誤: reject與error事件皆遮罩, 不連線; 拋出無憑證之錯誤者原物件`, async function() {
            let Fake = fakeOf()
            let r = await runOp(build(Fake), run)
            assert.ok(r.has)
            assert.ok(r.rej instanceof Error && r.rej.message.indexOf('***') >= 0 && r.rej.code === '28P01', textOf(r.rej).slice(0, 200))
            noLeak(r.rej, name)
            assert.strictEqual(r.evs.length, 1)
            noLeak(r.evs[0].e, `${name} 事件`)
            assert.deepStrictEqual(Fake.calls, [], '於連線之前reject')

            let plain = new RangeError('plain getter error')
            let r2 = await runOp(build(fakeOf()), (w) => w[name]({
                id: 'a',
                get v() {
                    throw plain
                }
            }))
            assert.strictEqual(r2.rej, plain)
        })
    }

})


describe('F6 createTable讀取樣本物件: 其存取器拋出之值為外來值, 本套件自身之固定詞彙錯誤(ownErr)原樣', function() {

    it('樣本之存取器拋出含憑證之錯誤: reject與error事件皆遮罩; 拋出無憑證者原物件', async function() {
        let r = await runOp(build(fakeOf()), (w) => w.createTable('tdiag', 'id', {
            id: 'x',
            get v() {
                throw leakErr()
            }
        }))
        assert.ok(r.rej instanceof Error && r.rej.message.indexOf('***') >= 0 && r.rej.code === '28P01', textOf(r.rej).slice(0, 200))
        noLeak(r.rej)
        assert.strictEqual(r.evs.length, 1)
        noLeak(r.evs[0].e, '事件')

        let plain = new RangeError('plain')
        let r2 = await runOp(build(fakeOf()), (w) => w.createTable('tdiag', 'id', {
            id: 'x',
            get v() {
                throw plain
            }
        }))
        assert.strictEqual(r2.rej, plain)
    })

    it('樣本為toString拋出含憑證錯誤之物件(組成obj[...]訊息時之字串化執行使用端程式): 遮罩', async function() {
        let o = {
            toString() {
                throw leakErr()
            }
        }
        //無自有鍵之樣本走「not an effective object」之固定訊息路徑, 組成該訊息時字串化樣本而執行其toString
        let r = await runOp(build(fakeOf()), (w) => w.createTable('tdiag', 'id', Object.create(o)))
        assert.ok(r.has)
        noLeak(r.rej)
    })

})


describe('O 本套件自身以固定詞彙組成之錯誤不經遮罩(D3-b): 密碼恰為其子字串時仍原樣', function() {

    //每站: [名稱, 操作, 密碼(取訊息內之詞), 取出該站之錯誤文字]; 預期值取自無詞彙衝突之基準實例(密碼為PW), 斷言兩者逐字相同, 且基準訊息確含該密碼詞(衝突為真)
    let txt = (x) => (x.has ? (typeof x.rej === 'string' ? x.rej : x.rej.message) : x.ok[0].err)
    let sites = [
        ['O1 createTable表名不合', (w) => w.createTable('bad;name', 'id', { id: 1 }), 'invalid createTable'],
        ['O2 createTable主鍵名不合', (w) => w.createTable('tdiag', 'bad pk', { id: 1 }), 'invalid createTable'],
        ['O3 createTable欄名不合', (w) => w.createTable('tdiag', 'id', { 'bad key': 1 }), 'unsupported column'],
        ['O4 createTable樣本非物件(obj[..])', (w) => w.createTable('tdiag', 'id', 'not-an-object'), 'effective object'],
        ['O5 select條件不合(cvFind)', (w) => w.select({ $foo: 1 }), 'unsupported operator'],
        ['O6 select排序不合(cvOrder)', (w) => w.select({}, { 'bad key': 'asc' }), 'invalid order'],
        ['O7 delAll條件不合', (w) => w.delAll({ $foo: 1 }), 'unsupported operator'],
        ['O8 insert缺主鍵(checkData)', (w) => w.insert({ v: 1 }), 'invalid id'],
        ['O9 insertBulk缺主鍵', (w) => w.insertBulk([{ v: 1 }]), 'invalid id'],
        ['O10 save整批缺主鍵', (w) => w.save({ v: 1 }), 'invalid id'],
        ['O11 save逐筆主鍵含孤立代理(rowErrs)', (w) => w.save([{ id: 'a\ud800', v: 1 }, { id: 'b', v: 1 }]), 'invalid id'],
        ['O12 del逐筆缺主鍵(idErrOf)', (w) => w.del({ v: 1 }), 'invalid id'],
        ['O13 save逐筆資料含孤立代理(rowErrs)', (w) => w.save([{ id: 'a', v: 'x\ud800' }, { id: 'b', v: 1 }]), 'invalid data'],
        ['O14 save未開autoInsert之資料鍵不合(checkKeys)', (w) => w.save({ 'id': 'a', '$inc': 1 }, { autoInsert: false }), 'invalid data'],
    ]
    for (let [name, run, word] of sites) {
        it(`${name}: 密碼為其中之詞「${word}」仍逐字原樣`, async function() {
            let b = await runOp(build(fakeOf()), run)
            let base = txt(b)
            assert.ok(base.indexOf(word) >= 0, `基準訊息應含「${word}」: ${base}`)
            assert.ok(base.indexOf('***') < 0)
            assert.ok(b.evs.length >= 1, '本站發出error事件')
            let r = await runOp(build(fakeOf(), {}, { pw: word }), run)
            assert.strictEqual(txt(r), base, `${name} 固定詞彙錯誤不得經遮罩`)
            assert.deepStrictEqual(r.evs, b.evs, `${name} error事件之訊息引數亦原樣`)
        })
    }

    it('O15 selectByPk與select之結果型別防禦分支(can not select by ...): 本套件自身訊息原樣(密碼為其中之詞)', async function() {
        for (let [run, word] of [[(w) => w.selectByPk('k1'), 'select'], [(w) => w.select({ id: 'k1' }), 'select']]) {
            let Fake = () => fakeOf({ query: () => ({ rows: undefined, rowCount: 0 }) })
            let base = await runOp(build(Fake()), run)
            let r = await runOp(build(Fake(), {}, { pw: word }), run)
            let t = typeof base.rej === 'string' ? base.rej : base.rej.message
            assert.ok(t.indexOf('can not select by') === 0, t)
            assert.strictEqual(typeof r.rej === 'string' ? r.rej : r.rej.message, t)
            assert.deepStrictEqual(r.evs, base.evs)
        }
    })

    it('O16 select與delAll之語句核對失敗(建句後之fail-closed, Object.prototype被資料型汙染時觸發): 本套件自身訊息原樣(密碼為其中之詞)', async function() {
        let word = 'internal statement check failed'
        //觸發法同unit-sqlbuild: Object.prototype.isRawInstance之getter就地改寫knex所讀之Date, 語句與條件不符而fail-closed
        let polluted = async (fn) => {
            // eslint-disable-next-line no-extend-native
            Object.defineProperty(Object.prototype, 'isRawInstance', {
                configurable: true,
                get() {
                    if (this instanceof Date) {
                        this.setTime(0)
                    }
                    return undefined
                },
            })
            try {
                return await fn()
            }
            finally {
                delete Object.prototype.isRawInstance
            }
        }
        let d = () => new Date(Date.UTC(2025, 0, 1))
        for (let [name, run, ev] of [['select', (w) => w.select({ d: d() }), 'select'], ['delAll', (w) => w.delAll({ d: d() }), 'delAll']]) {
            let b = await polluted(() => runOp(build(fakeOf()), run))
            let r = await polluted(() => runOp(build(fakeOf(), {}, { pw: word }), run))
            //斷言於汙染移除後進行(斷言失敗時AssertionError本身會讀寫被汙染的名稱)
            let t = typeof b.rej === 'string' ? b.rej : b.rej.message
            assert.ok(t.indexOf(word) >= 0 && t.indexOf('***') < 0, `${name} 基準訊息應含「${word}」: ${t}`)
            assert.strictEqual(typeof r.rej === 'string' ? r.rej : r.rej.message, t, `${name} 固定詞彙錯誤不得經遮罩`)
            assert.deepStrictEqual(r.evs, b.evs)
            assert.strictEqual(r.evs[0].m, ev)
        }
    })

    it('對照(證明上列測試有鑑別力): 若以wsemi之maskDiagErr包這些固定詞彙訊息, 密碼為其子字串者即被切碎', async function() {
        let { default: maskDiagErr } = await import('wsemi/src/maskDiagErr.mjs')
        let { default: getDiagSecrets } = await import('wsemi/src/getDiagSecrets.mjs')
        assert.strictEqual(maskDiagErr('invalid id: x', getDiagSecrets({ password: 'invalid' })), '*** id: x')
    })

})


describe('錯誤值之完整性: 遮罩副本之型態(接線)', function() {

    it('驅動之DatabaseError(pg-protocol)含憑證: 副本為同類別(instanceof、constructor名)、code/severity/detail等欄位保留、訊息中憑證為***', async function() {
        let { default: pg } = await import('pg')
        let e = new pg.DatabaseError(`password authentication failed ${PW} ${urlOf()}`, 10, 'error')
        e.code = '28P01'
        e.severity = 'FATAL'
        e.detail = 'detail text'
        let r = await runOp(build(fakeOf({ conn: () => e })), OPS[1][1])
        assert.ok(r.rej instanceof pg.DatabaseError && r.rej !== e)
        assert.strictEqual(r.rej.code, '28P01')
        assert.strictEqual(r.rej.severity, 'FATAL')
        assert.strictEqual(r.rej.detail, 'detail text')
        noLeak(r.rej)
    })

    it('原物件身分: 連續兩次不含憑證之reject為同一原物件(未被複製)', async function() {
        let e = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
        for (let i = 0; i < 2; i++) {
            let r = await runOp(build(fakeOf({ conn: () => e })), OPS[1][1])
            assert.strictEqual(r.rej, e)
        }
    })

})
