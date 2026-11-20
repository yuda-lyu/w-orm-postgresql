//主鍵「給了而非有效值」之處置(規則帳本 R19 之 S31、S35、S36; 第557項規則一之本套件形態)
//假驅動(test/tools/fakePg.mjs), 不連線、不需docker: Fake.calls為空陣列即未建立client、未連線、未送任何語句(資料庫不變)
//規格句:
//  S31 主鍵「未帶」(undefined、null、空字串、鍵不存在)與「給了而無效」(包裝物件、物件、陣列、Symbol、BigInt、NaN、無效Date、函數、Map、Buffer等)一律拒絕,
//      不補值、不換值(本套件無autoGenPk, 不隨任何設定改變): insert/insertBulk/save整批reject且error事件恰一次, del該筆ok:0, selectByPk回null; 皆不連線
//      型別化主鍵(有限或±Infinity之number、boolean、真Date)為有效值並原樣為綁定參數(PostgreSQL欄位為型別化, 與字串id型ORM之偏離, 見R19已知偏離)
//  S35 資料內之id為讀取即拋錯之值(已撤銷之Proxy等): 於複製階段(cloneDeep)轉固定詞彙invalid data: must be a readable value(不轉出拋出者之原文字, A3),
//      走與頂層不可讀相同之原失敗通道(整批reject、error事件恰一次、data為null、不連線)
//  S36 selectByPk: 可讀而無效之主鍵回null(不連線、不發事件); 不可讀者reject(見unit-readable-probe)
import assert from 'assert'
import { mk, collectOp, revoked, tagThrow, ownKeysThrow, UNREADABLE, expectRejectIn } from './tools/readableInputs.mjs'


let WRITE = ['insert', 'insertBulk', 'save']
let ALL = ['insert', 'insertBulk', 'save', 'del']
let MSG = (reason, k = 0) => `invalid id: ${reason} at [data[${k}].id]`

//bound, 送給驅動之各語句之綁定參數陣列(僅含有綁定參數者)
let bound = (Fake) => Fake.raw.filter((q) => q && q.values && q.values.length > 0).map((q) => q.values)
let same = (a, b) => (b instanceof Date ? a instanceof Date && a.getTime() === b.getTime() : Object.is(a, b))

//carried, 給定之主鍵值原樣交給驅動: 綁定參數與之逐字相同(number、Date); 布林在主鍵條件(select、delete之WHERE)為IS TRUE/IS FALSE字面值(R6之bool節點), 於INSERT仍為綁定參數
let carried = (Fake, val) => {
    if (typeof val === 'boolean' && Fake.raw.some((q) => /\bIS (TRUE|FALSE)\b/.test(q.text))) {
        return Fake.raw.some((q) => q.text.includes(val ? 'IS TRUE' : 'IS FALSE'))
    }
    return bound(Fake).some((vs) => same(vs[0], val))
}


