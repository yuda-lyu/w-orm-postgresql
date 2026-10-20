import assert from 'assert'
import WOrm from '../src/WOrmPostgresql.mjs'
import { startPg, stopPg, connectPg } from './tools/pgContainer.mjs'
import { SEM_ROWS, SEMANTICS } from './tools/irSemantics.mjs'


//條件(find)翻譯之輸入空間矩陣測試: 真 PostgreSQL(自建容器, 測畢即銷毀).
//預言機 = 手寫之 SQL 表驅動(運算子 -> SQL 運算子、null -> IS NULL、布林 -> 字面值比較), 以 pg 直連執行, **不共用被測碼**(不經 lowerFind / emitKnex / buildSql).
//規格句(帳本 S1 S4 S12):
//  S1  同一 find 於 select 命中之數據, 即 delAll 刪除之數據
//  S4  受支援運算子之語意為 SQL 三值邏輯($ne $nin 不命中 NULL 列; {c:null} 為 IS NULL; $in:[] 恆假)
//  S12 布林 $ne 為三值(不含 NULL 列)
//軸: 欄型(text / integer / numeric / boolean / timestamptz)× 運算子(隱含等值 $eq $ne $gt $gte $lt $lte $in(1 與 2 元素)$nin null $ne:null)× 值(各欄型代表值,含 NULL 列、空字串、$..$ 字串、含引號字串、Date)
//  + 節點語意期望表(tools/irSemantics.mjs)+ 偽隨機 $and/$or 樹對拍(固定種子, 可重現)+ order 組合

let ctName = 'worm-test-pg-matrix'
let ct = null
let admin = null
let CL = 'tmatrix'

let reset = async () => {
    await admin.query(`TRUNCATE ${CL}`)
    for (let r of SEM_ROWS) {
        await admin.query(`INSERT INTO ${CL} (id, s, n, b, d, x) VALUES ($1,$2,$3,$4,$5,$6)`, [r.id, r.s, r.n, r.b, r.d, r.n === null ? null : r.n + 0.5])
    }
}
let mk = () => WOrm({ url: ct.url, db: ct.db, cl: CL, pk: 'id' })
let ids = (rows) => rows.map((x) => x.id)
let sorted = (a) => [...a].sort((x, y) => x - y)
let remain = async () => (await admin.query(`SELECT id FROM ${CL} ORDER BY id`)).rows.map((x) => x.id)

//oracle, 以手寫 SQL 取得期望命中(升冪 id)
let oracle = async (where, params = []) => (await admin.query(`SELECT id FROM ${CL} WHERE ${where} ORDER BY id`, params)).rows.map((x) => x.id)

//check, 對一個 find 與其預言機 SQL: select 命中 = 預言機; delAll 刪除集合 = select 命中(S1); 兩者皆不改變其他列
let check = async (label, find, where, params) => {
    await reset()
    let want = await oracle(where, params)
    let wo = mk()
    let got = sorted(ids(await wo.select(find)))
    assert.deepStrictEqual(got, want, `${label}: select`)
    assert.deepStrictEqual(await remain(), sorted(SEM_ROWS.map((r) => r.id)), `${label}: select must not change data`)
    let all = SEM_ROWS.map((r) => r.id)
    let res = await wo.delAll(find)
    let left = await remain()
    let deleted = all.filter((x) => !left.includes(x))
    assert.deepStrictEqual(deleted, want, `${label}: delAll deletes exactly what the oracle says (S1)`)
    assert.strictEqual(res.n, want.length, `${label}: n`)
    assert.strictEqual(res.nDeleted, want.length, `${label}: nDeleted`)
}


before(async function() {
    this.timeout(600000)
    ct = await startPg(ctName)
    admin = await connectPg(ct)
    await admin.query(`CREATE TABLE ${CL} (id INTEGER PRIMARY KEY, s TEXT, n INTEGER, b BOOLEAN, d TIMESTAMPTZ, x NUMERIC(10,2))`)
})

after(async function() {
    this.timeout(120000)
    if (admin) {
        await admin.query(`DROP TABLE IF EXISTS ${CL}`).catch(() => {})
        await admin.end().catch(() => {})
    }
    await stopPg(ctName)
})


