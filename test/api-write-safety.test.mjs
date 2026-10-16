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
//  W3 首尾皆 $ 之主鍵值為無效主鍵
//  S5 整批 reject 時資料不變, 於 reject 前發一次 error 事件, reject 之值為 Error


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


describe('write: pk values that start and end with "$" are invalid (W3)', function() {
    it('should reject insert and insertBulk for pk "$x$" and write nothing', async function() {
        await reset()
        let wo = mk()
        let a = await settle(wo.insert({ time: '$x$', name: 'a' }))
        let b = await settle(wo.insertBulk([{ time: 11, name: 'b' }, { time: '$x$', name: 'a' }]))
        assert.strictEqual(a.ok, false) //W3
        assert.strictEqual(b.ok, false) //W3
        assert.ok(/invalid data\[\d\]\.time/.test(a.e.message), a.e.message)
        assert.strictEqual((await rows()).length, 3)
    })

    it('should reject save with autoInsert (default) and without for pk "$x$" and write nothing', async function() {
        await reset()
        let wo = mk()
        let evs = []
        wo.on('error', (mode) => evs.push(mode))
        let a = await settle(wo.save({ time: '$x$', name: 'a' }))
        let b = await settle(wo.save([{ time: 5, name: 'ok' }, { time: '$time$', name: 'b' }]))
        assert.strictEqual(a.ok, false) //W3 autoInsert 分支
        assert.strictEqual(b.ok, false) //整批性: 第一筆有效亦不寫入
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3])
        assert.deepStrictEqual(evs, ['save', 'save'])
    })

    it('should get null for selectByPk and ok:0 for del with pk "$time$"; all rows kept', async function() {
        await reset()
        let wo = mk()
        assert.strictEqual(await wo.selectByPk('$time$'), null)
        let r = await wo.del([{ time: '$time$' }, { time: '$' }, { time: '$$' }])
        assert.deepStrictEqual(r.map((x) => x.ok), [0, 0, 0])
        assert.strictEqual((await rows()).length, 3)
    })

    it('should handle TEXT pk with "$" inside normally and reject "$..$" pk', async function() {
        await admin.query('DROP TABLE IF EXISTS tpk')
        await admin.query('CREATE TABLE tpk (id TEXT PRIMARY KEY, name TEXT)')
        let wo = WOrm({ url: ct.url, db: ct.db, cl: 'tpk', pk: 'id' })
        let r = await wo.insert([{ id: 'x$', name: 'a' }, { id: '$y', name: 'b' }, { id: 'z', name: 'c' }])
        assert.strictEqual(r.nInserted, 3)
        assert.strictEqual((await wo.selectByPk('x$')).name, 'a') //前後單側 $ 為合法
        assert.strictEqual(await wo.selectByPk('$x$'), null)
        let d = await wo.del({ id: '$x$' })
        assert.strictEqual(d[0].ok, 0)
        assert.strictEqual((await admin.query('SELECT count(*)::int AS c FROM tpk')).rows[0].c, 3) //W3 不得刪光
        let s = await settle(wo.save({ id: '$x$', name: 'q' }, { autoInsert: false }))
        assert.strictEqual(s.ok, false)
        await admin.query('DROP TABLE tpk')
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
                assert.ok(/invalid data\[0\]\.time/.test(i.e.message), i.e.message)
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

    it('should not be affected by Object.prototype pollution of query options (limit, columns, expression, $custom)', async function() {
        await reset()
        let wo = mk()
        Object.prototype.limit = 1
        Object.prototype.columns = ['1']
        Object.prototype.expression = 'select 1; select 1; --'
        Object.prototype.$custom = ['true']
        let a
        let b
        let c
        let d
        try {
            a = await wo.selectByPk(2)
            b = await wo.select({ name: 'aa' })
            c = await wo.del({ time: 3 })
            d = await wo.delAll({ name: 'bb' })
        }
        finally {
            delete Object.prototype.limit
            delete Object.prototype.columns
            delete Object.prototype.expression
            delete Object.prototype.$custom
        }
        assert.strictEqual(a.name, 'bb') //W3 完整列, 非 columns 汙染之結果
        assert.deepStrictEqual(b.map((x) => x.time), [1])
        assert.strictEqual(c[0].nDeleted, 1)
        assert.strictEqual(d.n, 1)
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1])
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
        assert.ok(r.e instanceof Error && /^invalid data\[1\]\.time\[undefined\]/.test(r.e.message), String(r.e))
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


describe('write: table names (insert, save UPDATE and $nin)', function() {
    let before2 = async () => {
        await admin.query('CREATE SCHEMA IF NOT EXISTS rvo')
        await admin.query('DROP TABLE IF EXISTS rvo.dot')
        await admin.query('DROP TABLE IF EXISTS "rvo.dot"')
        await admin.query('CREATE TABLE rvo.dot (time INTEGER PRIMARY KEY, v INTEGER)')
        await admin.query('CREATE TABLE "rvo.dot" (time INTEGER PRIMARY KEY, v INTEGER)')
        await admin.query('INSERT INTO "rvo.dot" VALUES (1, 10)')
    }

    it('should write to the table named by a pre-quoted name, not to a schema-qualified table (like mongo-sql)', async function() {
        await before2()
        let wo = mk({ cl: '"rvo.dot"' })
        //僅測 insert: 帶條件之 select(含 save 預讀)對含點之預先引號表名由 mongo-sql 自身轉譯失敗(HEAD 亦然, 非本輪範圍)
        let r = await wo.insert({ time: 2, v: 20 })
        assert.strictEqual(r.nInserted, 1)
        assert.deepStrictEqual((await admin.query('SELECT time, v FROM "rvo.dot" ORDER BY time')).rows, [{ time: 1, v: 10 }, { time: 2, v: 20 }])
        assert.deepStrictEqual((await admin.query('SELECT time, v FROM rvo.dot')).rows, []) //另一關係未被寫入
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

    it('should reject $nin on a table whose name breaks the mongo-sql rewrite, keep $in working, and change no data', async function() {
        await admin.query('DROP TABLE IF EXISTS "rvo|p"')
        await admin.query('CREATE TABLE "rvo|p" (time INTEGER PRIMARY KEY, c INTEGER)')
        await admin.query('INSERT INTO "rvo|p" VALUES (1, 1), (2, 2), (3, 3)')
        let wo = mk({ cl: 'rvo|p' })
        let evs = []
        wo.on('error', (mode) => evs.push(mode))
        let a = await settle(wo.select({ c: { $nin: [1] } }))
        let b = await settle(wo.delAll({ c: { $nin: [1] } }))
        assert.strictEqual(a.ok, false)
        assert.strictEqual(b.ok, false)
        assert.ok(/\$nin is not supported with this table name/.test(a.e.message), a.e.message)
        assert.deepStrictEqual(evs, ['select', 'delAll'])
        let c = await wo.select({ c: { $in: [2] } })
        assert.deepStrictEqual(c.map((x) => x.time), [2])
        assert.strictEqual((await admin.query('SELECT count(*)::int AS n FROM "rvo|p"')).rows[0].n, 3)
        await admin.query('DROP TABLE "rvo|p"')
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
        assert.ok(/Symbol\(x\)/.test(r[1].err), r[1].err)
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [3])
        assert.deepStrictEqual(evs, ['del'])
    })

    it('should reject whole batch with a readable message for a Symbol pk in insert', async function() {
        await reset()
        let r = await settle(mk().insert({ time: Symbol('y'), name: 'a' }))
        assert.strictEqual(r.ok, false)
        assert.ok(/invalid data\[0\]\.time\[Symbol\(y\)\]/.test(r.e.message), r.e.message)
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
        assert.strictEqual(s.ok, false)
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
        assert.ok(/invalid data\[0\]\.time/.test(i.e.message), i.e.message)
        await admin.query(`DROP TABLE ${CLD}`)
    })
})


describe('write: statements use a null-prototype extended-protocol query config (no stacked statements, no polluted pg options)', function() {
    it('should not stack a second statement even if scalar prototypes are polluted with functions (zero bound parameters)', async function() {
        await reset()
        let wo = mk()
        //mongo-sql 之 parameterize 讀純量值之 value[0]、value[NaN]、value.substring: 原型被塞入函數(需程式碼執行權)時可產出無綁定參數且帶第二語句之 SQL
        let def = (k, v) => Object.defineProperty(Object.prototype, k, { value: v, configurable: true, writable: true })
        let r
        try {
            def('0', '$')
            def('NaN', '$')
            def('substring', () => `"${CL}"."n"; CREATE TABLE vt_pwned(x int); -- ".*`)
            r = await settle(wo.delAll({ n: 10 }))
        }
        finally {
            delete Object.prototype['0']
            delete Object.prototype.NaN
            delete Object.prototype.substring
        }
        assert.strictEqual(r.ok, false) //伺服器拒絕 extended 協定下之多語句
        assert.strictEqual((await admin.query('SELECT to_regclass(\'vt_pwned\') AS t')).rows[0].t, null) //第二語句未執行
        assert.strictEqual((await rows()).length, 3) //資料不變
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
        assert.ok(strs.length > 0 && strs.every((x) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(x)), JSON.stringify(strs)) //僅交易控制語句為字串
        assert.ok(cfgs.length >= 10, `statements=${cfgs.length}`)
        assert.ok(cfgs.some((c) => /^CREATE TABLE "tt3_stub"/.test(c.text)), JSON.stringify(cfgs.map((c) => c.text))) //DDL 亦為設定物件形式
        cfgs.forEach((c) => {
            assert.strictEqual(Object.getPrototypeOf(c), null)
            assert.strictEqual(c.queryMode, 'extended')
            assert.strictEqual(typeof c.text, 'string')
        })
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

    let badKeys = ['zq xw', 'zq"xw', 'zq;xw', 'zq.xw', 'zq-xw', 'zq$xw', 'zq\'xw', '1zqxw', 'zq) ; CREATE TABLE vo_pwned(a', `zq${'x'.repeat(70)}`, 'zq\u0000xw', 'zq\ud800xw', '', '__proto__', 'Infinity']
    it('should reject data keys that are not plain identifiers (space, quote, ;, ., -, $, digit first, NUL, lone surrogate, empty, __proto__, over 63 bytes) before sending any statement (W4)', async function() {
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
        for (let pk of ['time; drop table tt3_victim', 'a"b', 'a b', 'x.y', '1abc', 'p'.repeat(64), 'Infinity']) {
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
        //完整雙引號名稱: createTable 與 insert 可用; 其餘函數無法以它當 opt.cl(mongo-sql 以 quoteObject(欄, 表) 限定欄名, 表名帶引號時產出語法錯誤; HEAD 同, 見帳本 R9)
        assert.strictEqual((await mk({ cl: '"Tt3_Q"' }).insert({ time: 1 })).nInserted, 1)
        assert.strictEqual((await admin.query('SELECT count(*)::int AS n FROM "Tt3_Q"')).rows[0].n, 1)
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
    let bads = ['a"b', 'time; drop table x', 'a b', 'x.y', '1abc', '$x', 'a-b', '__proto__', 'Infinity', 'p'.repeat(64), 'p\u0000q', 'a\nb', 'a,b']
    bads.forEach((k) => {
        it(`should throw invalid opt.pk at construction for ${JSON.stringify(k.length > 20 ? k.slice(0, 20) + '...' : k)} without echoing it`, function() {
            assert.throws(() => mk({ pk: k }), (e) => e instanceof Error && /^invalid opt\.pk/.test(e.message) && !e.message.includes(k))
        })
    })

    it('should keep the default pk "time" for a pk that is not a non-empty string (compat)', async function() {
        await reset()
        for (let pk of [undefined, null, '', 0, 123, {}, [], true]) {
            let wo = mk({ pk })
            assert.strictEqual((await wo.selectByPk(2)).name, 'bb', String(pk))
        }
    })

    it('should accept identifiers with capitals, underscores, digits and non-ASCII letters', function() {
        for (let k of ['Id', 'ID_1', '_x', '主鍵', 'p'.repeat(63)]) {
            assert.doesNotThrow(() => mk({ pk: k }), k)
        }
    })
})


describe('write: INSERT data keys with NUL or a lone surrogate give a clear check error (R9, W7)', function() {
    let keys = [['NUL', 'a\u0000b'], ['lone surrogate', 'a\ud800b']]
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
                assert.ok(r.e instanceof Error && /^invalid data key/.test(r.e.message), String(r.e)) //原:協定層 insufficient data left in message
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
            assert.ok(/^invalid data key/.test(r[1].err), r[1].err)
            assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3, 11, 13])
            assert.deepStrictEqual(evs, ['save'])
        })
    })

    it('should roll back the batches already sent when an invalid data key is in a later batch (insert and insertBulk, one transaction)', async function() {
        this.timeout(120000)
        await reset()
        //每筆最多 2 欄 → 單批 32767 筆; 40001 筆分兩批, 壞鍵在第二批
        let big = Array.from({ length: 40000 }, (_, i) => ({ time: 1000 + i }))
        big.push({ 'time': 99999, 'a\u0000b': 1 })
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
            assert.ok(r.e instanceof Error && /^invalid data key/.test(r.e.message), String(r.e))
        }
        assert.strictEqual(seen.filter((x) => x === 'insert into').length, 2) //兩個呼叫各已送出第一批
        assert.strictEqual(seen.filter((x) => x === 'ROLLBACK').length, 2)
        assert.deepStrictEqual((await rows('time')).map((x) => x.time), [1, 2, 3]) //第一批已送出之筆數亦回滾
    })

    it('should ignore such a key when its value is undefined (keys are checked only when written; save no longer references it in ON CONFLICT, W5)', async function() {
        await reset()
        let r1 = await mk().insert({ 'time': 60, 'name': 'z', 'a\u0000b': undefined })
        let r2 = await mk().save({ 'time': 61, 'name': 'z', 'a\ud800b': undefined })
        assert.strictEqual(r1.nInserted, 1)
        assert.strictEqual(r2[0].nInserted, 1)
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
        assert.ok(/^invalid time\[undefined\]/.test(r[0][0].err), r[0][0].err)
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
            assert.ok(r.e instanceof Error && /^invalid data\[1\]\.time\[undefined\]/.test(r.e.message), String(r.e)) //原:UPDATE 作用於 time=2,或 PG 非空違反
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
        assert.ok(/^invalid data\[0\]\.time\[undefined\]/.test(s.e.message), String(s.e))
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
        assert.ok(s.ok === false && /^invalid data\[0\]\.time\[undefined\]/.test(s.e.message), String(s.e))
        let i = await settle(wo.insertBulk([nonEnum(7), new Row3()]))
        assert.ok(i.ok === false && /^invalid data\[0\]\.time\[undefined\]/.test(i.e.message), String(i.e))
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
