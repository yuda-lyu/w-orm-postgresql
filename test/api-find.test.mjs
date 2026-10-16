/* eslint-disable no-sparse-arrays, no-extend-native -- 測試刻意以稀疏陣列驗證 reject, 並暫時汙染原型(finally 還原)驗證免疫 */
import assert from 'assert'
import WOrm from '../src/WOrmPostgresql.mjs'
import { startPg, stopPg, connectPg } from './tools/pgContainer.mjs'


//條件(find)與排序(order)之轉譯與 reject 測試. 真 PostgreSQL(自建容器, 測畢即銷毀), 不 mock 接縫.
//規格句見 CLAUDE_rulebook.md 開頭(S1–S8), 摘要:
//  S1 同一 find 於 select 命中之數據, 即 delAll 刪除之數據
//  S2 不支援之運算子與無法轉譯之值必須 reject(整批性錯誤), 不得靜默忽略, 改變語意或擴大刪除範圍
//  S3 恆真恆假須明確, 不得因條件清單恰為空或某值為 undefined 而成為刪全表({} 或未給 find 刻意為全部)
//  S4 受支援運算子之既有語意不變
//  S5 reject 時資料不變, 於 reject 前發一次 error 事件, reject 之值為 Error 且訊息含 invalid find(order 為 invalid order)
//  S6 以主鍵值構成之條件(selectByPk, del, save)不得因主鍵值為 $..$ 字串而命中全部
//  S7 order 僅接受 asc/desc(可接 nulls first/last)
//  S8 useCache 下檢核不被快取繞過, 快取鍵不因不同型別之值而混同


let ctName = 'worm-test-postgresql-find'
let ct = null
let admin = null
let CL = 'tfind'

let SEED = [
    { time: 1, name: 'aa', value: 1, tag: 'x', ok: true, js: { k: 1 } },
    { time: 2, name: 'bb', value: 2, tag: 'y', ok: false, js: { k: 2 } },
    { time: 3, name: 'cc', value: 3, tag: null, ok: null, js: null },
    { time: 4, name: 'aa', value: 4, tag: 'x', ok: true, js: { k: 1 } },
    { time: 5, name: null, value: 5, tag: 'z', ok: true, js: { k: 3 } },
    { time: 6, name: '$name$', value: 6, tag: 'x', ok: false, js: null },
    { time: 7, name: 'AA', value: 7, tag: 'y', ok: true, js: null },
    { time: 8, name: 'a b', value: 8, tag: null, ok: null, js: null },
    { time: 9, name: 'a.b', value: 9, tag: 'z', ok: false, js: null },
    { time: 10, name: 'it\'s', value: 10, tag: 'x', ok: true, js: null },
]
let ALL = SEED.map((r) => r.time)
let ids = (pred) => SEED.filter(pred).map((r) => r.time)
let nn = (v) => v !== null && v !== undefined

//reset, 重建資料表與他表(tsecret供子查詢類案例驗證不得跨表讀取)
let reset = async () => {
    await admin.query(`DROP TABLE IF EXISTS ${CL}`)
    await admin.query(`CREATE TABLE ${CL} (time INTEGER PRIMARY KEY, name TEXT, value DOUBLE PRECISION, tag TEXT, ok BOOLEAN, js JSONB)`)
    for (let r of SEED) {
        await admin.query(`INSERT INTO ${CL} VALUES ($1,$2,$3,$4,$5,$6)`, [r.time, r.name, r.value, r.tag, r.ok, r.js === null ? null : JSON.stringify(r.js)])
    }
    await admin.query('DROP TABLE IF EXISTS tsecret')
    await admin.query('CREATE TABLE tsecret (id INTEGER, pw TEXT)')
    await admin.query('INSERT INTO tsecret VALUES (1, $1)', ['s3cret'])
}
let remain = async () => (await admin.query(`SELECT time FROM ${CL} ORDER BY time`)).rows.map((x) => x.time)
let mk = (opt = {}) => WOrm({ url: ct.url, db: ct.db, cl: CL, ...opt })
let settle = (p) => p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e }))
let sortNum = (a) => [...a].sort((x, y) => x - y)


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


