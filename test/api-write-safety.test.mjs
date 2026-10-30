/* eslint-disable no-extend-native -- 測試以暫時汙染原型(finally 還原)驗證寫入路徑免疫 */
import assert from 'assert'
import pg from 'pg'
import WOrm from '../src/WOrmPostgresql.mjs'
import { cvFind, cvOrder, cvKey } from '../src/cvFind.mjs'
import { startPg, stopPg, connectPg } from './tools/pgContainer.mjs'


//寫入路徑與主鍵類函數之輸入安全測試. 真 PostgreSQL(自建容器, 測畢即銷毀), 不 mock 接縫.
//規格句見 CLAUDE_rulebook.md 開頭:
//  W1 insert, insertBulk, save 之物件值(含帶 type 鍵者)以 JSON 原樣寫入, 不被當成子查詢, 不得跨表讀取
//  W2 save(..,{autoInsert:false}) 之 UPDATE 以綁定參數寫入字面值($..$ 字串, 資料鍵 $inc/$dec/$custom 不得生效),
//     非識別字之欄名鍵整批 reject
//  W3 包裝物件(Object(5) 等)、非 Date 物件、裝飾過之 Date 之主鍵值為無效主鍵(首尾皆 $ 之字串已改為一般字面值, 見 S6)
//  S5 整批 reject 時資料不變, 於 reject 前發一次 error 事件, reject 之值為 Error
//  S6 以主鍵值構成之條件不得因主鍵值為 $..$ 字串而命中全部(新版: $..$ 主鍵值為一般字面值, 恆為綁定參數)
//行為變更(mongo-sql → knex): 欄名 Infinity 合法; 系統欄名 ctid tableoid xmin xmax cmin cmax 拒收; 預引號表名可用於所有函數; $nin 不再受表名限制


let ctName = 'worm-test-postgresql-write'
let ct = null
let admin = null
let CL = 'twrite'

let SEED = [
    { time: 1, name: 'aa', n: 10, tag: 'x', value: 1.5 },
    { time: 2, name: 'bb', n: 20, tag: 'y', value: 2.5 },
    { time: 3, name: 'cc', n: 30, tag: 'z', value: 3.5 },
]

//reset, tsecret 供驗證不得跨表讀取
let reset = async () => {
    await admin.query(`DROP TABLE IF EXISTS ${CL}`)
    await admin.query(`CREATE TABLE ${CL} (time INTEGER PRIMARY KEY, name TEXT, n INTEGER, tag TEXT, value DOUBLE PRECISION, ok BOOLEAN, ts TIMESTAMPTZ, js JSONB, bin BYTEA, arr INTEGER[])`)
    for (let r of SEED) {
        await admin.query(`INSERT INTO ${CL}(time,name,n,tag,value) VALUES ($1,$2,$3,$4,$5)`, [r.time, r.name, r.n, r.tag, r.value])
    }
    await admin.query('DROP TABLE IF EXISTS tsecret')
    await admin.query('CREATE TABLE tsecret (id INTEGER, pw TEXT)')
    await admin.query('INSERT INTO tsecret VALUES (1, $1)', ['s3cret'])
}
let rows = async (cols = '*') => (await admin.query(`SELECT ${cols} FROM ${CL} ORDER BY time`)).rows
let row = async (time) => (await admin.query(`SELECT * FROM ${CL} WHERE time = $1`, [time])).rows[0]
let mk = (opt = {}) => WOrm({ url: ct.url, db: ct.db, cl: CL, ...opt })
let settle = (p) => p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e }))
let jtext = (o) => JSON.stringify(o)
//capture, 擷取送給 pg 之設定物件(text、values), 交易控制字串略過
let capture = async (fn) => {
    let seen = []
    let orig = pg.Client.prototype.query
    pg.Client.prototype.query = function(cfg, ...rest) {
        if (typeof cfg !== 'string') {
            seen.push([cfg.text, cfg.values])
        }
        return orig.call(this, cfg, ...rest)
    }
    try {
        await fn()
    }
    finally {
        pg.Client.prototype.query = orig
    }
    return seen
}


before(async function() {
    this.timeout(600000)
    ct = await startPg(ctName)
    admin = await connectPg(ct)
})

after(async function() {
    this.timeout(120000)
    if (admin) {
        await admin.end().catch(() => {})
    }
    await stopPg(ctName)
})


describe('write: object values are stored as JSON, never as sub-queries (W1)', function() {
    let geo = { type: 'Point', coordinates: [121.5, 25.05] }

    it('should store GeoJSON-like value with "type" key by insert', async function() {
        await reset()
        let r = await mk().insert({ time: 11, js: geo })
        assert.strictEqual(r.nInserted, 1)
        assert.deepStrictEqual((await row(11)).js, geo) //W1 JSONB 原樣
    })

    it('should store value with "type" key by insertBulk', async function() {
        await reset()
        let r = await mk().insertBulk([{ time: 11, js: geo }, { time: 12, js: { type: 'a', x: 1 } }])
        assert.strictEqual(r.nInserted, 2)
        assert.deepStrictEqual((await row(12)).js, { type: 'a', x: 1 }) //W1
    })

    it('should store value with "type" key by save (autoInsert insert and conflict update)', async function() {
        await reset()
        let wo = mk()
        let r1 = await wo.save({ time: 11, js: geo })
        assert.strictEqual(r1[0].nInserted, 1)
        let g2 = { type: 'LineString', coordinates: [[0, 0], [1, 1]] }
        let r2 = await wo.save({ time: 11, js: g2 })
        assert.strictEqual(r2[0].nModified, 1)
        assert.deepStrictEqual((await row(11)).js, g2) //W1
    })

    it('should store a sub-query-looking object as text, not execute it (insert)', async function() {
        await reset()
        let evil = { type: 'select', table: 'tsecret', columns: ['pw'] }
        await mk().insert({ time: 11, name: evil })
        let r = await row(11)
        assert.strictEqual(r.name, jtext(evil)) //W1 不得為他表之值 s3cret
        assert.notStrictEqual(r.name, 's3cret')
    })

    it('should store a sub-query-looking object as text, not execute it (save insert and update paths)', async function() {
        await reset()
        let evil = { type: 'select', table: 'tsecret', columns: ['pw'] }
        let wo = mk()
        await wo.save({ time: 11, name: evil })
        assert.strictEqual((await row(11)).name, jtext(evil)) //W1
        await wo.save({ time: 1, name: evil }, { autoInsert: false })
        assert.strictEqual((await row(1)).name, jtext(evil)) //W1 UPDATE 路徑
    })

    it('should keep roundtrip of nested objects without "type" key (compat)', async function() {
        await reset()
        let v = { a: 1, b: { c: [1, 2, { d: null }] }, e: 'x' }
        await mk().insert({ time: 11, js: v })
        assert.deepStrictEqual((await row(11)).js, v)
    })

    it('should keep values of Date, null, boolean, number as before', async function() {
        await reset()
        let d = new Date('2020-01-02T03:04:05.000Z')
        await mk().insert({ time: 11, ts: d, name: null, ok: true, n: 7, value: 0.25 })
        let r = await row(11)
        assert.strictEqual(r.ts.toISOString(), d.toISOString())
        assert.strictEqual(r.name, null)
        assert.strictEqual(r.ok, true)
        assert.strictEqual(r.n, 7)
        assert.strictEqual(r.value, 0.25)
    })

    it('should write Buffer values to a bytea column by insert and by save UPDATE (bound parameters)', async function() {
        await reset()
        let b1 = Buffer.from([0, 1, 2, 36, 255])
        let b2 = Buffer.from('$bin$')
        await mk().insert({ time: 11, bin: b1 })
        assert.ok((await row(11)).bin.equals(b1)) //W1 Buffer 原樣
        await mk().save({ time: 11, bin: b2 }, { autoInsert: false })
        assert.ok((await row(11)).bin.equals(b2)) //W2 UPDATE 路徑
    })

    it('should store a class instance carrying a "type" property as JSON, not as a sub-query', async function() {
        await reset()
        class T {
            constructor() {
                this.type = 'select'
                this.table = 'tsecret'
            }
        }
        let r = await mk().insert([{ time: 11, name: 'ok' }, { time: 12, js: new T() }])
        assert.strictEqual(r.nInserted, 2)
        assert.deepStrictEqual((await row(12)).js, { type: 'select', table: 'tsecret' }) //W1
    })

    it('should write Date, array and Buffer values that carry a "type" property as ordinary values', async function() {
        await reset()
        let extra = { type: 'select', table: 'tsecret', columns: ['pw'] }
        let d = Object.assign(new Date('2020-05-06T07:08:09.000Z'), extra)
        let a = Object.assign([4, 5], extra)
        let b = Object.assign(Buffer.from('xy'), extra)
        await mk().insert({ time: 11, ts: d, arr: a, bin: b })
        let x = await row(11)
        assert.strictEqual(x.ts.toISOString(), '2020-05-06T07:08:09.000Z') //W1
        assert.deepStrictEqual(x.arr, [4, 5])
        assert.ok(x.bin.equals(Buffer.from('xy')))
    })

    it('should write objects with a custom toPostgres method as pg serializes them (compat)', async function() {
        await reset()
        await mk().insert({
            time: 11,
            name: {
                toPostgres() {
                    return 'custom-value'
                }
            }
        })
        assert.strictEqual((await row(11)).name, 'custom-value')
        await mk().save({
            time: 1,
            name: {
                toPostgres() {
                    return 'custom-2'
                }
            }
        }, { autoInsert: false })
        assert.strictEqual((await row(1)).name, 'custom-2')
    })

    it('should not be affected by a polluted Object.prototype.type / Array.prototype.type while inserting', async function() {
        await reset()
        Object.prototype.type = 'select'
        Array.prototype.type = 'select'
        try {
            let r = await mk().insert({ time: 11, js: { a: 1 }, arr: [1], ts: new Date(0) })
            assert.strictEqual(r.nInserted, 1)
            let s = await mk().save({ time: 12, js: { b: 2 }, arr: [2] })
            assert.strictEqual(s[0].nInserted, 1)
        }
        finally {
            delete Object.prototype.type
            delete Array.prototype.type
        }
        assert.deepStrictEqual((await row(11)).js, { a: 1 }) //W1
        assert.deepStrictEqual((await row(12)).js, { b: 2 })
    })

    it('should serialize an object value once (toJSON called once) in a multi-record save and write every record', async function() {
        await reset()
        let calls = 0
        let o = {
            toJSON() {
                calls++; return { once: calls }
            }
        }
        await mk().save([{ time: 11, js: o }, { time: 12, js: { b: 1 } }])
        assert.strictEqual(calls, 1) //W1 僅由 pg 序列化一次
        assert.deepStrictEqual((await row(11)).js, { once: 1 })
        assert.strictEqual((await rows()).length, 5)
    })

    it('should double quote data keys of INSERT instead of breaking out of the identifier', async function() {
        await reset()
        let evs = []
        let wo = mk()
        wo.on('error', (mode) => evs.push(mode))
        let r = await settle(wo.insert({ 'time': 11, 'x") values (1); drop table twrite; --': 1 }))
        assert.strictEqual(r.ok, false) //欄名不存在, 由 PostgreSQL 回報
        assert.ok(/column .* does not exist/.test(r.e.message), r.e.message)
        assert.strictEqual((await rows()).length, 3) //表仍在, 資料不變
        assert.deepStrictEqual(evs, ['insert'])
    })
})


