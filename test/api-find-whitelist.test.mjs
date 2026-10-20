/* eslint-disable no-extend-native -- 測試暫時於 Array.prototype 安裝數字索引 setter(finally 還原)驗證第二階段不以索引指派建立陣列 */
import assert from 'assert'
import pg from 'pg'
import cvCases from 'wsemi/src/_cvOrmFindCases.mjs'
import WOrm from '../src/WOrmPostgresql.mjs'
import { cvFind } from '../src/cvFind.mjs'
import { buildDelete } from '../src/buildSql.mjs'
import { startPg, stopPg, connectPg } from './tools/pgContainer.mjs'


//系列條件白名單(dspec〈一之三〉)之契約案例表測試. 案例表隨 wsemi 發布(wsemi/src/_cvOrmFindCases.mjs, { columns, seed, cases }),
//此處逐案對公開 select(find) 與 delAll(find) 執行, 驗證共用檢核(wsemi cvOrmFind)被正確接線而非被後端繞過. 真 PostgreSQL(自建容器, 測畢即銷毀).
//規格句見 CLAUDE_rulebook.md(S1 S2 S5 S9 S10 S11, R11):
//  S1  同一 find 於 select 命中之數據, 即 delAll 刪除之數據
//  S2  白名單外之運算子與無法轉譯之值必須 reject(整批性錯誤)
//  S5  reject 時資料不變, 於 reject 前發一次 error 事件, change 不發, reject 之值為 Error 且訊息為 invalid find: <原因> at [<路徑>]
//  S9  只支援系列白名單    S10 檢查之值即使用之值    S11 壞 find 於送出任何 SQL 之前 reject
//案例欄位: expect 為 ALL/OK(預期命中集合為 ids.sql, SQL 三值)或 REJ; schema:true 者可因欄位不存在或型別不符而由 PG(或 pg 專屬限制)reject.


let ctName = 'worm-test-pg33-whitelist'
let ct = null
let admin = null
let CL = 'twl'

