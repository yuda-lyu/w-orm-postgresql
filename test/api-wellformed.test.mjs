import assert from 'assert'
import pg from 'pg'
import cvOrmStrCases from 'wsemi/src/_cvOrmStrCases.mjs'
import WOrm from '../src/WOrmPostgresql.mjs'
import { startPg, stopPg, connectPg } from './tools/pgContainer.mjs'


//字串良構(第 66 項批 1e): 主鍵值、寫入資料之字串值與鍵名(含巢狀/陣列)之孤立代理字元與主鍵之 NUL 一律拒收.
//真 PostgreSQL(自建容器, 測畢即銷毀), 不 mock 接縫. 規格句見 CLAUDE_rulebook.md R17(S20 ~ S24):
//  S20 主鍵: 孤立代理或 NUL -> 拒; 資料之字串值與鍵名(含巢狀、陣列元素、Map/Set 等 wsemi chkOrmData 走訪者): 孤立代理 -> 拒, 值之 NUL 不屬共用檢核
//  S21 處置同形: insert/insertBulk 整批 reject 且不寫任何一筆(先 emitError 再 reject), save/del 該筆 ok:0 附 err 且同批其他筆照常, selectByPk 回 null
//  S22 檢核作用於已 cloneDeep 之複本, 且先於連線; 訊息固定詞彙不回顯值(invalid id|data: <原因> at [data[<k>].<路徑>])
//  S23 建構時 opt.url/db/cl 含孤立代理或 NUL -> throw invalid opt.<名>: <原因>(見 unit-wellformed)
//  S24 本套件無 autoGenPk 選項(主鍵從不自動補值): 傳 autoGenPk:false 亦不改變檢核(案例表以 undefined 與 false 各跑一輪)
//逐案套用 wsemi 之契約案例表 _cvOrmStrCases(API 層, 不含 opt 組: 建構案在 unit-wellformed); PostgreSQL 為固定欄位後端, 需 'doc' 與 'gfs' 能力之案略過(拒收案全數適用)


let ctName = 'worm-test-pg66-wellformed'
let ct = null
let admin = null
let CL = 'twf'

//caps, 固定欄位之表(id TEXT 主鍵, name TEXT, meta JSONB): 無法[接受後讀回任意欄位與巢狀結構], 無 GridFS
let caps = { doc: false, gfs: false }

let mk = (id, extra) => ({ id, name: 'n', ...extra })
let msgOf = (err) => (err instanceof Error ? err.message : String(err))
let settle = (p) => p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e }))

let reset = async () => {
    await admin.query(`DROP TABLE IF EXISTS ${CL}`)
    await admin.query(`CREATE TABLE ${CL} (id TEXT PRIMARY KEY, name TEXT, meta JSONB)`)
}
let fresh = async (extra = {}) => {
    await reset()
    return WOrm({ url: ct.url, db: ct.db, cl: CL, pk: 'id', ...extra })
}
let allIds = async (wo) => (await wo.select()).map((v) => v.id).sort()
//以獨立的 admin 連線直讀資料庫(不經被測套件): 案例表 harness 的預存、快照與結果核對用, 只有被測 API 本身開連線(每案約 1 條, 免暫時埠耗盡)
let idsDb = async () => (await admin.query(`SELECT id FROM ${CL}`)).rows.map((v) => v.id).sort()
let rowDb = async (id) => (await admin.query(`SELECT id, name, meta FROM ${CL} WHERE id = $1`, [id])).rows[0] || null
let assertPartial = (actual, part) => {
    assert.ok(actual !== null && actual !== undefined, 'row must exist')
    for (let k of Object.keys(part)) {
        assert.deepStrictEqual(actual[k], part[k], `field ${k}`)
    }
}