describe('write: save UPDATE path (autoInsert:false) uses bound parameters (W2)', function() {
    it('should store "$tag$" string literally and not as column reference', async function() {
        await reset()
        let r = await mk().save({ time: 1, name: '$tag$' }, { autoInsert: false })
        assert.strictEqual(r[0].nModified, 1)
        assert.strictEqual((await row(1)).name, '$tag$') //W2 字面值, 非 tag 欄之值 x
    })

    it('should store "$$" and "$" strings literally', async function() {
        await reset()
        await mk().save([{ time: 1, name: '$$' }, { time: 2, name: '$' }], { autoInsert: false })
        assert.strictEqual((await row(1)).name, '$$') //W2
        assert.strictEqual((await row(2)).name, '$')
    })

    let badKeys = [
        ['$inc', { time: 1, $inc: { n: 5 } }],
        ['$dec', { time: 1, $dec: { n: 5 } }],
        ['$custom', { time: 1, $custom: { name: '(select pw from tsecret)' } }],
        ['double quote', { 'time': 1, 'na"me': 'x' }],
        ['dot', { 'time': 1, 'twrite.name': 'x' }],
        ['space', { 'time': 1, 'na me': 'x' }],
        ['semicolon', { 'time': 1, 'name = \'x\'; delete from twrite; --': 'x' }],
        ['empty', { 'time': 1, '': 'x' }],
        ['JSON path', { 'time': 1, 'js->>k': 'x' }],
        ['cast', { 'time': 1, 'n::text': 'x' }],
        ['longer than 63 bytes', { time: 1, ['c'.repeat(64)]: 'x' }],
        //行為變更 3: 系統欄名(未限定引用時會解析為系統欄)整批 reject
        ['system column ctid', { time: 1, ctid: '(0,1)' }],
        ['system column tableoid', { time: 1, tableoid: 1 }],
        ['system column xmin', { time: 1, xmin: 1 }],
        ['system column xmax', { time: 1, xmax: 1 }],
        ['system column cmin', { time: 1, cmin: 1 }],
        ['system column cmax', { time: 1, cmax: 1 }],
    ]
    badKeys.forEach(([label, d]) => {
        it(`should reject whole batch and write nothing for data key ${label}`, async function() {
            await reset()
            let evs = []
            let wo = mk()
            wo.on('error', (mode) => evs.push(mode))
            //第一筆有效, 第二筆含非法鍵: 檢核須在任何寫入之前, 故第一筆亦不寫入
            let r = await settle(wo.save([{ time: 2, name: 'changed' }, d], { autoInsert: false }))
            assert.strictEqual(r.ok, false) //W2
            assert.ok(r.e instanceof Error && /invalid data\[1\]/.test(r.e.message), r.e && r.e.message) //S5
            assert.deepStrictEqual(await rows('time,name,n'), SEED.map((x) => ({ time: x.time, name: x.name, n: x.n })))
            assert.deepStrictEqual(evs, ['save']) //S5
        })
    })

    it('should write null, boolean, number, Date and object values by bound parameters', async function() {
        await reset()
        let d = new Date('2021-02-03T04:05:06.000Z')
        let r = await mk().save({ time: 1, name: null, ok: false, n: 99, value: 0.5, ts: d, js: { a: 1 } }, { autoInsert: false })
        assert.strictEqual(r[0].nModified, 1)
        let x = await row(1)
        assert.strictEqual(x.name, null)
        assert.strictEqual(x.ok, false)
        assert.strictEqual(x.n, 99)
        assert.strictEqual(x.value, 0.5)
        assert.strictEqual(x.ts.toISOString(), d.toISOString())
        assert.deepStrictEqual(x.js, { a: 1 })
    })

    it('should ignore undefined values like before and update only the other columns', async function() {
        await reset()
        let r = await mk().save({ time: 1, name: 'changed', n: undefined }, { autoInsert: false })
        assert.strictEqual(r[0].nModified, 1)
        let x = await row(1)
        assert.strictEqual(x.name, 'changed')
        assert.strictEqual(x.n, 10)
    })

    it('should get ok:0 with err for a record that has no column to update', async function() {
        await reset()
        let evs = []
        let wo = mk()
        wo.on('error', (mode) => evs.push(mode))
        let r = await wo.save({ time: 1, n: undefined }, { autoInsert: false })
        assert.strictEqual(r[0].ok, 0)
        assert.ok(/no column to update/.test(r[0].err), r[0].err)
        assert.deepStrictEqual(evs, ['save']) //逐筆失敗每筆發一次
    })

    it('should keep n/nModified semantics: changed, same content, nonexistent', async function() {
        await reset()
        let wo = mk()
        let a = await wo.save({ time: 1, name: 'changed' }, { autoInsert: false })
        assert.deepStrictEqual(a, [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }])
        let b = await wo.save({ time: 1, name: 'changed' }, { autoInsert: false })
        assert.deepStrictEqual(b, [{ n: 1, nInserted: 0, nModified: 0, ok: 1 }])
        let c = await wo.save({ time: 99, name: 'nobody' }, { autoInsert: false })
        assert.deepStrictEqual(c, [{ n: 0, nInserted: 0, nModified: 0, ok: 1 }])
        assert.strictEqual((await rows()).length, 3)
    })

    it('should report db errors per record (type mismatch) without throwing', async function() {
        await reset()
        let r = await mk().save([{ time: 1, n: 'not a number' }, { time: 2, name: 'changed' }], { autoInsert: false })
        assert.strictEqual(r[0].ok, 0)
        assert.ok(/invalid input syntax/.test(r[0].err), r[0].err)
        assert.strictEqual(r[1].nModified, 1)
    })
})


//S6(新版, 行為變更 1): 首尾皆 $ 之主鍵值為一般字面值(恆為綁定參數), insert/insertBulk/save/del/selectByPk 皆如一般主鍵運作,
//不具欄引用義, 故不得命中其他列(不得成為 "time" = "time" 而命中全部). 原 W3「$..$ 主鍵為無效主鍵」已廢止.
describe('write: pk values that start and end with "$" are ordinary literal values and never hit other rows (S6, was W3)', function() {
    //TEXT 主鍵表(主鍵名 time, 同預設 opt.pk): 若 '$time$' 被當欄引用則條件為 "time" = "time", 命中全部
    let CLS = 'twrite_tpk'
    let mks = () => mk({ cl: CLS })
    let rowsS = async () => (await admin.query(`SELECT time, name FROM ${CLS} ORDER BY time COLLATE "C"`)).rows.map((x) => [x.time, x.name])
    let resetS = async () => {
        await admin.query(`DROP TABLE IF EXISTS ${CLS}`)
        await admin.query(`CREATE TABLE ${CLS} (time TEXT PRIMARY KEY, name TEXT)`)
        await admin.query(`INSERT INTO ${CLS} VALUES ('a', 'A'), ('b', 'B'), ('c', 'C')`)
    }
    after(async function() {
        await admin.query(`DROP TABLE IF EXISTS ${CLS}`)
    })

    it('should insert and insertBulk rows whose pk is "$x$" literally (TEXT pk)', async function() {
        await resetS()
        let wo = mks()
        let a = await wo.insert({ time: '$x$', name: 'X' })
        let b = await wo.insertBulk([{ time: '$time$', name: 'T' }, { time: '$', name: 'D1' }, { time: '$$', name: 'D2' }])
        assert.deepStrictEqual(a, { n: 1, nInserted: 1, ok: 1 })
        assert.strictEqual(b.nInserted, 3)
        assert.deepStrictEqual(await rowsS(), [['$', 'D1'], ['$$', 'D2'], ['$time$', 'T'], ['$x$', 'X'], ['a', 'A'], ['b', 'B'], ['c', 'C']])
        let c = await wo.insert({ time: '$x$', name: 'X2' }) //已存在者跳過(與一般主鍵同)
        assert.strictEqual(c.nInserted, 0)
    })

    it('should get the row whose pk is literally "$time$" by selectByPk, and null when no such literal pk exists (not the first row of the table)', async function() {
        await resetS()
        let wo = mks()
        assert.strictEqual(await wo.selectByPk('$time$'), null) //S6 若當欄引用則回第一列
        assert.strictEqual(await wo.selectByPk('$name$'), null)
        await wo.insert({ time: '$time$', name: 'T' })
        assert.deepStrictEqual(await wo.selectByPk('$time$'), { time: '$time$', name: 'T' })
        assert.strictEqual((await wo.selectByPk('a')).name, 'A')
    })

    it('should delete only the row whose pk is literally "$time$" (del), and nothing when it does not exist', async function() {
        await resetS()
        let wo = mks()
        let d0 = await wo.del({ time: '$time$' })
        assert.deepStrictEqual(d0, [{ n: 0, nDeleted: 0, ok: 1 }]) //S6 未命中, 不得刪全表
        assert.deepStrictEqual(await rowsS(), [['a', 'A'], ['b', 'B'], ['c', 'C']])
        await wo.insert([{ time: '$time$', name: 'T' }, { time: '$name$', name: 'N' }])
        let d1 = await wo.del([{ time: '$time$' }, { time: '$' }])
        assert.deepStrictEqual(d1.map((x) => [x.ok, x.nDeleted]), [[1, 1], [1, 0]])
        assert.deepStrictEqual(await rowsS(), [['$name$', 'N'], ['a', 'A'], ['b', 'B'], ['c', 'C']]) //只刪字面主鍵之列
    })

    it('should save (autoInsert true and false) the row whose pk is literally "$x$" and leave the other rows unchanged', async function() {
        await resetS()
        let wo = mks()
        let s0 = await wo.save({ time: '$x$', name: 'q' }, { autoInsert: false })
        assert.deepStrictEqual(s0, [{ n: 0, nInserted: 0, nModified: 0, ok: 1 }]) //不存在, 不得更新他列
        let s1 = await wo.save({ time: '$x$', name: 'q' })
        assert.deepStrictEqual(s1, [{ n: 1, nInserted: 1, nModified: 0, ok: 1 }])
        let s2 = await wo.save({ time: '$x$', name: 'q2' }, { autoInsert: false })
        assert.deepStrictEqual(s2, [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }])
        let s3 = await wo.save({ time: '$x$', name: 'q3' })
        assert.deepStrictEqual(s3, [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }])
        assert.deepStrictEqual(await rowsS(), [['$x$', 'q3'], ['a', 'A'], ['b', 'B'], ['c', 'C']])
    })

    //INTEGER 主鍵表: '$x$' 為一般字面值, 與欄位型別不符由 PostgreSQL 回 22P02, 依各函數既有「型別不符」語意處置; 任一情形皆不得作用於任何列
    it('should treat "$time$" on an INTEGER pk like any other mistyped pk: selectByPk null, del ok:0 per record, nothing deleted', async function() {
        await reset()
        let evs = []
        let wo = mk()
        wo.on('error', (mode) => evs.push(mode))
        assert.strictEqual(await wo.selectByPk('$time$'), null) //selectByPk: 型別不符(22P02)視為主鍵無效而回 null, 不發 error
        assert.deepStrictEqual(evs, [])
        let r = await wo.del([{ time: '$time$' }, { time: '$' }, { time: 2 }])
        assert.deepStrictEqual(r.map((x) => [x.ok, x.nDeleted]), [[0, 0], [0, 0], [1, 1]]) //del: 逐筆 ok:0, 其餘筆照常
        assert.ok(/invalid input syntax for type integer/.test(r[0].err), r[0].err)
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 3]) //S6 未刪全表
    })

    it('should reject insert, insertBulk and save of "$x$" on an INTEGER pk with the PostgreSQL type error and write nothing', async function() {
        await reset()
        let evs = []
        let wo = mk()
        wo.on('error', (mode) => evs.push(mode))
        let a = await settle(wo.insert({ time: '$x$', name: 'a' }))
        let b = await settle(wo.insertBulk([{ time: 11, name: 'b' }, { time: '$x$', name: 'a' }]))
        let c = await settle(wo.save({ time: '$x$', name: 'c' }))
        let d = await settle(wo.save({ time: '$time$', name: 'd' }, { autoInsert: false }))
        for (let x of [a, b, c, d]) {
            assert.strictEqual(x.ok, false)
            assert.strictEqual(x.e && x.e.code, '22P02', String(x.e)) //PG 之型別錯誤, 非本套件之主鍵檢核錯誤
            assert.ok(!/invalid data\[/.test(x.e.message), x.e.message)
        }
        assert.deepStrictEqual(evs, ['insert', 'insertBulk', 'save', 'save'])
        assert.deepStrictEqual(await rows('time,name'), SEED.map((x) => ({ time: x.time, name: x.name }))) //insertBulk 之有效首筆亦回滾, save 未更新任何列
    })
})


