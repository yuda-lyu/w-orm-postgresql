//第557項全族對齊輪(A1~A6; 規則帳本 R19 之 S38~S42): 逐代號釘住本套件之口徑, 含對照組(行為不變者)
//假驅動(test/tools/fakePg.mjs), 不連線、不需docker: Fake.calls為空陣列即未建立client、未連線、未送任何語句(資料庫不變)
//規格句(依C:/opensrcOper/dnow/20261120043625/align-rules.md; 本套件為型別化主鍵後端, A6依共同規則一第6點):
//  A1 選項容器本身不可讀(opt/option為已撤銷之Proxy、get陷阱拋錯等, 讀其成員即拋錯): 固定詞彙invalid option: must be a readable value(建構為invalid opt: ...),
//     讀取在既有try之內, 走原通道(非同步入口: error事件恰一次、data為null後reject; 建構: 同步throw)
//  A2 存取器拋錯(容器可讀而其成員為拋錯之getter: 建構opt.<鍵>、option.<鍵>、本庫自讀之陣列[0]、createTable樣本之成員與obj[0]):
//     於讀取處捕捉, 轉固定詞彙invalid <名稱>: must be a readable value, 原通道; 不轉出存取器拋出之文字
//  A3 複製階段之巢狀不可讀值(資料內之id、列之成員、陣列其後之元素、各欄位值為已撤銷之Proxy或拋錯之存取器; cloneDeep拋錯):
//     固定詞彙invalid data: must be a readable value, 與頂層不可讀同一通道(error事件恰一次、data為null後reject、資料庫不變); 複製處不分辨頂層與巢狀、不分辨拋出原因;
//     只到複製處為止, 複製之後讀取複本所拋者(原型上之存取器等)不擴大
//  A4 入口階段(選項與資料之讀取、判定與複製)拒絕之error事件之data為null; 其後之整批拒絕(invalid id等)與逐筆失敗之data不變
//  A5 selectByPk之不可讀pk: reject invalid pk: must be a readable value(error事件恰一次、data為null); 可讀而非有效者照既有回null(無事件)
//  A6 主鍵給了而無效: 型別化後端, number(非NaN)、boolean、真Date原樣交驅動; 其餘一律拒絕(訊息unsupported primary key value)、不補值、不拆包裝物件
//例外(維持): opt.logDetail/opt.funLog由wsemi getDiag處置; find之不可讀由wsemi cvOrmFind之固定詞彙處置
import assert from 'assert'
import cloneDeep from 'lodash-es/cloneDeep.js'
import { fakeOf, buildRaw } from './tools/fakePg.mjs'
import { mk, collectOp, revoked, tagThrow, ownKeysThrow, getTrapThrow, getTrapThrowOn, withGetterThrow, arrLenThrow, idxGetterThrow, nullProtoDate, deepNest, UNREADABLE, expectRejectIn } from './tools/readableInputs.mjs'


let ENTRIES = ['insert', 'insertBulk', 'save', 'del']
let REC = () => ({ id: 'a', name: 'n' })
let MSG = (reason, k = 0) => `invalid id: ${reason} at [data[${k}].id]`
let BASE = { url: 'postgresql://u:p@127.0.0.1:1' }

//accessorRow, 自有存取器id拋錯之列
let accRow = (prop = 'id') => withGetterThrow({}, prop)


describe('A1 option container itself cannot be read', function() {

    let bad = [['revoked Proxy', revoked], ['get trap throws for every key', getTrapThrow]]

    for (let [label, f] of bad) {
        it(`constructor: opt is ${label}: throws invalid opt synchronously`, function() {
            assert.throws(() => buildRaw(fakeOf(), f()), (e) => e instanceof Error && e.message === UNREADABLE('opt'))
        })
        for (let entry of ['insert', 'save']) {
            it(`${entry}: option is ${label}: reject invalid option, one error event with data null, no client`, async function() {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry](REC(), f()))
                expectRejectIn(r, entry, UNREADABLE('option'), a.Fake)
            })
        }
    }

    it('control: opt or option that is readable (ownKeys trap throws, Symbol.toStringTag throws, number 5) is never enumerated or tagged: constructs and runs as before', async function() {
        for (let f of [ownKeysThrow, tagThrow, () => 5]) {
            assert.doesNotThrow(() => buildRaw(fakeOf(), f()))
            for (let entry of ['insert', 'save']) {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry](REC(), f()))
                assert.ok(!r.has, entry)
                assert.strictEqual(r.evs.length, 0)
                assert.ok(a.Fake.calls.includes('connect'))
            }
        }
    })

})