//reset, 以案例表 seed() 重建資料表(欄位型別依 columns: id 主鍵字串, name/g/t 字串, age 整數, flag 布林, d 時間)
let reset = async () => {
    await admin.query(`DROP TABLE IF EXISTS ${CL}`)
    await admin.query(`CREATE TABLE ${CL} (id TEXT PRIMARY KEY, name TEXT, age INTEGER, g TEXT, t TEXT, flag BOOLEAN, d TIMESTAMPTZ)`)
    for (let r of cvCases.seed()) {
        let v = (x) => (x === undefined ? null : x)
        await admin.query(`INSERT INTO ${CL} (id, name, age, g, t, flag, d) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [r.id, v(r.name), v(r.age), v(r.g), v(r.t), v(r.flag), v(r.d)])
    }
}
let remain = async () => (await admin.query(`SELECT id FROM ${CL} ORDER BY id`)).rows.map((x) => x.id)
let mk = () => WOrm({ url: ct.url, db: ct.db, cl: CL, pk: 'id' })
let ids = (rows) => rows.map((x) => x.id).sort()
let ALL = cvCases.seed().map((r) => r.id)

//schema 案中由 pg 專屬第二階段(而非 PG)reject 者: 欄名超過 PostgreSQL 識別字上限 63 bytes.
//F26(Infinity)原亦屬此(mongo-sql 視為陣列索引), SQL 改由 knex 產生後為合法欄名(行為變更 2), 由 PG 回報欄不存在, 不再列於此
let PG_ONLY = {
    F21: /column name is too long \(> 63 bytes\)/,
}


before(async function() {
    this.timeout(600000)
    ct = await startPg(ctName)
    admin = await connectPg(ct)
    await reset()
})

after(async function() {
    this.timeout(120000)
    if (admin) {
        await admin.query(`DROP TABLE IF EXISTS ${CL}`).catch(() => {})
        await admin.end().catch(() => {})
    }
    await stopPg(ctName)
})


describe('whitelist: case table sanity', function() {
    it('should load the shared case table with 6 seed rows and a non-trivial number of cases', function() {
        assert.deepStrictEqual(ALL, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
        assert.ok(cvCases.cases.length >= 255, `cases: ${cvCases.cases.length}`)
        let n = (e) => cvCases.cases.filter((c) => c.expect === e).length
        assert.ok(n('ALL') >= 3 && n('OK') >= 70 && n('REJ') >= 160, `ALL ${n('ALL')} OK ${n('OK')} REJ ${n('REJ')}`)
    })
})


describe('whitelist: every case of the shared table through the public select and delAll (S1 S2 S5 S9)', function() {
    cvCases.cases.forEach((c) => {
        it(`${c.id} [${c.rule}] ${c.expect}${c.schema ? ' (schema)' : ''}: ${c.label}`, async function() {
            this.timeout(120000)
            let wo = mk()
            let evs = []
            let chg = []
            wo.on('error', (mode) => evs.push(mode))
            wo.on('change', (mode) => chg.push(mode))
            //track, 記下 settle 當下已發出之 error 事件數(事件須於 reject 之前發出)
            let track = (p) => p.then((v) => ({ ok: true, v, nEv: evs.length })).catch((e) => ({ ok: false, e, nEv: evs.length }))

            //select
            await reset()
            let rs = await track(wo.select(c.find()))
            assert.deepStrictEqual(await remain(), ALL) //select 不改資料

            //delAll(以 seed() 重建)
            await reset()
            let rd = await track(wo.delAll(c.find()))
            let left = await remain()
            let deleted = ALL.filter((x) => !left.includes(x))

            if (c.expect === 'REJ') {
                assert.strictEqual(rs.ok, false, 'select must reject') //S2
                assert.strictEqual(rd.ok, false, 'delAll must reject') //S2
                assert.ok(rs.e instanceof Error, `select reject value must be an Error: ${typeof rs.e}`) //S5
                assert.ok(rd.e instanceof Error, `delAll reject value must be an Error: ${typeof rd.e}`) //S5
                assert.ok(/^invalid find: .+ at \[.*\]$/s.test(rs.e.message), `select message: ${rs.e.message}`) //S5 格式
                assert.ok(/^invalid find: .+ at \[.*\]$/s.test(rd.e.message), `delAll message: ${rd.e.message}`) //S5 格式
                assert.deepStrictEqual(left, ALL) //S5 資料不變
                assert.strictEqual(rs.nEv, 1, 'one error event before select rejects') //S5
                assert.strictEqual(rd.nEv, 2, 'one more error event before delAll rejects') //S5
                assert.deepStrictEqual(evs, ['select', 'delAll'])
                assert.deepStrictEqual(chg, []) //S5 change 不發
                return
            }

            let want = [...c.ids.sql].sort()
            assert.strictEqual(rs.ok === rd.ok, true, `select and delAll must agree on accept/reject: select ${rs.ok ? 'ok' : rs.e && rs.e.message}, delAll ${rd.ok ? 'ok' : (rd.e && rd.e.message) || rd.e}`) //最低要求①
            if (rs.ok) {
                assert.deepStrictEqual(ids(rs.v), want, 'select hits') //S4
                assert.deepStrictEqual(deleted, want, 'delAll deletes exactly what select hits') //S1
                assert.strictEqual(rd.v.n, want.length) //S1 n 為實際刪除筆數
                assert.strictEqual(rd.v.nDeleted, want.length)
                assert.strictEqual(rd.v.ok, 1)
                assert.deepStrictEqual(evs, [])
                assert.deepStrictEqual(chg, ['delAll'])
            }
            else {
                //只有標 schema 之案可因欄位不存在或型別不符(PG 或 pg 專屬限制)而 reject
                assert.ok(c.schema === true, `only schema cases may reject, but ${c.id} rejected with: ${rs.e && rs.e.message}`)
                assert.ok(rs.e instanceof Error || typeof rs.e === 'string')
                //拒收原因須為 PG 端之錯誤(欄不存在、型別不符), 或 pg 專屬第二階段之指定限制(F21 欄名 >63 bytes); 不得是本套件對白名單內欄名之誤拒
                let m = String((rs.e && rs.e.message) || rs.e)
                if (/^invalid find: /.test(m)) {
                    assert.ok(PG_ONLY[c.id] && PG_ONLY[c.id].test(m), `${c.id} rejected by the validator with an unexpected reason: ${m}`)
                }
                else {
                    assert.ok(/does not exist|invalid input syntax|operator does not exist|out of range/.test(m), `${c.id} rejected with an unexpected database error: ${m}`)
                }
                assert.deepStrictEqual(left, ALL) //資料不變
                assert.deepStrictEqual(evs, ['select', 'delAll'])
                assert.deepStrictEqual(chg, [])
            }
        })
    })
})


describe('whitelist: column names that the shared grammar allows and the series table marks as schema cases work when the column exists (positive path)', function() {
    //案例表之 schema 案在 twl 表上必因欄不存在而被 PG 拒收, 正向路徑(合法欄名被本套件接受並正確命中)另以含這些欄之表驗證.
    //F21(128 字元欄名)超過 PostgreSQL 識別字上限 63 bytes, 無法建欄, 不在此列; F26(Infinity)另見下方〈schema cases whose expectation changed〉
    let CL2 = 'twl2'
    let cols = ['constructor', 'toString', 'hasOwnProperty', 'length', 'prototype', '姓名', 'á', 'ID']
    let POS = ['F04', 'F05', 'F07', 'F16', 'F17', 'F18', 'F19', 'F20', 'F25']
    let reset2 = async () => {
        await admin.query(`DROP TABLE IF EXISTS ${CL2}`)
        await admin.query(`CREATE TABLE ${CL2} (id TEXT PRIMARY KEY, "constructor" TEXT, "toString" TEXT, "hasOwnProperty" TEXT, "length" INTEGER, "prototype" TEXT, "姓名" TEXT, "á" TEXT, "ID" TEXT)`)
        await admin.query(`INSERT INTO ${CL2} VALUES ('a1','x','x','x',3,'x','x','1','a1'), ('a2','y','y','y',4,'y','y','2','a2')`)
    }
    let remain2 = async () => (await admin.query(`SELECT id FROM ${CL2} ORDER BY id`)).rows.map((x) => x.id)
    after(async function() {
        await admin.query(`DROP TABLE IF EXISTS ${CL2}`).catch(() => {})
    })
    it('should have created all the columns it needs (sanity of the fixture)', async function() {
        await reset2()
        let r = await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_name = '${CL2}'`)
        for (let c of cols) {
            assert.ok(r.rows.some((x) => x.column_name === c), `column ${c}`)
        }
    })
    POS.forEach((id) => {
        let c = cvCases.cases.find((x) => x.id === id)
        it(`${id}: ${c.label} selects and deletes exactly row a1 once the column exists`, async function() {
            assert.ok(c && c.schema === true && c.expect === 'OK')
            let wo = WOrm({ url: ct.url, db: ct.db, cl: CL2, pk: 'id' })
            await reset2()
            let rows = await wo.select(c.find())
            assert.deepStrictEqual(ids(rows), ['a1'])
            let rd = await wo.delAll(c.find())
            assert.strictEqual(rd.n, 1)
            assert.deepStrictEqual(await remain2(), ['a2'])
        })
    })
})


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