describe('find: supported operators (S1 S4)', function() {
    //命中集合由 SEED 以獨立之 SQL 三值述語推得(比較不含 NULL 列), 非取自被測實作
    let oks = [
        ['eq string', () => ({ name: 'aa' }), (r) => r.name === 'aa'],
        ['$equals', () => ({ name: { $equals: 'aa' } }), (r) => r.name === 'aa'],
        ['$ne (excludes NULL)', () => ({ name: { $ne: 'aa' } }), (r) => nn(r.name) && r.name !== 'aa'],
        ['$gt', () => ({ value: { $gt: 5 } }), (r) => r.value > 5],
        ['$gte', () => ({ value: { $gte: 5 } }), (r) => r.value >= 5],
        ['$lt', () => ({ value: { $lt: 3 } }), (r) => r.value < 3],
        ['$lte', () => ({ value: { $lte: 3 } }), (r) => r.value <= 3],
        ['$gt+$lt', () => ({ value: { $gt: 2, $lt: 6 } }), (r) => r.value > 2 && r.value < 6],
        ['$in', () => ({ value: { $in: [1, 2] } }), (r) => [1, 2].includes(r.value)],
        ['$in with null', () => ({ tag: { $in: ['x', null] } }), (r) => r.tag === 'x' || r.tag === null],
        ['$in [null]', () => ({ tag: { $in: [null] } }), (r) => r.tag === null],
        ['$in [] is constant false', () => ({ value: { $in: [] } }), () => false],
        ['$in literal $..$ string', () => ({ name: { $in: ['$name$'] } }), (r) => r.name === '$name$'],
        ['$nin (excludes NULL)', () => ({ tag: { $nin: ['x'] } }), (r) => nn(r.tag) && r.tag !== 'x'],
        ['$nin [null]', () => ({ tag: { $nin: [null] } }), (r) => nn(r.tag)],
        ['$nin with $notNull (replacement of $nin mixing null)', () => ({ tag: { $nin: ['x'], $notNull: true } }), (r) => nn(r.tag) && r.tag !== 'x'],
        ['$not scalar', () => ({ name: { $not: 'aa' } }), (r) => nn(r.name) && r.name !== 'aa'],
        ['$not operator object', () => ({ value: { $not: { $gt: 5 } } }), (r) => !(r.value > 5)],
        ['$like', () => ({ name: { $like: 'a%' } }), (r) => nn(r.name) && r.name.startsWith('a')],
        ['$ilike', () => ({ name: { $ilike: 'a%' } }), (r) => nn(r.name) && r.name.toLowerCase().startsWith('a')],
        ['$null true', () => ({ tag: { $null: true } }), (r) => r.tag === null],
        ['$null false', () => ({ tag: { $null: false } }), (r) => nn(r.tag)],
        ['$notNull true', () => ({ tag: { $notNull: true } }), (r) => nn(r.tag)],
        ['$notNull false', () => ({ tag: { $notNull: false } }), (r) => r.tag === null],
        ['eq null', () => ({ tag: null }), (r) => r.tag === null],
        ['$ne null', () => ({ tag: { $ne: null } }), (r) => nn(r.tag)],
        ['eq boolean', () => ({ ok: true }), (r) => r.ok === true],
        ['$ne true (IS NOT TRUE includes NULL)', () => ({ ok: { $ne: true } }), (r) => r.ok !== true],
        ['eq bigint', () => ({ time: 3n }), (r) => r.time === 3],
        ['$and', () => ({ $and: [{ value: { $gt: 2 } }, { value: { $lt: 6 } }] }), (r) => r.value > 2 && r.value < 6],
        ['$or', () => ({ $or: [{ value: { $lte: 1 } }, { value: { $gte: 10 } }] }), (r) => r.value <= 1 || r.value >= 10],
        ['README nested $or/$and', () => ({ $or: [{ $and: [{ value: { $ne: 4 } }, { value: { $in: [4, 5, 6] } }, { value: { $nin: [6, 7] } }] }, { $or: [{ value: { $lte: -1 } }, { value: { $gte: 10 } }] }] }), (r) => (r.value !== 4 && [4, 5, 6].includes(r.value) && ![6, 7].includes(r.value)) || r.value <= -1 || r.value >= 10],
        ['$and with {} element (constant true)', () => ({ $and: [{ name: 'aa' }, {}] }), (r) => r.name === 'aa'],
        ['multi columns AND', () => ({ name: 'aa', value: { $gt: 1 } }), (r) => r.name === 'aa' && r.value > 1],
        ['column + $or', () => ({ name: 'aa', $or: [{ value: 1 }, { value: 4 }] }), (r) => r.name === 'aa' && (r.value === 1 || r.value === 4)],
        ['JSON path key', () => ({ 'js->>k': '1' }), (r) => r.js !== null && r.js.k === 1],
        ['cast key', () => ({ 'value::text': '5' }), (r) => r.value === 5],
        ['{} is all (explicit)', () => ({}), () => true],
        ['undefined is all (explicit)', () => undefined, () => true],
    ]
    oks.forEach(([label, mkFind, pred]) => {
        let want = ids(pred)
        it(`should get ${JSON.stringify(want)} for select and delAll by ${label}`, async function() {
            let wo = mk()
            await reset()
            let rs = await wo.select(mkFind())
            await reset()
            let rd = await wo.delAll(mkFind())
            let left = await remain()
            assert.deepStrictEqual(sortNum(rs.map((x) => x.time)), want) //S4 命中集合 = 獨立述語
            assert.deepStrictEqual(ALL.filter((t) => !left.includes(t)), want) //S1 delAll 刪除 = select 命中
            assert.strictEqual(rd.n, want.length) //S1 n 為實際刪除筆數
            assert.strictEqual(rd.nDeleted, want.length) //S1
            assert.strictEqual(rd.ok, 1)
        })
    })
})