describe('A2 accessor that throws (the container is readable, a member throws)', function() {

    for (let name of ['url', 'db', 'cl', 'pk', 'useCache']) {
        it(`constructor: opt.${name} is an own accessor that throws: invalid opt.${name}, not the thrown text`, function() {
            let o = { ...BASE }
            delete o[name]
            Object.defineProperty(o, name, {
                get() {
                    throw new Error('SECRET-opt')
                },
                enumerable: true,
            })
            assert.throws(() => buildRaw(fakeOf(), o), (e) => e instanceof Error && e.message === UNREADABLE(`opt.${name}`))
        })
        it(`constructor: opt is a Proxy whose get trap throws only for ${name}: invalid opt.${name}, not invalid opt (the container is readable)`, function() {
            let p = getTrapThrowOn({ ...BASE }, name)
            assert.throws(() => buildRaw(fakeOf(), p), (e) => e instanceof Error && e.message === UNREADABLE(`opt.${name}`))
        })
    }

    it('exception (wsemi getDiag owns them): opt.logDetail and opt.funLog that throw do not make the constructor throw', function() {
        for (let name of ['logDetail', 'funLog']) {
            assert.doesNotThrow(() => buildRaw(fakeOf(), withGetterThrow({ ...BASE }, name)), name)
            assert.doesNotThrow(() => buildRaw(fakeOf(), getTrapThrowOn({ ...BASE }, name)), name)
        }
    })

    for (let [entry, key] of [['insert', 'returnList'], ['save', 'autoInsert']]) {
        it(`${entry}: option.${key} is an own accessor that throws: invalid option.${key}, one error event with data null, no client`, async function() {
            let a = mk()
            let r = await collectOp(a.w, (w) => w[entry](REC(), withGetterThrow({}, key)))
            expectRejectIn(r, entry, UNREADABLE(`option.${key}`), a.Fake)
        })
        it(`${entry}: option is a Proxy whose get trap throws only for ${key}: invalid option.${key}, not invalid option`, async function() {
            let a = mk()
            let r = await collectOp(a.w, (w) => w[entry](REC(), getTrapThrowOn({}, key)))
            expectRejectIn(r, entry, UNREADABLE(`option.${key}`), a.Fake)
        })
    }

    it('the single-element array [0] getter and the array length that throw (self-read by this package) are invalid data on every write entry', async function() {
        for (let entry of ENTRIES) {
            for (let f of [idxGetterThrow, arrLenThrow]) {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry](f()))
                expectRejectIn(r, entry, UNREADABLE('data'), a.Fake)
            }
        }
    })

    it('createTable: a sample member that is an accessor that throws, a [0] accessor of a longer array, or a get trap that throws for a member is invalid sample, data null', async function() {
        let samples = [
            () => withGetterThrow({ id: 'x' }, 'a'),
            () => accRow('id'),
            () => [accRow('id'), { id: 'y' }],
            () => {
                let arr = [1, 2]
                Object.defineProperty(arr, '0', {
                    get() {
                        throw new Error('SECRET-idx0')
                    },
                    enumerable: true,
                })
                return arr
            },
            () => getTrapThrowOn({ id: 'x', a: 1 }, 'a'),
        ]
        for (let f of samples) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.createTable('tnew', 'id', f()))
            expectRejectIn(r, 'createTable', UNREADABLE('sample'), a.Fake)
        }
    })

})