describe('whitelist: a bad find sends nothing to PostgreSQL (S11)', function() {
    let rejs = cvCases.cases.filter((c) => c.expect === 'REJ')

    it('should not construct a client, connect or query for any rejected case of the table (select and delAll)', async function() {
        this.timeout(120000)
        let st = spy()
        let nError = 0
        let rejected = 0
        try {
            let wo = mk()
            wo.on('error', () => nError++)
            for (let c of rejs) {
                let rs = await wo.select(c.find()).then(() => 'resolved').catch(() => 'rejected')
                let rd = await wo.delAll(c.find()).then(() => 'resolved').catch(() => 'rejected')
                assert.strictEqual(rs, 'rejected', `select ${c.id}`)
                assert.strictEqual(rd, 'rejected', `delAll ${c.id}`)
                rejected += 2
            }
        }
        finally {
            st.restore()
        }
        assert.strictEqual(rejected, rejs.length * 2)
        assert.strictEqual(nError, rejected) //每次 reject 恰發 1 次 error 事件
        assert.strictEqual(st.nCtor, 0, 'no pg.Client is constructed for a bad find')
        assert.strictEqual(st.nConnect, 0, 'no connection for a bad find')
        assert.strictEqual(st.nQuery, 0, 'no statement for a bad find')
    })

    it('should construct, connect and query when the find is good (control of the spy)', async function() {
        await reset()
        let st = spy()
        try {
            let wo = mk()
            let rows = await wo.select({ id: 'a1' })
            assert.deepStrictEqual(ids(rows), ['a1'])
            let rd = await wo.delAll({ id: 'a2' })
            assert.strictEqual(rd.n, 1)
        }
        finally {
            st.restore()
        }
        assert.strictEqual(st.nCtor, 2)
        assert.strictEqual(st.nConnect, 2)
        assert.ok(st.nQuery >= 2)
    })
})