describe('write: wrapper objects and decorated Dates are invalid pk values (W3)', function() {
    it('should treat Number, Boolean and String wrapper objects as invalid pk; nothing is deleted or selected', async function() {
        await reset()
        let wo = mk()
        let r = await wo.del([{ time: Object(5) }, { time: Object(true) }, { time: Object('a') }])
        assert.deepStrictEqual(r.map((x) => x.ok), [0, 0, 0]) //W3
        assert.strictEqual((await rows()).length, 3)
        assert.strictEqual(await wo.selectByPk(Object(1)), null)
        let s = await settle(wo.save({ time: Object(1), name: 'x' }, { autoInsert: false }))
        assert.strictEqual(s.ok, false)
        let i = await settle(wo.insert({ time: Object(1), name: 'x' }))
        assert.strictEqual(i.ok, false)
        assert.strictEqual((await rows()).length, 3)
    })

    it('should not let properties added to a Date pk reach the query (del keeps all rows)', async function() {
        await reset()
        let d = Object.assign(new Date(0), { 0: '$', length: 1, substring: () => 'time' })
        let r = await mk().del({ time: d })
        assert.strictEqual(r[0].nDeleted, 0) //W3 不得為 time = "time"
        assert.strictEqual((await rows()).length, 3)
        assert.strictEqual(await mk().selectByPk(d), null)
    })

    //裝飾過之 Date(自有方法覆寫、子類別): 各站點(where 用 cleanPk 重建、INSERT 送原值)會以不同方式解讀, 一律視為無效主鍵(W3)
    //以 TIMESTAMPTZ 主鍵表測試: 在 INTEGER 主鍵表上「判為無效」與「清理後當有效值查詢」兩種實作之結果相同, 無法區辨
    describe('on a TIMESTAMPTZ pk table', function() {
        let CLD = 'twrite_date'
        let mkd = () => mk({ cl: CLD })
        let rowsd = async () => (await admin.query(`SELECT to_char(time AT TIME ZONE 'UTC', 'YYYY') AS y, v FROM ${CLD} ORDER BY time`)).rows
        let resetd = async () => {
            await admin.query(`DROP TABLE IF EXISTS ${CLD}`)
            await admin.query(`CREATE TABLE ${CLD} (time TIMESTAMPTZ PRIMARY KEY, v TEXT)`)
            await admin.query(`INSERT INTO ${CLD} VALUES ('1970-01-01T00:00:00Z', 'A'), ('2099-01-01T00:00:00Z', 'B')`)
        }
        let decorated = [
            ['own getFullYear override', () => Object.assign(new Date(0), { getFullYear: () => 2099 })],
            ['own toISOString override', () => Object.assign(new Date(0), { toISOString: () => '2099-01-01T00:00:00.000Z' })],
            ['own enumerable property', () => Object.assign(new Date(0), { extra: 1 })],
            ['Date subclass instance', () => new (class MyDate extends Date {})(0)],
            //僅替換原型(constructor 仍為 Date)者, 寫入路徑之 cloneDeep 會重建為標準 Date(語意無歧義), 故不列入; selectByPk 則直接視為無效
        ]
        decorated.forEach(([label, mkDate]) => {
            it(`should treat a Date pk with ${label} as invalid in insert, save, selectByPk and del`, async function() {
                await resetd()
                let wo = mkd()
                let i = await settle(wo.insert({ time: mkDate(), v: 'new' }))
                let s = await settle(wo.save({ time: mkDate(), v: 'new' }))
                let s2 = await settle(wo.save({ time: mkDate(), v: 'new' }, { autoInsert: false }))
                assert.strictEqual(i.ok, false) //W3 整批性錯誤
                assert.strictEqual(s.ok, false)
                assert.strictEqual(s2.ok, false)
                assert.strictEqual(i.e.message, 'invalid id: unsupported primary key value at [data[0].time]') //固定詞彙, 不回顯值(R17)
                assert.strictEqual(await wo.selectByPk(mkDate()), null)
                let d = await wo.del({ time: mkDate() })
                assert.strictEqual(d[0].ok, 0)
                assert.deepStrictEqual(await rowsd(), [{ y: '1970', v: 'A' }, { y: '2099', v: 'B' }]) //資料不變
            })
        })
        it('should still accept a plain Date pk in insert, save, selectByPk and del', async function() {
            await resetd()
            let wo = mkd()
            await wo.insert({ time: new Date(Date.UTC(2000, 0, 1)), v: 'C' })
            assert.strictEqual((await wo.selectByPk(new Date(0))).v, 'A')
            let s = await wo.save({ time: new Date(0), v: 'A2' }, { autoInsert: false })
            assert.strictEqual(s[0].nModified, 1)
            let d = await wo.del({ time: new Date(Date.UTC(2099, 0, 1)) })
            assert.strictEqual(d[0].nDeleted, 1)
            assert.deepStrictEqual(await rowsd(), [{ y: '1970', v: 'A2' }, { y: '2000', v: 'C' }])
        })
    })

    //行為變更 8: 資料型汙染 Object.prototype 之查詢選項名(knex 內部以一般物件承載 limit 等)時, 各函數之結果須與無汙染時相同,
    //或以 invalid find: internal statement check failed (statement check) fail-closed reject; 絕不靜默送出被改寫之語句(不得兩者皆非)
    let pollutions = [
        ['limit', 1],
        ['offset', 1],
        ['columns', ['1']],
        ['expression', 'select 1; select 1; --'],
        ['$custom', ['true']],
        ['returning', ['name']],
        ['distinct', true],
        ['only', true],
        ['schema', 'tsecret'],
    ]
    pollutions.forEach(([k, v]) => {
        it(`should give the unpolluted result or fail closed with "statement check" when Object.prototype.${k} is polluted (selectByPk, select, del, delAll)`, async function() {
            await reset()
            let evs = []
            let wo = mk()
            wo.on('error', (mode) => evs.push(mode))
            let rs
            let sent
            Object.prototype[k] = v
            try {
                sent = await capture(async () => {
                    rs = [
                        await settle(wo.selectByPk(2)),
                        await settle(wo.select({ name: 'aa' })),
                        await settle(wo.del({ time: 3 })),
                        await settle(wo.delAll({ name: 'bb' })),
                    ]
                })
            }
            finally {
                delete Object.prototype[k]
            }
            //送出之語句(若有)須為無汙染時之語句本身: 結果恰好相同而語句已被改寫(如多了 limit)亦不允許
            let clean = [
                'select * from "twrite" as "$t" where "time" = $1',
                'select * from "twrite" as "$t" where "name" = $1',
                'delete from "twrite" as "$t" where "time" = $1',
                'delete from "twrite" as "$t" where "name" = $1',
            ]
            sent.forEach(([t]) => {
                assert.ok(clean.includes(t), t)
            })
            assert.strictEqual(sent.length, rs.filter((x) => x.ok).length) //fail-closed 者未送出任何語句
            let [a, b, c, d] = rs
            let fc = (x) => !x.ok && x.e instanceof Error && /^invalid find: internal statement check failed \(statement check\)/.test(x.e.message)
            assert.ok(fc(a) || (a.ok && jtext(a.v) === jtext({ time: 2, name: 'bb', n: 20, tag: 'y', value: 2.5, ok: null, ts: null, js: null, bin: null, arr: null })), `selectByPk ${String(a.e || jtext(a.v))}`)
            assert.ok(fc(b) || (b.ok && jtext(b.v.map((x) => [x.time, x.name])) === jtext([[1, 'aa']])), `select ${String(b.e || jtext(b.v))}`)
            assert.ok(fc(c) || (c.ok && jtext(c.v) === jtext([{ n: 1, nDeleted: 1, ok: 1 }])), `del ${String(c.e || jtext(c.v))}`)
            assert.ok(fc(d) || (d.ok && jtext(d.v) === jtext({ n: 1, nDeleted: 1, ok: 1 })), `delAll ${String(d.e || jtext(d.v))}`)
            //資料只因成功之 del(time 3)、delAll(name bb → time 2)而少列, 未刪其他列
            let want = [1, 2, 3].filter((t) => !(t === 3 && c.ok) && !(t === 2 && d.ok))
            assert.deepStrictEqual((await rows('time')).map((x) => x.time), want)
            assert.deepStrictEqual(evs, rs.map((x, i) => (x.ok ? null : ['selectByPk', 'select', 'del', 'delAll'][i])).filter((x) => x)) //每個 reject 發 1 次 error
            assert.strictEqual((await admin.query('SELECT count(*)::int AS n FROM tsecret')).rows[0].n, 1) //他表不受影響
        })
    })
})


describe('write: a record whose pk exists only on its prototype is a missing pk, rejected before any write (save, W8; was a per-record "no column to insert")', function() {
    it('should reject the whole save batch (nothing written) instead of failing only that record', async function() {
        await reset()
        let evs = []
        let wo = mk()
        wo.on('error', (mode) => evs.push(mode))
        let r = await settle(wo.save([{ time: 11, name: 'a' }, Object.create({ time: 12 }), { time: 13, name: 'c' }]))
        assert.strictEqual(r.ok, false) //W8 缺自有主鍵 = 缺主鍵: 整批 reject
        assert.ok(r.e instanceof Error && r.e.message === 'invalid id: primary key is missing at [data[1].time]', String(r.e))
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3]) //有效之第 0、2 筆亦不寫入
        assert.deepStrictEqual(evs, ['save']) //整批性錯誤發 1 次
    })
})


describe('write: data-only prototype pollution cannot add columns, fill missing values or hit the cache (W1, W2, S8)', function() {
    it('should update only own columns in save(autoInsert:false) when Object.prototype carries data keys', async function() {
        await reset()
        Object.prototype.tag = 'polluted' //既有欄: 不得成為 SET 欄位
        Object.prototype['x y'] = 1 //非識別字: 不得令整批 reject
        let r
        try {
            r = await mk().save({ time: 1, name: 'alice2' }, { autoInsert: false })
        }
        finally {
            delete Object.prototype.tag
            delete Object.prototype['x y']
        }
        assert.strictEqual(r[0].nModified, 1) //W2
        let x = await row(1)
        assert.strictEqual(x.name, 'alice2')
        assert.strictEqual(x.tag, 'x') //未被汙染值覆寫
    })

    it('should still judge a save with the same content as unchanged when Object.prototype carries a data key', async function() {
        await reset()
        Object.prototype.tag = 'polluted'
        let a
        let b
        try {
            a = await mk().save({ time: 1, name: 'aa' }) //autoInsert: 內容相同
            b = await mk().save({ time: 2, name: 'bb' }, { autoInsert: false })
        }
        finally {
            delete Object.prototype.tag
        }
        assert.strictEqual(a[0].nModified, 0) //預讀比對不含繼承鍵
        assert.strictEqual(b[0].nModified, 0)
        assert.strictEqual((await row(1)).tag, 'x')
        assert.strictEqual((await row(2)).tag, 'y')
    })

    it('should not fill a missing value of a bulk insert with a polluted Object.prototype value', async function() {
        await reset()
        Object.prototype.tag = 'polluted'
        try {
            let r = await mk().insertBulk([{ time: 31, name: 'a', tag: 't1' }, { time: 32, name: 'b' }])
            assert.strictEqual(r.nInserted, 2)
        }
        finally {
            delete Object.prototype.tag
        }
        assert.strictEqual((await row(31)).tag, 't1')
        assert.strictEqual((await row(32)).tag, null) //W1 DEFAULT, 非 polluted
    })

    it('should not take a polluted Object.prototype entry for a cache hit (useCache)', async function() {
        await reset()
        let wo = mk({ useCache: true })
        await wo.select({}) //令快取非空
        let key = cvKey(cvFind({ name: 'aa' }), cvOrder({}))
        Object.prototype[key] = [{ time: 99, name: 'fake' }]
        let a
        try {
            a = await wo.select({ name: 'aa' })
        }
        finally {
            delete Object.prototype[key]
        }
        assert.deepStrictEqual(a.map((x) => x.time), [1]) //S8 查 DB, 非偽造列
    })
})