describe('A2 order: a Proxy whose key or descriptor read throws is invalid order, never the thrown text', function() {

    //ownKeys多回一個symbol鍵, 該鍵之getOwnPropertyDescriptor拋錯(chkReadable之ownKeys探針只讀字串鍵描述子, 不涵蓋此形)
    let symDescThrow = () => {
        let s = Symbol('s')
        return new Proxy({ a: 'asc' }, {
            ownKeys(t) {
                return [...Reflect.ownKeys(t), s]
            },
            getOwnPropertyDescriptor(t, k) {
                if (k === s) {
                    throw new Error('SECRET-gopd-sym')
                }
                return Reflect.getOwnPropertyDescriptor(t, k)
            },
        })
    }
    //只於第1次讀取自有鍵時拋錯
    let onceKeysThrow = () => {
        let n = 0
        return new Proxy({ a: 'asc' }, {
            ownKeys(t) {
                n++
                if (n === 1) {
                    throw new Error('SECRET-ownKeys-once')
                }
                return Reflect.ownKeys(t)
            },
        })
    }

    //只於第1次讀取原型時拋錯(判斷與探針之讀取已不再拋, 錯誤由cvOrder之判斷階段拋出而非readOwn)
    let onceProtoThrow = () => {
        let n = 0
        return new Proxy({ a: 'asc' }, {
            getPrototypeOf(t) {
                n++
                if (n === 1) {
                    throw new Error('SECRET-proto-once')
                }
                return Reflect.getPrototypeOf(t)
            },
        })
    }

    for (let [label, f] of [['a symbol key whose descriptor read throws', symDescThrow], ['an ownKeys trap that throws on the first read only', onceKeysThrow], ['a getPrototypeOf trap that throws on the first read only', onceProtoThrow]]) {
        it(`select: order is ${label}: invalid order, one error event with data null, no client`, async function() {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.select({}, f()))
            expectRejectIn(r, 'select', UNREADABLE('order'), a.Fake)
        })
    }

})


describe('A2 createTable: a readable sample that is not an effective object keeps the existing message, whatever its string conversion does', function() {

    it('Symbol, null-prototype object, class instance whose toString throws: obj[...] is not an effective object (not invalid sample), the event carries the given value', async function() {
        class Bad {
            toString() {
                throw new Error('SECRET-toString')
            }
        }
        let sym = Symbol('s')
        //文字: String(值)可轉者為其轉換結果, 拋錯者為內部標籤; 陣列內之元素是否被取為樣本由wsemi isearr決定, 故陣列形只斷言訊息樣式
        for (let [v, expectText] of [[sym, 'Symbol(s)'], [Object.create(null), '[object Object]'], [new Bad(), '[object Object]'], [[sym], null], [[Object.create(null)], null]]) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.createTable('tnew', 'id', v))
            assert.ok(r.has && r.rej instanceof Error)
            if (expectText === null) {
                assert.ok(/^obj\[.*\] is not an effective object$/.test(r.rej.message), r.rej.message)
            }
            else {
                assert.strictEqual(r.rej.message, `obj[${expectText}] is not an effective object`)
            }
            assert.strictEqual(r.evs.length, 1)
            assert.ok(r.evs[0].d === v, '可讀而型別不符者之event data照既有(呼叫端輸入)')
            assert.deepStrictEqual(a.Fake.calls, [])
        }
    })

})