describe('find: unsupported or untranslatable must reject (S2 S3 S5)', function() {
    let col = (v) => ({ name: v })
    class Foo {
        constructor() {
            this.name = 'aa'
        }
    }
    let bads = [
        //undefined, 任一位置(S3)
        ['undefined value', () => ({ name: undefined })],
        ['partial undefined', () => ({ name: 'aa', value: undefined })],
        ['undefined in operator', () => ({ value: { $gt: undefined } })],
        ['undefined in $and', () => ({ $and: [{ name: undefined }] })],
        ['$in [undefined]', () => ({ value: { $in: [undefined] } })],
        ['$nin [undefined]', () => ({ value: { $nin: [undefined] } })],
        ['$nin [1,undefined]', () => ({ value: { $nin: [1, undefined] } })],
        ['$in sparse array', () => ({ value: { $in: [1, , 3] } })],
        ['$and: undefined', () => ({ $and: undefined })],
        ['$or: undefined', () => ({ $or: undefined })],
        ['$in: undefined', () => ({ name: { $in: undefined } })],
        ['$not: undefined', () => ({ name: { $not: undefined } })],
        //不支援之運算子(S2)
        ['$nor', () => ({ $nor: [{ value: 1 }, { value: 2 }] })],
        ['$nor single', () => ({ $nor: [{ value: 1 }] })],
        ['$nor []', () => ({ $nor: [] })],
        ['$regex string', () => col({ $regex: 'a' })],
        ['$regex RegExp', () => col({ $regex: /a/ })],
        ['$regex + $options', () => col({ $regex: 'AA', $options: 'i' })],
        ['$options only', () => col({ $options: 'i' })],
        ['RegExp as value', () => col(/a/)],
        ['$exists true', () => col({ $exists: true })],
        ['$exists null', () => col({ $exists: null })],
        ['$exists subquery', () => ({ value: { $exists: { type: 'select', table: 'tsecret', columns: ['id'] } } })],
        ['$notExists subquery', () => ({ value: { $notExists: { type: 'select', table: 'tsecret', columns: ['id'] } } })],
        ['$in subquery', () => ({ value: { $in: { type: 'select', table: 'tsecret', columns: ['id'] } } })],
        ['$nin subquery', () => ({ value: { $nin: { type: 'select', table: 'tsecret', columns: ['id'] } } })],
        ['$custom raw sql', () => ({ value: { $custom: ['true'] } })],
        ['$custom stacked statement', () => ({ value: { $custom: ['true; delete from tfind'] } })],
        ['$custom_array', () => ({ value: { $custom_array: ['true'] } })],
        ['$custom_object', () => ({ value: { $custom_object: { value: 'true', values: [] } } })],
        ['top-level $custom', () => ({ $custom: ['true'] })],
        ['$years_ago', () => ({ value: { $years_ago: 1 } })],
        ['$eq', () => col({ $eq: 'aa' })],
        ['$where', () => ({ $where: 'this.value>1' })],
        ['$expr', () => ({ $expr: { $gt: ['$value', 1] } })],
        ['$jsonSchema {}', () => ({ $jsonSchema: {} })],
        ['$mod', () => ({ value: { $mod: [2, 0] } })],
        ['unknown $foo', () => col({ $foo: 1 })],
        ['unknown without $', () => ({ value: { gt: 1 } })],
        ['top-level comparison', () => ({ $gt: 5 })],
        ['top-level $not', () => ({ $not: { name: 'aa' } })],
        ['valid + unknown operator', () => ({ value: { $gt: 1, $foo: 2 } })],
        ['nested non-operator key', () => col({ value: 1 })],
        ['nested non-operator key beside operator', () => ({ value: { $gt: 1, tag: 'x' } })],
        ['column-level $or (not supported)', () => ({ value: { $or: [{ $gt: 8 }, { $lt: 2 }] } })],
        ['column-level $and (not supported)', () => ({ value: { $and: [{ $gt: 1 }, { $lt: 5 }] } })],
        ['$or as object', () => ({ $or: { name: 'aa', value: 2 } })],
        //空清單與恆真(S3)
        ['$and []', () => ({ $and: [] })],
        ['$or []', () => ({ $or: [] })],
        ['$and {}', () => ({ $and: {} })],
        ['$or [{}]', () => ({ $or: [{}] })],
        ['$and [{}]', () => ({ $and: [{}] })],
        ['$or [{}, cond] ({} is true)', () => ({ $or: [{}, { name: 'aa' }] })],
        ['$or [undefined, cond]', () => ({ $or: [undefined, { name: 'aa' }] })],
        ['$or [null, cond]', () => ({ $or: [null, { name: 'aa' }] })],
        ['$or [1, 2]', () => ({ $or: [1, 2] })],
        ['$or scalar', () => ({ $or: 5 })],
        ['$and nested array', () => ({ $and: [[{ name: 'aa' }]] })],
        ['$nin []', () => ({ value: { $nin: [] } })],
        ['$not {$in: []}', () => ({ value: { $not: { $in: [] } } })],
        ['empty object value', () => col({})],
        ['empty array value', () => col([])],
        ['array value', () => col(['aa', 'bb'])],
        ['empty operator object in $or', () => ({ $or: [{ name: {} }] })],
        ['$nin with null and others (wrong in mongo-sql)', () => ({ tag: { $nin: ['x', null] } })],
        //值(S2)
        ['NaN', () => ({ value: NaN })],
        ['Infinity', () => ({ value: { $gt: Infinity } })],
        ['invalid Date', () => ({ value: new Date('invalid') })],
        ['Map value', () => col(new Map())],
        ['Set value', () => col(new Set([1]))],
        ['class instance value', () => col(new Foo())],
        ['function value', () => col(function() {})],
        ['Symbol value', () => col(Symbol('s'))],
        ['String wrapper', () => col(Object('aa'))],
        ['Number wrapper', () => col(Object(5))],
        ['lone surrogate string', () => col('\ud800')],
        ['NUL string', () => col('a\u0000b')],
        ['"$name$" string (column reference in mongo-sql)', () => col('$name$')],
        ['"$" string', () => col('$')],
        ['"$$" string', () => col({ $ne: '$$' })],
        ['null for $gt', () => ({ value: { $gt: null } })],
        ['null for $lte', () => ({ value: { $lte: null } })],
        ['null for $like', () => col({ $like: null })],
        ['$not null', () => col({ $not: null })],
        ['$like non-string', () => col({ $like: 5 })],
        ['$null non-boolean', () => ({ tag: { $null: {} } })],
        ['$notNull non-boolean', () => ({ tag: { $notNull: 0 } })],
        ['$in scalar', () => ({ value: { $in: 5 } })],
        ['$in nested array', () => ({ value: { $in: [[1, 2]] } })],
        ['$in RegExp element', () => col({ $in: [/a/] })],
        ['$in object element', () => col({ $in: [{}] })],
        ['$in NaN element', () => ({ value: { $in: [NaN] } })],
        //欄名(S2)
        ['column with double quote', () => ({ 'na"me': 'aa' })],
        ['column with dot', () => ({ 'tfind.name': 'aa' })],
        ['column with space', () => ({ ' name': 'aa' })],
        ['column star', () => ({ '*': 1 })],
        ['column empty', () => ({ '': 'aa' })],
        ['column numeric', () => ({ 0: 'aa' })],
        ['column Infinity', () => ({ Infinity: 5 })],
        ['column $x$', () => ({ $name$: 'aa' })],
        ['column with $ inside', () => ({ 'a$b': { $nin: ['x'] } })],
        ['column __proto__ (own)', () => JSON.parse('{"__proto__":{"name":"aa"}}')],
        ['column longer than 63 bytes', () => ({ ['c'.repeat(64)]: 1 })],
        ['column injection via ->>', () => ({ 'js->>9 is null or time': 99 })],
        ['column injection stacked', () => ({ 'js->>1 is null; delete from tfind; --': null })],
        ['JSON path part starting with digit', () => ({ 'js->1abc': 1 })],
        ['JSON path part with leading zero', () => ({ 'js->007': 1 })],
        ['JSON path quoted part', () => ({ 'js->>\'k\'': '1' })],
        ['JSON path with cast', () => ({ 'js->>k::int': 1 })],
        ['column with regexp meta', () => ({ 'n+': { $nin: ['aa'] } })],
        //頂層型別與物件形態(S2 S3)
        ['top Date', () => new Date()],
        ['top RegExp', () => /a/],
        ['top Map', () => new Map([['name', 'aa']])],
        ['top Set', () => new Set(['a'])],
        ['top class instance', () => new Foo()],
        ['top function', () => function() {}],
        ['top bigint', () => 10n],
        ['top Symbol', () => Symbol('x')],
        ['top Promise', () => Promise.resolve({ name: 'aa' })],
        ['top Error', () => new Error('x')],
        ['top non-empty string', () => 'name=aa'],
        ['inherited property', () => Object.create({ name: 'aa' })],
        ['non-enumerable property', () => {
            let o = {}; Object.defineProperty(o, 'name', { value: 'aa', enumerable: false }); return o
        }],
        ['Symbol key', () => ({ [Symbol('name')]: 'aa' })],
        ['getter property', () => ({
            get name() {
                return 'aa'
            }
        })],
        ['circular', () => {
            let f = { $and: [] }; f.$and.push(f); return f
        }],
        ['too deep ($and nested 40)', () => {
            let f = { name: 'aa' }; for (let i = 0; i < 40; i++) {
                f = { $and: [f] }
            } return f
        }],
    ]
    bads.forEach(([label, mkFind]) => {
        it(`should reject select and delAll and keep all rows by ${label}`, async function() {
            let wo = mk()
            let evs = []
            wo.on('error', (mode, data, err) => evs.push(mode))
            await reset()
            let rs = await settle(wo.select(mkFind()))
            let rd = await settle(wo.delAll(mkFind()))
            let left = await remain()
            assert.strictEqual(rs.ok, false, 'select must reject') //S2
            assert.strictEqual(rd.ok, false, 'delAll must reject') //S2 S3
            assert.ok(rs.e instanceof Error && /invalid find/.test(rs.e.message), `select error: ${rs.e && rs.e.message}`) //S5
            assert.ok(rd.e instanceof Error && /invalid find/.test(rd.e.message), `delAll error: ${rd.e && rd.e.message}`) //S5
            assert.deepStrictEqual(left, ALL) //S2 S3 資料不變
            assert.deepStrictEqual(evs, ['select', 'delAll']) //S5 各發一次 error 事件
        })
    })

    //欄名不存在或大小寫變體: 檢核不查 schema, 由資料庫回報(設計限制); 仍須 reject 且資料不變
    let dbRej = [
        ['nonexistent column', () => ({ nocol: 1 })],
        ['case variant column', () => ({ Name: 'aa' })],
    ]
    dbRej.forEach(([label, mkFind]) => {
        it(`should reject select and delAll and keep all rows by ${label}`, async function() {
            let wo = mk()
            await reset()
            let rs = await settle(wo.select(mkFind()))
            let rd = await settle(wo.delAll(mkFind()))
            assert.strictEqual(rs.ok, false) //S2
            assert.strictEqual(rd.ok, false) //S2
            assert.deepStrictEqual(await remain(), ALL)
        })
    })

    it('should get [] and delete 0 for $in [] on a nonexistent column (constant false does not reference the column, documented limit)', async function() {
        let wo = mk()
        await reset()
        assert.deepStrictEqual(await wo.select({ nocol: { $in: [] } }), []) //S4 恆假
        let rd = await wo.delAll({ nocol: { $in: [] } })
        assert.strictEqual(rd.n, 0)
        assert.deepStrictEqual(await remain(), ALL)
    })
})


