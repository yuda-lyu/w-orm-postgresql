//讀取即拋錯之輸入依原失敗通道拒絕(規則帳本 R19 之 S32–S37; 第557項規則二、四; wsemi chkReadable)
//假驅動(test/tools/fakePg.mjs), 不連線、不需docker: Fake.calls為空陣列即未建立client、未連線、未送任何語句(資料庫不變)
//規格句:
//  S32 呼叫端給的資料容器(insert、insertBulk、save、del之data, createTable之樣本)、選項(建構opt與其成員、option與其returnList)、selectByPk之pk、order、
//      createTable之cl與pk引數: 判斷函數回false後以chkReadable分辨「不可讀」與「型別不符」; 不可讀者走原失敗通道
//      (寫入入口: error事件恰一次後reject、不連線、不寫入; 建構: 同步throw), 訊息為固定詞彙 invalid <名稱>: must be a readable value(不含原例外文字)
//  S33 可讀而型別不符者照既有處理(輸入無效之通道或用預設), 行為不變
//  S34 入口階段拒絕之error事件, data引數為null(不把不可讀之值交給訂閱函數)
//  S35 容器可讀而成員為拋錯之存取器(chkReadable不呼叫存取器)與複製階段之巢狀不可讀值(對齊A2、A3, 見unit-readable-align):
//      一律轉固定詞彙(invalid opt.<名>|option.<鍵>|sample|data: must be a readable value), 不轉出拋出者之原文字, 仍走原通道
//  S36 selectByPk之不可讀pk: reject(error事件恰一次); 可讀而無效者回null(見unit-pk-given)
//  S37 探針置於判斷函數回false之後: 有效輸入不多讀
import assert from 'assert'
import fs from 'fs'
import { fakeOf, build, buildRaw } from './tools/fakePg.mjs'
import { mk, collectOp, revoked, tagThrow, lateTag, tagCounter, ownKeysThrow, getTrapThrow, getTrapThrowOn, withGetterThrow, withGetterValue, unreadableData, codeLines, UNREADABLE, expectRejectIn } from './tools/readableInputs.mjs'


let REC = () => ({ id: 'a', name: 'n' })
let EMPTY = {
    insert: { n: 0, nInserted: 0, ok: 1 },
    insertBulk: { n: 0, nInserted: 0, ok: 1 },
    save: [],
    del: [],
}

describe('constructor: opt and its members that cannot be read throw synchronously (S32, S33, S35)', function() {

    it('opt itself cannot be read (revoked Proxy): throws the fixed wording, not the engine message', function() {
        assert.throws(() => buildRaw(fakeOf(), revoked()), (e) => e instanceof Error && e.message === UNREADABLE('opt'))
        //get陷阱全拋錯之Proxy(內部標籤亦讀不到)
        assert.throws(() => buildRaw(fakeOf(), getTrapThrow()), (e) => e instanceof Error && e.message === UNREADABLE('opt'))
    })

    for (let name of ['url', 'db', 'cl', 'pk', 'useCache']) {
        for (let [label, v] of [['revoked Proxy', revoked], ['Symbol.toStringTag throws', tagThrow]]) {
            it(`opt.${name} is a ${label}: throws invalid opt.${name} (not ignored in favour of the default)`, function() {
                let Fake = fakeOf()
                assert.throws(() => build(Fake, { [name]: v() }), (e) => e instanceof Error && e.message === UNREADABLE(`opt.${name}`))
                assert.deepStrictEqual(Fake.calls, [])
            })
        }
    }

    it('a member that is a throwing accessor (container readable): the fixed wording invalid opt.<name>, not the thrown text (A2)', function() {
        let p = getTrapThrowOn({ url: 'postgresql://u:p@h:1' }, 'cl')
        assert.throws(() => buildRaw(fakeOf(), p), (e) => e instanceof Error && e.message === UNREADABLE('opt.cl'))
        assert.throws(() => buildRaw(fakeOf(), withGetterThrow({ url: 'postgresql://u:p@h:1' }, 'db')), (e) => e instanceof Error && e.message === UNREADABLE('opt.db'))
    })

    //capture, 記錄建構驅動之設定(connectionString)
    let capture = (ex) => {
        let Base = fakeOf()
        let cfgs = []
        class Cap extends Base {
            constructor(cfg) {
                super(cfg)
                cfgs.push(cfg)
            }
        }
        let w = build(Cap, ex)
        return { w, cfgs, Base }
    }
    let mismatch = [['number 5', () => 5], ['String wrapper', () => Object('x')], ['plain object', () => ({})], ['null', () => null], ['array', () => []], ['empty string', () => '']]

    for (let [label, v] of mismatch) {
        it(`readable but not a valid value (${label}): url, db, cl, pk, useCache fall back to the defaults as before`, async function() {
            //url、db
            let a = capture({ url: v(), db: v() })
            await a.w.select()
            assert.strictEqual(a.cfgs[0].connectionString, 'postgresql://user:password@127.0.0.1:5432/worm')
            //cl
            let b = capture({ cl: v() })
            await b.w.select()
            assert.ok(/"test"/.test(b.Base.raw[0].text), b.Base.raw[0].text)
            //pk(預設time)
            let c = capture({ pk: v() })
            let r = await c.w.del({ time: 'a' })
            assert.deepStrictEqual(r, [{ n: 0, nDeleted: 0, ok: 1 }])
            assert.ok(/"time"/.test(c.Base.raw[0].text), c.Base.raw[0].text)
            //useCache(預設false: 連續兩次select各自建立client)
            let d = capture({ useCache: v() })
            await d.w.select()
            await d.w.select()
            assert.strictEqual(d.Base.calls.filter((x) => x === 'new').length, 2)
        })
    }

})