describe('A3 nested value that cannot be read, met while the data is copied', function() {

    //[名稱, 工廠]: 每次呼叫皆新建; 皆為資料內之巢狀值(頂層容器可讀)
    let shapes = [
        ['id is a revoked Proxy (single object)', () => ({ id: revoked(), name: 'n' })],
        ['id is a revoked Proxy (inside an array)', () => [{ id: revoked(), name: 'n' }]],
        ['id has a Symbol.toStringTag that throws', () => ({ id: tagThrow(), name: 'n' })],
        ['id is an own accessor that throws', () => accRow('id')],
        ['a field value is an own accessor that throws', () => ({ id: 'a', n: accRow('x') })],
        ['a field value is a revoked Proxy', () => ({ id: 'a', n: revoked() })],
        ['a u8a field is a revoked Proxy', () => ({ id: 'a', u8a: revoked() })],
        ['a row member is an own accessor that throws', () => withGetterThrow({ id: 'a' }, 'x')],
        ['a later array element is a revoked Proxy', () => [{ id: 'a', n: 1 }, revoked()]],
        ['a later array element is a row with a throwing accessor', () => [{ id: 'a', n: 1 }, accRow('x')]],
        ['a later array element has a Symbol.toStringTag that throws', () => [{ id: 'a', n: 1 }, tagThrow()]],
        ['a later array element is a Proxy whose ownKeys trap throws', () => [{ id: 'a', n: 1 }, ownKeysThrow()]],
        ['the first of two array elements is a revoked Proxy', () => [revoked(), { id: 'a' }]],
        ['a field value is a Proxy whose get trap throws', () => ({ id: 'a', n: getTrapThrow() })],
        ['a Date whose prototype is null (readable, cannot be copied)', () => ({ id: 'a', d: nullProtoDate() })],
        ['nesting 50000 levels deep (readable, cannot be copied)', () => ({ id: 'a', d: deepNest(50000) })],
    ]

    for (let entry of ENTRIES) {
        for (let [label, f] of shapes) {
            it(`${entry}: ${label}: invalid data, one error event with data null, no client, not the thrown text`, async function() {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry](f()))
                expectRejectIn(r, entry, UNREADABLE('data'), a.Fake)
            })
        }
    }

    it('after the rejection a valid call on the same instance proceeds (no state is left behind)', async function() {
        for (let entry of ENTRIES) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w[entry]({ id: revoked(), name: 'n' }))
            assert.ok(r.has, entry)
            let r2 = await collectOp(a.w, (w) => w[entry](REC()))
            assert.ok(!r2.has, entry)
            assert.ok(a.Fake.calls.includes('connect'))
        }
    })

    it('the second copy (the check copy made after the first copy succeeded) is a copy step too: a prototype accessor that throws only from the (R+1)-th read of one clone is invalid data on insert, insertBulk and save', async function() {
        //lateCtor: 原型上之constructor存取器, 第n次讀取才拋錯(cloneDeep於每份複本讀取constructor, 複本與原物件共用同一原型, 故計數跨複本累計)
        let lateCtor = (n) => {
            let c = 0
            let proto = {
                get constructor() {
                    c++
                    if (c >= n) {
                        throw new Error('ctor boom')
                    }
                    return Object
                },
            }
            return { obj: Object.create(proto, { id: { value: 'a', enumerable: true }, name: { value: 'n', enumerable: true } }), reads: () => c }
        }
        //R: 一份cloneDeep所讀constructor之次數
        let t = lateCtor(Infinity)
        cloneDeep(t.obj)
        let R = t.reads()
        assert.ok(R >= 1, `R=${R}`)
        for (let entry of ['insert', 'insertBulk', 'save']) {
            for (let n of [R + 1, R + 2]) {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry](lateCtor(n).obj))
                expectRejectIn(r, entry, UNREADABLE('data'), a.Fake)
            }
        }
        //第1份複本即拋錯者(n <= R)同為固定詞彙
        for (let entry of ENTRIES) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w[entry](lateCtor(1).obj))
            expectRejectIn(r, entry, UNREADABLE('data'), a.Fake)
        }
    })

    it('scope ends at the copy: a value that is read only after the copy (an accessor on the prototype) is the existing id check, not invalid data', async function() {
        for (let entry of ENTRIES) {
            let a = mk()
            let proto = {
                get id() {
                    throw new Error('SECRET-inherit')
                },
            }
            let d = Object.create(proto, { name: { value: 'n', enumerable: true } })
            let r = await collectOp(a.w, (w) => w[entry](d))
            let msg = entry === 'del' ? r.ok[0].err : r.rej.message
            assert.strictEqual(msg, MSG('primary key is missing'), entry) //原型上之id不被讀(只讀自有可列舉屬性), 視為缺主鍵
            assert.strictEqual(r.evs.length, 1)
        }
    })

})


describe('A4 data argument of the error event', function() {

    it('every entry-stage rejection of A1~A3 and the unreadable top level carries null (not the unreadable value)', async function() {
        for (let entry of ENTRIES) {
            for (let f of [revoked, tagThrow, ownKeysThrow, () => ({ id: revoked() }), () => accRow('id')]) {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry](f()))
                assert.ok(r.has && r.evs.length === 1 && r.evs[0].d === null, `${entry}: ${r.has ? r.rej.message : 'no reject'}`)
            }
        }
    })

    it('after the entry stage the data argument is unchanged: the whole-batch rejection of an invalid id carries the (copied) data, not null', async function() {
        for (let entry of ['insert', 'insertBulk', 'save']) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w[entry]({ name: 'n' }))
            assert.ok(r.has)
            assert.strictEqual(r.rej.message, MSG('primary key is missing'))
            assert.strictEqual(r.evs.length, 1)
            assert.ok(Array.isArray(r.evs[0].d) && r.evs[0].d.length === 1 && r.evs[0].d[0].name === 'n', `${entry}: data引數照既有(複本)`)
        }
        //del之逐筆失敗: 結果之ok:0, error事件照既有
        let b = mk()
        let r2 = await collectOp(b.w, (w) => w.del({ name: 'n' }))
        assert.ok(!r2.has)
        assert.deepStrictEqual(r2.ok, [{ n: 0, nDeleted: 0, ok: 0, err: MSG('primary key is missing') }])
        assert.strictEqual(r2.evs.length, 1)
        assert.ok(r2.evs[0].d !== null)
    })

    it('createTable: a readable sample that is not an effective object keeps the given value in the event (not an unreadable value)', async function() {
        let a = mk()
        let r = await collectOp(a.w, (w) => w.createTable('tnew', 'id', 5))
        assert.ok(r.has)
        assert.strictEqual(r.evs.length, 1)
        assert.strictEqual(r.evs[0].d, 5)
    })

})