describe('write: data keys are checked only when they are written (W2, compat)', function() {
    it('should ignore a non-identifier key whose value is undefined in save(autoInsert:false)', async function() {
        await reset()
        let r = await mk().save({ 'time': 1, 'name': 'q', 'a b': undefined, 'x"y': undefined }, { autoInsert: false })
        assert.strictEqual(r[0].nModified, 1)
        assert.strictEqual((await row(1)).name, 'q')
    })
})


describe('write: table names (pre-quoted, schema-qualified, and $nin with odd characters)', function() {
    let before2 = async () => {
        await admin.query('CREATE SCHEMA IF NOT EXISTS rvo')
        await admin.query('DROP TABLE IF EXISTS rvo.dot')
        await admin.query('DROP TABLE IF EXISTS "rvo.dot"')
        await admin.query('CREATE TABLE rvo.dot (time INTEGER PRIMARY KEY, v INTEGER)')
        await admin.query('CREATE TABLE "rvo.dot" (time INTEGER PRIMARY KEY, v INTEGER)')
        await admin.query('INSERT INTO "rvo.dot" VALUES (1, 10)')
    }

    it('should write to the table named by a pre-quoted name, not to a schema-qualified table', async function() {
        await before2()
        let wo = mk({ cl: '"rvo.dot"' })
        let r = await wo.insert({ time: 2, v: 20 })
        assert.strictEqual(r.nInserted, 1)
        assert.deepStrictEqual((await admin.query('SELECT time, v FROM "rvo.dot" ORDER BY time')).rows, [{ time: 1, v: 10 }, { time: 2, v: 20 }])
        assert.deepStrictEqual((await admin.query('SELECT time, v FROM rvo.dot')).rows, []) //另一關係未被寫入
        await admin.query('DROP TABLE "rvo.dot"')
        await admin.query('DROP TABLE rvo.dot')
    })

    it('should use a pre-quoted table name with a dot in select, selectByPk, save, del and delAll too (behavior change 6; was a syntax error)', async function() {
        await before2()
        await admin.query('INSERT INTO "rvo.dot" VALUES (2, 20), (3, 30)')
        let wo = mk({ cl: '"rvo.dot"' })
        assert.deepStrictEqual((await wo.select({ v: { $gte: 20 } })).map((x) => x.time), [2, 3])
        assert.deepStrictEqual(await wo.selectByPk(1), { time: 1, v: 10 })
        assert.deepStrictEqual(await wo.save({ time: 1, v: 11 }), [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }]) //預讀 + UPSERT
        assert.deepStrictEqual(await wo.save({ time: 2, v: 21 }, { autoInsert: false }), [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }]) //預讀 + UPDATE
        assert.deepStrictEqual(await wo.del({ time: 3 }), [{ n: 1, nDeleted: 1, ok: 1 }])
        assert.deepStrictEqual((await admin.query('SELECT time, v FROM "rvo.dot" ORDER BY time')).rows, [{ time: 1, v: 11 }, { time: 2, v: 21 }])
        assert.deepStrictEqual(await wo.delAll({ v: 21 }), { n: 1, nDeleted: 1, ok: 1 })
        assert.deepStrictEqual((await admin.query('SELECT time, v FROM "rvo.dot" ORDER BY time')).rows, [{ time: 1, v: 11 }])
        assert.deepStrictEqual((await admin.query('SELECT time, v FROM rvo.dot')).rows, []) //schema 限定之同名表未被讀寫
        await admin.query('DROP TABLE "rvo.dot"')
        await admin.query('DROP TABLE rvo.dot')
    })

    it('should write to schema-qualified table "rvo.dot" when the name is not pre-quoted', async function() {
        await before2()
        let wo = mk({ cl: 'rvo.dot' })
        let r = await wo.insert({ time: 5, v: 50 })
        assert.strictEqual(r.nInserted, 1)
        assert.deepStrictEqual((await admin.query('SELECT time, v FROM rvo.dot')).rows, [{ time: 5, v: 50 }])
        assert.deepStrictEqual((await admin.query('SELECT time, v FROM "rvo.dot"')).rows, [{ time: 1, v: 10 }])
        await admin.query('DROP TABLE "rvo.dot"')
        await admin.query('DROP TABLE rvo.dot')
    })

    //行為變更 1: $nin 之表名守門(ninOk、opt.nin)已移除; 表名含 | $ ? 等字元時 $nin 照常可用, 且 select 命中者即 delAll 刪除者(S1)
    let oddNames = ['rvo|p', 'rvo$p', 'rvo?p']
    oddNames.forEach((name) => {
        it(`should support $nin (and $in) on table ${JSON.stringify(name)}: select hits exactly the rows that delAll deletes`, async function() {
            await admin.query(`DROP TABLE IF EXISTS "${name}"`)
            await admin.query(`CREATE TABLE "${name}" (time INTEGER PRIMARY KEY, c INTEGER)`)
            await admin.query(`INSERT INTO "${name}" VALUES (1, 1), (2, 2), (3, 3)`)
            let wo = mk({ cl: name })
            let evs = []
            wo.on('error', (mode) => evs.push(mode))
            assert.deepStrictEqual((await wo.select({ c: { $nin: [1] } })).map((x) => x.time), [2, 3]) //$nin 為 not in, 非 in
            assert.deepStrictEqual((await wo.select({ c: { $in: [2] } })).map((x) => x.time), [2])
            assert.deepStrictEqual(await wo.delAll({ c: { $nin: [1, 3] } }), { n: 1, nDeleted: 1, ok: 1 })
            assert.deepStrictEqual((await admin.query(`SELECT time FROM "${name}" ORDER BY time`)).rows.map((x) => x.time), [1, 3])
            assert.deepStrictEqual(evs, [])
            await admin.query(`DROP TABLE "${name}"`)
        })
    })
})


describe('write: del with a pk that cannot be turned into text keeps the per-record result (S5, compat)', function() {
    it('should report ok:0 for a Symbol pk and still delete the other records', async function() {
        await reset()
        let evs = []
        let wo = mk()
        wo.on('error', (mode) => evs.push(mode))
        let r = await wo.del([{ time: 1 }, { time: Symbol('x') }, { time: 2 }])
        assert.deepStrictEqual(r.map((x) => x.ok), [1, 0, 1]) //逐筆, 非整批拋錯而部分刪除
        assert.strictEqual(r[1].err, 'invalid id: unsupported primary key value at [data[1].time]') //固定詞彙, 不回顯 Symbol(x)(R17)
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [3])
        assert.deepStrictEqual(evs, ['del'])
    })

    it('should reject whole batch with a fixed message (the Symbol is not echoed) for a Symbol pk in insert', async function() {
        await reset()
        let r = await settle(mk().insert({ time: Symbol('y'), name: 'a' }))
        assert.strictEqual(r.ok, false)
        assert.strictEqual(r.e.message, 'invalid id: unsupported primary key value at [data[0].time]')
        assert.strictEqual((await rows()).length, 3)
    })
})


describe('write: pk strings that change on the wire are invalid pk values (W3)', function() {
    let CLP = 'twrite_pkt'
    let mkp = () => mk({ cl: CLP, pk: 'id' })
    let resetp = async () => {
        await admin.query(`DROP TABLE IF EXISTS ${CLP}`)
        await admin.query(`CREATE TABLE ${CLP} (id TEXT PRIMARY KEY, name TEXT)`)
        await admin.query(`INSERT INTO ${CLP} VALUES ($1, 'replacement_char_row'), ('ok', 'ok_row')`, ['�'])
    }
    it('should not delete the U+FFFD row when the pk is a lone surrogate (UTF-8 turns it into U+FFFD)', async function() {
        await resetp()
        let r = await mkp().del({ id: '\ud800' })
        assert.strictEqual(r[0].ok, 0)
        assert.strictEqual(r[0].nDeleted, 0)
        assert.strictEqual((await admin.query(`SELECT count(*)::int AS c FROM ${CLP}`)).rows[0].c, 2)
    })
    it('should treat NUL and lone surrogate pk as invalid in selectByPk, insert and save', async function() {
        await resetp()
        let wo = mkp()
        assert.strictEqual(await wo.selectByPk('a\u0000b'), null) //原為伺服器 invalid byte sequence 之 reject
        assert.strictEqual(await wo.selectByPk('\ud800'), null)
        let i = await settle(wo.insert({ id: 'a\u0000b', name: 'x' }))
        let s = await settle(wo.save({ id: '\ud800', name: 'x' }))
        assert.strictEqual(i.ok, false)
        assert.strictEqual(i.e.message, 'invalid id: string contains NUL at [data[0].id]')
        assert.strictEqual(s.ok, true) //第 66 項(D5): 孤立代理主鍵之 save 由整批 reject 改為逐筆 ok:0
        assert.deepStrictEqual([s.v.length, s.v[0].ok, s.v[0].err], [1, 0, 'invalid id: string contains lone surrogate at [data[0].id]'])
        assert.strictEqual((await admin.query(`SELECT count(*)::int AS c FROM ${CLP}`)).rows[0].c, 2)
    })
    it('should treat an invalid Date as an invalid pk', async function() {
        await resetp()
        let CLD = 'twrite_date2'
        await admin.query(`DROP TABLE IF EXISTS ${CLD}`)
        await admin.query(`CREATE TABLE ${CLD} (time TIMESTAMPTZ PRIMARY KEY, v TEXT)`)
        let wo = mk({ cl: CLD })
        assert.strictEqual(await wo.selectByPk(new Date(NaN)), null)
        let i = await settle(wo.insert({ time: new Date(NaN), v: 'x' }))
        assert.strictEqual(i.ok, false)
        assert.strictEqual(i.e.message, 'invalid id: unsupported primary key value at [data[0].time]')
        await admin.query(`DROP TABLE ${CLD}`)
    })
})