describe('find: top-level value that is not a condition object rejects the whole batch (user ruling B, dspec 〈一之一〉)', function() {
    //裁示 B: delAll()/select 的 find 為 undefined 或 {} 才是全部; 其餘非條件物件之值(null、陣列含 []/[{...}]、字串、數值、布林、函數、
    //Date、RegExp、Map、Set、類別實例…)一律整批 reject, 不得視為 {}, 不得以現況如此為由維持.
    class Cond {
        constructor() {
            this.name = 'aa'
        }
    }
    let bads = [
        ['null', () => null], ['false', () => false], ['true', () => true], ['0', () => 0], ['empty string', () => ''], ['number 5', () => 5], ['NaN', () => NaN],
        ['string "aa"', () => 'aa'], ['empty array', () => []], ['array of empty objects', () => [{}, {}]], ['array [{name:"aa"}]', () => [{ name: 'aa' }]],
        ['array AND-combined', () => [{ name: 'aa' }, { value: { $gt: 2 } }]], ['array holding a nested array', () => [[{ name: 'aa' }]]],
        ['array holding undefined value', () => [{ name: undefined }]], ['array holding $nor', () => [{ $nor: [{ value: 1 }] }]],
        ['function', () => () => ({})], ['Date', () => new Date(0)], ['RegExp', () => /aa/], ['Map', () => new Map()], ['Set', () => new Set()], ['class instance', () => new Cond()],
    ]
    bads.forEach(([label, mkFind]) => {
        it(`should reject select and delAll and keep all rows by top-level ${label}`, async function() {
            let wo = mk()
            await reset()
            let evs = []
            wo.on('error', (mode) => evs.push(mode))
            let rs = await settle(wo.select(mkFind()))
            let rd = await settle(wo.delAll(mkFind()))
            assert.strictEqual(rs.ok, false) //裁示 B
            assert.strictEqual(rd.ok, false) //裁示 B
            assert.ok(rs.e instanceof Error && /invalid find/.test(rs.e.message), `select error: ${rs.e && rs.e.message}`)
            assert.ok(rd.e instanceof Error && /invalid find/.test(rd.e.message), `delAll error: ${rd.e && rd.e.message}`)
            assert.deepStrictEqual(await remain(), ALL) //資料不變
            assert.deepStrictEqual(evs, ['select', 'delAll']) //S5 各發一次 error 事件
        })
    })
    it('should treat only undefined and {} as all rows (select and delAll)', async function() {
        let wo = mk()
        await reset()
        assert.deepStrictEqual(sortNum((await wo.select()).map((x) => x.time)), ALL)
        assert.deepStrictEqual(sortNum((await wo.select({})).map((x) => x.time)), ALL)
        assert.deepStrictEqual(sortNum((await wo.select(undefined)).map((x) => x.time)), ALL)
        let rd = await wo.delAll()
        assert.strictEqual(rd.n, ALL.length)
        assert.deepStrictEqual(await remain(), [])
        await reset()
        rd = await wo.delAll({})
        assert.strictEqual(rd.n, ALL.length)
        assert.deepStrictEqual(await remain(), [])
    })
})