describe('write entries: a data container that cannot be read is rejected through the existing channel (S32, S33, S34)', function() {

    for (let entry of ['insert', 'insertBulk', 'save', 'del']) {
        for (let [label, f] of unreadableData) {
            it(`${entry}: data is ${label}: reject with the fixed wording, one error event with data null, no client`, async function() {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry](f()))
                expectRejectIn(r, entry, UNREADABLE('data'), a.Fake)
            })
        }

        for (let [label, v] of [['number 5', 5], ['null', null], ['undefined', undefined], ['string', 'abc'], ['boolean', true], ['empty array', []], ['empty object', {}]]) {
            it(`${entry}: data is readable but not data (${label}): the existing empty result, no event, no client`, async function() {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry](v))
                assert.ok(!r.has)
                assert.deepStrictEqual(r.ok, EMPTY[entry])
                assert.strictEqual(r.evs.length, 0)
                assert.deepStrictEqual(a.Fake.calls, [])
            })
        }
    }

    it('a tag that throws only on the n-th read: every n up to the total number of reads R of one full check (judgment functions and the probe itself) is rejected exactly once with data null; n > R is the existing readable-invalid result', async function() {
        for (let entry of ['insert', 'insertBulk', 'save', 'del']) {
            //R: 可讀而無效(空物件, 標籤回Object)之一次完整檢核所讀標籤之總次數
            let t = tagCounter()
            let a0 = mk()
            let r0 = await collectOp(a0.w, (w) => w[entry](t.obj))
            assert.deepStrictEqual(r0.ok, EMPTY[entry])
            let R = t.reads()
            assert.ok(R >= 3, `${entry}: 探針之讀取次數R=${R}`)
            for (let n = 1; n <= R; n++) {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry](lateTag(n)))
                assert.ok(r.has && r.rej instanceof Error, `${entry} n=${n}/${R}: 應reject`)
                assert.strictEqual(r.evs.length, 1, `${entry} n=${n}/${R}: error事件恰一次(探針自身拋錯亦視為不可讀)`)
                assert.ok(r.evs[0].d === null, `${entry} n=${n}`)
                assert.deepStrictEqual(a.Fake.calls, [])
            }
            let b = mk()
            let r = await collectOp(b.w, (w) => w[entry](lateTag(R + 1)))
            assert.deepStrictEqual(r.ok, EMPTY[entry], `${entry} n=${R + 1}`)
            assert.strictEqual(r.evs.length, 0)
        }
        //order: 不論第幾次讀取才拋, 皆為固定詞彙(不外洩原例外文字); 讀取皆成功者為既有之symbol key訊息
        let t = tagCounter()
        let a0 = mk()
        let r0 = await collectOp(a0.w, (w) => w.select({}, t.obj))
        assert.ok(/^invalid order: symbol key is not allowed/.test(r0.rej.message), r0.rej.message)
        let R = t.reads()
        assert.ok(R >= 3, `order: R=${R}`)
        for (let n = 1; n <= R; n++) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.select({}, lateTag(n)))
            assert.ok(r.has, `order n=${n}/${R}`)
            assert.strictEqual(r.rej.message, UNREADABLE('order'), `order n=${n}/${R}: ${r.rej.message}`)
            assert.strictEqual(r.evs.length, 1)
        }
    })

    it('insert with returnList: true still rejects an unreadable data (not the empty list)', async function() {
        let a = mk()
        let r = await collectOp(a.w, (w) => w.insert(revoked(), { returnList: true }))
        expectRejectIn(r, 'insert', UNREADABLE('data'), a.Fake)
        let b = mk()
        let r2 = await collectOp(b.w, (w) => w.insert(5, { returnList: true }))
        assert.deepStrictEqual(r2.ok, [])
    })

    it('a single-element array whose element cannot be read is a copy-step failure: the fixed wording invalid data, same channel (A3)', async function() {
        for (let entry of ['insert', 'insertBulk', 'save', 'del']) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w[entry]([revoked()]))
            expectRejectIn(r, entry, UNREADABLE('data'), a.Fake)
        }
    })

    it('a valid data object still reaches the driver (control)', async function() {
        for (let entry of ['insert', 'insertBulk', 'save', 'del']) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w[entry](REC()))
            assert.ok(!r.has)
            assert.ok(a.Fake.calls.includes('connect'))
        }
    })

})