describe('write: statements use a null-prototype extended-protocol query config (no stacked statements, no polluted pg options)', function() {
    it('should neither stack a second statement nor change the condition when Object.prototype carries 0 / NaN / substring (delAll, select, del)', async function() {
        await reset()
        let wo = mk()
        //原(mongo-sql)之 parameterize 讀純量值之 value[0]、value[NaN]、value.substring: 原型被塞入函數(需程式碼執行權)時可產出無綁定參數且帶第二語句之 SQL,
        //當時僅靠 pgq 之 extended 協定由伺服器拒絕多語句(故斷言 reject). 換 knex 後值一律為綁定參數、不再讀這些屬性:
        //斷言改為「條件仍為 n = 10 之綁定參數, 結果正確, 且無第二語句被執行」(pgq 之 extended 協定縱深另由下方 stub 案斷言)
        let def = (k, v) => Object.defineProperty(Object.prototype, k, { value: v, configurable: true, writable: true })
        let a
        let b
        let c
        try {
            def('0', '$')
            def('NaN', '$')
            def('substring', () => `"${CL}"."n"; CREATE TABLE vt_pwned(x int); -- ".*`)
            a = await settle(wo.select({ n: 20 }))
            b = await settle(wo.delAll({ n: 10 }))
            c = await settle(wo.del({ time: 3 }))
        }
        finally {
            delete Object.prototype['0']
            delete Object.prototype.NaN
            delete Object.prototype.substring
        }
        assert.ok(a.ok, String(a.e))
        assert.deepStrictEqual(a.v.map((x) => x.time), [2]) //條件未被改為 n = n(全部)
        assert.deepStrictEqual(b, { ok: true, v: { n: 1, nDeleted: 1, ok: 1 } }) //只刪 n = 10 之列
        assert.deepStrictEqual(c, { ok: true, v: [{ n: 1, nDeleted: 1, ok: 1 }] })
        assert.strictEqual((await admin.query('SELECT to_regclass(\'vt_pwned\') AS t')).rows[0].t, null) //第二語句未執行
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [2])
    })

    it('should refuse a second statement in a single query config (extended protocol), even without bound parameters', async function() {
        //pgq 之縱深: 以本套件送出之設定物件形式(queryMode extended)直接送多語句, 由伺服器拒絕
        await reset()
        let seen = []
        let orig = pg.Client.prototype.query
        pg.Client.prototype.query = function(cfg, ...rest) {
            if (typeof cfg !== 'string' && /^delete from/.test(cfg.text)) {
                seen.push(cfg)
                cfg.text = `${cfg.text.replace(/where .*$/, 'where false')}; CREATE TABLE vt_pwned(x int)` //模擬語句被置入片段
                cfg.values = []
            }
            return orig.call(this, cfg, ...rest)
        }
        let r
        try {
            r = await settle(mk().delAll({ n: 10 }))
        }
        finally {
            pg.Client.prototype.query = orig
        }
        assert.strictEqual(seen.length, 1)
        assert.strictEqual(r.ok, false)
        assert.ok(/cannot insert multiple commands into a prepared statement/.test(String(r.e)), String(r.e))
        assert.strictEqual((await admin.query('SELECT to_regclass(\'vt_pwned\') AS t')).rows[0].t, null)
        assert.strictEqual((await rows()).length, 3)
    })

    it('should not be affected by a polluted Object.prototype.rowMode / name of the pg query config', async function() {
        await reset()
        Object.prototype.rowMode = 'array'
        let a
        try {
            a = await mk().select({ time: 1 })
        }
        finally {
            delete Object.prototype.rowMode
        }
        assert.strictEqual(a[0].name, 'aa') //列仍為物件
        let b
        Object.prototype.name = 'stmt'
        try {
            b = await settle(mk().save([{ time: 21, name: 'n1' }, { time: 22, name: 'n2' }]))
        }
        finally {
            delete Object.prototype.name
        }
        assert.strictEqual(b.ok, true) //pg 設定物件之 name 不得被汙染(否則兩筆同名 prepared statement 衝突)
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3, 21, 22])
    })

    //R8(第162項): 交易控制語句BEGIN、COMMIT、ROLLBACK原為字串(pg內部以一般物件包成設定, 繼承被汙染之Object.prototype), 現亦經pgq
    for (let [label, props] of [
        ['name (short)', { name: 'stmt' }],
        ['name (> 63 chars: the backend would truncate it and pg-protocol prints a warning to stderr)', { name: 'n'.repeat(80) }],
        ['rowMode', { rowMode: 'array' }],
        ['queryMode (simple)', { queryMode: 'simple' }],
    ]) {
        it(`should run the transaction statements of insert and insertBulk (BEGIN, COMMIT, ROLLBACK) unaffected by a polluted Object.prototype.${label}`, async function() {
            await reset()
            for (let [k, v] of Object.entries(props)) {
                Object.prototype[k] = v
            }
            let ok1
            let ok2
            let ng1
            let ng2
            let errs = []
            let origErr = console.error
            console.error = (...a) => errs.push(a.map(String).join(' '))
            try {
                ok1 = await settle(mk().insert({ time: 31, name: 'p1' })) //BEGIN、INSERT、COMMIT
                ok2 = await settle(mk().insertBulk([{ time: 32, name: 'p2' }, { time: 33, name: 'p3' }]))
                ng1 = await settle(mk().insert([{ time: 34, name: 'p4' }, { time: 99999999999, name: 'big' }])) //第2筆超出INTEGER範圍: INSERT失敗 -> ROLLBACK
                ng2 = await settle(mk().insertBulk([{ time: 35, name: 'p5' }, { time: 1, name: 'dup' }])) //撞主鍵: INSERT失敗 -> ROLLBACK
            }
            finally {
                console.error = origErr
                for (let k of Object.keys(props)) {
                    delete Object.prototype[k]
                }
            }
            assert.ok(ok1.ok && ok1.v.nInserted === 1, jtext(ok1))
            assert.ok(ok2.ok && ok2.v.nInserted === 2, jtext(ok2))
            assert.ok(!ng1.ok && !ng2.ok, '失敗路徑應reject(而非因語句被汙染而於他處失敗後被誤判): ' + jtext([ng1, ng2]))
            assert.ok(/out of range|integer/i.test(ng1.e.message), ng1.e.message)
            assert.ok(/duplicate key|unique/i.test(ng2.e.message), ng2.e.message)
            assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3, 31, 32, 33]) //失敗之兩次皆整批回滾
            assert.deepStrictEqual(errs, [], 'pg不得因汙染之name而輸出警告')
        })
    }
})


describe('write: exceptions thrown by caller data while it is copied are reported with one error event (S5)', function() {
    let bad = (extra = {}) => {
        let o = { time: 1, ...extra }
        Object.defineProperty(o, 'name', {
            enumerable: true,
            get() {
                throw new Error('getter boom')
            }
        })
        return o
    }
    let calls = [
        ['insert', (wo) => wo.insert(bad())],
        ['insertBulk', (wo) => wo.insertBulk([bad()])],
        ['save', (wo) => wo.save(bad())],
        ['del', (wo) => wo.del(bad())],
    ]
    calls.forEach(([mode, fn]) => {
        it(`should reject ${mode} with that Error, emit one error event and write nothing`, async function() {
            await reset()
            let evs = []
            let wo = mk()
            wo.on('error', (m) => evs.push(m))
            let r = await settle(fn(wo))
            assert.strictEqual(r.ok, false)
            assert.ok(r.e instanceof Error && /getter boom/.test(r.e.message), String(r.e))
            assert.deepStrictEqual(evs, [mode])
            assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3])
        })
    })
})


describe('write: more input shapes found by review round 3 (opus)', function() {
    it('should treat a Date pk with an own throwing valueOf / Symbol.toPrimitive as invalid pk (null) without running the caller function', async function() {
        await reset()
        let calls = 0
        let d1 = new Date(0)
        d1.valueOf = () => {
            calls++
            throw new Error('caller valueOf')
        }
        let d2 = new Date(0)
        Object.defineProperty(d2, Symbol.toPrimitive, {
            value: () => {
                calls++
                throw new Error('caller toPrimitive')
            }
        })
        let evs = []
        let wo = mk()
        wo.on('error', (m) => evs.push(m))
        assert.strictEqual(await wo.selectByPk(d1), null)
        assert.strictEqual(await wo.selectByPk(d2), null)
        assert.strictEqual(calls, 0)
        assert.deepStrictEqual(evs, [])
    })

    it('should send every statement that carries caller values or names with a null-prototype config in extended mode (all 9 sites, R8)', async function() {
        await reset()
        await admin.query('DROP TABLE IF EXISTS tt3_stub')
        let seen = []
        let orig = pg.Client.prototype.query
        pg.Client.prototype.query = function(cfg, ...rest) {
            seen.push(cfg)
            return orig.call(this, cfg, ...rest)
        }
        try {
            let wo = mk()
            await wo.createTable('tt3_stub', 'time', { time: 1 }) //createTable(DDL)
            await wo.select({ name: 'aa' }) //select
            await wo.selectByPk(1) //selectByPk
            await wo.insert({ time: 41, name: 'i' }) //insertBatches
            await wo.insertBulk([{ time: 42, name: 'ib' }]) //insertBatches
            await wo.save({ time: 43, name: 's' }) //save 預讀 + UPSERT
            await wo.save({ time: 1, name: 'u' }, { autoInsert: false }) //save 預讀 + UPDATE
            await wo.del({ time: 41 }) //del
            await wo.delAll({ name: 'zz' }) //delAll
        }
        finally {
            pg.Client.prototype.query = orig
            await admin.query('DROP TABLE IF EXISTS tt3_stub')
        }
        let cfgs = seen.filter((c) => typeof c !== 'string')
        let strs = seen.filter((c) => typeof c === 'string')
        assert.deepStrictEqual(strs, [], JSON.stringify(strs)) //無字串形式之語句: 交易控制語句BEGIN、COMMIT亦為設定物件(第162項)
        assert.strictEqual(cfgs.filter((c) => c.text === 'BEGIN').length, 2) //insert、insertBulk各一
        assert.strictEqual(cfgs.filter((c) => c.text === 'COMMIT').length, 2)
        assert.ok(cfgs.length >= 14, `statements=${cfgs.length}`)
        assert.ok(cfgs.some((c) => /^CREATE TABLE "tt3_stub"/.test(c.text)), JSON.stringify(cfgs.map((c) => c.text))) //DDL 亦為設定物件形式
        cfgs.forEach((c) => {
            assert.strictEqual(Object.getPrototypeOf(c), null)
            assert.strictEqual(c.queryMode, 'extended')
            assert.strictEqual(typeof c.text, 'string')
        })
    })
})


describe('write: pk and find conditions are sent with unqualified column names and the table alias "$t" (selectByPk, save, del, delAll)', function() {
    //欄位不加表限定("t"."c" 時 PG 會把不存在之欄以函數記法 c(t) 解析, 第 76 項), 表一律以別名 "$t" 引用; UPDATE 之欄名以 quoteKey 引用
    it('should send the hand-written statements for selectByPk, save (pre-read, UPDATE, UPSERT), del and delAll', async function() {
        await reset()
        let wo = mk()
        let seen = await capture(async () => {
            await wo.selectByPk(2)
            await wo.save({ time: 1, name: 'u' }, { autoInsert: false })
            await wo.save({ time: 2, name: 'v' })
            await wo.del({ time: 3 })
            await wo.delAll({ name: 'zz' })
            await wo.delAll({ n: { $gte: 10 }, $or: [{ tag: 'x' }, { tag: { $ne: 'y' } }] })
        })
        assert.deepStrictEqual(seen, [
            ['select * from "twrite" as "$t" where "time" = $1', [2]],
            ['select * from "twrite" as "$t" where "time" = $1', [1]], //save 預讀
            ['update "twrite" set "name" = $1 where "time" = $2', ['u', 1]],
            ['select * from "twrite" as "$t" where "time" = $1', [2]],
            ['insert into "twrite" ("time", "name") values ($1, $2) ON CONFLICT ("time") DO UPDATE SET "name" = EXCLUDED."name" RETURNING (xmax = 0) AS inserted', [2, 'v']],
            ['delete from "twrite" as "$t" where "time" = $1', [3]],
            ['delete from "twrite" as "$t" where "name" = $1', ['zz']],
            ['delete from "twrite" as "$t" where "n" >= $1 and ("tag" = $2 or "tag" != $3)', [10, 'x', 'y']], //根層 and 不加括號, or 加括號
        ])
        seen.forEach(([t]) => {
            assert.ok(!t.includes('"twrite".'), t) //無表限定欄
        })
        //time 3 被 del; 末句 n>=10 且(tag='x' 或 tag!='y'): time 1(x)命中, time 2(y)兩支皆假而保留
        assert.deepStrictEqual((await rows('time,name')).map((x) => [x.time, x.name]), [[2, 'v']])
    })

    it('should bind a "$x$" pk as the string parameter $1 (del, selectByPk, save pre-read), not as a column reference', async function() {
        let CLS = 'twrite_tpk2'
        await admin.query(`DROP TABLE IF EXISTS ${CLS}`)
        await admin.query(`CREATE TABLE ${CLS} (time TEXT PRIMARY KEY, name TEXT)`)
        await admin.query(`INSERT INTO ${CLS} VALUES ('$x$', 'X'), ('a', 'A')`)
        let wo = mk({ cl: CLS })
        let seen = await capture(async () => {
            await wo.selectByPk('$time$')
            await wo.save({ time: '$time$', name: 'T' }, { autoInsert: false })
            await wo.del({ time: '$x$' })
        })
        assert.deepStrictEqual(seen, [
            [`select * from "${CLS}" as "$t" where "time" = $1`, ['$time$']],
            [`select * from "${CLS}" as "$t" where "time" = $1`, ['$time$']], //save 預讀(不存在而不 UPDATE)
            [`delete from "${CLS}" as "$t" where "time" = $1`, ['$x$']],
        ])
        assert.strictEqual(typeof seen[2][1][0], 'string')
        assert.deepStrictEqual((await admin.query(`SELECT time FROM ${CLS}`)).rows, [{ time: 'a' }]) //只刪字面主鍵 $x$ 之列
        await admin.query(`DROP TABLE ${CLS}`)
    })
})


