/* eslint-disable no-sparse-arrays, no-extend-native -- 測試刻意以稀疏陣列驗證 reject, 並暫時汙染原型(finally 還原)驗證免疫 */
import assert from 'assert'
import pg from 'pg'
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
//  S9–S14(第 33 項批 1, 系列條件白名單): 形狀檢核由 wsemi cvOrmFind 擁有(R11), 案例表逐案測試在 api-find-whitelist.test.mjs;
//  本檔保留 pg 專屬案(布林 $ne 三值 S12, 首尾 $ 字串, JSON/轉型鍵移除 S14, 63 bytes 欄名, 系統欄, 表名, 快取, 敵意輸入)
//SQL 產生改由 knex(mongo-sql 移除)之行為變更(tmp/brief-tests.md〈本次裁示的行為變更〉第 1–9 點):
//  1 首尾皆 $ 之字串於所有比較運算子皆為字面值($gt $gte $lt $lte 亦然), $nin 之表名守門移除
//  2 欄名 Infinity 合法(欄是否存在由 PG 回報)    3 系統欄名 ctid tableoid xmin xmax cmin cmax 於 find/order 拒收(oid 不拒)
//  4 欄名等於函數名或表名時 PG 回報欄不存在(42703), 條件不再對全表成立(第 76 項)    5 order 鍵僅識別字
//  6 預引號表名可用    8 Object.prototype 汙染: SQL 不變, 或以 statement check fail-closed reject, 不得靜默改寫


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
    //name 以 COLLATE "C"(位元組序)建欄, 令字串大小比較之預期可由 JS 字串比較(ASCII 範圍內同序)獨立推得, 不隨伺服器預設定序而變
    await admin.query(`CREATE TABLE ${CL} (time INTEGER PRIMARY KEY, name TEXT COLLATE "C", value DOUBLE PRECISION, tag TEXT, ok BOOLEAN, js JSONB)`)
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
        ['$eq', () => ({ name: { $eq: 'aa' } }), (r) => r.name === 'aa'],
        ['$eq null', () => ({ tag: { $eq: null } }), (r) => r.tag === null],
        ['$eq number', () => ({ value: { $eq: 5 } }), (r) => r.value === 5],
        ['$eq true', () => ({ ok: { $eq: true } }), (r) => r.ok === true],
        ['$eq + $ne on one column', () => ({ value: { $eq: 5, $ne: 4 } }), (r) => r.value === 5],
        ['$ne (excludes NULL)', () => ({ name: { $ne: 'aa' } }), (r) => nn(r.name) && r.name !== 'aa'],
        ['$gt', () => ({ value: { $gt: 5 } }), (r) => r.value > 5],
        ['$gte', () => ({ value: { $gte: 5 } }), (r) => r.value >= 5],
        ['$lt', () => ({ value: { $lt: 3 } }), (r) => r.value < 3],
        ['$lte', () => ({ value: { $lte: 3 } }), (r) => r.value <= 3],
        ['$gt+$lt', () => ({ value: { $gt: 2, $lt: 6 } }), (r) => r.value > 2 && r.value < 6],
        ['$in', () => ({ value: { $in: [1, 2] } }), (r) => [1, 2].includes(r.value)],
        ['$in [] is constant false', () => ({ value: { $in: [] } }), () => false],
        ['$in literal $..$ string', () => ({ name: { $in: ['$name$'] } }), (r) => r.name === '$name$'],
        ['$nin (excludes NULL)', () => ({ tag: { $nin: ['x'] } }), (r) => nn(r.tag) && r.tag !== 'x'],
        ['portable: exclude NULL with $and of $ne null', () => ({ $and: [{ tag: { $ne: null } }, { tag: { $ne: 'x' } }] }), (r) => nn(r.tag) && r.tag !== 'x'],
        ['portable: include NULL with $or of null', () => ({ $or: [{ tag: null }, { tag: { $ne: 'x' } }] }), (r) => r.tag === null || r.tag !== 'x'],
        ['eq null', () => ({ tag: null }), (r) => r.tag === null],
        ['$ne null', () => ({ tag: { $ne: null } }), (r) => nn(r.tag)],
        ['eq boolean', () => ({ ok: true }), (r) => r.ok === true],
        //布林 $ne 為 SQL 三值(S12): 不含 NULL 列(原 IS NOT TRUE / IS NOT FALSE 含 NULL 列)
        ['$ne true (SQL three-valued, excludes NULL)', () => ({ ok: { $ne: true } }), (r) => r.ok === false],
        ['$ne false (SQL three-valued, excludes NULL)', () => ({ ok: { $ne: false } }), (r) => r.ok === true],
        ['$eq false + $ne true (both mean ok is false)', () => ({ ok: { $eq: false, $ne: true } }), (r) => r.ok === false],
        ['$eq true + $ne true (contradiction, empty set)', () => ({ ok: { $eq: true, $ne: true } }), () => false],
        //首尾皆 $ 之字串為字面值(行為變更 1: 所有比較運算子皆為綁定參數之字面值, 不再具欄引用義, 亦不再改寫為 $in/$nin)
        ['eq "$name$" string (literal)', () => ({ name: '$name$' }), (r) => r.name === '$name$'],
        ['$nin ["$name$"] (literal, excludes NULL)', () => ({ name: { $nin: ['$name$'] } }), (r) => nn(r.name) && r.name !== '$name$'],
        //$gt $gte $lt $lte 給首尾 $ 字串: 原 reject(S13 舊規), 今為字面值比較; name 欄為 COLLATE "C", 預期以 JS 字串比較(同為碼位序)推得.
        //若被當成欄引用(name > name)則恆為假或僅等值列, 與下列預期不同
        ['$gt "$name$" string (literal, behavior change 1)', () => ({ name: { $gt: '$name$' } }), (r) => nn(r.name) && r.name > '$name$'],
        ['$gte "$name$" string (literal, behavior change 1)', () => ({ name: { $gte: '$name$' } }), (r) => nn(r.name) && r.name >= '$name$'],
        ['$lt "$zz$" string (literal, behavior change 1)', () => ({ name: { $lt: '$zz$' } }), (r) => nn(r.name) && r.name < '$zz$'],
        ['$lte "$name$" string (literal, behavior change 1)', () => ({ name: { $lte: '$name$' } }), (r) => nn(r.name) && r.name <= '$name$'],
        ['$gt "$name$" + $lt "b" (literal range)', () => ({ name: { $gt: '$name$', $lt: 'b' } }), (r) => nn(r.name) && r.name > '$name$' && r.name < 'b'],
        ['$eq "$name$" string (literal)', () => ({ name: { $eq: '$name$' } }), (r) => r.name === '$name$'],
        ['$ne "$name$" string (literal, excludes NULL)', () => ({ name: { $ne: '$name$' } }), (r) => nn(r.name) && r.name !== '$name$'],
        ['$eq "$name$" + $in with same operator slot', () => ({ name: { $eq: '$name$', $in: ['$name$', 'aa'] } }), (r) => r.name === '$name$'],
        ['$ne "$name$" + $nin with same operator slot', () => ({ name: { $ne: '$name$', $nin: ['aa'] } }), (r) => nn(r.name) && r.name !== '$name$' && r.name !== 'aa'],
        //反序之碰撞: 先到者占位, 後到者併入 $and(不得靜默覆蓋或丟棄)
        ['$ne true then $eq true (contradiction, empty set)', () => ({ ok: { $ne: true, $eq: true } }), () => false],
        ['$ne true then $eq false (same meaning)', () => ({ ok: { $ne: true, $eq: false } }), (r) => r.ok === false],
        ['$ne false then $eq false (contradiction, empty set)', () => ({ ok: { $ne: false, $eq: false } }), () => false],
        ['$nin then $ne "$name$"', () => ({ name: { $nin: ['aa'], $ne: '$name$' } }), (r) => nn(r.name) && r.name !== 'aa' && r.name !== '$name$'],
        ['$in then $eq "$name$" (the $eq goes to $and)', () => ({ name: { $in: ['aa', '$name$'], $eq: '$name$' } }), (r) => r.name === '$name$'],
        ['collision inside an $or element beside a user $and', () => ({ $or: [{ ok: { $ne: true, $eq: false }, $and: [{ value: { $lt: 5 } }] }, { value: 10 }] }), (r) => (r.ok === false && r.value < 5) || r.value === 10],
        ['collision beside a user $or (the moved condition must not join the $or)', () => ({ ok: { $eq: true, $ne: true }, $or: [{ value: 1 }, { value: 2 }] }), () => false],
        ['collision beside a user $or (same meaning)', () => ({ ok: { $eq: true, $ne: false }, $or: [{ value: 1 }, { value: 2 }] }), (r) => r.ok === true && (r.value === 1 || r.value === 2)],
        ['two columns collide independently', () => ({ ok: { $eq: false, $ne: true }, name: { $eq: '$name$', $in: ['aa', '$name$'] } }), (r) => r.ok === false && r.name === '$name$'],
        ['eq "$" string (literal)', () => ({ name: '$' }), () => false],
        ['"$name$" string beside other columns and $or', () => ({ name: '$name$', $or: [{ value: 6 }, { value: 99 }] }), (r) => r.name === '$name$' && (r.value === 6 || r.value === 99)],
        ['$and', () => ({ $and: [{ value: { $gt: 2 } }, { value: { $lt: 6 } }] }), (r) => r.value > 2 && r.value < 6],
        ['$or', () => ({ $or: [{ value: { $lte: 1 } }, { value: { $gte: 10 } }] }), (r) => r.value <= 1 || r.value >= 10],
        ['README nested $or/$and', () => ({ $or: [{ $and: [{ value: { $ne: 4 } }, { value: { $in: [4, 5, 6] } }, { value: { $nin: [6, 7] } }] }, { $or: [{ value: { $lte: -1 } }, { value: { $gte: 10 } }] }] }), (r) => (r.value !== 4 && [4, 5, 6].includes(r.value) && ![6, 7].includes(r.value)) || r.value <= -1 || r.value >= 10],
        ['multi columns AND', () => ({ name: 'aa', value: { $gt: 1 } }), (r) => r.name === 'aa' && r.value > 1],
        ['column + $or', () => ({ name: 'aa', $or: [{ value: 1 }, { value: 4 }] }), (r) => r.name === 'aa' && (r.value === 1 || r.value === 4)],
        ['numeric string for numeric column (PG converts by column type)', () => ({ value: '5' }), (r) => r.value === 5],
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
        //第 33 項批 1 自白名單移除之運算子(R11, S9): 原可用, 今 reject
        ['$equals (alias removed, use $eq)', () => col({ $equals: 'aa' })],
        ['$like (removed)', () => col({ $like: 'a%' })],
        ['$ilike (removed)', () => col({ $ilike: 'a%' })],
        ['$null true (removed)', () => ({ tag: { $null: true } })],
        ['$null false (removed)', () => ({ tag: { $null: false } })],
        ['$notNull true (removed)', () => ({ tag: { $notNull: true } })],
        ['$notNull false (removed)', () => ({ tag: { $notNull: false } })],
        ['$not scalar (removed)', () => col({ $not: 'aa' })],
        ['$not operator object (removed)', () => ({ value: { $not: { $gt: 5 } } })],
        ['$not $in (removed)', () => ({ name: { $not: { $in: ['aa', 'bb'] } } })],
        ['$in with null (removed)', () => ({ tag: { $in: ['x', null] } })],
        ['$in [null] (removed)', () => ({ tag: { $in: [null] } })],
        ['$nin [null] (removed)', () => ({ tag: { $nin: [null] } })],
        ['$nin with $notNull (removed)', () => ({ tag: { $nin: ['x'], $notNull: true } })],
        ['bigint value (removed)', () => ({ time: 3n })],
        ['bigint in $in (removed)', () => ({ time: { $in: [3n] } })],
        ['bigint in $gt (removed)', () => ({ time: { $gt: 3n } })],
        ['Buffer value (removed)', () => ({ name: Buffer.from('aa') })],
        ['Buffer in $in (removed)', () => ({ name: { $in: [Buffer.from('aa')] } })],
        ['$and with {} element (removed: was dropped as constant true)', () => ({ $and: [{ name: 'aa' }, {}] })],
        ['$and with {} first (removed)', () => ({ $and: [{}, { name: 'aa' }] })],
        ['JSON path ->> (removed)', () => ({ 'js->>k': '1' })],
        ['JSON path -> (removed)', () => ({ 'js->k': '1' })],
        ['JSON path #>> (removed)', () => ({ 'js#>>k': '1' })],
        ['JSON path #> (removed)', () => ({ 'js#>k': '1' })],
        ['JSON path multi (removed)', () => ({ 'js->k->>k': '1' })],
        ['JSON path array index (removed)', () => ({ 'js->>0': '1' })],
        ['JSON path with $nin (removed)', () => ({ 'js->>k': { $nin: ['1'] } })],
        ['cast key (removed)', () => ({ 'value::text': '5' })],
        ['cast key with operator (removed)', () => ({ 'value::text': { $gte: '5' } })],
        //首尾皆 $ 之字串於 $gt $gte $lt $lte 原為 reject(pg 專屬限制), 行為變更 1 起為字面值, 已移至 supported operators(S1 對拍)
        //共用層上限(wsemi 預設): $and/$or 1000、$in/$nin 10000、欄名 128、pg 欄名 63 bytes、綁定參數 65535
        ['$or with 1001 elements', () => ({ $or: Array.from({ length: 1001 }, (_, i) => ({ value: i })) })],
        ['$and with 1001 elements', () => ({ $and: Array.from({ length: 1001 }, (_, i) => ({ value: { $ne: i } })) })],
        ['$in with 10001 elements', () => ({ value: { $in: Array.from({ length: 10001 }, (_, i) => i) } })],
        ['$nin with 10001 elements', () => ({ value: { $nin: Array.from({ length: 10001 }, (_, i) => i) } })],
        ['column name of 129 chars', () => ({ ['c'.repeat(129)]: 1 })],
        ['bound parameters over 65535 (7 x $in of 10000)', () => ({ $or: Array.from({ length: 7 }, (_, k) => ({ value: { $in: Array.from({ length: 10000 }, (_, i) => i + k * 10000) } })) })],
        //原型被改為 null 之內建品牌物件(頂層與非頂層), 頂層 Proxy 空物件(空即全部須為可證明之真實空物件)
        ['top Map with null prototype', () => Object.setPrototypeOf(new Map([['name', 'aa']]), null)],
        ['top Set with Object.prototype', () => Object.setPrototypeOf(new Set(['aa']), Object.prototype)],
        ['Map with null prototype and own key inside $or', () => ({ $or: [Object.assign(Object.setPrototypeOf(new Map(), null), { name: 'aa' })] })],
        ['top empty Proxy', () => new Proxy({}, {})],
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
        //欄名 Infinity 原於 pg 第二階段拒收(mongo-sql 視為陣列索引), 行為變更 2 起合法, 移至下方 dbRej(由 PG 回報欄不存在)與 Infinity 正向案
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

    //欄名不存在或大小寫變體: 檢核不查 schema, 由資料庫回報(設計限制); 仍須 reject 且資料不變.
    //select 以 PG 錯誤物件 reject(SQLSTATE 42703 undefined_column), delAll 以字串(err.message, 既有 Q10)reject, 各發 1 次 error 事件(行為變更 4、7、9)
    let dbRej = [
        ['nonexistent column', () => ({ nocol: 1 })],
        ['case variant column', () => ({ Name: 'aa' })],
        ['column Infinity (valid name since behavior change 2, not in this table)', () => ({ Infinity: 5 })],
        ['column Infinity inside an $or', () => ({ $or: [{ name: 'aa' }, { Infinity: { $gt: 0 } }] })],
        ['column equal to the table name ($ne)', () => ({ [CL]: { $ne: 1 } })],
        ['column equal to the table name (null)', () => ({ [CL]: null })],
        ['column oid (not blocked, PostgreSQL 17 tables have no oid column)', () => ({ oid: { $gt: 0 } })],
    ]
    dbRej.forEach(([label, mkFind]) => {
        it(`should reject select and delAll by the database and keep all rows by ${label}`, async function() {
            let wo = mk()
            let evs = []
            wo.on('error', (mode) => evs.push(mode))
            await reset()
            let rs = await settle(wo.select(mkFind()))
            let rd = await settle(wo.delAll(mkFind()))
            assert.strictEqual(rs.ok, false) //S2
            assert.strictEqual(rd.ok, false) //S2
            assert.ok(rs.e instanceof Error && rs.e.code === '42703', `select: ${rs.e && rs.e.code} ${rs.e && rs.e.message}`) //行為變更 4 欄不存在由 PG 回報
            assert.ok(/does not exist/.test(rs.e.message), rs.e.message) //行為變更 7
            assert.ok(typeof rd.e === 'string' && /does not exist/.test(rd.e), `delAll: ${rd.e}`) //Q10 delAll 之 DB 錯誤為字串
            assert.deepStrictEqual(await remain(), ALL) //資料不變
            assert.deepStrictEqual(evs, ['select', 'delAll']) //S5 各發一次
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


describe('find: pk based functions with a $..$ string on an INTEGER pk are an ordinary PostgreSQL type error, never a column reference (S6 after R4; the TEXT pk behaviour is in api-write-safety)', function() {
    it('should get null for selectByPk("$time$") (type error of the INTEGER pk column, not the first row)', async function() {
        await reset()
        assert.strictEqual(await mk().selectByPk('$time$'), null) //S6
    })
    it('should get ok:0 (PostgreSQL type error) and keep all rows for del({time:"$time$"})', async function() {
        await reset()
        let r = await mk().del({ time: '$time$' })
        assert.strictEqual(r[0].ok, 0) //S6
        assert.strictEqual(r[0].nDeleted, 0)
        assert.deepStrictEqual(await remain(), ALL)
    })
    it('should reject (PostgreSQL type error) and keep all rows for save({time:"$time$"}, {autoInsert:false})', async function() {
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
    //order 鍵僅識別字(行為變更 5): JSON 取值鍵、::轉型鍵(原 cvOrder 舊文法可用)與系統欄名(行為變更 3)一律 invalid order, 訊息指出該鍵
    let keyBads = [
        ['js->>k', 'desc'],
        ['js->k', 'asc'],
        ['js#>k', 'asc'],
        ['js#>>k', 'desc nulls last'],
        ['value::text', 'asc'],
        ['js->>k::int', 'asc'],
        ['ctid', 'asc'],
        ['tableoid', 'desc'],
        ['xmin', 'asc'],
        ['xmax', 'asc'],
        ['cmin', 'asc'],
        ['cmax', 'desc'],
    ]
    keyBads.forEach(([k, dir]) => {
        it(`should reject select with invalid order for the order key ${k} and keep all rows (behavior change 5)`, async function() {
            await reset()
            let evs = []
            let wo = mk()
            wo.on('error', (mode) => evs.push(mode))
            let rs = await settle(wo.select({ name: 'aa' }, { time: 'asc', [k]: dir }))
            assert.strictEqual(rs.ok, false) //S7
            assert.ok(rs.e instanceof Error, String(rs.e)) //S5
            assert.strictEqual(rs.e.message, `invalid order: unsupported column name [${k}] at [order.${k}]`) //行為變更 5
            assert.deepStrictEqual(await remain(), ALL) //資料不變
            assert.deepStrictEqual(evs, ['select']) //S5 恰 1 次
        })
    })
    it('should order by a column named Infinity once it exists (behavior change 2)', async function() {
        await admin.query('DROP TABLE IF EXISTS tinf')
        await admin.query('CREATE TABLE tinf (id INTEGER PRIMARY KEY, "Infinity" INTEGER)')
        await admin.query('INSERT INTO tinf VALUES (1, 5), (2, 6), (3, NULL)')
        try {
            let wo = WOrm({ url: ct.url, db: ct.db, cl: 'tinf', pk: 'id' })
            assert.deepStrictEqual((await wo.select({}, { Infinity: 'desc nulls last' })).map((x) => x.id), [2, 1, 3]) //S7
            assert.deepStrictEqual((await wo.select({}, { Infinity: 'asc nulls first' })).map((x) => x.id), [3, 1, 2])
        }
        finally {
            await admin.query('DROP TABLE IF EXISTS tinf')
        }
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
    it('should not mix results of {name: null} with invalid $in [undefined] in cache', async function() {
        await reset()
        let wo = mk({ useCache: true })
        let a = await settle(wo.select({ name: { $in: [undefined] } }))
        assert.strictEqual(a.ok, false)
        let b = await wo.select({ name: null })
        assert.deepStrictEqual(b.map((x) => x.time), [5]) //S8
    })
    it('should reject a bigint find with cache on as invalid find (no TypeError from JSON.stringify), also after a valid cached query', async function() {
        await reset()
        let wo = mk({ useCache: true })
        let b = await wo.select({ time: 3 })
        assert.deepStrictEqual(b.map((x) => x.time), [3])
        let c = await settle(wo.select({ time: 3n }))
        assert.strictEqual(c.ok, false) //S8 第 33 項批 1: bigint 不在白名單
        assert.ok(c.e instanceof Error && /^invalid find: /.test(c.e.message), c.e && c.e.message)
    })
    it('should serve a repeated {$eq: v} find from the cache of the same instance (same normalized find) but not for another instance', async function() {
        await reset()
        let wo = mk({ useCache: true })
        let a = await wo.select({ name: { $eq: 'aa' } })
        await admin.query(`UPDATE ${CL} SET name = $1 WHERE time = 1`, ['zz'])
        let b = await wo.select({ name: { $eq: 'aa' } })
        assert.deepStrictEqual(b.map((x) => x.time), a.map((x) => x.time)) //同一正規化 find 取快取
        let c = await mk().select({ name: { $eq: 'aa' } })
        assert.deepStrictEqual(c.map((x) => x.time), [4]) //未啟用快取之實例讀 DB
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
    it('should share one cache key between {name:"aa"} and {$and:[{name:"aa"}]} (same condition, IR source path ignored), but not with another condition (S8)', async function() {
        await reset()
        let wo = mk({ useCache: true })
        let a = await wo.select({ name: 'aa' })
        assert.deepStrictEqual(sortNum(a.map((x) => x.time)), [1, 4])
        await admin.query(`UPDATE ${CL} SET name = $1 WHERE time = 1`, ['changed-outside'])
        let b = await wo.select({ $and: [{ name: 'aa' }] })
        assert.deepStrictEqual(sortNum(b.map((x) => x.time)), [1, 4]) //S8 單項 $and 與原條件同語意, 取同一快取(單程序快取語意)
        let c = await wo.select({ name: { $in: ['aa'] } })
        assert.deepStrictEqual(c.map((x) => x.time), [4]) //S8 不同條件(in)不得取到上一筆快取, 讀 DB
        let d = await wo.select({ $and: [{ name: 'aa' }] }, { time: 'desc' })
        assert.deepStrictEqual(d.map((x) => x.time), [4]) //S8 order 不同即不同快取鍵
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


describe('find: Object.prototype pollution of option names read inside knex keeps the statement or fails closed (R1, behavior change 8)', function() {
    //汙染值為資料型(JSON 可造: 數值、字串、陣列、物件、布林), 每案只汙染一個 knex 內部可能讀取之屬性名, 只在被測呼叫期間汙染, finally 還原.
    //判準(行為變更 8): (a) 結果與無汙染時完全相同(select 命中集合、delAll 刪除集合), 或
    //(b) reject 且訊息含 statement check、資料不變、未刪任何列、恰 1 次 error 事件; 第三種(命中集合不同、刪錯列、其他錯誤)一律紅
    let PROPS = ['limit', 'offset', 'join', 'having', 'schema', 'only', 'distinct', 'returning', 'using', 'union', 'group', 'columns', 'expression', 'order', 'wrapIdentifier']
    let VALS = [['5', 5], ['\'x\'', 'x'], ['[\'a\']', ['a']], ['{a:1}', { a: 1 }], ['true', true]]
    let WANT = ids((r) => r.name === 'aa') //無汙染時 {name:'aa'} 之命中集合 = 刪除集合(手寫述語)
    let reClosed = /^invalid (find|order): internal statement check failed \(statement check\): .+ at \[(find|order)\]$/

    //polluted, 汙染 pairs 後執行 fn, finally 一律還原(汙染前須不存在, 以免誤刪既有屬性)
    let polluted = async (pairs, fn) => {
        for (let [k] of pairs) {
            assert.ok(Object.getOwnPropertyDescriptor(Object.prototype, k) === undefined, `Object.prototype.${k} must not exist before the case`)
        }
        try {
            for (let [k, v] of pairs) {
                Object.prototype[k] = v
            }
            return await fn()
        }
        finally {
            for (let [k] of pairs) {
                delete Object.prototype[k]
            }
        }
    }

    //judgeSelect, (a) 命中集合同無汙染(ordered 時連順序), 無 error 事件; 或 (b) statement check 之 Error, 恰 1 次 error 事件
    let judgeSelect = (rs, nEv, want, ordered) => {
        if (rs.ok) {
            let got = rs.v.map((x) => x.time)
            assert.deepStrictEqual(ordered ? got : sortNum(got), want, 'polluted select must hit exactly the rows of the unpolluted select') //(a)
            assert.strictEqual(nEv, 0)
            return
        }
        assert.ok(rs.e instanceof Error && reClosed.test(rs.e.message), `polluted select may only fail closed: ${(rs.e && rs.e.message) || rs.e}`) //(b) 不得為第三種
        assert.strictEqual(nEv, 1) //(b) S5
    }

    //judgeDelAll, (a) 刪除集合同無汙染, n 為實際刪除筆數; 或 (b) statement check 之 Error, 未刪任何列, 恰 1 次 error 事件
    let judgeDelAll = (rd, nEv, deleted, want) => {
        if (rd.ok) {
            assert.deepStrictEqual(deleted, want, 'polluted delAll must delete exactly the rows of the unpolluted delAll') //(a) S1
            assert.strictEqual(rd.v.n, want.length)
            assert.strictEqual(nEv, 0)
            return
        }
        assert.ok(rd.e instanceof Error && reClosed.test(rd.e.message), `polluted delAll may only fail closed: ${(rd.e && rd.e.message) || rd.e}`) //(b) 不得為第三種
        assert.deepStrictEqual(deleted, [], 'a rejected delAll deletes nothing') //(b) 資料不變
        assert.strictEqual(nEv, 1) //(b) S5
    }

    //runPair, 同一汙染下各跑一次 select({name:'aa'}) 與 delAll({name:'aa'})(各自 reset), 依判準檢查
    let runPair = async (pairs) => {
        await reset()
        let wo = mk()
        let evs = []
        wo.on('error', (mode) => evs.push(mode))
        let rs = await polluted(pairs, () => settle(wo.select({ name: 'aa' })))
        let nS = evs.length
        judgeSelect(rs, nS, WANT, false)
        assert.deepStrictEqual(await remain(), ALL) //select 不改資料
        let rd = await polluted(pairs, () => settle(wo.delAll({ name: 'aa' })))
        let left = await remain()
        judgeDelAll(rd, evs.length - nS, ALL.filter((t) => !left.includes(t)), WANT)
    }

    it('should hit and delete exactly the rows of {name:"aa"} without pollution (baseline of the cases below)', async function() {
        assert.deepStrictEqual(WANT, [1, 4])
        await reset()
        let wo = mk()
        assert.deepStrictEqual(sortNum((await wo.select({ name: 'aa' })).map((x) => x.time)), WANT)
        let rd = await wo.delAll({ name: 'aa' })
        assert.strictEqual(rd.n, 2)
        assert.deepStrictEqual(await remain(), ALL.filter((t) => !WANT.includes(t)))
    })

    PROPS.forEach((k) => {
        VALS.forEach(([vl, v]) => {
            it(`should keep the statement or fail closed for select and delAll when Object.prototype.${k} = ${vl}`, async function() {
                await runPair([[k, v]])
            })
        })
    })

    it('should keep the statement or fail closed when limit, columns, expression, $custom and an order-like name are polluted together (former case)', async function() {
        await reset()
        let wo = mk()
        let evs = []
        wo.on('error', (mode) => evs.push(mode))
        let pairs = [['limit', 1], ['columns', ['1']], ['expression', 'select 1; select 1; --'], ['$custom', ['true']], ['zzorder', 'asc; delete from tfind']]
        let ra = await polluted(pairs, () => settle(wo.select({ name: 'aa' }, { time: 'desc' })))
        judgeSelect(ra, evs.length, [4, 1], true)
        let n0 = evs.length
        let rb = await polluted(pairs, () => settle(wo.select({ $or: [{ value: 1 }, { value: { $in: [2, 3] } }] })))
        judgeSelect(rb, evs.length - n0, [1, 2, 3], false)
        assert.deepStrictEqual(await remain(), ALL)
        n0 = evs.length
        let rc = await polluted(pairs, () => settle(wo.delAll({ value: { $gt: 8 } })))
        let left = await remain()
        judgeDelAll(rc, evs.length - n0, ALL.filter((t) => !left.includes(t)), [9, 10])
    })

    //補充案(程式碼執行權等級, 非資料型汙染): 值為函數. 判準相同; 屬性名為 knex 呼叫之鉤子(如 wrapIdentifier)時亦不得靜默改寫
    describe('supplemental: function values (code execution level)', function() {
        PROPS.forEach((k) => {
            it(`should keep the statement or fail closed for select and delAll when Object.prototype.${k} = () => 'zz'`, async function() {
                await runPair([[k, () => 'zz']])
            })
        })
    })
})


describe('find: table names containing "$" (the $nin table-name guard is removed, behavior change 1)', function() {
    //原 mongo-sql 以含表名之 RegExp 改寫 $nin, 表名含 $ 時失配而被守門拒收; knex 不改寫, $nin 與首尾 $ 字串照常可用, 且 select 命中 = delAll 刪除(S1)
    let TN = 't$nin'
    let resetN = async () => {
        await admin.query(`DROP TABLE IF EXISTS "${TN}"`)
        await admin.query(`CREATE TABLE "${TN}" (time INTEGER PRIMARY KEY, a TEXT COLLATE "C")`)
        await admin.query(`INSERT INTO "${TN}" VALUES (1, $1), (2, $2), (3, NULL)`, ['x', 'y'])
    }
    let remainN = async () => (await admin.query(`SELECT time FROM "${TN}" ORDER BY time`)).rows.map((x) => x.time)
    after(async function() {
        await admin.query(`DROP TABLE IF EXISTS "${TN}"`).catch(() => {})
    })
    let cases = [
        ['$nin ["x"] (must not silently become $in)', () => ({ a: { $nin: ['x'] } }), [2]],
        ['$ne "$x$" (literal, excludes NULL)', () => ({ a: { $ne: '$x$' } }), [1, 2]],
        ['$nin ["$x$", "y"]', () => ({ a: { $nin: ['$x$', 'y'] } }), [1]],
        ['$eq "$x$" (literal, no row)', () => ({ a: { $eq: '$x$' } }), []],
        ['$gt "$x$" (literal, byte order: "x" and "y" are greater)', () => ({ a: { $gt: '$x$' } }), [1, 2]],
        ['$in ["x"]', () => ({ a: { $in: ['x'] } }), [1]],
        ['$ne "x"', () => ({ a: { $ne: 'x' } }), [2]],
    ]
    cases.forEach(([label, mkFind, want]) => {
        it(`should get ${JSON.stringify(want)} for select and delAll by ${label}`, async function() {
            let wo = WOrm({ url: ct.url, db: ct.db, cl: TN })
            await resetN()
            let rs = await wo.select(mkFind())
            assert.deepStrictEqual(sortNum(rs.map((x) => x.time)), want) //S4 行為變更 1
            await resetN()
            let rd = await wo.delAll(mkFind())
            let left = await remainN()
            assert.deepStrictEqual([1, 2, 3].filter((t) => !left.includes(t)), want) //S1
            assert.strictEqual(rd.n, want.length)
        })
    })
    it('should keep $nin working for ordinary table names', async function() {
        await reset()
        let r = await mk().select({ tag: { $nin: ['x'] } })
        assert.deepStrictEqual(sortNum(r.map((x) => x.time)), ids((x) => nn(x.tag) && x.tag !== 'x'))
    })
})


describe('find: the column name Infinity is valid (behavior change 2)', function() {
    let resetI = async () => {
        await admin.query('DROP TABLE IF EXISTS tinf')
        await admin.query('CREATE TABLE tinf (id INTEGER PRIMARY KEY, "Infinity" INTEGER)')
        await admin.query('INSERT INTO tinf VALUES (1, 5), (2, 6), (3, NULL)')
    }
    let remainI = async () => (await admin.query('SELECT id FROM tinf ORDER BY id')).rows.map((x) => x.id)
    after(async function() {
        await admin.query('DROP TABLE IF EXISTS tinf').catch(() => {})
    })
    let cases = [
        ['{Infinity:5}', () => ({ Infinity: 5 }), [1]],
        ['{Infinity:{$gte:5}}', () => ({ Infinity: { $gte: 5 } }), [1, 2]],
        ['{Infinity:null}', () => ({ Infinity: null }), [3]],
        ['{Infinity:{$nin:[5]}} (excludes NULL)', () => ({ Infinity: { $nin: [5] } }), [2]],
        ['{$or:[{Infinity:6},{id:3}]}', () => ({ $or: [{ Infinity: 6 }, { id: 3 }] }), [2, 3]],
    ]
    cases.forEach(([label, mkFind, want]) => {
        it(`should get ${JSON.stringify(want)} for select and delAll by ${label} on a table with a column named Infinity`, async function() {
            let wo = WOrm({ url: ct.url, db: ct.db, cl: 'tinf', pk: 'id' })
            await resetI()
            let rs = await wo.select(mkFind())
            assert.deepStrictEqual(sortNum(rs.map((x) => x.id)), want) //行為變更 2
            await resetI()
            let rd = await wo.delAll(mkFind())
            let left = await remainI()
            assert.deepStrictEqual([1, 2, 3].filter((t) => !left.includes(t)), want) //S1
            assert.strictEqual(rd.n, want.length)
        })
    })
})


describe('find: column names equal to a function name or to the table name are reported by PostgreSQL, the condition never holds for all rows (item 76, behavior change 4)', function() {
    //欄名未加表限定且表以別名 "$t" 引用: PG 不會把不存在之欄改以函數記法 欄(表) 或整列參照解析, 一律 42703(undefined_column)
    let TF = 'tfn'
    let resetF = async () => {
        await admin.query(`DROP TABLE IF EXISTS ${TF}`)
        await admin.query(`CREATE TABLE ${TF} (id INTEGER PRIMARY KEY, t TEXT, n INTEGER)`)
        await admin.query(`INSERT INTO ${TF} VALUES (1, 'x', 1), (2, 'y', 2), (3, NULL, NULL)`)
    }
    let countF = async () => (await admin.query(`SELECT count(*)::int AS c FROM ${TF}`)).rows[0].c
    after(async function() {
        await admin.query(`DROP TABLE IF EXISTS ${TF}`).catch(() => {})
    })

    it('should hold for all rows under the former table-qualified form (control: the danger the unqualified form removes)', async function() {
        await resetF()
        let r = await admin.query(`SELECT count(*)::int AS c FROM ${TF} WHERE "${TF}"."concat" <> $1`, ['x'])
        assert.strictEqual(r.rows[0].c, 3) //舊形 "tfn"."concat" 被解析為 concat(tfn), 對全表成立
        let r2 = await admin.query(`SELECT count(*)::int AS c FROM ${TF} WHERE "${TF}" IS NOT NULL`)
        assert.strictEqual(r2.rows[0].c, 2) //未用別名時欄名等於表名會解析為整列參照(全欄非 NULL 之列)
    })

    let NAMES = ['concat', 'to_json', 'to_jsonb', 'row_to_json', 'pg_typeof', 'num_nulls', 'num_nonnulls', 'quote_literal', 'pg_column_size', TF, 'Concat']
    let FINDS = [
        ['{$ne:"x"}', (c) => ({ [c]: { $ne: 'x' } })],
        ['null', (c) => ({ [c]: null })],
        ['{$gt:0}', (c) => ({ [c]: { $gt: 0 } })],
        ['{$nin:["x"]}', (c) => ({ [c]: { $nin: ['x'] } })],
    ]
    NAMES.forEach((c) => {
        FINDS.forEach(([fl, mkFind]) => {
            it(`should reject select (42703) and delAll (does not exist) and keep all rows by {${c}:${fl}}`, async function() {
                await resetF()
                let wo = WOrm({ url: ct.url, db: ct.db, cl: TF, pk: 'id' })
                let evs = []
                wo.on('error', (mode) => evs.push(mode))
                let rs = await settle(wo.select(mkFind(c)))
                assert.deepStrictEqual(evs, ['select']) //S5 恰 1 次
                let rd = await settle(wo.delAll(mkFind(c)))
                assert.strictEqual(rs.ok, false) //行為變更 4: 不再對全表成立
                assert.ok(rs.e instanceof Error && rs.e.code === '42703', `select: ${rs.e && rs.e.code} ${rs.e && rs.e.message}`)
                assert.strictEqual(rd.ok, false)
                assert.ok(typeof rd.e === 'string' && /does not exist/.test(rd.e), `delAll: ${rd.e}`) //Q10 字串
                assert.deepStrictEqual(evs, ['select', 'delAll']) //S5 各恰 1 次
                assert.strictEqual(await countF(), 3) //資料不變
            })
        })
    })
})


describe('find/order: system column names are rejected before any connection (behavior change 3, S11)', function() {
    let SYS = ['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax']
    //spy, 暫時以計數用之子類別取代 pg.Client(WOrm 於建構時取用 pg.Client, 故須在 mk() 之前呼叫), 並計 connect 與 query
    let spy = () => {
        let st = { nCtor: 0, nConnect: 0, nQuery: 0 }
        let Ori = pg.Client
        let oriConnect = Ori.prototype.connect
        let oriQuery = Ori.prototype.query
        pg.Client = class extends Ori {
            constructor(...a) {
                super(...a)
                st.nCtor += 1
            }
        }
        Ori.prototype.connect = function(...a) {
            st.nConnect += 1
            return oriConnect.apply(this, a)
        }
        Ori.prototype.query = function(...a) {
            st.nQuery += 1
            return oriQuery.apply(this, a)
        }
        st.restore = () => {
            pg.Client = Ori
            Ori.prototype.connect = oriConnect
            Ori.prototype.query = oriQuery
        }
        return st
    }

    it('should resolve an unqualified system column on any table (control: why it is rejected, the condition holds for all rows)', async function() {
        await reset()
        let r = await admin.query(`SELECT count(*)::int AS c FROM ${CL} AS "$t" WHERE "tableoid" > 0`)
        assert.strictEqual(r.rows[0].c, ALL.length)
    })

    SYS.forEach((c) => {
        it(`should reject find and order on ${c} with invalid find|order before constructing a pg.Client, keeping all rows`, async function() {
            await reset()
            let st = spy()
            let evs = []
            let rs
            let rd
            let rn
            let ro
            try {
                let wo = mk()
                wo.on('error', (mode) => evs.push(mode))
                rs = await settle(wo.select({ [c]: { $gt: 0 } }))
                rd = await settle(wo.delAll({ [c]: { $ne: 'x' } }))
                rn = await settle(wo.delAll({ $or: [{ name: 'aa' }, { [c]: null }] }))
                ro = await settle(wo.select({ name: 'aa' }, { [c]: 'asc' }))
            }
            finally {
                st.restore()
            }
            for (let r of [rs, rd, rn, ro]) {
                assert.strictEqual(r.ok, false) //行為變更 3
                assert.ok(r.e instanceof Error, String(r.e)) //S5
            }
            assert.strictEqual(rs.e.message, `invalid find: unsupported column name [${c}] at [find.${c}]`)
            assert.strictEqual(rd.e.message, `invalid find: unsupported column name [${c}] at [find.${c}]`)
            assert.strictEqual(rn.e.message, `invalid find: unsupported column name [${c}] at [find.$or[1].${c}]`)
            assert.strictEqual(ro.e.message, `invalid order: unsupported column name [${c}] at [order.${c}]`)
            assert.strictEqual(st.nCtor, 0, 'no pg.Client is constructed') //S11
            assert.strictEqual(st.nConnect, 0, 'no connection') //S11
            assert.strictEqual(st.nQuery, 0, 'no statement') //S11
            assert.deepStrictEqual(evs, ['select', 'delAll', 'delAll', 'select']) //S5 各恰 1 次
            assert.deepStrictEqual(await remain(), ALL) //資料不變
        })
    })

    it('should not block oid (decided by PostgreSQL: undefined column on PostgreSQL 17), so a client is constructed', async function() {
        await reset()
        let st = spy()
        let rs
        let rd
        try {
            let wo = mk()
            rs = await settle(wo.select({ oid: { $gt: 0 } }))
            rd = await settle(wo.delAll({ oid: { $gt: 0 } }))
        }
        finally {
            st.restore()
        }
        assert.ok(rs.e instanceof Error && rs.e.code === '42703', `select: ${rs.e && rs.e.message}`) //行為變更 3: oid 不拒, 由 PG 決定
        assert.ok(typeof rd.e === 'string' && /does not exist/.test(rd.e), `delAll: ${rd.e}`)
        assert.strictEqual(st.nCtor, 2)
        assert.deepStrictEqual(await remain(), ALL)
    })
})


describe('table names: a pre-quoted opt.cl (\'"Po_Q"\') works for select, selectByPk, save, del and delAll (behavior change 6)', function() {
    let resetQ = async () => {
        await admin.query('DROP TABLE IF EXISTS "Po_Q"')
        await admin.query('DROP TABLE IF EXISTS po_q')
        await admin.query('CREATE TABLE "Po_Q" (id TEXT PRIMARY KEY, v INTEGER)')
        await admin.query('INSERT INTO "Po_Q" VALUES ($1, 1), ($2, 2), ($3, 3)', ['a1', 'a2', 'a3'])
        //同名小寫表(未引用之名會被 PG 折為小寫而指到此表): 其資料不得被讀到或改動
        await admin.query('CREATE TABLE po_q (id TEXT PRIMARY KEY, v INTEGER)')
        await admin.query('INSERT INTO po_q VALUES ($1, 1)', ['z1'])
    }
    let rowsQ = async (t) => (await admin.query(`SELECT id, v FROM ${t} ORDER BY id`)).rows.map((x) => `${x.id}:${x.v}`)
    after(async function() {
        await admin.query('DROP TABLE IF EXISTS "Po_Q"').catch(() => {})
        await admin.query('DROP TABLE IF EXISTS po_q').catch(() => {})
    })

    it('should read and write the quoted table only (formerly a syntax error)', async function() {
        await resetQ()
        let wo = WOrm({ url: ct.url, db: ct.db, cl: '"Po_Q"', pk: 'id' })
        assert.deepStrictEqual((await wo.select({ v: { $gte: 2 } })).map((x) => x.id).sort(), ['a2', 'a3'])
        assert.deepStrictEqual((await wo.select({}, { id: 'desc' })).map((x) => x.id), ['a3', 'a2', 'a1'])
        assert.strictEqual((await wo.selectByPk('a2')).v, 2)
        assert.strictEqual(await wo.selectByPk('z1'), null) //不得讀到 po_q
        let rsv = await wo.save([{ id: 'a2', v: 20 }, { id: 'a4', v: 4 }])
        assert.deepStrictEqual(rsv.map((x) => x.ok), [1, 1])
        assert.deepStrictEqual(await rowsQ('"Po_Q"'), ['a1:1', 'a2:20', 'a3:3', 'a4:4'])
        let rdel = await wo.del([{ id: 'a1' }])
        assert.strictEqual(rdel[0].ok, 1)
        assert.strictEqual(rdel[0].nDeleted, 1)
        let rda = await wo.delAll({ v: { $gt: 10 } })
        assert.strictEqual(rda.n, 1)
        assert.deepStrictEqual(await rowsQ('"Po_Q"'), ['a3:3', 'a4:4'])
        assert.deepStrictEqual(await rowsQ('po_q'), ['z1:1']) //同名小寫表不受影響
    })
})


describe('table names: a schema-qualified opt.cl (schema.table) uses the table of that schema, not the one found by search_path', function() {
    let TABS = [['wst1.tsame', 'a'], ['wst2.tsame', 'b'], ['public.tsame', 'c']]
    let dropS = async () => {
        await admin.query('DROP SCHEMA IF EXISTS wst1 CASCADE')
        await admin.query('DROP SCHEMA IF EXISTS wst2 CASCADE')
        await admin.query('DROP TABLE IF EXISTS public.tsame')
    }
    let resetS = async () => {
        await dropS()
        await admin.query('CREATE SCHEMA wst1')
        await admin.query('CREATE SCHEMA wst2')
        for (let [t, p] of TABS) {
            await admin.query(`CREATE TABLE ${t} (id TEXT PRIMARY KEY, v INTEGER)`)
            await admin.query(`INSERT INTO ${t} VALUES ($1, 1), ($2, 2), ($3, 3)`, [`${p}1`, `${p}2`, `${p}3`])
        }
    }
    let idsOf = async (t) => (await admin.query(`SELECT id FROM ${t} ORDER BY id`)).rows.map((x) => x.id)
    after(async function() {
        await dropS().catch(() => {})
    })

    it('should select, selectByPk, del and delAll on wst2.tsame only (two schemas and public hold a table of the same name)', async function() {
        await resetS()
        let wo = WOrm({ url: ct.url, db: ct.db, cl: 'wst2.tsame', pk: 'id' })
        assert.deepStrictEqual((await wo.select({ v: { $gte: 2 } })).map((x) => x.id).sort(), ['b2', 'b3'])
        assert.strictEqual((await wo.selectByPk('b1')).v, 1)
        assert.strictEqual(await wo.selectByPk('a1'), null) //不得讀到他 schema 之表
        assert.strictEqual(await wo.selectByPk('c1'), null) //亦不得讀到 search_path 上之 public.tsame
        let rdel = await wo.del([{ id: 'b1' }])
        assert.strictEqual(rdel[0].nDeleted, 1)
        let rda = await wo.delAll({ v: { $lt: 3 } })
        assert.strictEqual(rda.n, 1) //只剩 b2 符合
        assert.deepStrictEqual(await idsOf('wst2.tsame'), ['b3'])
        assert.deepStrictEqual(await idsOf('wst1.tsame'), ['a1', 'a2', 'a3'])
        assert.deepStrictEqual(await idsOf('public.tsame'), ['c1', 'c2', 'c3'])
    })

    it('should delete all rows of wst1.tsame only by delAll({})', async function() {
        await resetS()
        let wo = WOrm({ url: ct.url, db: ct.db, cl: 'wst1.tsame', pk: 'id' })
        assert.deepStrictEqual((await wo.select()).map((x) => x.id).sort(), ['a1', 'a2', 'a3'])
        let rda = await wo.delAll({})
        assert.strictEqual(rda.n, 3)
        assert.deepStrictEqual(await idsOf('wst1.tsame'), [])
        assert.deepStrictEqual(await idsOf('wst2.tsame'), ['b1', 'b2', 'b3'])
        assert.deepStrictEqual(await idsOf('public.tsame'), ['c1', 'c2', 'c3'])
    })
})


describe('find: boolean equality is IS TRUE / IS FALSE and does not take part in operator resolution (user-defined domain with its own = operator)', function() {
    //網域 wdbool(底層 BOOLEAN)上自訂 = 運算子為不嚴格之恆真函數: 若條件以 "b" = $1 送出, 對每列(含 NULL)皆成立而 delAll 刪全表;
    //布林等值為 "b" IS TRUE / IS FALSE(不經運算子解析), 只命中值相符之列
    let dropD = async () => {
        await admin.query('DROP TABLE IF EXISTS tdom')
        await admin.query('DROP DOMAIN IF EXISTS wdbool CASCADE') //一併移除依賴之函數與運算子
    }
    let resetD = async () => {
        await dropD()
        await admin.query('CREATE DOMAIN wdbool AS BOOLEAN')
        await admin.query('CREATE FUNCTION wdbool_eq_any(wdbool, wdbool) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS \'SELECT true\'')
        await admin.query('CREATE OPERATOR = (LEFTARG = wdbool, RIGHTARG = wdbool, FUNCTION = wdbool_eq_any)')
        await admin.query('CREATE TABLE tdom (id INTEGER PRIMARY KEY, b wdbool)')
        await admin.query('INSERT INTO tdom VALUES (1, true), (2, false), (3, NULL)')
    }
    let remainD = async () => (await admin.query('SELECT id FROM tdom ORDER BY id')).rows.map((x) => x.id)
    after(async function() {
        await dropD().catch(() => {})
    })

    it('should resolve "b" = $1 to the user operator and hold for all rows (control: the case reproduces)', async function() {
        await resetD()
        let r = await admin.query('SELECT count(*)::int AS c FROM tdom WHERE b = $1', [true])
        assert.strictEqual(r.rows[0].c, 3)
    })

    let cases = [
        ['{b:true}', () => ({ b: true }), [1]],
        ['{b:false}', () => ({ b: false }), [2]],
        ['{b:{$eq:true}}', () => ({ b: { $eq: true } }), [1]],
        ['{b:{$ne:true}} (SQL three-valued, excludes NULL)', () => ({ b: { $ne: true } }), [2]],
    ]
    cases.forEach(([label, mkFind, want]) => {
        it(`should get ${JSON.stringify(want)} for select and delAll by ${label}`, async function() {
            let wo = WOrm({ url: ct.url, db: ct.db, cl: 'tdom', pk: 'id' })
            await resetD()
            let rs = await wo.select(mkFind())
            assert.deepStrictEqual(sortNum(rs.map((x) => x.id)), want) //S4 S12
            await resetD()
            let rd = await wo.delAll(mkFind())
            let left = await remainD()
            assert.deepStrictEqual([1, 2, 3].filter((t) => !left.includes(t)), want) //S1 只刪命中之列
            assert.strictEqual(rd.n, want.length)
        })
    })
})