describe('find: exceptions thrown while validating caller objects are always reported as invalid find/order (S5, R1)', function() {
    it('should reject with an Error and emit one error event even if the thrown object cannot be read (message getter throws)', async function() {
        await reset()
        let o = {}
        Object.defineProperty(o, 'message', {
            get() {
                throw o
            }
        })
        let bad = () => ({
            get [Symbol.toStringTag]() {
                throw o
            }
        })
        let evs = []
        let wo = mk()
        wo.on('error', (mode) => evs.push(mode))
        let rs = await settle(wo.select({ name: bad() }))
        let rd = await settle(wo.delAll({ name: bad() }))
        let ro = await settle(wo.select({}, bad()))
        assert.strictEqual(rs.ok, false)
        assert.strictEqual(rd.ok, false)
        assert.strictEqual(ro.ok, false)
        assert.ok(rs.e instanceof Error && /^invalid find/.test(rs.e.message), `select: ${rs.e && rs.e.message}`)
        assert.ok(rd.e instanceof Error && /^invalid find/.test(rd.e.message), `delAll: ${rd.e && rd.e.message}`)
        assert.ok(ro.e instanceof Error && /^invalid order/.test(ro.e.message), `order: ${ro.e && ro.e.message}`)
        assert.deepStrictEqual(evs, ['select', 'delAll', 'select']) //S5 各發一次
        assert.deepStrictEqual(await remain(), ALL)
    })
})


