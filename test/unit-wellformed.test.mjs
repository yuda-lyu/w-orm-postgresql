import assert from 'assert'
import fs from 'fs'
import path from 'path'
import pg from 'pg'
import cvOrmStrCases from 'wsemi/src/_cvOrmStrCases.mjs'
import WOrm from '../src/WOrmPostgresql.mjs'
import { cvTable, genInsert, genConflict } from '../src/cvWrite.mjs'


//字串良構(第 66 項批 1e)之不需 docker 部分. 規格句見 CLAUDE_rulebook.md R17:
//  S23 建構時 opt.url/db/cl 含孤立代理字元(或 NUL)-> throw Error('invalid opt.<名>: <原因>'), 不連線; 案例表 opt 組(48 案)逐案執行
//  S21、S22 公開 API 於死埠(不存在之連線位址)下的檢核: 先於連線(連線數 0)、批次索引、事件、逐筆處置、事件 payload 為獨立快照(不需 docker)
//  S25 良構性判定單一擁有者為 wsemi 之 chkOrmStr/chkOrmData: src 內不得再有私有複本(isCleanStr、isWellFormed、孤立代理正則),
//      主鍵、表名、資料鍵之判定皆經 chkOrmStr, 寫入資料之走訪經 chkOrmData(接線站點見 R17 站點全集)
//API 層案例(id、single、val、free、type、toctou、order)見 api-wellformed.test.mjs


let srcDir = path.resolve('./src')
let readSrc = (f) => fs.readFileSync(path.join(srcDir, f), 'utf8')
let stripComments = (s) => s.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n')
let count = (s, re) => (s.match(re) || []).length

let base = { url: 'postgresql://username:password@127.0.0.1:5432', db: 'worm', cl: 'test', pk: 'id' }
let mk = (id, extra) => ({ id, name: 'n', ...extra })


describe('wellformed(unit): opt.url / opt.db / opt.cl at construction (cvOrmStrCases opt group)', function() {
    let optCases = cvOrmStrCases.cases.filter((v) => v.group === 'opt')

    it('should have 48 opt cases (3 names x 16 lone forms)', function() {
        assert.strictEqual(optCases.length, 48)
    })

    for (let c of optCases) {
        it(c.id, function() {
            let args = c.args(mk, base)
            assert.throws(() => WOrm(...args), (e) => e instanceof Error && e.message === c.expect.msg)
        })
    }

    for (let name of ['url', 'db', 'cl']) {
        it(`should throw 'invalid opt.${name}: string contains NUL' for a NUL (the name would be cut by the C string of the protocol)`, function() {
            assert.throws(() => WOrm({ ...base, [name]: `${base[name]}\u0000x` }), (e) => e instanceof Error && e.message === `invalid opt.${name}: string contains NUL`)
        })
        it(`should construct with a well-formed opt.${name} (emoji, CJK extension B, U+FFFD, combining marks)`, function() {
            for (let s of ['a\u{1F600}b', '\u{20BB7}野家', 'a�b', 'é']) {
                let v = name === 'url' ? `${base.url}?x=${s}` : s
                assert.doesNotThrow(() => WOrm({ ...base, [name]: v }), s)
            }
        })
        it(`should ignore a non-string opt.${name} (default is used, no throw)`, function() {
            for (let v of [undefined, null, 5, {}, ['a\ud800'], '']) {
                assert.doesNotThrow(() => WOrm({ ...base, [name]: v }), String(typeof v))
            }
        })
        it(`should throw 'not a string' for a String wrapper object as opt.${name} (it is not a plain string, and must not slip past the check with a lone surrogate inside)`, function() {
            assert.throws(() => WOrm({ ...base, [name]: Object('a\ud800') }), (e) => e instanceof Error && e.message === `invalid opt.${name}: not a string`)
        })
    }

    it('should not echo the offending name in the message and should throw before any property of opt.pk is used', function() {
        let secret = 'sec\ud800ret'
        let e = null
        try {
            WOrm({ ...base, cl: secret, pk: 'bad pk' })
        }
        catch (err) {
            e = err
        }
        assert.strictEqual(e.message, 'invalid opt.cl: string contains lone surrogate') //url, db, cl 先於 pk 檢核
        assert.ok(!e.message.includes('sec'))
    })

    it('should check url first, then db, then cl', function() {
        let bad = 'x\ud800'
        assert.throws(() => WOrm({ url: bad, db: bad, cl: bad }), /^Error: invalid opt\.url: /)
        assert.throws(() => WOrm({ db: bad, cl: bad }), /^Error: invalid opt\.db: /)
        assert.throws(() => WOrm({ cl: bad }), /^Error: invalid opt\.cl: /)
    })

    it('should keep rejecting a lone surrogate in opt.pk by the identifier grammar (no echo)', function() {
        assert.throws(() => WOrm({ ...base, pk: 'a\ud800' }), (e) => /^invalid opt\.pk: must be a plain identifier/.test(e.message) && !e.message.includes('\ud800'))
    })
})