//以下為原 T3(DDL、ON CONFLICT、RETURNING 之名稱內插)與「主鍵可來自原型」, run03 納入規則 R9、R10(規格句 W4–W8)

//cleanT3, 清掉本區塊建的表(createTable 以 tt3 開頭; vo_pwned* 為堆疊語句之偵測表)
let cleanT3 = async () => {
    let r = await admin.query('SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = \'r\' AND n.nspname IN (\'public\', \'rvo\') AND (c.relname ILIKE \'tt3%\' OR c.relname ILIKE \'vo_pwned%\')')
    for (let x of r.rows) {
        await admin.query(`DROP TABLE IF EXISTS "${x.nspname}"."${x.relname}"`)
    }
}
//rel, 以關係名(逐字)計數, 不經識別字折疊
let rel = async (name) => (await admin.query('SELECT count(*)::int AS n FROM pg_class WHERE relname = $1', [name])).rows[0].n
//colsOf, 表之欄名(依序)
let colsOf = async (name) => (await admin.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position', [name])).rows.map((x) => x.column_name)


describe('write: createTable checks and quotes every name it puts into the DDL and cannot stack statements (R9, W4)', function() {
    beforeEach(cleanT3)
    after(cleanT3)

    it('should reject a data key that stacks a second statement: nothing is created, one error event, the message does not echo the key (W4)', async function() {
        let evs = []
        let wo = mk()
        wo.on('error', (m) => evs.push(m))
        let r = await settle(wo.createTable('tt3_stack', 'time', { 'time': 1, 'x int) ; CREATE TABLE vo_pwned(a': {} }))
        assert.strictEqual(r.ok, false)
        assert.ok(r.e instanceof Error && /^invalid createTable: /.test(r.e.message), String(r.e))
        assert.ok(!r.e.message.includes('vo_pwned'), r.e.message)
        assert.deepStrictEqual(evs, ['createTable'])
        assert.strictEqual(await rel('tt3_stack'), 0)
        assert.strictEqual(await rel('vo_pwned'), 0) //第二語句未執行
    })

    //系統欄名(行為變更 3)由本套件於送出前拒收(Error, invalid createTable), 非由 PG 回報(PG 回報者為字串 reject: column name conflicts with a system column name)
    let badKeys = ['zq xw', 'zq"xw', 'zq;xw', 'zq.xw', 'zq-xw', 'zq$xw', 'zq\'xw', '1zqxw', 'zq) ; CREATE TABLE vo_pwned(a', `zq${'x'.repeat(70)}`, 'zq\u0000xw', 'zq\ud800xw', '', '__proto__', 'ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax']
    it('should reject data keys that are not plain identifiers (space, quote, ;, ., -, $, digit first, NUL, lone surrogate, empty, __proto__, over 63 bytes, system column names) before sending any statement (W4)', async function() {
        let evs = []
        let wo = mk()
        wo.on('error', (m) => evs.push(m))
        for (let k of badKeys) {
            let sample = { time: 1 }
            Object.defineProperty(sample, k, { value: 'x', enumerable: true, writable: true, configurable: true })
            let r = await settle(wo.createTable('tt3_bad', 'time', sample))
            assert.strictEqual(r.ok, false, JSON.stringify(k))
            assert.ok(r.e instanceof Error && /^invalid createTable: /.test(r.e.message), `${JSON.stringify(k)} ${String(r.e)}`)
            if (k !== '') {
                assert.ok(!r.e.message.includes(k), 'message must not echo the key')
            }
            assert.strictEqual(await rel('tt3_bad'), 0, JSON.stringify(k))
        }
        assert.strictEqual(await rel('vo_pwned'), 0)
        assert.strictEqual(evs.length, badKeys.length) //每次整批 reject 各發 1 次 error
    })

    it('should reject a pk name that is not a plain identifier, whether or not the sample has such a key (W4)', async function() {
        let wo = mk()
        for (let pk of ['time; drop table tt3_victim', 'a"b', 'a b', 'x.y', '1abc', 'p'.repeat(64), 'xmin', 'ctid']) {
            let sample = { time: 1 }
            sample[pk] = 'x'
            let r1 = await settle(wo.createTable('tt3_pk', pk, { time: 1 }))
            let r2 = await settle(wo.createTable('tt3_pk', pk, sample))
            for (let r of [r1, r2]) {
                assert.strictEqual(r.ok, false, JSON.stringify(pk))
                assert.ok(r.e instanceof Error && /^invalid createTable: /.test(r.e.message), `${JSON.stringify(pk)} ${String(r.e)}`)
            }
            assert.strictEqual(await rel('tt3_pk'), 0, JSON.stringify(pk))
        }
    })

    it('should reject table names that are neither plain nor fully quoted identifiers (incl. DDL fragments such as IF NOT EXISTS), and non-string table names (W4)', async function() {
        let evs = []
        let wo = mk()
        wo.on('error', (m) => evs.push(m))
        let bads = ['tt3_t"; CREATE TABLE vo_pwned(a int); --', 'tt3_t" (a int); --', 'tt3_t->1; CREATE TABLE vo_pwned(a int); --', 'tt3_t::int', 'tt3_t.*', 'tt3_t..x', '', 'tt3\u0000t', null, undefined, 123, {}, 'IF NOT EXISTS tt3_ine', 'TEMP tt3_tmp', 'tt3 sp;ace', 'tt3-x', 'tt3_t (a int)']
        for (let name of bads) {
            let r = await settle(wo.createTable(name, 'time', { time: 1 }))
            assert.strictEqual(r.ok, false, String(name))
            assert.ok(r.e instanceof Error && /^invalid createTable: /.test(r.e.message), `${String(name)} ${String(r.e)}`)
        }
        assert.strictEqual(evs.length, bads.length)
        assert.strictEqual(await rel('vo_pwned'), 0)
        assert.strictEqual((await admin.query('SELECT count(*)::int AS n FROM pg_class WHERE relname ILIKE \'tt3%\'')).rows[0].n, 0)
    })

    it('should create plain, schema-qualified, pre-quoted, capitalised and $-containing table names exactly as they are written (quoted like the other paths, B23)', async function() {
        await admin.query('CREATE SCHEMA IF NOT EXISTS rvo')
        let wo = mk()
        for (let name of ['tt3_plain', 'rvo.tt3_schema', '"Tt3_Q"', 'Tt3_Case', 'tt3$d']) {
            assert.deepStrictEqual(await wo.createTable(name, 'time', { time: 1 }), { ok: 1 }, name)
        }
        assert.strictEqual(await rel('tt3_plain'), 1)
        assert.strictEqual((await admin.query('SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = \'rvo\' AND c.relname = \'tt3_schema\'')).rows[0].n, 1)
        assert.strictEqual(await rel('Tt3_Q'), 1)
        assert.strictEqual(await rel('Tt3_Case'), 1) //原折為 tt3_case
        assert.strictEqual(await rel('tt3_case'), 0)
        assert.strictEqual(await rel('tt3$d'), 1)
        //其餘路徑以同法引用: 寫得進、讀得到 createTable 建的表(一般名稱、大寫、含 $、schema.table)
        for (let cl of ['Tt3_Case', 'tt3$d', 'rvo.tt3_schema', 'tt3_plain']) {
            let w = mk({ cl })
            assert.strictEqual((await w.insert({ time: 1 })).nInserted, 1, cl)
            assert.strictEqual((await w.save({ time: 1 }))[0].n, 1, cl)
            assert.strictEqual((await w.selectByPk(1)).time, 1, cl)
            assert.deepStrictEqual((await w.select({ time: 1 })).map((x) => x.time), [1], cl)
            assert.strictEqual((await w.del({ time: 1 }))[0].nDeleted, 1, cl)
        }
        //完整雙引號名稱: 行為變更 6 起所有函數皆可用(欄名不加表限定, 原 mongo-sql 之 ""Tt3_Q""."time" 語法錯誤不再發生)
        let wq = mk({ cl: '"Tt3_Q"' })
        assert.strictEqual((await wq.insert({ time: 1 })).nInserted, 1)
        assert.strictEqual((await wq.save({ time: 2 }))[0].nInserted, 1)
        assert.strictEqual((await wq.selectByPk(1)).time, 1)
        assert.deepStrictEqual((await wq.select({ time: { $gte: 1 } })).map((x) => x.time), [1, 2])
        assert.strictEqual((await wq.del({ time: 1 }))[0].nDeleted, 1)
        assert.strictEqual((await admin.query('SELECT count(*)::int AS n FROM "Tt3_Q"')).rows[0].n, 1)
        assert.strictEqual((await wq.delAll({})).nDeleted, 1)
        assert.strictEqual((await admin.query('SELECT count(*)::int AS n FROM "Tt3_Q"')).rows[0].n, 0)
    })

    it('should create and use a column and a pk named Infinity (behavior change 2: Infinity is an ordinary identifier)', async function() {
        //原限制源自 mongo-sql 以 +key>=0 判陣列索引; 換 knex 後 Infinity 為一般識別字
        assert.deepStrictEqual(await mk().createTable('tt3_inf', 'Infinity', { Infinity: 1, v: 'x' }), { ok: 1 })
        assert.deepStrictEqual(await colsOf('tt3_inf'), ['Infinity', 'v'])
        let wo = mk({ cl: 'tt3_inf', pk: 'Infinity' })
        assert.strictEqual((await wo.insert([{ Infinity: 1, v: 'a' }, { Infinity: 2, v: 'b' }])).nInserted, 2)
        assert.deepStrictEqual(await wo.save({ Infinity: 1, v: 'a2' }, { autoInsert: false }), [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }])
        assert.deepStrictEqual(await wo.selectByPk(1), { Infinity: 1, v: 'a2' })
        assert.deepStrictEqual((await wo.select({ Infinity: { $gt: 1 } })).map((x) => x.v), ['b'])
        assert.deepStrictEqual(await wo.del({ Infinity: 2 }), [{ n: 1, nDeleted: 1, ok: 1 }])
        assert.deepStrictEqual((await admin.query('SELECT "Infinity", v FROM tt3_inf')).rows, [{ Infinity: 1, v: 'a2' }])
        //資料鍵 Infinity 於其他表為合法鍵(通過檢核), 欄是否存在由 PG 回報(逐筆 ok:0, 非整批之 invalid data)
        await reset()
        let r = await mk().save({ time: 1, Infinity: 5 }, { autoInsert: false })
        assert.strictEqual(r[0].ok, 0)
        assert.ok(/does not exist/.test(r[0].err), r[0].err)
    })

    it('should reject a sample object that has only inherited enumerable keys (it would create a table without columns)', async function() {
        let evs = []
        let wo = mk()
        wo.on('error', (m) => evs.push(m))
        let r = await settle(wo.createTable('tt3_zero', 'time', Object.create({ time: 1 })))
        assert.strictEqual(r.ok, false)
        assert.ok(r.e instanceof Error && /not an effective object/.test(r.e.message), String(r.e))
        assert.deepStrictEqual(evs, ['createTable'])
        assert.strictEqual(await rel('tt3_zero'), 0) //原:建出零欄表
    })

    it('should create case-preserving columns and a case-preserving pk that insert, save, select, selectByPk and del use as they are (ON CONFLICT and RETURNING quoted, B23)', async function() {
        let sample = { Id: 1, userName: 'x', N2: 1.5, snake_case: true }
        assert.deepStrictEqual(await mk({ pk: 'Id' }).createTable('tt3_case', null, sample), { ok: 1 })
        assert.deepStrictEqual(await colsOf('tt3_case'), ['Id', 'userName', 'N2', 'snake_case']) //原折為 id、username、n2
        let pkcols = (await admin.query('SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = \'public.tt3_case\'::regclass AND i.indisprimary')).rows.map((x) => x.attname)
        assert.deepStrictEqual(pkcols, ['Id'])
        let wo = mk({ cl: 'tt3_case', pk: 'Id' })
        assert.strictEqual((await wo.insert({ Id: 1, userName: 'a', N2: 1.5 })).nInserted, 1)
        let l = await wo.insert([{ Id: 1, userName: 'dup' }, { Id: 2, userName: 'b' }], { returnList: true }) //RETURNING "Id"
        assert.deepStrictEqual(l.map((x) => x.nInserted), [0, 1])
        assert.strictEqual((await wo.insertBulk([{ Id: 4, userName: 'd' }])).nInserted, 1)
        let s1 = await wo.save({ Id: 2, userName: 'b2' }) //ON CONFLICT ("Id") DO UPDATE SET "userName"
        assert.strictEqual(s1[0].nModified, 1)
        let s2 = await wo.save({ Id: 3, userName: 'c' })
        assert.strictEqual(s2[0].nInserted, 1)
        assert.deepStrictEqual((await wo.select({ userName: 'b2' })).map((x) => x.Id), [2])
        assert.strictEqual((await wo.selectByPk(3)).userName, 'c')
        assert.deepStrictEqual((await wo.del([{ Id: 1 }, { Id: 2 }, { Id: 3 }, { Id: 4 }])).map((x) => x.nDeleted), [1, 1, 1, 1])
        assert.deepStrictEqual(await wo.select({}), [])
    })

    it('should create and use a table whose columns and pk are non-ASCII letters', async function() {
        let wo = mk({ cl: 'tt3_uni', pk: '主鍵' })
        assert.deepStrictEqual(await wo.createTable('tt3_uni', null, { 主鍵: 1, 欄位: 'x' }), { ok: 1 })
        assert.strictEqual((await wo.save({ 主鍵: 1, 欄位: 'a' }))[0].nInserted, 1)
        assert.strictEqual((await wo.save({ 主鍵: 1, 欄位: 'b' }))[0].nModified, 1)
        assert.strictEqual((await wo.selectByPk(1)).欄位, 'b')
        assert.strictEqual((await wo.del({ 主鍵: 1 }))[0].nDeleted, 1)
    })

    it('should keep deriving column types from the sample values (compat)', async function() {
        let r = await mk().createTable('tt3_types', 'time', [{ time: 1, s: 'x', f: 1.5, b: true, j: { a: 1 }, ts: '2025-01-02T03:04:05Z', nn: null }])
        assert.deepStrictEqual(r, { ok: 1 })
        let t = (await admin.query('SELECT column_name, data_type FROM information_schema.columns WHERE table_name = \'tt3_types\'')).rows
        let m = {}
        t.forEach((x) => {
            m[x.column_name] = x.data_type
        })
        assert.deepStrictEqual(m, { time: 'integer', s: 'text', f: 'double precision', b: 'boolean', j: 'jsonb', ts: 'timestamp with time zone', nn: 'text' })
        let pk = (await admin.query('SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = \'public.tt3_types\'::regclass AND i.indisprimary')).rows
        assert.deepStrictEqual(pk.map((x) => x.attname), ['time'])
    })

    it('should keep rejecting a sample that is not an object, and report a database error (table exists) as the message string (compat)', async function() {
        let wo = mk()
        let a = await settle(wo.createTable('tt3_nobj', 'time', 'str'))
        assert.strictEqual(a.ok, false)
        assert.ok(a.e instanceof Error && /not an effective object/.test(a.e.message), String(a.e))
        assert.strictEqual(await rel('tt3_nobj'), 0)
        await wo.createTable('tt3_dup', 'time', { time: 1 })
        let b = await settle(wo.createTable('tt3_dup', 'time', { time: 1 }))
        assert.strictEqual(b.ok, false)
        assert.strictEqual(typeof b.e, 'string')
        assert.ok(/already exists/.test(b.e), b.e)
    })
})