describe('option of insert and save (S32, S33, S34, S35, S37)', function() {

    let optBad = [
        ['revoked Proxy', revoked],
        ['a Proxy whose get trap throws', getTrapThrow],
    ]

    for (let entry of ['insert', 'save']) {
        for (let [label, f] of optBad) {
            it(`${entry}: option is ${label}: reject with invalid option, one error event with data null, no client`, async function() {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry](REC(), f()))
                expectRejectIn(r, entry, UNREADABLE('option'), a.Fake)
            })
        }
    }

    it('insert: option.returnList cannot be read (revoked Proxy, Symbol.toStringTag throws): invalid option.returnList, not treated as false', async function() {
        for (let f of [revoked, tagThrow]) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.insert(REC(), { returnList: f() }))
            expectRejectIn(r, 'insert', UNREADABLE('option.returnList'), a.Fake)
        }
    })

    it('a member that is a throwing accessor is the fixed wording invalid option.<key> on the same channel, not the thrown text (insert returnList, save autoInsert; A2)', async function() {
        let a = mk()
        let r = await collectOp(a.w, (w) => w.insert(REC(), withGetterThrow({}, 'returnList')))
        expectRejectIn(r, 'insert', UNREADABLE('option.returnList'), a.Fake)
        let b = mk()
        let r2 = await collectOp(b.w, (w) => w.save(REC(), withGetterThrow({}, 'autoInsert')))
        expectRejectIn(r2, 'save', UNREADABLE('option.autoInsert'), b.Fake)
    })

    it('insert: option.returnList readable but not boolean is treated as not given (false), as before', async function() {
        for (let v of [5, 'true', {}, null, [], 0]) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.insert(REC(), { returnList: v }))
            assert.ok(!r.has)
            assert.deepStrictEqual(r.ok, { n: 1, nInserted: 0, ok: 1 })
            assert.strictEqual(r.evs.length, 0)
        }
        let b = mk()
        let r2 = await collectOp(b.w, (w) => w.insert(REC(), { returnList: true }))
        assert.deepStrictEqual(r2.ok, [{ n: 1, nInserted: 0, ok: 1 }])
    })

    it('option readable but not an object (5, null, string) is treated as {} as before', async function() {
        for (let v of [5, null, 'x']) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.insert(REC(), v))
            assert.ok(!r.has)
            assert.strictEqual(r.evs.length, 0)
            let b = mk()
            let r2 = await collectOp(b.w, (w) => w.save(REC(), v))
            assert.ok(!r2.has)
            assert.strictEqual(r2.evs.length, 0)
        }
    })

    it('order of reads is unchanged: insert reads option first (rejects), save reads it after the data check (invalid data returns [] first)', async function() {
        let a = mk()
        let r = await collectOp(a.w, (w) => w.insert(5, revoked()))
        expectRejectIn(r, 'insert', UNREADABLE('option'), a.Fake)
        let b = mk()
        let r2 = await collectOp(b.w, (w) => w.save(5, revoked()))
        assert.deepStrictEqual(r2.ok, [])
        assert.strictEqual(r2.evs.length, 0)
    })

    it('save: the value of option.autoInsert is not passed through a judgment function, so it is not probed (only its truthiness is used)', async function() {
        let a = mk()
        let r = await collectOp(a.w, (w) => w.save(REC(), { autoInsert: revoked() }))
        assert.ok(!r.has)
        assert.strictEqual(r.evs.length, 0)
    })

    it('valid options are not probed (S37: the probe sits after the judgment that returned false)', async function() {
        let reads = 0
        let spy = (target) => new Proxy(target, {
            get(t, k, r) {
                if (k === Symbol.toStringTag) {
                    reads++
                }
                return Reflect.get(t, k, r)
            },
        })
        let a = mk()
        await a.w.insert(REC(), spy({ returnList: true }))
        await a.w.insert(REC(), spy({ returnList: false }))
        await a.w.insert(REC(), spy({}))
        await a.w.save(REC(), spy({ autoInsert: false }))
        await a.w.save(REC(), spy({ autoInsert: true }))
        assert.strictEqual(reads, 0, '有效之option不得被讀內部標籤(探針只在判斷函數回false之後)')
    })

})