describe('matrix: node semantics table through the public select and delAll on real PostgreSQL (S1 S4 S12)', function() {
    SEMANTICS.forEach((s) => {
        it(`[${s.id}] ${s.node}`, async function() {
            this.timeout(60000)
            await reset()
            let wo = mk()
            let got = sorted(ids(await wo.select(s.find())))
            if (s.hits !== null) {
                assert.deepStrictEqual(got, s.hits, 'hand-written expectation of the table') //手寫期望
            }
            assert.deepStrictEqual(await remain(), [1, 2, 3, 4, 5, 6])
            let res = await wo.delAll(s.find())
            let left = await remain()
            let deleted = [1, 2, 3, 4, 5, 6].filter((x) => !left.includes(x))
            assert.deepStrictEqual(deleted, got, 'delAll deletes exactly what select hits (S1)')
            assert.strictEqual(res.n, got.length)
        })
    })
})


describe('matrix: column type × operator × value against an independent SQL oracle (S1 S4 S12)', function() {
    //[欄, 值集]: 欄型各取代表值(含 NULL 列不命中之邊界)
    let COLS = [
        ['s', ['a', '', '$x$', 'it\'s', '1', 'zzz']],
        ['n', [0, 1, 3, -1, 99]],
        ['x', [1.5, 2.5, 0, 100]],
        ['d', [new Date('2020-01-01T00:00:00Z'), new Date('2021-06-01T00:00:00Z'), new Date('1999-12-31T23:59:59Z')]],
        ['b', [true, false]],
    ]
    let CMP = [['$eq', '='], ['$ne', '<>'], ['$gt', '>'], ['$gte', '>='], ['$lt', '<'], ['$lte', '<=']]

    COLS.forEach(([col, vals]) => {
        it(`column ${col}: implicit equality and $eq $ne $gt $gte $lt $lte`, async function() {
            this.timeout(180000)
            for (let v of vals) {
                let isb = typeof v === 'boolean'
                //隱含等值
                await check(`${col} = ${String(v)}`, { [col]: v }, isb ? `"${col}" = ${v ? 'TRUE' : 'FALSE'}` : `"${col}" = $1`, isb ? [] : [v])
                for (let [op, sql] of CMP) {
                    await check(`${col} ${op} ${String(v)}`, { [col]: { [op]: v } }, isb ? `"${col}" ${sql} ${v ? 'TRUE' : 'FALSE'}` : `"${col}" ${sql} $1`, isb ? [] : [v])
                }
            }
        })

        it(`column ${col}: $in (1 and 2 elements, empty) and $nin`, async function() {
            this.timeout(180000)
            let v1 = vals[0]
            let v2 = vals[vals.length - 1]
            await check(`${col} in [v1]`, { [col]: { $in: [v1] } }, `"${col}" IN ($1)`, [v1])
            await check(`${col} in [v1,v2]`, { [col]: { $in: [v1, v2] } }, `"${col}" IN ($1, $2)`, [v1, v2])
            await check(`${col} nin [v1]`, { [col]: { $nin: [v1] } }, `"${col}" NOT IN ($1)`, [v1])
            await check(`${col} nin [v1,v2]`, { [col]: { $nin: [v1, v2] } }, `"${col}" NOT IN ($1, $2)`, [v1, v2])
            await check(`${col} in []`, { [col]: { $in: [] } }, 'FALSE', [])
            await check(`${col} in [v1] and nin [v2] (two operators on one column)`, { [col]: { $in: [v1, v2], $nin: [v2] } }, `"${col}" IN ($1, $2) AND "${col}" NOT IN ($3)`, [v1, v2, v2])
        })

        it(`column ${col}: null, $eq null, $ne null`, async function() {
            this.timeout(180000)
            await check(`${col} null`, { [col]: null }, `"${col}" IS NULL`, [])
            await check(`${col} $eq null`, { [col]: { $eq: null } }, `"${col}" IS NULL`, [])
            await check(`${col} $ne null`, { [col]: { $ne: null } }, `"${col}" IS NOT NULL`, [])
            await check(`${col} $ne null and $gt`, { [col]: { $ne: null, $gte: vals[0] } }, typeof vals[0] === 'boolean' ? `"${col}" IS NOT NULL AND "${col}" >= ${vals[0] ? 'TRUE' : 'FALSE'}` : `"${col}" IS NOT NULL AND "${col}" >= $1`, typeof vals[0] === 'boolean' ? [] : [vals[0]])
        })
    })

    it('boolean $ne is three-valued: NULL rows hit neither $ne:true nor $ne:false (S12)', async function() {
        this.timeout(60000)
        await reset()
        let wo = mk()
        assert.deepStrictEqual(sorted(ids(await wo.select({ b: { $ne: true } }))), [2, 5])
        assert.deepStrictEqual(sorted(ids(await wo.select({ b: { $ne: false } }))), [1, 4])
        assert.deepStrictEqual(sorted(ids(await wo.select({ $or: [{ b: null }, { b: false }] }))), [2, 3, 5, 6]) //可攜寫法: 含 NULL 列
    })

    it('numeric string for a numeric column and $..$ strings are bound as literals (PG converts by column type)', async function() {
        this.timeout(60000)
        await check('n = "1"', { n: '1' }, 'n = $1', ['1'])
        await check('s = $x$', { s: '$x$' }, 's = $1', ['$x$'])
        await check('s <= $x$ (no longer rejected)', { s: { $lte: '$x$' } }, 's <= $1', ['$x$'])
        await check('s ne $x$', { s: { $ne: '$x$' } }, 's <> $1', ['$x$'])
        await check('s in [$x$, ""]', { s: { $in: ['$x$', ''] } }, 's IN ($1, $2)', ['$x$', ''])
    })
})