//runCase, 對公開 API 執行一案(依案例表檔頭[後端套用方式]); extra 為建構時附加之設定(如 autoGenPk:false)
let runCase = async (c, extra) => {
    let wo = await fresh(extra)
    let evs = []
    wo.on('error', (mode, data, msg) => evs.push([mode, msg]))
    for (let d of c.pre(mk)) {
        await admin.query(`INSERT INTO ${CL} (id, name) VALUES ($1, $2)`, [d.id, d.name])
    }
    let args = c.args(mk, null)
    let before = {}
    for (let id of (c.expect.unchanged || [])) {
        before[id] = await rowDb(id)
    }
    let e = c.expect
    let r, rej
    try {
        let p = wo[c.api](...args)
        if (c.afterCall) {
            c.afterCall(args)
        }
        r = await p
    }
    catch (err) {
        rej = err
    }
    if (e.kind === 'free') {
        let re = new RegExp(e.notMsg)
        if (rej !== undefined) {
            assert.ok(!re.test(msgOf(rej)), `free: shared check must not reject: ${msgOf(rej)}`)
        }
        else if (Array.isArray(r)) {
            r.forEach((x) => {
                assert.ok(x.ok === 1 || !re.test(String(x.err)), `free: shared check must not reject: ${x.err}`)
            })
        }
    }
    else if (e.kind === 'rejectAll') {
        assert.ok(rej !== undefined, 'must reject')
        assert.strictEqual(msgOf(rej), e.msg)
        assert.ok(rej instanceof Error, 'reject value must be an Error')
        assert.deepStrictEqual(evs.map((v) => v[1]), [e.msg], 'exactly one error event, with the same message, before the reject')
    }
    else {
        assert.ok(rej === undefined, `must not reject: ${rej && msgOf(rej)}`)
        if (e.kind === 'null') {
            assert.strictEqual(r, null)
            assert.deepStrictEqual(evs, [])
        }
        if (e.kind === 'itemErr') {
            assert.ok(Array.isArray(r) && r.length === (Array.isArray(args[0]) ? args[0].length : 1), 'one result per input record')
            r.forEach((x, i) => {
                if (e.bad.includes(i)) {
                    assert.deepStrictEqual([x.ok, x.err], [0, e.msgs ? e.msgs[e.bad.indexOf(i)] : e.msg])
                }
                else {
                    assert.strictEqual(x.ok, 1, `record ${i} must be processed: ${x.err}`)
                }
            })
            assert.strictEqual(evs.length, e.bad.length, 'one error event per failed record')
            assert.deepStrictEqual(evs.map((v) => v[1]), e.bad.map((i) => (e.msgs ? e.msgs[e.bad.indexOf(i)] : e.msg)))
        }
        if (e.kind === 'ok') {
            assert.deepStrictEqual(evs, [])
        }
    }
    if (e.kind === 'ok' && /^insert/.test(c.api)) {
        assert.strictEqual(r.ok, 1)
    }
    if (e.ids) {
        assert.deepStrictEqual(await idsDb(), e.ids)
    }
    for (let id of (e.unchanged || [])) {
        assert.deepStrictEqual(await rowDb(id), before[id])
    }
    if (e.kind === 'ok' && e.result) {
        assertPartial(r, e.result)
    }
    for (let [id, part] of Object.entries(e.rows || {})) {
        assertPartial(await rowDb(id), part)
    }
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


//API 層案例(group 非 str/data; opt 組為建構案, 見 unit-wellformed)
let apiCases = cvOrmStrCases.cases.filter((v) => v.group !== 'str' && v.group !== 'data' && v.api !== 'new')

describe('wellformed: cvOrmStrCases against the public API', function() {

    it('should run every non-constructor case of the shared table (shape guard)', function() {
        assert.ok(apiCases.length >= 1200, `cases: ${apiCases.length}`)
        assert.ok(new Set(apiCases.map((v) => v.id)).size === apiCases.length)
        assert.strictEqual(cvOrmStrCases.cases.filter((v) => v.api === 'new').length, 48)
    })

    for (let c of apiCases) {
        it(c.id, async function() {
            if (c.need.includes('doc') && !caps.doc) {
                return this.skip()
            }
            if (c.need.includes('gfs') && !caps.gfs) {
                return this.skip()
            }
            await runCase(c, {})
        })
    }
})

//S24: 本套件無 autoGenPk 選項, 傳 autoGenPk:false 不改變檢核(案例表 id/single/val/order 以 autoGenPk:false 再跑一輪)
describe('wellformed: cvOrmStrCases with autoGenPk:false (no such option; checks must not change)', function() {
    for (let c of apiCases.filter((v) => ['id', 'single', 'val', 'order'].includes(v.group))) {
        it(`${c.id} [autoGenPk:false]`, async function() {
            if (c.need.includes('doc') && !caps.doc) {
                return this.skip()
            }
            if (c.need.includes('gfs') && !caps.gfs) {
                return this.skip()
            }
            await runCase(c, { autoGenPk: false })
        })
    }
})


describe('wellformed: postgresql-specific', function() {

    //名稱類(D3): 孤立代理之 opt.cl 經 UTF-8 送出變 U+FFFD, 原本誤中名為 't'+U+FFFD 之他表並被 delAll 清空
    describe('storage name that UTF-8 would rewrite onto another table', function() {
        let other = 't�'
        let setup = async () => {
            await admin.query(`DROP TABLE IF EXISTS "${other}"`)
            await admin.query(`CREATE TABLE "${other}" (id TEXT PRIMARY KEY, name TEXT)`)
            await admin.query(`INSERT INTO "${other}" VALUES ('victim', 'x')`)
        }
        let teardown = async () => {
            await admin.query(`DROP TABLE IF EXISTS "${other}"`)
        }
        let rowsOf = async () => (await admin.query(`SELECT id FROM "${other}"`)).rows.map((v) => v.id)

        for (let [label, cl] of [['high surrogate', 't\ud800'], ['low surrogate', 't\udc00'], ['reversed pair', 't\udc00\ud800']]) {
            it(`should throw at construction for opt.cl with a lone ${label}; the other table is untouched`, async function() {
                await setup()
                try {
                    assert.throws(() => WOrm({ url: ct.url, db: ct.db, cl, pk: 'id' }), (e) => e instanceof Error && e.message === 'invalid opt.cl: string contains lone surrogate')
                    assert.deepStrictEqual(await rowsOf(), ['victim'])
                }
                finally {
                    await teardown()
                }
            })
        }

        it('should use the well-formed table named with U+FFFD, and keep it apart from the surrogate-named instances', async function() {
            await setup()
            try {
                let wo = WOrm({ url: ct.url, db: ct.db, cl: other, pk: 'id' })
                assert.deepStrictEqual((await wo.select()).map((v) => v.id), ['victim'])
                assert.deepStrictEqual((await wo.del({ id: 'victim' }))[0].nDeleted, 1)
                assert.deepStrictEqual(await rowsOf(), [])
            }
            finally {
                await teardown()
            }
        })

        it('should throw at construction for opt.db and opt.url with a lone surrogate, without connecting', function() {
            let n = 0
            let orig = pg.Client.prototype.connect
            pg.Client.prototype.connect = function(...a) {
                n++
                return orig.apply(this, a)
            }
            try {
                assert.throws(() => WOrm({ url: ct.url, db: 'w\ud800', cl: CL }), (e) => e.message === 'invalid opt.db: string contains lone surrogate')
                assert.throws(() => WOrm({ url: `${ct.url}\udc00`, db: ct.db, cl: CL }), (e) => e.message === 'invalid opt.url: string contains lone surrogate')
            }
            finally {
                pg.Client.prototype.connect = orig
            }
            assert.strictEqual(n, 0)
        })
    })

    //處置同形(統一規格 T6、dspec〈一之三〉9.3): 良構性之無效主鍵(孤立代理字元、NUL)save 由整批 reject 改為逐筆 ok:0(D5);
    //未帶有效主鍵(未給、空字串、型別不符等)仍為 T6 之整批性錯誤(insert、insertBulk、save 皆 reject); del 一律逐筆; 訊息皆為固定詞彙不回顯值
    describe('invalid pk values of every kind: fixed vocabulary; save is per-record only for well-formedness problems', function() {
        let bad = [
            ['missing', {}, 'primary key is missing'],
            ['undefined', { id: undefined }, 'primary key is missing'],
            ['empty string', { id: '' }, 'string is empty'],
            ['null', { id: null }, 'unsupported primary key value'],
            ['NaN', { id: NaN }, 'unsupported primary key value'],
            ['Number wrapper', { id: Object(5) }, 'unsupported primary key value'],
            ['String wrapper', { id: Object('x') }, 'unsupported primary key value'],
            ['plain object', { id: { a: 1 } }, 'unsupported primary key value'],
            ['array', { id: ['x'] }, 'unsupported primary key value'],
            ['invalid Date', { id: new Date(NaN) }, 'unsupported primary key value'],
            ['Symbol', { id: Symbol('secret-desc') }, 'unsupported primary key value'],
            ['function', { id: () => 1 }, 'unsupported primary key value'],
            ['NUL string', { id: 'a\u0000b' }, 'string contains NUL'],
            ['lone surrogate string', { id: 'a\ud800b' }, 'string contains lone surrogate'],
        ]
        bad.forEach(([label, doc, reason]) => {
            let msg = (k) => `invalid id: ${reason} at [data[${k}].id]`
            it(`${label}: insert and insertBulk reject the whole batch with a fixed message (nothing written)`, async function() {
                for (let api of ['insert', 'insertBulk']) {
                    let wo = await fresh()
                    await wo.insertBulk([mk('k0')])
                    let evs = []
                    wo.on('error', (mode, data, m) => evs.push([mode, m]))
                    let r = await settle(wo[api]([mk('g0'), { ...doc, name: 'bad' }, mk('g2')]))
                    assert.ok(!r.ok && r.e instanceof Error, api)
                    assert.strictEqual(r.e.message, msg(1), api)
                    assert.deepStrictEqual(evs, [[api, msg(1)]], api)
                    assert.deepStrictEqual(await allIds(wo), ['k0'], api)
                }
            })
            if (reason === 'string contains lone surrogate' || reason === 'string contains NUL') {
                it(`${label}: save fails only that record (ok:0 + err), the others are saved`, async function() {
                    let wo = await fresh()
                    let evs = []
                    wo.on('error', (mode, data, m) => evs.push([mode, m]))
                    let r = await wo.save([mk('g0'), { ...doc, name: 'bad' }, mk('g2')])
                    assert.deepStrictEqual(r.map((v) => v.ok), [1, 0, 1])
                    assert.deepStrictEqual([r[1].n, r[1].nInserted, r[1].nModified], [1, 0, 0])
                    assert.strictEqual(r[1].err, msg(1))
                    assert.deepStrictEqual(evs, [['save', msg(1)]])
                    assert.deepStrictEqual(await allIds(wo), ['g0', 'g2'])
                })
            }
            else {
                it(`${label}: save rejects the whole batch (T6: no valid pk is not a per-record problem) and writes nothing`, async function() {
                    let wo = await fresh()
                    await wo.insertBulk([mk('k0')])
                    let evs = []
                    wo.on('error', (mode, data, m) => evs.push([mode, m]))
                    let r = await settle(wo.save([mk('g0'), { ...doc, name: 'bad' }, mk('g2')]))
                    assert.ok(!r.ok && r.e instanceof Error)
                    assert.strictEqual(r.e.message, msg(1))
                    assert.deepStrictEqual(evs, [['save', msg(1)]])
                    assert.deepStrictEqual(await allIds(wo), ['k0'])
                })
            }
            it(`${label}: del fails only that record (ok:0 + err), the others are deleted`, async function() {
                let wo = await fresh()
                await wo.insertBulk([mk('g0'), mk('g2'), mk('keep')])
                let r = await wo.del([mk('g0'), { ...doc }, mk('g2')])
                assert.deepStrictEqual(r.map((v) => v.ok), [1, 0, 1])
                assert.strictEqual(r[1].err, msg(1))
                assert.deepStrictEqual([r[1].n, r[1].nDeleted], [0, 0])
                assert.deepStrictEqual(await allIds(wo), ['keep'])
            })
            it(`${label}: selectByPk returns null`, async function() {
                let wo = await fresh()
                await wo.insertBulk([mk('k0')])
                assert.strictEqual(await wo.selectByPk(doc.id), null)
            })
        })

        it('should not echo the offending value in any message', async function() {
            let wo = await fresh()
            let secret = 'sec\ud800ret-value'
            let rs = []
            rs.push(await settle(wo.insert([{ id: secret }])))
            rs.push(await settle(wo.insertBulk([{ id: secret }])))
            rs.push((await wo.save([{ id: secret }]))[0].err)
            rs.push((await wo.save([{ id: 'ok', name: secret }]))[0].err)
            rs.push((await wo.del([{ id: secret }]))[0].err)
            rs.push(await settle(wo.insert([{ id: 'ok', name: secret }])))
            rs.push(await settle(wo.insert([{ id: 'ok', meta: { [`k${secret}`]: 1 } }])))
            let texts = rs.map((v) => (typeof v === 'string' ? v : msgOf(v.e)))
            texts.forEach((t) => {
                assert.ok(t.startsWith('invalid id: string contains lone surrogate at [data[0].id]') || t.startsWith('invalid data: string contains lone surrogate at ['), t)
                assert.ok(!t.includes('sec') && !t.includes('ret-value') && !/\\u/i.test(t) && !t.includes('\ud800'), t)
            })
        })
    })

    //檢核先於連線: 連不上之位址也得到檢核錯誤(而非連線錯誤), 且不建立連線
    describe('checks run before any connection', function() {
        it('should reject insert and insertBulk with the check error, never connecting (dead port)', async function() {
            let n = 0
            let orig = pg.Client.prototype.connect
            pg.Client.prototype.connect = function(...a) {
                n++
                return orig.apply(this, a)
            }
            try {
                let wo = WOrm({ url: 'postgresql://username:password@127.0.0.1:1', db: 'worm', cl: CL, pk: 'id' })
                let evs = []
                wo.on('error', (mode, data, m) => evs.push([mode, m]))
                for (let api of ['insert', 'insertBulk']) {
                    let r1 = await settle(wo[api]([{ id: 'a\ud800' }]))
                    assert.strictEqual(r1.e.message, 'invalid id: string contains lone surrogate at [data[0].id]', api)
                    let r2 = await settle(wo[api]([{ id: 'a', name: 'x\udc00' }]))
                    assert.strictEqual(r2.e.message, 'invalid data: string contains lone surrogate at [data[0].name]', api)
                }
                assert.strictEqual(n, 0)
                assert.strictEqual(evs.length, 4)
            }
            finally {
                pg.Client.prototype.connect = orig
            }
        })

        it('should report the connection error when the checks pass (the checks do not mask it)', async function() {
            let wo = WOrm({ url: 'postgresql://username:password@127.0.0.1:1', db: 'worm', cl: CL, pk: 'id' })
            let r = await settle(wo.insert([{ id: 'good' }]))
            assert.ok(!r.ok && !/^invalid (id|data)/.test(msgOf(r.e)), msgOf(r.e))
        })
    })

    //寫入值: 良構的 emoji/CJK 擴充 B/U+FFFD 照常寫入並讀回; 巢狀 JSONB 之孤立代理由共用檢核拒收(原由資料庫報錯)
    describe('values: well-formed strings are stored as is; lone surrogates in JSONB are refused before the database', function() {
        let good = ['a\u{1F600}b', '\u{20BB7}野家', 'a�b', 'é', '\u{1F468}‍\u{1F469}']
        good.forEach((s, i) => {
            it(`should store and read back the well-formed string #${i} (top-level, JSONB value, JSONB key, array element) via insert, insertBulk and save`, async function() {
                let wo = await fresh()
                await wo.insert([{ id: `i${i}`, name: s, meta: { [s]: [s, { n: s }] } }])
                await wo.insertBulk([{ id: `b${i}`, name: s, meta: { [s]: [s, { n: s }] } }])
                await wo.save([{ id: `s${i}`, name: s, meta: { [s]: [s, { n: s }] } }])
                await wo.save([{ id: `s${i}`, name: `${s}2`, meta: { [s]: [s, { n: s }] } }], { autoInsert: false })
                for (let p of ['i', 'b', 's']) {
                    let r = await wo.selectByPk(`${p}${i}`)
                    assert.strictEqual(r.name, p === 's' ? `${s}2` : s)
                    assert.deepStrictEqual(r.meta, { [s]: [s, { n: s }] })
                }
            })
        })

        it('should refuse a lone surrogate inside a JSONB value, array element and key with the shared message (not a database error)', async function() {
            let wo = await fresh()
            let cases = [
                [{ id: 'g', meta: { a: { b: 'x\ud800' } } }, 'invalid data: string contains lone surrogate at [data[0].meta.a.b]'],
                [{ id: 'g', meta: { a: ['ok', 'x\udc00'] } }, 'invalid data: string contains lone surrogate at [data[0].meta.a[1]]'],
                [{ id: 'g', meta: { 'k\ud800': 1 } }, 'invalid data: string contains lone surrogate at [data[0].meta.<invalid key>]'],
                [{ 'id': 'g', 'k\ud800': 1 }, 'invalid data: string contains lone surrogate at [data[0].<invalid key>]'],
            ]
            for (let [doc, msg] of cases) {
                let r = await settle(wo.insert([doc]))
                assert.strictEqual(msgOf(r.e), msg)
                let r2 = await wo.save([doc])
                assert.deepStrictEqual([r2[0].ok, r2[0].err], [0, msg])
                let r3 = await wo.save([doc], { autoInsert: false })
                assert.deepStrictEqual([r3[0].ok, r3[0].err], [0, msg])
            }
            assert.deepStrictEqual(await allIds(wo), [])
        })

        it('should not look into Date and Buffer values (skipped), and accept NUL in values and keys as far as the shared check goes', async function() {
            let wo = await fresh()
            await admin.query(`ALTER TABLE ${CL} ADD COLUMN ts TIMESTAMPTZ, ADD COLUMN bin BYTEA`)
            let r = await wo.insert([{ id: 'd', ts: new Date(0), bin: Buffer.from([0xd8, 0x00, 0x41]) }])
            assert.strictEqual(r.nInserted, 1)
            let row = await wo.selectByPk('d')
            assert.strictEqual(row.ts.getTime(), 0)
            assert.deepStrictEqual([...row.bin], [0xd8, 0x00, 0x41])
            //值含 NUL 不屬共用檢核: 由 PostgreSQL 自身拒收, 訊息不是共用詞彙
            let r2 = await settle(wo.insert([{ id: 'n', name: 'a\u0000b' }]))
            assert.ok(!r2.ok && !/^invalid (id|data): string contains/.test(msgOf(r2.e)), msgOf(r2.e))
        })
    })

    //save 預先檢核之順序: 欄名文法(autoInsert:false)之整批 reject 不被無效主鍵筆遮蔽, 但無效主鍵筆不做欄名檢核
    describe('save: whole-batch column-name check and per-record checks', function() {
        it('should still reject the whole batch for a non-identifier data key of a valid record (autoInsert:false), writing nothing', async function() {
            let wo = await fresh()
            await wo.insertBulk([mk('a'), mk('b')])
            let evs = []
            wo.on('error', (mode, data, m) => evs.push([mode, m]))
            let r = await settle(wo.save([{ id: 'a', name: 'changed' }, { 'id': 'b', 'x y': 1 }], { autoInsert: false }))
            assert.ok(!r.ok && /^invalid data\[1\]: /.test(r.e.message), msgOf(r.e))
            assert.strictEqual(evs.length, 1)
            assert.strictEqual((await wo.selectByPk('a')).name, 'n')
        })

        it('should treat an invalid-pk record as a per-record failure even when it also has a non-identifier key', async function() {
            let wo = await fresh()
            await wo.insertBulk([mk('a')])
            let r = await wo.save([{ id: 'a', name: 'changed' }, { 'id': 'a\ud800', 'x y': 1 }], { autoInsert: false })
            assert.deepStrictEqual(r.map((v) => v.ok), [1, 0])
            assert.strictEqual(r[1].err, 'invalid id: string contains lone surrogate at [data[1].id]')
        })

        it('should reject the whole batch for the smallest-index batch-level problem, across record kinds (lone pk before it stays per-record, never written)', async function() {
            let wo = await fresh()
            await wo.insertBulk([mk('a')])
            let evs = []
            wo.on('error', (mode, data, m) => evs.push([mode, m]))
            //索引 0 為良構性問題(逐筆), 索引 1 為缺主鍵(整批), 索引 2 為不合文法之鍵(整批): 以索引 1 為準
            let r = await settle(wo.save([{ id: 'x\ud800' }, { name: 'nopk' }, { 'id': 'a', 'x y': 1 }], { autoInsert: false }))
            assert.strictEqual(msgOf(r.e), 'invalid id: primary key is missing at [data[1].id]')
            //索引 0 為不合文法之鍵(整批)先於索引 1 之缺主鍵
            let r2 = await settle(wo.save([{ 'id': 'a', 'x y': 1 }, { name: 'nopk' }], { autoInsert: false }))
            assert.ok(/^invalid data\[0\]: /.test(msgOf(r2.e)), msgOf(r2.e))
            assert.deepStrictEqual(evs.map((v) => v[0]), ['save', 'save'])
            assert.deepStrictEqual(await allIds(wo), ['a'])
        })

        it('should keep the whole-batch column-name error when the same record (valid pk) also has a lone surrogate in a value (autoInsert:false)', async function() {
            let wo = await fresh()
            await wo.insertBulk([mk('a'), mk('b')])
            let evs = []
            wo.on('error', (mode, data, m) => evs.push([mode, m]))
            let r = await settle(wo.save([{ 'id': 'a', 'name': 'x\ud800', 'x y': 1 }, { id: 'b', name: 'changed' }], { autoInsert: false }))
            assert.ok(!r.ok && /^invalid data\[0\]: /.test(msgOf(r.e)), msgOf(r.e))
            assert.strictEqual(evs.length, 1)
            assert.strictEqual((await wo.selectByPk('b')).name, 'n') //整批無寫入
            //autoInsert:true 不做欄名文法檢核(INSERT 一律引用), 同一筆之良構問題仍為逐筆
            let r2 = await wo.save([{ 'id': 'a', 'name': 'x\ud800', 'x y': 1 }])
            assert.deepStrictEqual([r2[0].ok, r2[0].err], [0, 'invalid data: string contains lone surrogate at [data[0].name]'])
        })

        it('should report a lone-surrogate data key per record (fixed path) in autoInsert:false, while a NUL key (not an identifier) still rejects the whole batch', async function() {
            let wo = await fresh()
            await wo.insertBulk([mk('a'), mk('b')])
            let r = await wo.save([{ 'id': 'a', 'k\ud800': 1 }, { id: 'b', name: 'changed' }], { autoInsert: false })
            assert.deepStrictEqual(r.map((v) => v.ok), [0, 1])
            assert.strictEqual(r[0].err, 'invalid data: string contains lone surrogate at [data[0].<invalid key>]')
            assert.ok(!/ud800|�|\ud800/i.test(r[0].err))
            assert.strictEqual((await wo.selectByPk('b')).name, 'changed')
            let r2 = await settle(wo.save([{ 'id': 'b', 'k\u0000': 1 }], { autoInsert: false }))
            assert.ok(!r2.ok && /^invalid data\[0\]: /.test(msgOf(r2.e)), msgOf(r2.e))
        })

        it('should refuse createTable for a fully quoted table name with a lone surrogate or NUL before sending any DDL', async function() {
            let wo = await fresh()
            let evs = []
            wo.on('error', (mode, data, m) => evs.push([mode, m]))
            for (let s of ['t\ud800', 't\udc00', 't\u0000']) {
                let r = await settle(wo.createTable(`"${s}"`, 'id', { id: 'x' }))
                assert.ok(!r.ok && r.e instanceof Error && r.e.message === 'invalid createTable: invalid table name', msgOf(r.e))
            }
            assert.strictEqual(evs.length, 3)
            let t = await admin.query('SELECT relname FROM pg_class WHERE relname LIKE \'t%\' AND relkind = \'r\'')
            assert.deepStrictEqual(t.rows.map((v) => v.relname).filter((n) => n !== CL), [])
        })

        it('should use the batch index of each failed record in save and del (not 0 or the loop count)', async function() {
            let wo = await fresh()
            await wo.insertBulk([mk('k0'), mk('k1')])
            let H = 'x\ud800'
            let r = await wo.save([mk('k0', { name: 's0' }), mk(H), mk('k1', { name: 's1' }), mk(H), { id: 'k5', name: H }])
            assert.deepStrictEqual(r.map((v) => v.err), [undefined, 'invalid id: string contains lone surrogate at [data[1].id]', undefined, 'invalid id: string contains lone surrogate at [data[3].id]', 'invalid data: string contains lone surrogate at [data[4].name]'])
            let d = await wo.del([mk('k0'), mk(H), mk(H)])
            assert.deepStrictEqual(d.map((v) => v.err), [undefined, 'invalid id: string contains lone surrogate at [data[1].id]', 'invalid id: string contains lone surrogate at [data[2].id]'])
        })
    })

    //檢查之值即使用之值(外審 sol F1~F3): 檢核過程(chkOrmData 呼叫繼承存取器)與事件回呼皆不得改動其後實際寫入之數據
    describe('the checked value is the written value: check side effects and event listeners cannot reach the pending data', function() {
        //帶副作用之繼承可列舉 getter: chkOrmData 呼叫它時會把 name 改成含孤立代理字元之字串
        let mkRec = (id, name) => {
            class Rec {}
            Object.defineProperty(Rec.prototype, 'hook', {
                enumerable: true,
                configurable: true,
                get() {
                    this.name = 'x\ud800'
                    return 'h'
                },
            })
            let r = new Rec()
            r.id = id
            r.name = name
            return r
        }

        it('should write the checked value when an inherited enumerable getter rewrites the record during the check (insert, insertBulk, save)', async function() {
            for (let api of ['insert', 'insertBulk', 'save']) {
                let wo = await fresh()
                let r = await settle(wo[api]([mkRec('a', 'good'), mkRec('b', 'fine')]))
                assert.ok(r.ok, `${api}: ${r.e && msgOf(r.e)}`)
                assert.deepStrictEqual((await wo.select()).map((v) => [v.id, v.name]).sort(), [['a', 'good'], ['b', 'fine']], api)
            }
        })

        it('should give the change(insert) listener of save the record as it was written, also when a getter rewrote the check copy', async function() {
            let wo = await fresh()
            let got = []
            wo.on('change', (mode, data) => {
                if (mode === 'insert') {
                    got.push([data[0].id, data[0].name])
                }
            })
            await wo.save([mkRec('a', 'good'), mkRec('b', 'fine')])
            assert.deepStrictEqual(got, [['a', 'good'], ['b', 'fine']])
            assert.deepStrictEqual((await wo.select()).map((v) => [v.id, v.name]).sort(), [['a', 'good'], ['b', 'fine']])
        })

        it('should not let an error/change listener rewrite a later record of save through a reference shared with an earlier record', async function() {
            let wo = await fresh()
            let shared = { s: 'good' }
            let seen = 0
            wo.on('error', (mode, data) => {
                seen++
                data[0].meta.s = 'evil\ud800'
            })
            wo.on('change', (mode, data) => {
                if (mode === 'insert') {
                    data[0].meta.s = 'evil2\ud800'
                }
            })
            let r = await wo.save([{ id: 'bad\ud800', meta: shared }, { id: 'ok1', meta: shared }, { id: 'ok2', meta: shared }])
            assert.deepStrictEqual(r.map((v) => v.ok), [0, 1, 1])
            assert.strictEqual(seen, 1)
            assert.deepStrictEqual((await wo.selectByPk('ok1')).meta, { s: 'good' })
            assert.deepStrictEqual((await wo.selectByPk('ok2')).meta, { s: 'good' })
            assert.deepStrictEqual(shared, { s: 'good' }) //呼叫端原物件亦未被改動
        })

        it('should hand every per-record failure event of save (NUL data key, database error) an independent snapshot', async function() {
            let wo = await fresh()
            let shared = { s: 'good' }
            let seen = []
            wo.on('error', (mode, data) => {
                seen.push(data[0].meta.s)
                data[0].meta.s = 'evil\ud800'
            })
            let r = await wo.save([
                { 'id': 'a', 'k\u0000': 1, 'meta': shared }, //資料鍵含 NUL: genInsert 檢核失敗(縱深)
                { id: 'ok1', meta: shared },
                { id: 'b', nocol: 1, meta: shared }, //欄不存在: PostgreSQL 回報
                { id: 'ok2', meta: shared },
            ])
            assert.deepStrictEqual(r.map((v) => v.ok), [0, 1, 0, 1])
            assert.deepStrictEqual(seen, ['good', 'good'])
            assert.deepStrictEqual((await wo.selectByPk('ok1')).meta, { s: 'good' })
            assert.deepStrictEqual((await wo.selectByPk('ok2')).meta, { s: 'good' })
        })

        it('should not let an error listener change which row a later del removes (Date pk shared between records)', async function() {
            await admin.query('DROP TABLE IF EXISTS twf_date')
            await admin.query('CREATE TABLE twf_date (time TIMESTAMPTZ PRIMARY KEY, v TEXT)')
            await admin.query('INSERT INTO twf_date VALUES (\'1970-01-01T00:00:01Z\', \'one\'), (\'1970-01-01T00:00:02Z\', \'two\')')
            try {
                let wo = WOrm({ url: ct.url, db: ct.db, cl: 'twf_date', pk: 'time' })
                wo.on('error', (mode, data) => {
                    if (data[0] && data[0].ref instanceof Date) {
                        data[0].ref.setTime(2000)
                    }
                })
                let d = new Date(1000)
                let r = await wo.del([{ time: Symbol('x'), ref: d }, { time: d }])
                assert.deepStrictEqual(r.map((v) => v.ok), [0, 1])
                assert.deepStrictEqual((await admin.query('SELECT v FROM twf_date ORDER BY time')).rows.map((v) => v.v), ['two'])
                assert.strictEqual(d.getTime(), 1000) //呼叫端原物件未被改動
            }
            finally {
                await admin.query('DROP TABLE IF EXISTS twf_date')
            }
        })
    })

    //全批皆已於連線之前判定為逐筆失敗者無須連線; 混合批次連線失敗仍整批 reject
    describe('save/del: a batch that is all per-record failures needs no connection', function() {
        let countConnects = async (fn) => {
            let n = 0
            let orig = pg.Client.prototype.connect
            pg.Client.prototype.connect = function(...a) {
                n++
                return orig.apply(this, a)
            }
            try {
                return { n, out: await fn(() => n) }
            }
            finally {
                pg.Client.prototype.connect = orig
            }
        }

        it('should return the per-record results and events without connecting (dead port)', async function() {
            let wo = WOrm({ url: 'postgresql://username:password@127.0.0.1:1', db: 'worm', cl: CL, pk: 'id' })
            let evs = []
            wo.on('error', (mode, data, m) => evs.push([mode, m]))
            let { out, n } = await countConnects(async (get) => {
                let s = await wo.save([{ id: 'a\ud800' }, { id: 'b', name: 'x\udc00' }])
                let d = await wo.del([{ id: 'c\u0000' }, { id: 'd\ud800' }])
                return { s, d, count: get() }
            })
            assert.strictEqual(out.count, 0)
            assert.strictEqual(n, 0)
            assert.deepStrictEqual(out.s.map((v) => [v.ok, v.err]), [[0, 'invalid id: string contains lone surrogate at [data[0].id]'], [0, 'invalid data: string contains lone surrogate at [data[1].name]']])
            assert.deepStrictEqual(out.d.map((v) => [v.ok, v.err]), [[0, 'invalid id: string contains NUL at [data[0].id]'], [0, 'invalid id: string contains lone surrogate at [data[1].id]']])
            assert.strictEqual(evs.length, 4)
        })

        it('should still reject the whole call with the connection error when a batch has a record to process', async function() {
            let wo = WOrm({ url: 'postgresql://username:password@127.0.0.1:1', db: 'worm', cl: CL, pk: 'id' })
            let r1 = await settle(wo.save([{ id: 'a\ud800' }, { id: 'ok' }]))
            let r2 = await settle(wo.del([{ id: 'a\ud800' }, { id: 'ok' }]))
            for (let r of [r1, r2]) {
                assert.ok(!r.ok && !/^invalid (id|data)/.test(msgOf(r.e)), msgOf(r.e))
            }
        })
    })

    //預設主鍵 time(INTEGER): 資料字串值之檢核與主鍵欄名無關; 路徑中之主鍵名為建構時已驗證之識別字
    describe('default pk name', function() {
        it('should name the configured pk column in the path', async function() {
            await admin.query(`DROP TABLE IF EXISTS ${CL}`)
            await admin.query(`CREATE TABLE ${CL} (time TEXT PRIMARY KEY, name TEXT)`)
            let wo = WOrm({ url: ct.url, db: ct.db, cl: CL })
            let r = await settle(wo.insert([{ time: 'a\ud800' }]))
            assert.strictEqual(msgOf(r.e), 'invalid id: string contains lone surrogate at [data[0].time]')
            let r2 = await settle(wo.insert([{ time: 't1', name: 'a\ud800' }]))
            assert.strictEqual(msgOf(r2.e), 'invalid data: string contains lone surrogate at [data[0].name]')
        })
    })
})