describe('selectByPk: a pk that cannot be read rejects like the write entries (S36)', function() {

    for (let [label, f] of [['revoked Proxy', revoked], ['Symbol.toStringTag throws', tagThrow]]) {
        it(`pk is ${label}: reject with invalid pk, one error event with data null, no client`, async function() {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.selectByPk(f()))
            expectRejectIn(r, 'selectByPk', UNREADABLE('pk'), a.Fake)
        })
    }

    it('boundary: a Proxy whose ownKeys trap throws is readable for a pk (a pk is never enumerated): still the plain invalid-pk result null', async function() {
        let a = mk()
        let r = await collectOp(a.w, (w) => w.selectByPk(ownKeysThrow()))
        assert.ok(!r.has)
        assert.strictEqual(r.ok, null)
        assert.strictEqual(r.evs.length, 0)
        assert.deepStrictEqual(a.Fake.calls, [])
    })

    it('valid pks are not probed (a Date, a string and a number go straight to the driver)', async function() {
        let a = mk()
        for (let v of ['a', 5, true, new Date(1700000000000)]) {
            let r = await collectOp(a.w, (w) => w.selectByPk(v))
            assert.ok(!r.has)
            assert.strictEqual(r.ok, null)
        }
        assert.strictEqual(a.Fake.calls.filter((x) => x === 'connect').length, 4)
    })

})


describe('createTable: sample, cl and pk arguments that cannot be read (S32, S33, S34)', function() {

    let sampleBad = [...unreadableData, ['array whose element is a revoked Proxy', () => [revoked()]]]
    for (let [label, f] of sampleBad) {
        it(`sample is ${label}: reject with invalid sample, one error event with data null, no client`, async function() {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.createTable('tnew', 'id', f()))
            expectRejectIn(r, 'createTable', UNREADABLE('sample'), a.Fake)
        })
    }

    for (let [label, f] of [['revoked Proxy', revoked], ['Symbol.toStringTag throws', tagThrow]]) {
        it(`cl argument is ${label}: invalid cl (not the generic invalid table name)`, async function() {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.createTable(f(), 'id', { id: 'x' }))
            expectRejectIn(r, 'createTable', UNREADABLE('cl'), a.Fake)
        })
        it(`pk argument is ${label}: invalid pk (not silently replaced by the configured primary key)`, async function() {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.createTable('tnew', f(), { id: 'x' }))
            expectRejectIn(r, 'createTable', UNREADABLE('pk'), a.Fake)
        })
    }

    it('readable but not a valid sample (5, null, string, true, empty array, empty object): the existing message, the event still carries the given value', async function() {
        for (let v of [5, null, 'abc', true, [], {}]) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.createTable('tnew', 'id', v))
            assert.ok(r.has && r.rej instanceof Error)
            assert.ok(/^obj\[.*\] is not an effective object$/.test(r.rej.message), r.rej.message)
            assert.strictEqual(r.evs.length, 1)
            assert.strictEqual(r.evs[0].d, v, '可讀而型別不符者之event data照既有(呼叫端輸入)')
            assert.deepStrictEqual(a.Fake.calls, [])
        }
    })

    it('readable but not a string cl: the existing invalid table name; pk (5, String wrapper, undefined, null, {}) is treated as not given', async function() {
        let a = mk()
        let r = await collectOp(a.w, (w) => w.createTable(5, 'id', { id: 'x' }))
        assert.ok(r.has)
        assert.strictEqual(r.rej.message, 'invalid createTable: invalid table name')
        for (let v of [5, Object('zzz'), undefined, null, {}]) {
            let b = mk()
            let r2 = await collectOp(b.w, (w) => w.createTable('tnew', v, { id: 'x' }))
            assert.ok(!r2.has, r2.has ? r2.rej.message : '')
            assert.ok(b.Fake.calls.some((c) => /PRIMARY KEY/.test(c) && /"id" TEXT PRIMARY KEY/.test(c)), '採建構時設定之主鍵欄位id')
        }
    })

    it('a sample whose member is a throwing accessor or whose [0] getter throws is the fixed wording invalid sample, one error event with data null (A2, A3)', async function() {
        let samples = [
            ['own accessor member', () => withGetterThrow({ id: 'x' }, 'a')],
            ['own accessor id', () => withGetterThrow({}, 'id')],
            ['array whose [0] is an accessor that throws (length 2)', () => {
                let arr = [1, 2]
                Object.defineProperty(arr, '0', {
                    get() {
                        throw new Error('idx boom')
                    },
                    enumerable: true,
                })
                return arr
            }],
            ['Proxy whose get trap throws only for the member', () => getTrapThrowOn({ id: 'x', a: 1 }, 'a')],
        ]
        for (let [label, f] of samples) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.createTable('tnew', 'id', f()))
            expectRejectIn(r, 'createTable', UNREADABLE('sample'), a.Fake)
            assert.ok(r.rej.message.indexOf('boom') < 0, label)
        }
    })

    it('boundary: a sample member that cannot be read is only used for its JSONB type guess (its content is never read)', async function() {
        let a = mk()
        let r = await collectOp(a.w, (w) => w.createTable('tnew', 'id', { id: 'x', a: revoked() }))
        assert.ok(!r.has)
        assert.ok(a.Fake.calls.some((c) => /"a" JSONB/.test(c)))
    })

})