describe('primary key not given (undefined, null, empty string, key absent) is rejected and never filled in (S31)', function() {

    //既有詞彙(R17): undefined與鍵不存在=primary key is missing, 空字串=string is empty, null=unsupported primary key value
    let cases = [
        ['key absent', () => ({ name: 'n' }), 'primary key is missing'],
        ['undefined', () => ({ id: undefined, name: 'n' }), 'primary key is missing'],
        ['null', () => ({ id: null, name: 'n' }), 'unsupported primary key value'],
        ['empty string', () => ({ id: '', name: 'n' }), 'string is empty'],
    ]

    for (let entry of WRITE) {
        for (let [label, mkRec, reason] of cases) {
            it(`${entry}: ${label} rejects the whole batch (single and array), one error event, no client, nothing written`, async function() {
                //單筆
                let a = mk()
                let r1 = await collectOp(a.w, (w) => w[entry](mkRec()))
                assert.ok(r1.has && r1.rej instanceof Error)
                assert.strictEqual(r1.rej.message, MSG(reason, 0))
                assert.strictEqual(r1.evs.length, 1)
                assert.strictEqual(r1.evs[0].m, entry)
                assert.strictEqual(r1.evs[0].e, MSG(reason, 0))
                assert.deepStrictEqual(a.Fake.calls, [])

                //陣列(第2筆不合格: 整批reject, 第1筆有效者亦不寫入, 索引為最小不合格者)
                let b = mk()
                let r2 = await collectOp(b.w, (w) => w[entry]([{ id: 'ok', name: 'a' }, mkRec()]))
                assert.ok(r2.has && r2.rej instanceof Error)
                assert.strictEqual(r2.rej.message, MSG(reason, 1))
                assert.strictEqual(r2.evs.length, 1)
                assert.deepStrictEqual(b.Fake.calls, [])
            })
        }
    }

    for (let [label, mkRec, reason] of cases) {
        it(`del: ${label} is a per-record failure (ok:0, err), no query for that record, other records proceed`, async function() {
            let a = mk()
            let r1 = await collectOp(a.w, (w) => w.del(mkRec()))
            assert.ok(!r1.has)
            assert.deepStrictEqual(r1.ok, [{ n: 0, nDeleted: 0, ok: 0, err: MSG(reason, 0) }])
            assert.strictEqual(r1.evs.length, 1)
            assert.deepStrictEqual(a.Fake.calls, [])

            let b = mk()
            let r2 = await collectOp(b.w, (w) => w.del([{ id: 'ok' }, mkRec()]))
            assert.ok(!r2.has)
            assert.strictEqual(r2.ok.length, 2)
            assert.strictEqual(r2.ok[0].ok, 1) //有效筆照常
            assert.deepStrictEqual(r2.ok[1], { n: 0, nDeleted: 0, ok: 0, err: MSG(reason, 1) })
            assert.strictEqual(r2.evs.length, 1)
            assert.strictEqual(bound(b.Fake).length, 1) //只為有效筆送出一次DELETE
            assert.deepStrictEqual(bound(b.Fake)[0], ['ok'])
        })
    }

    it('no autoGenPk in this package: an unknown autoGenPk option changes nothing (a primary key is never generated)', async function() {
        for (let flag of [true, false]) {
            let a = mk({ autoGenPk: flag })
            let r = await collectOp(a.w, (w) => w.insert({ name: 'n' }))
            assert.ok(r.has)
            assert.strictEqual(r.rej.message, MSG('primary key is missing'))
            assert.deepStrictEqual(a.Fake.calls, [])
        }
    })

})


describe('primary key given but not a valid value is rejected, never replaced by another value (S31)', function() {

    //經cloneDeep後仍保持其種類者(裝飾過之Date經cloneDeep會變成一般Date, 另於selectByPk測)
    let bad = [
        ['String wrapper object', () => Object('a')],
        ['Number wrapper object', () => Object(5)],
        ['plain object', () => ({})],
        ['array', () => ['a']],
        ['Symbol', () => Symbol('s')],
        ['BigInt', () => 5n],
        ['NaN', () => NaN],
        ['invalid Date', () => new Date(NaN)],
        ['function', () => () => 1],
        ['Map', () => new Map()],
        ['Buffer', () => Buffer.from('a')],
    ]

    for (let entry of WRITE) {
        for (let [label, v] of bad) {
            it(`${entry}: ${label} rejects the whole batch with the fixed wording, one error event, no client`, async function() {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry]({ id: v(), name: 'n' }))
                assert.ok(r.has && r.rej instanceof Error)
                assert.strictEqual(r.rej.message, MSG('unsupported primary key value'))
                assert.strictEqual(r.evs.length, 1)
                assert.strictEqual(r.evs[0].e, MSG('unsupported primary key value'))
                assert.deepStrictEqual(a.Fake.calls, []) //不連線: 不寫入, 亦不換成他值寫入

                let b = mk()
                let r2 = await collectOp(b.w, (w) => w[entry]([{ id: 'ok', name: 'a' }, { id: v(), name: 'b' }]))
                assert.ok(r2.has)
                assert.strictEqual(r2.rej.message, MSG('unsupported primary key value', 1))
                assert.deepStrictEqual(b.Fake.calls, [])
            })
        }
    }

    for (let [label, v] of bad) {
        it(`del: ${label} is a per-record failure (ok:0, err) and sends no query`, async function() {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.del({ id: v() }))
            assert.ok(!r.has)
            assert.deepStrictEqual(r.ok, [{ n: 0, nDeleted: 0, ok: 0, err: MSG('unsupported primary key value') }])
            assert.strictEqual(r.evs.length, 1)
            assert.deepStrictEqual(a.Fake.calls, [])

            //批次索引1(A6): 第1筆有效者照常, 第2筆為該筆之失敗(err之索引為1), 只為有效筆送出一次DELETE
            let b = mk()
            let r2 = await collectOp(b.w, (w) => w.del([{ id: 'ok' }, { id: v() }]))
            assert.ok(!r2.has)
            assert.strictEqual(r2.ok[0].ok, 1)
            assert.deepStrictEqual(r2.ok[1], { n: 0, nDeleted: 0, ok: 0, err: MSG('unsupported primary key value', 1) })
            assert.strictEqual(r2.evs.length, 1)
            assert.strictEqual(bound(b.Fake).length, 1)
        })
    }

})