describe('wellformed(unit): single owner (wsemi chkOrmStr / chkOrmData); no private copy of the check in src', function() {
    let files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.mjs'))

    it('should not contain isCleanStr, isWellFormed, toWellFormed, a surrogate range or a private lone-surrogate regex in any src file', function() {
        assert.ok(files.length >= 5)
        for (let f of files) {
            let s = stripComments(readSrc(f))
            assert.ok(!/isCleanStr|isWellFormed|toWellFormed|reLone/.test(s), `${f}: private well-formed check`)
            assert.ok(!/\\u[dD][89a-fA-F][0-9a-fA-F]{2}|0x[dD][89a-fA-F][0-9a-fA-F]{2}/.test(s), `${f}: surrogate range`)
        }
    })

    it('should import chkOrmStr in WOrmPostgresql.mjs and cvWrite.mjs, and chkOrmData only in WOrmPostgresql.mjs', function() {
        let w = stripComments(readSrc('WOrmPostgresql.mjs'))
        let cw = stripComments(readSrc('cvWrite.mjs'))
        assert.strictEqual(count(w, /^import chkOrmStr from 'wsemi\/src\/chkOrmStr\.mjs'/gm), 1)
        assert.strictEqual(count(w, /^import chkOrmData from 'wsemi\/src\/chkOrmData\.mjs'/gm), 1)
        assert.strictEqual(count(cw, /^import chkOrmStr from 'wsemi\/src\/chkOrmStr\.mjs'/gm), 1)
        for (let f of files) {
            if (f !== 'WOrmPostgresql.mjs') {
                assert.ok(!/chkOrmData/.test(stripComments(readSrc(f))), f)
            }
        }
    })

    it('should call chkOrmData at exactly one site (the per-record check shared by insert, insertBulk and save) with the batch index in root', function() {
        let w = stripComments(readSrc('WOrmPostgresql.mjs'))
        assert.strictEqual(count(w, /chkOrmData\(/g), 1)
        assert.ok(/chkOrmData\(c, \{ root: `data\[\$\{k\}\]` \}\)/.test(w))
    })

    it('should call chkOrmStr at the pk site, the opt names site, the lone-key filter of the column-name check, the NUL key pre-check, and in cvWrite for table names and data keys only', function() {
        let w = stripComments(readSrc('WOrmPostgresql.mjs'))
        let cw = stripComments(readSrc('cvWrite.mjs'))
        assert.strictEqual(count(w, /chkOrmStr\(/g), 4)
        assert.strictEqual(count(cw, /chkOrmStr\(/g), 2)
    })
})


describe('wellformed(unit): public API against an unreachable address (every check runs before any connection; no docker needed)', function() {
    let H = 'x\ud800'
    let L = 'y\udc00'
    let mkDead = () => WOrm({ url: 'postgresql://username:password@127.0.0.1:1', db: 'worm', cl: 'cl', pk: 'id' })
    let settle = (p) => p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e }))
    //watch, 計 pg.Client 的 connect 次數(死埠: 任何連線嘗試都會被記到)
    let watch = async (fn) => {
        let n = 0
        let orig = pg.Client.prototype.connect
        pg.Client.prototype.connect = function(...a) {
            n++
            return orig.apply(this, a)
        }
        try {
            await fn()
        }
        finally {
            pg.Client.prototype.connect = orig
        }
        return n
    }
    let idMsg = (i, why = 'string contains lone surrogate') => `invalid id: ${why} at [data[${i}].id]`
    let dataMsg = (i, p) => `invalid data: string contains lone surrogate at [data[${i}].${p}]`

    it('should reject insert and insertBulk with the smallest failing index, one error event, and never connect', async function() {
        let wo = mkDead()
        let evs = []
        wo.on('error', (mode, data, m) => evs.push([mode, m]))
        let n = await watch(async() => {
            for (let api of ['insert', 'insertBulk']) {
                let r1 = await settle(wo[api]([{ id: 'a' }, { id: H }, { id: L }]))
                assert.strictEqual(r1.e.message, idMsg(1), api)
                let r2 = await settle(wo[api]([{ id: 'a' }, { id: 'b', name: 'ok' }, { id: 'c', name: { d: [1, H] } }]))
                assert.strictEqual(r2.e.message, dataMsg(2, 'name.d[1]'), api)
                let r3 = await settle(wo[api]({ id: 'a\u0000' }))
                assert.strictEqual(r3.e.message, idMsg(0, 'string contains NUL'), api)
                let r4 = await settle(wo[api]([{ id: 'a', name: L, [H]: 1 }]))
                assert.strictEqual(r4.e.message, dataMsg(0, '<invalid key>'), api) //鍵名先於值
            }
        })
        assert.strictEqual(n, 0)
        assert.strictEqual(evs.length, 8)
        assert.deepStrictEqual(evs.slice(0, 4).map((v) => v[0]), ['insert', 'insert', 'insert', 'insert'])
    })

    it('should return per-record failures of save and del with the batch index of each record, one error event per failure, and never connect', async function() {
        let wo = mkDead()
        let evs = []
        wo.on('error', (mode, data, m) => evs.push([mode, m]))
        let s
        let d
        let n = await watch(async() => {
            s = await wo.save([{ id: H }, { id: 'ok-but-bad-data', name: L }, { id: 'a\u0000b' }])
            d = await wo.del([{ id: L }, { id: H }, { id: 'a\u0000' }])
        })
        assert.strictEqual(n, 0)
        assert.deepStrictEqual(s.map((v) => [v.n, v.nInserted, v.nModified, v.ok, v.err]), [[1, 0, 0, 0, idMsg(0)], [1, 0, 0, 0, dataMsg(1, 'name')], [1, 0, 0, 0, idMsg(2, 'string contains NUL')]])
        assert.deepStrictEqual(d.map((v) => [v.n, v.nDeleted, v.ok, v.err]), [[0, 0, 0, idMsg(0)], [0, 0, 0, idMsg(1)], [0, 0, 0, idMsg(2, 'string contains NUL')]])
        assert.deepStrictEqual(evs, [['save', s[0].err], ['save', s[1].err], ['save', s[2].err], ['del', d[0].err], ['del', d[1].err], ['del', d[2].err]])
    })

    it('should treat a missing pk as a whole-batch error of save/insert (smallest index wins over per-record failures), and a missing pk in del as that record only', async function() {
        let wo = mkDead()
        let n = await watch(async() => {
            let r = await settle(wo.save([{ id: H }, { name: 'nopk' }, { id: 'a\ud800' }]))
            assert.strictEqual(r.e.message, 'invalid id: primary key is missing at [data[1].id]')
            let r2 = await settle(wo.save([{ 'id': 'a', 'x y': 1 }, { name: 'nopk' }], { autoInsert: false }))
            assert.ok(/^invalid data\[0\]: /.test(r2.e.message), r2.e.message)
            let d = await wo.del([{ name: 'nopk' }, { id: H }])
            assert.deepStrictEqual(d.map((v) => v.err), ['invalid id: primary key is missing at [data[0].id]', idMsg(1)])
        })
        assert.strictEqual(n, 0)
    })

    it('should hand the listeners of save an independent snapshot of the record, so a listener cannot change a later record', async function() {
        let wo = mkDead()
        let shared = { s: 'good' }
        let input = [{ id: H, meta: shared }, { id: L, meta: shared }]
        let payloads = []
        let seen = []
        wo.on('error', (mode, data) => {
            payloads.push(data[0])
            seen.push(data[0].meta.s) //收到當下之值
            data[0].meta.s = 'changed-by-listener'
        })
        let s = await wo.save(input)
        assert.deepStrictEqual(s.map((v) => v.ok), [0, 0])
        assert.strictEqual(payloads.length, 2)
        assert.deepStrictEqual(seen, ['good', 'good']) //第 1 筆事件回呼的改動不影響第 2 筆之事件數據
        assert.notStrictEqual(payloads[0], input[0])
        assert.deepStrictEqual(shared, { s: 'good' }) //呼叫端原物件未被改動
    })

    it('should refuse a NUL data key before any connection: insert/insertBulk as a whole batch, save per record; a NUL key whose value is undefined is not written and not refused', async function() {
        let wo = mkDead()
        let evs = []
        wo.on('error', (mode, data, m) => evs.push([mode, m]))
        let msg = (i) => `invalid data key: contains NUL at [data[${i}].<invalid key>]`
        let n = await watch(async() => {
            for (let api of ['insert', 'insertBulk']) {
                let r = await settle(wo[api]([{ id: 'a' }, { 'id': 'b', 'k\u0000x': 1 }]))
                assert.strictEqual(r.e.message, msg(1), api)
                assert.ok(!r.e.message.includes('kx') && !r.e.message.includes(String.fromCharCode(0)), api) //不回顯鍵名
            }
            let s = await wo.save([{ 'id': 'a', 'k\u0000x': 1 }, { id: H }])
            assert.deepStrictEqual(s.map((v) => [v.ok, v.err]), [[0, msg(0)], [0, idMsg(1)]])
        })
        assert.strictEqual(n, 0)
        assert.strictEqual(evs.length, 4)
        //值為 undefined 之 NUL 鍵不寫入亦不拒收: 其餘無待處理之筆時只剩連線(死埠)失敗, 非檢核錯誤
        let r2 = await settle(wo.insert([{ 'id': 'a', 'k\u0000x': undefined }]))
        assert.ok(!r2.ok && !/^invalid (id|data)/.test(r2.e.message), r2.e.message)
    })

    it('should validate the createTable arguments before connecting (table name, pk name, sample keys, sample object)', async function() {
        let wo = mkDead()
        let evs = []
        wo.on('error', (mode, data, m) => evs.push([mode, m]))
        let n = await watch(async() => {
            for (let s of ['t\ud800', 't\udc00', 't\u0000']) {
                let r = await settle(wo.createTable(`"${s}"`, 'id', { id: 'x' }))
                assert.strictEqual(r.e.message, 'invalid createTable: invalid table name')
            }
            let r2 = await settle(wo.createTable('t', 'bad pk', { id: 'x' }))
            assert.strictEqual(r2.e.message, 'invalid createTable: invalid pk name')
            let r3 = await settle(wo.createTable('t', 'id', { 'bad key': 'x' }))
            assert.ok(/^invalid createTable: unsupported column name/.test(r3.e.message))
            let r4 = await settle(wo.createTable('t', 'id', 5))
            assert.ok(/is not an effective object/.test(r4.e.message))
        })
        assert.strictEqual(n, 0)
        assert.strictEqual(evs.length, 6)
        //引數合格者才連線(死埠 -> 連線錯誤, 非檢核錯誤)
        let m = await watch(async() => {
            let r = await settle(wo.createTable('t', 'id', { id: 'x' }))
            assert.ok(!r.ok && !/^invalid createTable/.test(String(r.e && r.e.message)))
        })
        assert.strictEqual(m, 1)
    })

    it('should keep a Date pk of del as a snapshot taken at check time (a listener that changes the shared Date does not change the key of a later record)', async function() {
        let wo = mkDead()
        let n = await watch(async() => {
            let d = new Date(1000)
            wo.on('error', (mode, data) => {
                if (data[0].ref instanceof Date) {
                    data[0].ref.setTime(2000)
                }
            })
            let r = await settle(wo.del([{ id: Symbol('x'), ref: d }, { id: d }]))
            //第 2 筆 id 為 Date: 在 id 欄為文字的表是型別錯, 但此處只驗: 第 1 筆為逐筆失敗, 第 2 筆需連線(死埠 -> 整批 reject), 原 Date 未被改動
            assert.ok(!r.ok)
            assert.strictEqual(d.getTime(), 1000)
        })
        assert.strictEqual(n, 1) //僅第 2 筆有待處理, 故連線一次(失敗)
    })
})