describe('matrix: pseudo-random $and/$or trees against the oracle (fixed seed, reproducible)', function() {
    //mulberry32, 固定種子
    let rng = (seed) => {
        let a = seed >>> 0
        return () => {
            a = (a + 0x6D2B79F5) >>> 0
            let t = a
            t = Math.imul(t ^ (t >>> 15), t | 1)
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        }
    }

    //葉目錄: { find, sql(含 ? 佔位), vals }; 預言機 SQL 全為手寫
    let D1 = new Date('2020-06-01T00:00:00Z')
    let LEAVES = [
        { find: { s: 'a' }, sql: 's = ?', vals: ['a'] },
        { find: { s: { $ne: 'a' } }, sql: 's <> ?', vals: ['a'] },
        { find: { s: null }, sql: 's IS NULL', vals: [] },
        { find: { s: { $ne: null } }, sql: 's IS NOT NULL', vals: [] },
        { find: { s: { $in: ['a', 'b'] } }, sql: 's IN (?, ?)', vals: ['a', 'b'] },
        { find: { s: { $nin: ['a', '$x$'] } }, sql: 's NOT IN (?, ?)', vals: ['a', '$x$'] },
        { find: { s: { $in: [] } }, sql: 'FALSE', vals: [] },
        { find: { n: { $gt: 1 } }, sql: 'n > ?', vals: [1] },
        { find: { n: { $lte: 2 } }, sql: 'n <= ?', vals: [2] },
        { find: { n: { $gt: 0, $lt: 4 } }, sql: 'n > ? AND n < ?', vals: [0, 4] },
        { find: { n: 3 }, sql: 'n = ?', vals: [3] },
        { find: { n: { $nin: [1, 3] } }, sql: 'n NOT IN (?, ?)', vals: [1, 3] },
        { find: { b: true }, sql: 'b = TRUE', vals: [] },
        { find: { b: false }, sql: 'b = FALSE', vals: [] },
        { find: { b: { $ne: true } }, sql: 'b <> TRUE', vals: [] },
        { find: { b: { $ne: false } }, sql: 'b <> FALSE', vals: [] },
        { find: { b: null }, sql: 'b IS NULL', vals: [] },
        { find: { b: { $in: [true] } }, sql: 'b IN (?)', vals: [true] },
        { find: { d: { $gt: D1 } }, sql: 'd > ?', vals: [D1] },
        { find: { d: null }, sql: 'd IS NULL', vals: [] },
        { find: { x: { $gte: 1.5 } }, sql: 'x >= ?', vals: [1.5] },
        { find: { x: { $ne: 2.5 } }, sql: 'x <> ?', vals: [2.5] },
    ]
    //樹: { k:'leaf', i } | { k:'and'|'or', c:[...] } | { k:'doc', c:[leaf, leaf] }(隱含 AND, 兩葉須在不同欄)
    let colOf = (i) => Object.keys(LEAVES[i].find)[0]
    let gen = (r, depth) => {
        let pick = r()
        if (depth === 0 || pick < 0.35) {
            return { k: 'leaf', i: Math.floor(r() * LEAVES.length) }
        }
        if (pick < 0.5) {
            let i = Math.floor(r() * LEAVES.length)
            let j = Math.floor(r() * LEAVES.length)
            if (colOf(i) === colOf(j)) {
                return { k: 'leaf', i }
            }
            return { k: 'doc', c: [{ k: 'leaf', i }, { k: 'leaf', i: j }] }
        }
        let n = 1 + Math.floor(r() * 3)
        return { k: pick < 0.75 ? 'and' : 'or', c: Array.from({ length: n }, () => gen(r, depth - 1)) }
    }
    let toFind = (t) => {
        if (t.k === 'leaf') {
            return cloneFind(LEAVES[t.i].find)
        }
        if (t.k === 'doc') {
            return Object.assign({}, ...t.c.map(toFind))
        }
        return { [t.k === 'and' ? '$and' : '$or']: t.c.map(toFind) }
    }
    //cloneFind, 保留 Date(JSON 往返會把 Date 變字串)
    let cloneFind = (f) => {
        let o = {}
        for (let k of Object.keys(f)) {
            let v = f[k]
            if (v === null || typeof v !== 'object' || v instanceof Date) {
                o[k] = v
            }
            else if (Array.isArray(v)) {
                o[k] = [...v]
            }
            else {
                o[k] = cloneFind(v)
            }
        }
        return o
    }
    let toSql = (t, params) => {
        if (t.k === 'leaf') {
            let L = LEAVES[t.i]
            let n = 0
            let out = L.sql.replace(/\?/g, () => {
                params.push(L.vals[n])
                n += 1
                return `$${params.length}`
            })
            return `(${out})`
        }
        if (t.k === 'doc') {
            return `(${t.c.map((x) => toSql(x, params)).join(' AND ')})`
        }
        return `(${t.c.map((x) => toSql(x, params)).join(t.k === 'and' ? ' AND ' : ' OR ')})`
    }

    it('should agree with the oracle on 400 generated trees (depth <= 3), and delAll must delete what select hits', async function() {
        this.timeout(600000)
        let r = rng(20261020)
        let nHit = 0
        let nEmpty = 0
        for (let i = 0; i < 400; i++) {
            let t = gen(r, 3)
            let find = toFind(t)
            let params = []
            let where = toSql(t, params)
            await reset()
            let want = await oracle(where, params)
            let wo = mk()
            let got = sorted(ids(await wo.select(find)))
            assert.deepStrictEqual(got, want, `tree #${i}: ${where} ${JSON.stringify(find)}`)
            let res = await wo.delAll(find)
            let left = await remain()
            assert.deepStrictEqual([1, 2, 3, 4, 5, 6].filter((x) => !left.includes(x)), want, `tree #${i}: delAll (S1)`)
            assert.strictEqual(res.nDeleted, want.length)
            if (want.length > 0) {
                nHit += 1
            }
            else {
                nEmpty += 1
            }
        }
        //生成器須有鑑別力: 命中與不命中的樹都要有一定數量
        assert.ok(nHit >= 100 && nEmpty >= 20, `hit ${nHit}, empty ${nEmpty}`)
    })
})