describe('select and delAll: find and order that cannot be read (S32, S34)', function() {

    for (let [label, f] of [['revoked Proxy', revoked], ['Symbol.toStringTag throws', tagThrow], ['ownKeys trap throws', ownKeysThrow]]) {
        it(`select: order is ${label}: invalid order with the fixed wording (no engine or user exception text), one error event with data null`, async function() {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.select({}, f()))
            expectRejectIn(r, 'select', UNREADABLE('order'), a.Fake)
        })

        for (let entry of ['select', 'delAll']) {
            it(`${entry}: find is ${label}: rejects as invalid find (owned by wsemi cvOrmFind, fixed wording without the exception text), one error event with data null`, async function() {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry](f()))
                assert.ok(r.has && r.rej instanceof Error)
                assert.ok(/^invalid find: /.test(r.rej.message), r.rej.message)
                assert.ok(!/boom|revoked/.test(r.rej.message), r.rej.message)
                assert.strictEqual(r.evs.length, 1)
                assert.strictEqual(r.evs[0].m, entry)
                assert.ok(r.evs[0].d === null, 'data must be null')
                assert.deepStrictEqual(a.Fake.calls, [])
            })
        }
    }

    it('order that is readable but invalid keeps the existing message (type mismatch, direction, accessor)', async function() {
        let a = mk()
        let r = await collectOp(a.w, (w) => w.select({}, 5))
        assert.strictEqual(r.rej.message, 'invalid order: order must be a plain object at [order]')
        let b = mk()
        let r2 = await collectOp(b.w, (w) => w.select({}, { a: 'sideways' }))
        assert.ok(/^invalid order: direction must be asc or desc/.test(r2.rej.message), r2.rej.message)
        let c = mk()
        let r3 = await collectOp(c.w, (w) => w.select({}, withGetterValue('a', 'asc')))
        assert.ok(/^invalid order: accessor property/.test(r3.rej.message), r3.rej.message)
    })

    it('valid order and find still run (control)', async function() {
        let a = mk()
        let r = await collectOp(a.w, (w) => w.select({ name: 'n' }, { name: 'asc' }))
        assert.ok(!r.has)
        assert.deepStrictEqual(r.ok, [])
        assert.ok(a.Fake.calls.includes('connect'))
    })

})