describe('wellformed(unit): the write-side name checks that stay in cvWrite (NUL and lone surrogate in table names and data keys)', function() {
    it('should reject table names and written data keys containing NUL or a lone surrogate, and accept well-formed ones', function() {
        assert.throws(() => cvTable('t\ud800'), /^Error: invalid table name$/)
        assert.throws(() => cvTable('t\u0000'), /^Error: invalid table name$/)
        //完整雙引號名稱(不經未引號識別字文法)以 chkOrmStr 為唯一把關者: 孤立代理(高/低/反序)與 NUL 皆拒收, 含 schema 限定之各段亦然
        for (let s of ['t\ud800', 't\udc00', 't\udc00\ud800', 't\u0000', 'a\ud800b']) {
            assert.throws(() => cvTable(`"${s}"`), /^Error: invalid table name$/, JSON.stringify(s))
            assert.throws(() => cvTable(`"ok"."${s}"`), /^Error: invalid table name$/, JSON.stringify(s))
            assert.throws(() => cvTable(`"${s}"."ok"`), /^Error: invalid table name$/, JSON.stringify(s))
        }
        assert.strictEqual(cvTable('"ok"."t\u{1F600}�"'), '"ok"."t\u{1F600}�"')
        assert.strictEqual(cvTable('"t\u{1F600}"'), '"t\u{1F600}"')
        assert.throws(() => genInsert('t', [{ 'id': 'a', 'k\ud800': 1 }]), /^Error: invalid data key/)
        assert.throws(() => genInsert('t', [{ 'id': 'a', 'k\u0000': 1 }]), /^Error: invalid data key/)
        assert.throws(() => genConflict('id', { 'id': 'a', 'k\udc00': 1 }), /^Error: invalid data key/)
        assert.strictEqual(genInsert('t', [{ 'id': 'a', 'k\u{1F600}': 1 }]).query, 'insert into "t" ("id", "k\u{1F600}") values ($1, $2)')
    })
})