describe('typed primary keys (number, boolean, real Date) are valid and reach the driver exactly as given (S31)', function() {

    //PostgreSQL之主鍵欄位為型別化(INTEGER、FLOAT8、BOOLEAN、TIMESTAMPTZ), 呼叫端給的number、boolean、Date即該型別之值: 有效, 且不被轉成字串或他值
    let ok = [
        ['integer 5', () => 5],
        ['zero', () => 0],
        ['negative float', () => -1.5],
        ['Infinity (a FLOAT8 key can hold it)', () => Infinity],
        ['true', () => true],
        ['false', () => false],
        ['real Date', () => new Date(1700000000000)],
    ]

    for (let entry of ALL) {
        for (let [label, v] of ok) {
            it(`${entry}: ${label} is accepted and bound unchanged, no error event`, async function() {
                let a = mk()
                let val = v()
                let r = await collectOp(a.w, (w) => w[entry](entry === 'del' ? { id: val } : { id: val, name: 'n' }))
                assert.ok(!r.has, r.has ? String(r.rej && r.rej.message) : '')
                assert.strictEqual(r.evs.length, 0)
                assert.ok(a.Fake.calls.includes('connect'))
                assert.ok(carried(a.Fake, val), `${label}: 須原樣交給驅動(綁定參數逐字相同、型別不變; 布林於WHERE為IS TRUE/IS FALSE字面值)`)
            })
        }
    }

    for (let [label, v] of ok) {
        it(`selectByPk: ${label} is accepted and bound unchanged`, async function() {
            let a = mk()
            let val = v()
            let r = await collectOp(a.w, (w) => w.selectByPk(val))
            assert.ok(!r.has)
            assert.strictEqual(r.ok, null) //假驅動無此列
            assert.strictEqual(r.evs.length, 0)
            assert.ok(carried(a.Fake, val))
        })
    }

})


describe('selectByPk with a primary key that is readable but not valid returns null (S36)', function() {

    let decorated = () => Object.assign(new Date(1700000000000), { x: 1 })
    let cases = [
        ['undefined', () => undefined],
        ['null', () => null],
        ['empty string', () => ''],
        ['String wrapper object', () => Object('a')],
        ['plain object', () => ({})],
        ['array', () => []],
        ['Symbol', () => Symbol('s')],
        ['BigInt', () => 5n],
        ['NaN', () => NaN],
        ['invalid Date', () => new Date(NaN)],
        ['Date that carries an own property', decorated],
        ['string with a lone surrogate', () => 'a\ud800'],
        ['string with NUL', () => 'a\u0000b'],
    ]
    for (let [label, v] of cases) {
        it(`${label}: null, no event, no client`, async function() {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.selectByPk(v()))
            assert.ok(!r.has)
            assert.strictEqual(r.ok, null)
            assert.strictEqual(r.evs.length, 0)
            assert.deepStrictEqual(a.Fake.calls, [])
        })
    }

})


describe('an id inside the data that cannot be read is rejected at the copy step with the fixed wording (S35, A3)', function() {

    //複製階段(cloneDeep)之巢狀不可讀值: 轉固定詞彙invalid data: must be a readable value(不轉出拋出者之原文字), 走原失敗通道, 不補值; error事件之data為null(不把不可讀之值交給訂閱函數)
    let hostile = [
        ['revoked Proxy', revoked],
        ['Symbol.toStringTag throws', tagThrow],
        ['ownKeys trap throws', ownKeysThrow],
    ]
    for (let entry of ALL) {
        for (let [label, v] of hostile) {
            it(`${entry}: id is ${label}: whole batch rejects with the fixed wording, one error event with data null, no client`, async function() {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry]({ id: v(), name: 'n' }))
                expectRejectIn(r, entry, UNREADABLE('data'), a.Fake) //data為null: 失敗時不把可能為已撤銷之Proxy交給報告器(其inspect會使mocha崩潰)
            })
        }
    }

})