describe('write: save (autoInsert) ON CONFLICT ... DO UPDATE SET quotes the column names and skips undefined values (R9, W5)', function() {
    let mkMix = async () => {
        await admin.query('DROP TABLE IF EXISTS tt3_mix')
        await admin.query('CREATE TABLE tt3_mix (time INTEGER PRIMARY KEY, "Name" TEXT, name TEXT, "my col" TEXT, "n-1" INTEGER, "a""b" TEXT)')
        await admin.query('INSERT INTO tt3_mix (time, "Name", name, "my col", "n-1", "a""b") VALUES (1, \'n0\', \'lower0\', \'m0\', 0, \'q0\')')
    }
    let mixRow = async () => (await admin.query('SELECT * FROM tt3_mix WHERE time = 1')).rows[0]
    after(cleanT3)

    it('should update the column whose name equals the key, not its case-folded twin', async function() {
        await mkMix()
        let r = await mk({ cl: 'tt3_mix' }).save({ time: 1, Name: 'N1' })
        assert.strictEqual(r[0].ok, 1, JSON.stringify(r))
        assert.strictEqual(r[0].nModified, 1)
        let x = await mixRow()
        assert.strictEqual(x.Name, 'N1')
        assert.strictEqual(x.name, 'lower0') //原:Name 折為 name 而把 name 清成 NULL
    })

    it('should update columns whose names contain a space, a hyphen or a double quote', async function() {
        await mkMix()
        let r = await mk({ cl: 'tt3_mix' }).save({ 'time': 1, 'my col': 'm1', 'n-1': 7, 'a"b': 'q1' })
        assert.strictEqual(r[0].ok, 1, JSON.stringify(r))
        assert.strictEqual(r[0].nModified, 1)
        let x = await mixRow()
        assert.deepStrictEqual([x['my col'], x['n-1'], x['a"b'], x.Name, x.name], ['m1', 7, 'q1', 'n0', 'lower0'])
    })

    it('should keep the column of a key whose value is undefined and update the others', async function() {
        await reset()
        let r = await mk().save({ time: 1, name: undefined, n: 99 })
        assert.strictEqual(r[0].ok, 1)
        assert.strictEqual(r[0].nModified, 1)
        let x = await row(1)
        assert.strictEqual(x.name, 'aa') //原:SET name = EXCLUDED.name 把 name 清成 NULL
        assert.strictEqual(x.n, 99)
        assert.strictEqual(x.tag, 'x')
    })

    it('should not let an undefined-valued key that looks like SQL read another table (no cross-table value is written)', async function() {
        await reset()
        let k = 'name = (SELECT pw FROM tsecret LIMIT 1) --'
        let r = await mk().save({ time: 1, n: 5, [k]: undefined })
        assert.strictEqual(r[0].ok, 1)
        let x = await row(1)
        assert.strictEqual(x.name, 'aa') //原:'s3cret'
        assert.strictEqual(x.n, 5)
    })

    it('should report a defined key that looks like SQL as a per-record failure and change nothing (compat)', async function() {
        await reset()
        let k = 'name = (SELECT pw FROM tsecret LIMIT 1) --'
        let r = await mk().save([{ time: 1, n: 5, [k]: 1 }, { time: 2, n: 6 }])
        assert.deepStrictEqual(r.map((x) => x.ok), [0, 1])
        assert.strictEqual((await row(1)).name, 'aa')
        assert.strictEqual((await row(1)).n, 10)
        assert.strictEqual((await row(2)).n, 6)
    })

    it('should treat an undefined value the same in autoInsert true and false (keep the column; compat for false)', async function() {
        await reset()
        let a = await mk().save({ time: 2, name: undefined, n: 77 }, { autoInsert: false })
        let b = await mk().save({ time: 3, name: undefined, n: 88 })
        assert.strictEqual(a[0].nModified, 1)
        assert.strictEqual(b[0].nModified, 1)
        assert.deepStrictEqual((await rows('time, name, n')).map((x) => [x.time, x.name, x.n]), [[1, 'aa', 10], [2, 'bb', 77], [3, 'cc', 88]])
    })

    it('should do nothing (no error, no change) when the record has only the pk and undefined values', async function() {
        await reset()
        let evs = []
        let wo = mk()
        wo.on('error', (m) => evs.push(m))
        let r = await wo.save({ time: 1, name: undefined })
        assert.deepStrictEqual([r[0].ok, r[0].n, r[0].nInserted, r[0].nModified], [1, 1, 0, 0])
        assert.strictEqual((await row(1)).name, 'aa') //原:SET name = EXCLUDED.name 清成 NULL
        assert.deepStrictEqual(evs, [])
    })

    it('should insert a new record whose undefined keys stay DEFAULT (compat)', async function() {
        await reset()
        let r = await mk().save({ time: 50, name: 'new', n: undefined })
        assert.strictEqual(r[0].nInserted, 1)
        let x = await row(50)
        assert.deepStrictEqual([x.name, x.n], ['new', null])
    })

    it('should send ON CONFLICT and RETURNING with quoted pk and column names (statement text)', async function() {
        await reset()
        let seen = []
        let orig = pg.Client.prototype.query
        pg.Client.prototype.query = function(cfg, ...rest) {
            seen.push(cfg)
            return orig.call(this, cfg, ...rest)
        }
        try {
            let wo = mk()
            await wo.save({ time: 1, name: 'z', n: undefined, tag: 't' })
            await wo.save({ time: 60 })
            await wo.insert({ time: 61 }, { returnList: true })
            await wo.insertBulk({ time: 62 })
        }
        finally {
            pg.Client.prototype.query = orig
        }
        let texts = seen.filter((c) => typeof c !== 'string').map((c) => c.text)
        let has = (re) => texts.some((t) => re.test(t))
        assert.ok(has(/ON CONFLICT \("time"\) DO UPDATE SET "name" = EXCLUDED\."name", "tag" = EXCLUDED\."tag" RETURNING \(xmax = 0\) AS inserted$/), JSON.stringify(texts))
        assert.ok(has(/values \(\$1\) ON CONFLICT \("time"\) DO NOTHING RETURNING \(xmax = 0\) AS inserted$/), JSON.stringify(texts))
        assert.ok(has(/ON CONFLICT \("time"\) DO NOTHING RETURNING "time"$/), JSON.stringify(texts))
        assert.ok(texts.some((t) => /^insert into "twrite" \("time"\) values \(\$1\)$/.test(t)), JSON.stringify(texts)) //insertBulk 無 ON CONFLICT
    })
})


describe('write: opt.pk must be an identifier at construction and is quoted wherever it is put into SQL (R9, W6)', function() {
    let bads = ['a"b', 'time; drop table x', 'a b', 'x.y', '1abc', '$x', 'a-b', '__proto__', 'p'.repeat(64), 'p\u0000q', 'a\nb', 'a,b']
    bads.forEach((k) => {
        it(`should throw invalid opt.pk at construction for ${JSON.stringify(k.length > 20 ? k.slice(0, 20) + '...' : k)} without echoing it`, function() {
            assert.throws(() => mk({ pk: k }), (e) => e instanceof Error && /^invalid opt\.pk: must be a plain identifier/.test(e.message) && !e.message.includes(k))
        })
    })

    //行為變更 3: 系統欄名作為 opt.pk 於建構時拋出專屬訊息(未限定引用時會解析為系統欄)
    let sysCols = ['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax']
    sysCols.forEach((k) => {
        it(`should throw "invalid opt.pk: system column names ... are not supported" at construction for ${k}`, function() {
            assert.throws(() => mk({ pk: k }), (e) => e instanceof Error && e.message === 'invalid opt.pk: system column names (ctid, tableoid, xmin, xmax, cmin, cmax) are not supported')
        })
    })

    it('should keep the default pk "time" for a pk that is not a non-empty string (compat)', async function() {
        await reset()
        for (let pk of [undefined, null, '', 0, 123, {}, [], true]) {
            let wo = mk({ pk })
            assert.strictEqual((await wo.selectByPk(2)).name, 'bb', String(pk))
        }
    })

    it('should accept identifiers with capitals, underscores, digits and non-ASCII letters, and Infinity and oid (behavior changes 2, 3)', function() {
        for (let k of ['Id', 'ID_1', '_x', '主鍵', 'p'.repeat(63), 'Infinity', 'oid', 'XMIN']) {
            assert.doesNotThrow(() => mk({ pk: k }), k)
        }
    })
})