describe('find: pk based functions with $..$ string (S6)', function() {
    it('should get null for selectByPk("$time$")', async function() {
        await reset()
        assert.strictEqual(await mk().selectByPk('$time$'), null) //S6
    })
    it('should get ok:0 and keep all rows for del({time:"$time$"})', async function() {
        await reset()
        let r = await mk().del({ time: '$time$' })
        assert.strictEqual(r[0].ok, 0) //S6
        assert.strictEqual(r[0].nDeleted, 0)
        assert.deepStrictEqual(await remain(), ALL)
    })
    it('should reject and keep all rows for save({time:"$time$"}, {autoInsert:false})', async function() {
        await reset()
        let rd = await settle(mk().save({ time: '$time$', name: 'zz' }, { autoInsert: false }))
        assert.strictEqual(rd.ok, false) //S6
        let names = (await admin.query(`SELECT name FROM ${CL} ORDER BY time`)).rows.map((x) => x.name)
        assert.deepStrictEqual(names, SEED.map((r) => r.name))
    })
})


describe('find: order (S7)', function() {
    let oks = [
        ['{time:"desc"}', { time: 'desc' }, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]],
        ['{time:"DESC"}', { time: 'DESC' }, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]],
        ['{tag:"asc nulls last", time:"asc"}', { tag: 'asc nulls last', time: 'asc' }, [1, 4, 6, 10, 2, 7, 5, 9, 3, 8]],
        ['{} (no order)', {}, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
        ['null (no order)', null, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
    ]
    oks.forEach(([label, order, want]) => {
        it(`should get ${JSON.stringify(want)} for select by order ${label}`, async function() {
            await reset()
            let rs = await mk().select({}, order)
            assert.deepStrictEqual(rs.map((x) => x.time), want) //S7 正向
        })
    })
    let bads = [
        ['injection in direction', { time: 'asc; delete from tfind' }],
        ['subquery in direction', { time: 'asc, (select 1)' }],
        ['injection in key', { 'time) desc, (select 1': 'asc' }],
        ['number direction -1', { time: -1 }],
        ['number direction 1', { time: 1 }],
        ['undefined direction', { time: undefined }],
        ['raw string', 'time desc'],
        ['raw array', ['time desc']],
    ]
    bads.forEach(([label, order]) => {
        it(`should reject select and keep all rows by order ${label}`, async function() {
            await reset()
            let evs = []
            let wo = mk()
            wo.on('error', (mode) => evs.push(mode))
            let rs = await settle(wo.select({}, order))
            assert.strictEqual(rs.ok, false) //S7
            assert.ok(rs.e instanceof Error && /invalid order/.test(rs.e.message), rs.e && rs.e.message) //S5
            assert.deepStrictEqual(await remain(), ALL) //S7 資料不變
            assert.deepStrictEqual(evs, ['select']) //S5
        })
    })
    it('should reject order injection even when find has bound parameters (error-based leak)', async function() {
        await reset()
        let rs = await settle(mk().select({ name: 'aa' }, { time: 'asc, (select cast(pw as int) from tsecret)' }))
        assert.strictEqual(rs.ok, false)
        assert.ok(!/s3cret/.test(rs.e.message), 'error message must not carry other table values') //S7
    })
})