describe('matrix: order combinations against ORDER BY of the oracle (S7)', function() {
    //[order, 手寫 ORDER BY]
    let ORDERS = [
        [{ n: 'asc' }, '"n" ASC, "id" ASC'],
        [{ n: 'desc' }, '"n" DESC, "id" ASC'],
        [{ n: 'asc nulls first' }, '"n" ASC NULLS FIRST, "id" ASC'],
        [{ n: 'desc nulls last' }, '"n" DESC NULLS LAST, "id" ASC'],
        [{ s: 'desc', n: 'asc' }, '"s" DESC, "n" ASC, "id" ASC'],
        [{ b: 'asc nulls last', d: 'desc nulls first' }, '"b" ASC NULLS LAST, "d" DESC NULLS FIRST, "id" ASC'],
        [{ id: 'desc' }, '"id" DESC'],
    ]
    ORDERS.forEach(([order, sql]) => {
        it(`order ${JSON.stringify(order)} should equal ${sql}`, async function() {
            this.timeout(60000)
            await reset()
            let wo = mk()
            let want = (await admin.query(`SELECT id FROM ${CL} ORDER BY ${sql}`)).rows.map((x) => x.id)
            //id 為最後之決勝鍵: 未列於 order 時補上, 使順序全定
            let o = { ...order }
            if (!('id' in o)) {
                o.id = 'asc'
            }
            assert.deepStrictEqual(ids(await wo.select({}, o)), want)
            //帶條件
            let want2 = (await admin.query(`SELECT id FROM ${CL} WHERE n IS NOT NULL ORDER BY ${sql}`)).rows.map((x) => x.id)
            assert.deepStrictEqual(ids(await wo.select({ n: { $ne: null } }, o)), want2)
        })
    })
})