describe('whitelist: schema cases whose expectation changed with the knex rewrite (F21 column name > 63 bytes, F26 Infinity)', function() {
    let CL3 = 'twl3'
    let remain3 = async () => (await admin.query(`SELECT id FROM ${CL3} ORDER BY id`)).rows.map((x) => x.id)
    after(async function() {
        await admin.query(`DROP TABLE IF EXISTS ${CL3}`).catch(() => {})
    })

    it('F21: a 128-char column name (series-legal) is rejected by the pg-only stage before any connection (> 63 bytes; 63 bytes is accepted)', async function() {
        let c = cvCases.cases.find((x) => x.id === 'F21')
        assert.ok(c && c.schema === true && c.expect === 'OK') //系列案例表: 共用層合法, schema 案
        await reset()
        let st = spy()
        let evs = []
        let rs
        let rd
        let r63
        let r64u
        try {
            let wo = mk()
            wo.on('error', (mode) => evs.push(mode))
            rs = await wo.select(c.find()).then(() => null, (e) => e)
            rd = await wo.delAll(c.find()).then(() => null, (e) => e)
            //UTF-8 計: '姓' 為 3 bytes, 22 個 = 66 bytes(> 63, 雖僅 22 字元)
            r64u = await wo.delAll({ ['姓'.repeat(22)]: 'x' }).then(() => null, (e) => e)
        }
        finally {
            st.restore()
        }
        for (let e of [rs, rd, r64u]) {
            assert.ok(e instanceof Error && /^invalid find: column name is too long \(> 63 bytes\) at \[find\./.test(e.message), String(e && e.message)) //pg 專屬限制
        }
        assert.strictEqual(st.nCtor, 0, 'no pg.Client for a column name over 63 bytes') //S11
        assert.strictEqual(st.nQuery, 0)
        assert.deepStrictEqual(evs, ['select', 'delAll', 'delAll']) //S5 各恰 1 次
        assert.deepStrictEqual(await remain(), ALL)
        //63 bytes 恰為上限: 通過檢核, 由 PG 回報欄不存在(twl 無此欄)
        r63 = await mk().select({ ['x'.repeat(63)]: 1 }).then(() => null, (e) => e)
        assert.ok(r63 instanceof Error && r63.code === '42703', String(r63 && r63.message))
    })

    it('F26: {Infinity:1} passes the validator (behavior change 2): PostgreSQL reports the column does not exist on twl, and it hits rows of a table that has the column', async function() {
        let c = cvCases.cases.find((x) => x.id === 'F26')
        assert.ok(c && c.schema === true && c.expect === 'OK')
        await reset()
        let evs = []
        let wo = mk()
        wo.on('error', (mode) => evs.push(mode))
        let rs = await wo.select(c.find()).then(() => null, (e) => e)
        let rd = await wo.delAll(c.find()).then(() => null, (e) => e)
        assert.ok(rs instanceof Error && rs.code === '42703' && /does not exist/.test(rs.message), String(rs && rs.message)) //原為 invalid find(pg 專屬), 今由 PG 回報
        assert.ok(typeof rd === 'string' && /does not exist/.test(rd), String(rd)) //delAll 之 DB 錯誤為字串(Q10)
        assert.deepStrictEqual(evs, ['select', 'delAll'])
        assert.deepStrictEqual(await remain(), ALL)
        //正向: 有 Infinity 欄之表, select 命中 = delAll 刪除(S1)
        await admin.query(`DROP TABLE IF EXISTS ${CL3}`)
        await admin.query(`CREATE TABLE ${CL3} (id TEXT PRIMARY KEY, "Infinity" INTEGER)`)
        await admin.query(`INSERT INTO ${CL3} VALUES ('a1', 1), ('a2', 2), ('a3', NULL)`)
        let wo3 = WOrm({ url: ct.url, db: ct.db, cl: CL3, pk: 'id' })
        assert.deepStrictEqual(ids(await wo3.select(c.find())), ['a1'])
        let rd3 = await wo3.delAll(c.find())
        assert.strictEqual(rd3.n, 1)
        assert.deepStrictEqual(await remain3(), ['a2', 'a3'])
    })
})


describe('whitelist: the checked copy is what gets used (S10)', function() {
    it('should read each property of the caller find exactly once (Proxy get traps counted) and use the read values', async function() {
        await reset()
        let reads = {}
        let target = { g: 'A', age: { $gt: 20 } }
        let find = new Proxy(target, {
            get(t, k, r) {
                reads[k] = (reads[k] || 0) + 1
                return Reflect.get(t, k, r)
            },
            getOwnPropertyDescriptor(t, k) {
                reads[`d:${String(k)}`] = (reads[`d:${String(k)}`] || 0) + 1
                return Reflect.getOwnPropertyDescriptor(t, k)
            }
        })
        let wo = mk()
        let rows = await wo.select(find)
        assert.deepStrictEqual(ids(rows), ['a2'])
        //每個鍵之描述子只讀一次; 不經 get 陷阱再讀值
        assert.strictEqual(reads['d:g'], 1)
        assert.strictEqual(reads['d:age'], 1)
        assert.strictEqual(reads.g || 0, 0)
        assert.strictEqual(reads.age || 0, 0)
    })

    it('should reject an accessor property without invoking it (the checked value and the used value cannot come apart), keeping all rows', async function() {
        await reset()
        let wo = mk()
        let n = 0
        let find = {}
        Object.defineProperty(find, 'g', {
            enumerable: true,
            get() {
                n += 1
                return n === 1 ? 'A' : 'B'
            }
        })
        let r = await wo.delAll(find).then(() => 'resolved').catch((e) => e)
        assert.ok(r instanceof Error && /^invalid find: /.test(r.message), String(r && r.message))
        assert.strictEqual(n, 0, 'the accessor is never invoked')
        assert.deepStrictEqual(await remain(), ALL)
    })

    it('should hand the SQL builder nothing of the caller object: the SQL values are the checked ones even if the caller changes the find between the check and building the SQL (select)', async function() {
        await reset()
        let wo = mk()
        let find = { g: 'A', age: { $gt: 20 } }
        let seen = []
        let oriQuery = pg.Client.prototype.query
        let oriConnect = pg.Client.prototype.connect
        pg.Client.prototype.connect = function(...a) {
            //檢核之後、組 SQL 之前, 呼叫端改動原物件: 已檢核之複本不受影響
            find.g = 'B'
            find.age.$gt = 0
            return oriConnect.apply(this, a)
        }
        pg.Client.prototype.query = function(q, ...a) {
            if (q && q.values) {
                seen.push(JSON.stringify(q.values))
            }
            return oriQuery.call(this, q, ...a)
        }
        let rows
        try {
            rows = await wo.select(find)
        }
        finally {
            pg.Client.prototype.connect = oriConnect
            pg.Client.prototype.query = oriQuery
        }
        assert.deepStrictEqual(seen, ['["A",20]'])
        assert.deepStrictEqual(ids(rows), ['a2'])
    })

    it('should keep every checked condition although a numeric-index setter on Array.prototype exists while the find is checked (select and delAll)', async function() {
        await reset()
        let swallowed = 0
        let had = Object.getOwnPropertyDescriptor(Array.prototype, '0')
        let arm = () => {
            Object.defineProperty(Array.prototype, '0', {
                configurable: true,
                get() {
                    return undefined
                },
                set() {
                    swallowed += 1 //吞掉指派(若本套件以索引指派建立陣列元素, 已檢核之條件會被清空)
                }
            })
        }
        let disarm = () => {
            if (had) {
                Object.defineProperty(Array.prototype, '0', had)
            }
            else {
                delete Array.prototype[0]
            }
        }
        //視窗: 檢核開始(find 之 Proxy 描述子陷阱)起. select 於 cvFind 之後緊接 cvOrder(早於 knex 建句), 以 order 之 Proxy 陷阱還原, 視窗恰為 cvFind;
        //delAll 無此接縫, 視窗延伸至 knex 建句: knex 內部以索引指派建陣列, 屬本套件控制範圍外(R1: 安裝 Array.prototype 數字索引 accessor 屬程式碼執行權層級),
        //判準為 fail-closed(結果正確, 或以 statement check reject 且未刪任何列), 另以直接呼叫 cvFind 驗證檢核本身不以索引指派
        let oriConnect = pg.Client.prototype.connect
        pg.Client.prototype.connect = function(...a) {
            disarm()
            return oriConnect.apply(this, a)
        }
        let mkf = (target) => {
            let armed = false
            return new Proxy(target, {
                getOwnPropertyDescriptor(t, k) {
                    if (!armed) {
                        armed = true
                        arm()
                    }
                    return Reflect.getOwnPropertyDescriptor(t, k)
                }
            })
        }
        let orderDisarms = () => new Proxy({}, {
            get(t, k, r) {
                disarm()
                return Reflect.get(t, k, r)
            }
        })
        let fdel = () => ({ $or: [{ g: 'A' }, { id: 'a5' }], flag: { $eq: false, $ne: true } })
        let wo = mk()
        let nEv = 0
        wo.on('error', () => {
            nEv += 1 //不用陣列 push: 視窗內之索引指派會被測試自己安裝之 setter 吞掉
        })
        let rs
        let rd
        let ir
        let nSel
        try {
            rs = await wo.select(mkf({ $and: [{ g: 'A' }], t: { $in: ['q', 'r'] } }), orderDisarms())
            nSel = swallowed
            ir = cvFind(mkf(fdel()))
            disarm()
            await reset()
            rd = await wo.delAll(mkf(fdel())).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))
        }
        finally {
            disarm()
            pg.Client.prototype.connect = oriConnect
        }
        assert.deepStrictEqual(ids(rs), ['a2']) //g=A 且 t in (q,r)
        assert.strictEqual(nSel, 0, 'no array index is assigned by cvFind (select)') //S10
        //cvFind 於視窗內產出之 IR 未被吞掉: 視窗外建句, 手寫預期: (g=A 或 id=a5) 且 flag IS FALSE($eq:false) 且 flag IS FALSE($ne:true)
        let r = buildDelete(CL, ir)
        assert.strictEqual(r.query, 'delete from "twl" as "$t" where ("g" = $1 or "id" = $2) and "flag" IS FALSE and "flag" IS FALSE')
        assert.deepStrictEqual([...r.values], ['A', 'a5'])
        //delAll(視窗含 knex 建句): fail-closed
        let left = await remain()
        if (rd.ok) {
            assert.strictEqual(rd.v.n, 2) //flag=false 且 (g=A 或 id=a5): a2、a5
            assert.deepStrictEqual(left, ['a1', 'a3', 'a4', 'a6'])
            assert.strictEqual(nEv, 0)
        }
        else {
            assert.ok(rd.e instanceof Error && /^invalid find: internal statement check failed \(statement check\): .+ at \[find\]$/.test(rd.e.message), String((rd.e && rd.e.message) || rd.e))
            assert.deepStrictEqual(left, ALL) //未刪任何列
            assert.strictEqual(nEv, 1) //恰 1 次
        }
    })

    it('should hand the SQL builder nothing of the caller object: delAll deletes the checked condition even if the caller changes the find after the check (delAll)', async function() {
        await reset()
        let wo = mk()
        let find = { g: 'A' }
        let oriConnect = pg.Client.prototype.connect
        pg.Client.prototype.connect = function(...a) {
            find.g = 'B'
            find.$or = [{ id: 'a3' }]
            return oriConnect.apply(this, a)
        }
        let rd
        try {
            rd = await wo.delAll(find)
        }
        finally {
            pg.Client.prototype.connect = oriConnect
        }
        assert.strictEqual(rd.n, 2)
        assert.deepStrictEqual(await remain(), ['a3', 'a4', 'a5', 'a6'])
    })
})