describe('find: useCache (S8)', function() {
    it('should reject invalid find even if the same cache key was filled by a valid find', async function() {
        await reset()
        let wo = mk({ useCache: true })
        assert.strictEqual((await wo.select({})).length, 10)
        let r = await settle(wo.select({ name: undefined })) //JSON.stringify 後與 {} 同鍵
        assert.strictEqual(r.ok, false) //S8
    })
    it('should not mix results of $in [null] with invalid $in [undefined] in cache', async function() {
        await reset()
        let wo = mk({ useCache: true })
        let a = await settle(wo.select({ name: { $in: [undefined] } }))
        assert.strictEqual(a.ok, false)
        let b = await wo.select({ name: { $in: [null] } })
        assert.deepStrictEqual(b.map((x) => x.time), [5]) //S8
    })
    it('should resolve bigint find with cache on (no TypeError from JSON.stringify)', async function() {
        await reset()
        let wo = mk({ useCache: true })
        let b = await wo.select({ time: 3n })
        assert.deepStrictEqual(b.map((x) => x.time), [3])
        let c = await wo.select({ time: 3n })
        assert.deepStrictEqual(c.map((x) => x.time), [3]) //S8
    })
    it('should keep cache keys distinct for Date value and its ISO string (different result sets)', async function() {
        await reset()
        await admin.query('ALTER TABLE tfind ADD COLUMN s TEXT')
        await admin.query('UPDATE tfind SET s = $1 WHERE time = 1', ['2020-01-01T00:00:00.000Z'])
        let wo = mk({ useCache: true })
        let d = new Date('2020-01-01T00:00:00.000Z')
        let rd = await wo.select({ s: d.toISOString() })
        let rt = await wo.select({ s: d })
        assert.deepStrictEqual(rd.map((x) => x.time), [1])
        //Date 以 pg 序列化為本地時間字串, 與 ISO 字串比對 TEXT 欄之結果集合可不同; 重點為第二次查詢不得取到第一次之快取
        let direct = await mk().select({ s: d })
        assert.deepStrictEqual(rt.map((x) => x.time), direct.map((x) => x.time)) //S8
    })
    it('should share cache between selectByPk(pk) and select({[pk]: pk}) (R4)', async function() {
        await reset()
        let wo = mk({ useCache: true })
        let a = await wo.select({ time: 2 })
        assert.strictEqual(a[0].name, 'bb')
        await admin.query(`UPDATE ${CL} SET name = $1 WHERE time = 2`, ['changed-outside'])
        let b = await wo.selectByPk(2)
        assert.strictEqual(b.name, 'bb') //R4 取到 select 填入之快取(單程序快取語意)
        let c = await mk().selectByPk(2) //未啟用快取之實例讀 DB
        assert.strictEqual(c.name, 'changed-outside')
    })
    it('should keep legacy reject types: select rejects with Error, delAll with the db message string (Q10, unchanged)', async function() {
        await reset()
        let wo = mk()
        let rs = await settle(wo.select({ nocol: 1 }))
        let rd = await settle(wo.delAll({ nocol: 1 }))
        assert.strictEqual(rs.ok, false)
        assert.strictEqual(rd.ok, false)
        assert.ok(rs.e instanceof Error)
        assert.strictEqual(typeof rd.e, 'string') //既有行為, 不改以免破壞呼叫端; 新檢核之錯誤(invalid find)一律為 Error
    })
    it('should clear cache by delAll and not return deleted rows', async function() {
        await reset()
        let wo = mk({ useCache: true })
        assert.strictEqual((await wo.select({})).length, 10)
        await wo.delAll({ name: 'aa' })
        assert.strictEqual((await wo.select({})).length, 8)
    })
})