describe('A5 selectByPk with a pk that cannot be read', function() {

    for (let [label, f] of [['revoked Proxy', revoked], ['Symbol.toStringTag throws', tagThrow], ['get trap throws for every key', getTrapThrow], ['revoked array Proxy', () => {
        let r = Proxy.revocable([], {})
        r.revoke()
        return r.proxy
    }]]) {
        it(`pk is ${label}: reject invalid pk, one error event with data null, no client`, async function() {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.selectByPk(f()))
            expectRejectIn(r, 'selectByPk', UNREADABLE('pk'), a.Fake)
        })
    }

    it('control: a pk that is readable but not valid keeps the existing null with no event (ownKeys trap throws, wrappers, null, {}, Symbol, undefined)', async function() {
        for (let f of [ownKeysThrow, () => Object('a'), () => null, () => ({}), () => Symbol('s'), () => undefined, () => getTrapThrowOn({}, 'valueOf')]) {
            let a = mk()
            let r = await collectOp(a.w, (w) => w.selectByPk(f()))
            assert.ok(!r.has)
            assert.strictEqual(r.ok, null)
            assert.strictEqual(r.evs.length, 0)
            assert.deepStrictEqual(a.Fake.calls, [])
        }
    })

})


describe('A6 primary key given but not valid (typed backend: number, boolean and a real Date are valid and go to the driver as given)', function() {

    //給了而無效: 一律拒絕, 訊息unsupported primary key value, 不補值、不拆包裝物件; 批次索引1亦同(索引為最小不合格者)
    let invalid = [
        ['String wrapper', () => Object('a')],
        ['Number wrapper', () => Object(5)],
        ['Boolean wrapper', () => Object(true)],
        ['plain object', () => ({})],
        ['array', () => ['a']],
        ['Symbol', () => Symbol('s')],
        ['BigInt', () => 5n],
        ['NaN', () => NaN],
        ['invalid Date', () => new Date(NaN)],
        ['Date with an own property', () => Object.assign(new Date(1700000000000), { x: 1 })],
        ['function', () => () => 1],
        ['Map', () => new Map()],
        ['Buffer', () => Buffer.from('a')],
    ]

    for (let entry of ['insert', 'insertBulk', 'save']) {
        for (let [label, v] of invalid) {
            it(`${entry}: ${label} at batch index 1 rejects the whole batch (index 1 in the message), nothing is written, no client`, async function() {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry]([{ id: 'first', name: 'm' }, { id: v(), name: 'n' }]))
                assert.ok(r.has && r.rej instanceof Error)
                assert.strictEqual(r.rej.message, MSG('unsupported primary key value', 1))
                assert.strictEqual(r.evs.length, 1)
                assert.deepStrictEqual(a.Fake.calls, [])
            })
        }
    }

    it('not given at batch index 1 (undefined, null, empty string, key absent) is rejected with its own existing reason, never filled in', async function() {
        for (let entry of ['insert', 'insertBulk', 'save']) {
            for (let [rec, reason] of [[{ name: 'n' }, 'primary key is missing'], [{ id: undefined, name: 'n' }, 'primary key is missing'], [{ id: null, name: 'n' }, 'unsupported primary key value'], [{ id: '', name: 'n' }, 'string is empty']]) {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry]([{ id: 'first', name: 'm' }, rec]))
                assert.ok(r.has)
                assert.strictEqual(r.rej.message, MSG(reason, 1))
                assert.deepStrictEqual(a.Fake.calls, [])
            }
        }
    })

    it('typed keys stay valid on every entry: number (0, negative float), boolean, real Date reach the driver and raise no event', async function() {
        for (let entry of ENTRIES) {
            for (let v of [0, -1.5, true, false, new Date(1700000000000)]) {
                let a = mk()
                let r = await collectOp(a.w, (w) => w[entry](entry === 'del' ? { id: v } : { id: v, name: 'n' }))
                assert.ok(!r.has, `${entry}: ${String(v)}`)
                assert.strictEqual(r.evs.length, 0)
                assert.ok(a.Fake.calls.includes('connect'))
            }
        }
    })

})