describe('write: INSERT data keys with NUL or a lone surrogate give a clear check error (R9, W7; lone surrogate: shared chkOrmData check first, R17)', function() {
    let keys = [['NUL', 'a\u0000b'], ['lone surrogate', 'a\ud800b']]
    //NUL 鍵由 genInsert 檢核(invalid data key); 孤立代理鍵自第 66 項起先由 wsemi chkOrmData 於連線之前拒收(固定詞彙, 路徑 <invalid key>), genInsert 之檢核為縱深防禦
    let keyMsg = (label) => (label === 'NUL' ? /^invalid data key/ : /^invalid data: string contains lone surrogate at \[data\[1\]\.<invalid key>\]$/)
    keys.forEach(([label, k]) => {
        it(`should reject insert and insertBulk with invalid data key (${label}) and write nothing`, async function() {
            await reset()
            let evs = []
            let wo = mk()
            wo.on('error', (m) => evs.push(m))
            let a = await settle(wo.insert([{ time: 11, name: 'ok' }, { time: 12, [k]: 1 }]))
            let b = await settle(wo.insertBulk([{ time: 13, name: 'ok' }, { time: 14, [k]: 1 }]))
            for (let r of [a, b]) {
                assert.strictEqual(r.ok, false)
                assert.ok(r.e instanceof Error && keyMsg(label).test(r.e.message), String(r.e)) //原:協定層 insufficient data left in message
                assert.ok(!r.e.message.includes(k))
            }
            assert.deepStrictEqual(evs, ['insert', 'insertBulk'])
            assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3])
        })

        it(`should fail only that record of save with invalid data key (${label}) and save the others`, async function() {
            await reset()
            let evs = []
            let wo = mk()
            wo.on('error', (m) => evs.push(m))
            let r = await wo.save([{ time: 11, name: 'a' }, { time: 12, [k]: 1 }, { time: 13, name: 'c' }])
            assert.deepStrictEqual(r.map((x) => x.ok), [1, 0, 1])
            assert.ok(keyMsg(label).test(r[1].err), r[1].err)
            assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3, 11, 13])
            assert.deepStrictEqual(evs, ['save'])
        })
    })

    it('should roll back the batches already sent when a later batch fails in the database (unknown column; insert and insertBulk, one transaction)', async function() {
        this.timeout(120000)
        await reset()
        //每筆最多 2 欄 → 單批 32767 筆; 40001 筆分兩批, 第二批含不存在之欄(PG 回報; 第 66 項起 NUL 鍵已於連線前拒收, 不再能用來測此項)
        let big = Array.from({ length: 40000 }, (_, i) => ({ time: 1000 + i }))
        big.push({ 'time': 99999, 'zz_nocol': 1 })
        let seen = []
        let orig = pg.Client.prototype.query
        pg.Client.prototype.query = function(cfg, ...rest) {
            seen.push(typeof cfg === 'string' ? cfg : cfg.text.slice(0, 11))
            return orig.call(this, cfg, ...rest)
        }
        let a
        let b
        try {
            a = await settle(mk().insert(big))
            b = await settle(mk().insertBulk(big))
        }
        finally {
            pg.Client.prototype.query = orig
        }
        for (let r of [a, b]) {
            assert.strictEqual(r.ok, false)
            assert.ok(r.e instanceof Error && /zz_nocol/.test(r.e.message), String(r.e))
        }
        assert.strictEqual(seen.filter((x) => x === 'insert into').length, 4) //兩個呼叫各送出 2 批(第 2 批失敗)
        assert.strictEqual(seen.filter((x) => x === 'ROLLBACK').length, 2)
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3]) //第一批已送出之筆數亦回滾
    })

    it('should ignore a NUL key when its value is undefined (genInsert checks keys only when written; save no longer references it in ON CONFLICT, W5)', async function() {
        await reset()
        let r1 = await mk().insert({ 'time': 60, 'name': 'z', 'a\u0000b': undefined })
        let r2 = await mk().save({ 'time': 61, 'name': 'z', 'a\u0000b': undefined })
        assert.strictEqual(r1.nInserted, 1)
        assert.strictEqual(r2[0].nInserted, 1)
    })

    it('should reject a lone-surrogate key even when its value is undefined (the shared chkOrmData check looks at every key name, R17)', async function() {
        await reset()
        let r1 = await settle(mk().insert({ 'time': 60, 'name': 'z', 'a\ud800b': undefined }))
        let r2 = await mk().save({ 'time': 61, 'name': 'z', 'a\ud800b': undefined })
        assert.strictEqual(r1.ok, false)
        assert.strictEqual(r1.e.message, 'invalid data: string contains lone surrogate at [data[0].<invalid key>]')
        assert.deepStrictEqual([r2[0].ok, r2[0].err], [0, 'invalid data: string contains lone surrogate at [data[0].<invalid key>]'])
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3])
    })
})


describe('write: pk is read only from own enumerable properties of the data (R10, W8)', function() {
    class Row3 {
        constructor() {
            this.name = 'zz'
        }

        get time() {
            return 3
        }
    }
    let withPollutedTime = async (fn) => {
        Object.prototype.time = 2
        try {
            return await fn()
        }
        finally {
            delete Object.prototype.time
        }
    }

    it('should not delete the row that a polluted Object.prototype.time points to (del: per-record ok:0 as a missing pk)', async function() {
        await reset()
        let evs = []
        let wo = mk()
        wo.on('error', (m) => evs.push(m))
        let r = await withPollutedTime(async () => {
            let a = await wo.del([{}, { name: 'x' }])
            let b = await wo.del({ name: 'y' })
            return [a, b]
        })
        assert.deepStrictEqual(r[0].map((x) => [x.ok, x.nDeleted]), [[0, 0], [0, 0]])
        assert.strictEqual(r[0][0].err, 'invalid id: primary key is missing at [data[0].time]')
        assert.strictEqual(r[0][1].err, 'invalid id: primary key is missing at [data[1].time]') //逐筆取批次索引
        assert.strictEqual(r[1][0].err, 'invalid id: primary key is missing at [data[0].time]')
        assert.deepStrictEqual(r[1].map((x) => [x.ok, x.nDeleted]), [[0, 0]])
        assert.deepStrictEqual(evs, ['del', 'del', 'del']) //每筆失敗各發 1 次
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3]) //原:time=2 被刪
    })

    it('should reject save (autoInsert false and true) and insert/insertBulk of data without an own pk as a whole batch and write nothing', async function() {
        await reset()
        let evs = []
        let wo = mk()
        wo.on('error', (m) => evs.push(m))
        let rs = await withPollutedTime(async () => {
            return [
                await settle(wo.save([{ time: 1, name: 'ok' }, { name: 'zz' }], { autoInsert: false })),
                await settle(wo.save([{ time: 1, name: 'ok' }, { name: 'zz' }])),
                await settle(wo.insert([{ time: 21, name: 'ok' }, { name: 'zz' }])),
                await settle(wo.insertBulk([{ time: 22, name: 'ok' }, { name: 'zz' }])),
            ]
        })
        rs.forEach((r) => {
            assert.strictEqual(r.ok, false)
            assert.ok(r.e instanceof Error && r.e.message === 'invalid id: primary key is missing at [data[1].time]', String(r.e)) //原:UPDATE 作用於 time=2,或 PG 非空違反
        })
        assert.deepStrictEqual(evs, ['save', 'save', 'insert', 'insertBulk'])
        assert.deepStrictEqual((await rows('name')).map((x) => x.name), ['aa', 'bb', 'cc']) //整批無寫入(含有效之第 0 筆)
    })

    it('should treat a pk that exists only on the prototype chain (Object.create, class getter) as a missing pk', async function() {
        await reset()
        let wo = mk()
        let d = await wo.del([new Row3(), Object.create({ time: 2 }, { name: { value: 'x', enumerable: true } })])
        assert.deepStrictEqual(d.map((x) => [x.ok, x.nDeleted]), [[0, 0], [0, 0]])
        let s = await settle(wo.save(new Row3(), { autoInsert: false }))
        assert.strictEqual(s.ok, false)
        assert.strictEqual(s.e.message, 'invalid id: primary key is missing at [data[0].time]')
        let i = await settle(wo.insert(Object.create({ time: 9 }, { name: { value: 'x', enumerable: true } })))
        assert.strictEqual(i.ok, false)
        assert.deepStrictEqual((await rows('name')).map((x) => x.name), ['aa', 'bb', 'cc'])
    })

    it('own non-enumerable pk and prototype-only pk: two or more records are a missing pk; a lone record without enumerable keys is the existing empty-input no-op (nothing is written)', async function() {
        await reset()
        let evs = []
        let wo = mk()
        wo.on('error', (m) => evs.push(m))
        let nonEnum = (t) => Object.defineProperty({}, 'time', { value: t, enumerable: false })
        //兩筆以上: 不經入口之空輸入守衛, 走缺主鍵處置(自有不可列舉之主鍵不算, 原型 getter 之主鍵亦不算)
        let d = await wo.del([nonEnum(2), new Row3()])
        assert.deepStrictEqual(d.map((x) => [x.ok, x.nDeleted]), [[0, 0], [0, 0]])
        let s = await settle(wo.save([nonEnum(2), new Row3()]))
        assert.ok(s.ok === false && s.e.message === 'invalid id: primary key is missing at [data[0].time]', String(s.e))
        let i = await settle(wo.insertBulk([nonEnum(7), new Row3()]))
        assert.ok(i.ok === false && i.e.message === 'invalid id: primary key is missing at [data[0].time]', String(i.e))
        assert.deepStrictEqual(evs, ['del', 'del', 'save', 'insertBulk'])
        //單筆且無任何可列舉鍵: 既有之空輸入語意(同 del({})), 不送語句、不發 error、不作用於任何列
        class KeyOnly {
            get time() {
                return 3
            }
        }
        assert.deepStrictEqual(await wo.del(nonEnum(2)), [])
        assert.deepStrictEqual(await wo.del([new KeyOnly()]), [])
        assert.deepStrictEqual(await wo.save(new KeyOnly()), [])
        assert.deepStrictEqual(await wo.insert(new KeyOnly()), { n: 0, nInserted: 0, ok: 1 })
        assert.deepStrictEqual(evs, ['del', 'del', 'save', 'insertBulk']) //單筆無可列舉鍵者不發 error
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3])
    })

    it('should keep working for an own enumerable pk: plain objects and JSON.parse results (compat)', async function() {
        await reset()
        let wo = mk()
        let d = await wo.del(JSON.parse('[{"time":1},{"time":2}]'))
        assert.deepStrictEqual(d.map((x) => x.nDeleted), [1, 1])
        let s = await wo.save(JSON.parse('{"time":3,"name":"cc2"}'), { autoInsert: false })
        assert.strictEqual(s[0].nModified, 1)
        let i = await wo.insert(JSON.parse('{"time":4,"name":"dd"}'))
        assert.strictEqual(i.nInserted, 1)
        assert.deepStrictEqual((await rows('time, name')).map((x) => [x.time, x.name]), [[3, 'cc2'], [4, 'dd']])
    })
})