describe('matrix: primary key values +Infinity / -Infinity (a float8 key can hold them; checkPk accepts every number but NaN; same as before the SQL builder change)', function() {
    let CLI = 'tinf'
    let CLN = 'tinfint'
    let mkI = (cl) => WOrm({ url: ct.url, db: ct.db, cl })
    let resetI = async () => {
        await admin.query(`DROP TABLE IF EXISTS ${CLI}`)
        await admin.query(`CREATE TABLE ${CLI} ("time" DOUBLE PRECISION PRIMARY KEY, v TEXT)`)
        await admin.query(`INSERT INTO ${CLI} VALUES (1, 'one'), ('Infinity', 'pinf'), ('-Infinity', 'minf')`)
        await admin.query(`DROP TABLE IF EXISTS ${CLN}`)
        await admin.query(`CREATE TABLE ${CLN} ("time" INTEGER PRIMARY KEY, v TEXT)`)
        await admin.query(`INSERT INTO ${CLN} VALUES (1, 'one')`)
    }
    let leftI = async () => (await admin.query(`SELECT v FROM ${CLI} ORDER BY "time"`)).rows.map((x) => x.v)

    after(async function() {
        await admin.query(`DROP TABLE IF EXISTS ${CLI}`).catch(() => {})
        await admin.query(`DROP TABLE IF EXISTS ${CLN}`).catch(() => {})
    })

    it('should find the +Infinity and -Infinity rows by selectByPk (the emitter must let non-finite pk numbers through, they are bound parameters)', async function() {
        this.timeout(60000)
        await resetI()
        let wo = mkI(CLI)
        assert.strictEqual((await wo.selectByPk(Infinity)).v, 'pinf')
        assert.strictEqual((await wo.selectByPk(-Infinity)).v, 'minf')
        assert.strictEqual((await wo.selectByPk(1)).v, 'one')
        assert.strictEqual(await wo.selectByPk(NaN), null) //NaN 不是有效主鍵值
    })

    it('should delete and update those rows by del and save(autoInsert:false), record by record', async function() {
        this.timeout(60000)
        await resetI()
        let wo = mkI(CLI)
        let r = await wo.save([{ time: -Infinity, v: 'zz' }], { autoInsert: false })
        assert.deepStrictEqual(r.map((x) => [x.n, x.nModified, x.ok]), [[1, 1, 1]])
        assert.deepStrictEqual(await leftI(), ['zz', 'one', 'pinf'])
        let d = await wo.del([{ time: Infinity }])
        assert.deepStrictEqual(d.map((x) => [x.n, x.nDeleted, x.ok]), [[1, 1, 1]])
        assert.deepStrictEqual(await leftI(), ['zz', 'one'])
    })

    it('should reject Infinity as a find value (series whitelist: finite numbers only) while the pk functions accept it', async function() {
        this.timeout(60000)
        await resetI()
        let wo = mkI(CLI)
        await assert.rejects(() => wo.select({ time: Infinity }), /^Error: invalid find: /)
        await assert.rejects(() => wo.delAll({ time: { $gt: -Infinity } }), /^Error: invalid find: /)
        assert.deepStrictEqual(await leftI(), ['minf', 'one', 'pinf'])
    })

    it('should treat Infinity as a PostgreSQL type error on an INTEGER pk (selectByPk gives null, del reports ok:0 and keeps the row)', async function() {
        this.timeout(60000)
        await resetI()
        let wo = mkI(CLN)
        assert.strictEqual(await wo.selectByPk(Infinity), null)
        let d = await wo.del([{ time: Infinity }])
        assert.strictEqual(d[0].ok, 0)
        assert.strictEqual((await admin.query(`SELECT count(*)::int AS n FROM ${CLN}`)).rows[0].n, 1)
    })
})