describe('site inventory of the probes (R19: no local probe, every site is wsemi chkReadable)', function() {

    let srcOf = (f) => codeLines(fs.readFileSync(`./src/${f}`, 'utf8'))
    let count = (lines, re) => lines.filter((l) => re.test(l)).length

    it('chkReadable is imported from wsemi once per file and called at the known sites only', function() {
        let main = srcOf('WOrmPostgresql.mjs')
        let cv = srcOf('cvFind.mjs')
        let reImport = /^import chkReadable from 'wsemi\/src\/chkReadable\.mjs'$/gm
        assert.strictEqual((fs.readFileSync('./src/WOrmPostgresql.mjs', 'utf8').match(reImport) || []).length, 1)
        assert.strictEqual((fs.readFileSync('./src/cvFind.mjs', 'utf8').match(reImport) || []).length, 1)
        //WOrmPostgresql: getOptVal 1、chkOptReadable 1、getOpt 1、getOptBol 1、isUnreadableData 2、selectByPk 1、createTable(cl、pk) 2
        assert.strictEqual(count(main, /\bchkReadable\(/), 9)
        //cvFind: isUnreadableOrder 2
        assert.strictEqual(count(cv, /\bchkReadable\(/), 2)
        //其餘檔不得自有探針
        for (let f of fs.readdirSync('./src')) {
            if (/^(WOrmPostgresql|cvFind)\.mjs$/.test(f) || !/\.mjs$/.test(f)) {
                continue
            }
            assert.strictEqual(count(srcOf(f), /\bchkReadable\(/), 0, f)
        }
    })

    it('no local probe implementation (the read of the internal tag and keys is owned by wsemi)', function() {
        for (let f of fs.readdirSync('./src')) {
            let t = srcOf(f).join('\n')
            assert.ok(!/probeReadable|assertReadable|isUnreadable(?!Data|Order)|\bnew Proxy\b/.test(t), f)
        }
    })

    it('the own-keys probe of isUnreadableData is guarded by the [object Object] tag (typed arrays and Buffers are never enumerated)', function() {
        //字串字面值於codeLines中被抹除, 此處讀原始檔
        let raw = (f) => fs.readFileSync(`./src/${f}`, 'utf8')
        let n = (t, re) => (t.match(re) || []).length
        assert.strictEqual(n(raw('WOrmPostgresql.mjs'), /toString\.call\(data\) === '\[object Object\]' && chkReadable\(data, \{ ownKeys: true \}\)/g), 1)
        assert.strictEqual(n(raw('WOrmPostgresql.mjs'), /chkReadable\([^)]*ownKeys: true/g), 1)
        assert.strictEqual(n(raw('cvFind.mjs'), /tag\(order\) === '\[object Object\]' && chkReadable\(order, \{ ownKeys: true \}\)/g), 1)
        assert.strictEqual(n(raw('cvFind.mjs'), /chkReadable\([^)]*ownKeys: true/g), 1)
    })

    it('the entry sites call the shared helpers: rejectIn (unreadable data, copy step, option, pk) and no direct emitError with the unreadable value', function() {
        let main = srcOf('WOrmPostgresql.mjs')
        //rejectIn: insert(option、data、複製)3、insertBulk(data、複製)2、save(data、複製、option)3、del(data、複製)2、selectByPk 1
        assert.strictEqual(count(main, /\breturn rejectIn\(/), 11)
        assert.strictEqual(count(main, /\bisUnreadableData\(/), 5) //呼叫點: insert、insertBulk、save、del 4 + createTable 1
    })

    it('the copy step has one owner, cloneInput: cloneDeep of the caller data is called there only (A3); the four entries call cloneInput, none catches the copy error itself', function() {
        let main = srcOf('WOrmPostgresql.mjs')
        //cloneInput本體1處return cloneDeep(data); 其餘cloneDeep為內部複本(save逐筆檢核複本、checkData之檢核複本、快取之進出[_cache[key] = cloneDeep(data)為select結果之快取])
        assert.strictEqual(count(main, /\breturn cloneDeep\(data\)/), 1)
        assert.strictEqual(count(main, /\b_cache\[key\] = cloneDeep\(data\)/), 1)
        assert.strictEqual(count(main, /\bcloneDeep\(data\)/), 2)
        assert.strictEqual(count(main, /\bdata = cloneInput\(data\)/), 4)
        assert.strictEqual(count(main, /\bdata = cloneDeep\(/), 0)
        //檢核複本(第2份複本: checkData之rowErrOf、save逐筆檢核)亦經cloneInput, 無直接cloneDeep(v)
        assert.strictEqual(count(main, /\bcloneInput\(v\)/), 2)
        assert.strictEqual(count(main, /rowErrOf\(v, cloneDeep\(/), 0)
        assert.strictEqual(count(main, /\blet c = cloneDeep\(/), 0)
    })

})