describe('find: Object.prototype pollution of query options does not change select and delAll (R1)', function() {
    it('should return and delete exactly the rows of the find although limit, columns, expression, $custom and order options are polluted', async function() {
        await reset()
        let wo = mk()
        Object.prototype.limit = 1
        Object.prototype.columns = ['1']
        Object.prototype.expression = 'select 1; select 1; --'
        Object.prototype.$custom = ['true']
        Object.prototype.zzorder = 'asc; delete from tfind'
        let a
        let b
        let c
        try {
            a = await wo.select({ name: 'aa' }, { time: 'desc' })
            b = await wo.select({ $or: [{ value: 1 }, { value: { $in: [2, 3] } }] })
            c = await wo.delAll({ value: { $gt: 8 } })
        }
        finally {
            delete Object.prototype.limit
            delete Object.prototype.columns
            delete Object.prototype.expression
            delete Object.prototype.$custom
            delete Object.prototype.zzorder
        }
        assert.deepStrictEqual(a.map((x) => x.time), [4, 1]) //S2 不受汙染影響
        assert.deepStrictEqual(sortNum(b.map((x) => x.time)), [1, 2, 3])
        assert.strictEqual(c.n, 2)
        assert.deepStrictEqual(await remain(), [1, 2, 3, 4, 5, 6, 7, 8])
    })
})


describe('find: table names that break the $nin rewrite of mongo-sql (R1)', function() {
    it('should reject $nin (instead of silently becoming $in) for a table name containing "$", and still support the other operators', async function() {
        await admin.query('DROP TABLE IF EXISTS "t$nin"')
        await admin.query('CREATE TABLE "t$nin" (time INTEGER PRIMARY KEY, a TEXT)')
        await admin.query('INSERT INTO "t$nin" VALUES (1, $1), (2, $2)', ['x', 'y'])
        let wo = WOrm({ url: ct.url, db: ct.db, cl: 't$nin' })
        let r = await settle(wo.select({ a: { $nin: ['x'] } }))
        assert.strictEqual(r.ok, false) //S2 不得靜默變成 $in
        assert.ok(r.e instanceof Error && /\$nin is not supported with this table name/.test(r.e.message), r.e && r.e.message) //S5
        let d = await settle(wo.delAll({ a: { $nin: ['x'] } }))
        assert.strictEqual(d.ok, false)
        assert.strictEqual((await admin.query('SELECT count(*)::int AS c FROM "t$nin"')).rows[0].c, 2)
        assert.deepStrictEqual((await wo.select({ a: { $in: ['x'] } })).map((x) => x.time), [1]) //S4 其他運算子照常
        assert.deepStrictEqual((await wo.select({ a: { $not: { $in: ['x'] } } })).map((x) => x.time), [2])
        await admin.query('DROP TABLE "t$nin"')
    })
    it('should keep $nin working for ordinary table names', async function() {
        await reset()
        let r = await mk().select({ tag: { $nin: ['x'] } })
        assert.deepStrictEqual(sortNum(r.map((x) => x.time)), ids((x) => nn(x.tag) && x.tag !== 'x'))
    })
})
