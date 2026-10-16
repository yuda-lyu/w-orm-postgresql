/* eslint-disable no-extend-native, no-sparse-arrays, no-control-regex, no-throw-literal -- 測試刻意以稀疏陣列、控制字元與暫時汙染原型(finally 還原)驗證檢核器 */
import assert from 'assert'
import mongoSql from 'mongo-sql'
import { cvFind, cvOrder, cvKey, cvColumn, isCleanStr } from '../src/cvFind.mjs'


//cvFind/cvOrder/cvKey 之純函數測試(不連線, 不需 docker).
//規格句見 CLAUDE_rulebook.md 開頭(S1–S8):
//  S2 不支援之運算子與無法轉譯之值必須 reject  S3 空清單與 undefined 不得成為恆真
//  S4 受支援語意不變(被接受者交 mongo-sql 之 query 與 values 與原 find 逐字相同)
//  S5 訊息格式 invalid find: <原因> at [<路徑>]  S7 order  S8 快取鍵


let sqlOf = (where, order) => {
    let q = { type: 'select', table: 'tprobe', where }
    if (order !== undefined) {
        q.order = order
    }
    let s = mongoSql.sql(q)
    let d = mongoSql.sql({ type: 'delete', table: 'tprobe', where })
    return JSON.stringify({ q: s.query, v: s.values, dq: d.query, dv: d.values }, (k, v) => typeof v === 'bigint' ? `bigint:${v}` : v)
}
let throwsFind = (f, re = /^invalid find: /) => assert.throws(() => cvFind(f), (e) => e instanceof Error && re.test(e.message))
class Foo {
    constructor() {
        this.name = 'aa'
    }
}


describe('cvFind: accepted finds produce the same mongo-sql output as the original (S4)', function() {
    let d = new Date('2020-01-01T00:00:00.000Z')
    let accepts = [
        ['undefined', undefined],
        ['empty object', {}],
        ['eq string', { name: 'aa' }],
        ['eq null', { tag: null }],
        ['eq boolean', { ok: true }],
        ['eq false', { ok: false }],
        ['eq number', { value: 1.5 }],
        ['eq bigint', { time: 3n }],
        ['eq Date', { ts: d }],
        ['eq Buffer', { bin: Buffer.from('ab') }],
        ['eq string with quote', { name: 'it\'s' }],
        ['string starting with $', { name: '$a' }],
        ['string ending with $', { name: 'a$' }],
        ['$equals', { name: { $equals: 'aa' } }],
        ['$equals null', { name: { $equals: null } }],
        ['$ne', { name: { $ne: 'aa' } }],
        ['$ne null', { name: { $ne: null } }],
        ['$ne true', { ok: { $ne: true } }],
        ['$gt $gte $lt $lte', { value: { $gt: 1, $gte: 2, $lt: 9, $lte: 8 } }],
        ['$in', { value: { $in: [1, 2, 3] } }],
        ['$in with null', { tag: { $in: ['x', null] } }],
        ['$in [null]', { tag: { $in: [null] } }],
        ['$in []', { value: { $in: [] } }],
        ['$in $..$ literal', { name: { $in: ['$name$', '$'] } }],
        ['$in Date', { ts: { $in: [d] } }],
        ['$nin', { value: { $nin: [1, 2] } }],
        ['$nin [null]', { tag: { $nin: [null] } }],
        ['$not scalar', { name: { $not: 'aa' } }],
        ['$not true', { ok: { $not: true } }],
        ['$not operator object', { value: { $not: { $gt: 5, $lt: 9 } } }],
        ['$not $not', { value: { $not: { $not: { $gt: 5 } } } }],
        ['$not $in', { name: { $not: { $in: ['aa', null] } } }],
        ['$like', { name: { $like: 'a%' } }],
        ['$ilike', { name: { $ilike: 'A_' } }],
        ['$null true', { tag: { $null: true } }],
        ['$null false', { tag: { $null: false } }],
        ['$notNull true', { tag: { $notNull: true } }],
        ['$notNull false', { tag: { $notNull: false } }],
        ['multi columns', { name: 'aa', value: { $gt: 1 }, tag: null }],
        ['$and', { $and: [{ value: { $gt: 2 } }, { value: { $lt: 6 } }] }],
        ['$or', { $or: [{ value: { $lte: 1 } }, { value: { $gte: 10 } }] }],
        ['$and one element', { $and: [{ name: 'aa' }] }],
        ['$or one element', { $or: [{ name: 'aa' }] }],
        ['$and with {} element', { $and: [{ name: 'aa' }, {}] }],
        ['$and with {} first', { $and: [{}, { name: 'aa' }, { value: 1 }] }],
        ['column + $or', { name: 'aa', $or: [{ value: 1 }, { value: 4 }] }],
        ['$or of multi-key docs', { $or: [{ name: 'aa', value: 1 }, { tag: 'y' }] }],
        ['nested $or $and', { $or: [{ $and: [{ value: { $ne: 4 } }, { value: { $in: [4, 5, 6] } }, { value: { $nin: [6, 7] } }] }, { $or: [{ value: { $lte: -1 } }, { value: { $gte: 10 } }] }] }],
        ['$or with $in null (parenthesized)', { $or: [{ tag: { $in: ['x', null] } }, { name: 'aa' }] }],
        ['JSON path ->>', { 'js->>k': '1' }],
        ['JSON path ->', { 'js->k': '1' }],
        ['JSON path #>>', { 'js#>>k': '1' }],
        ['JSON path #>', { 'js#>k': '1' }],
        ['JSON path multi', { 'js->a->>b': 'x' }],
        ['JSON path array index', { 'js->>0': 'x' }],
        ['JSON path with $nin', { 'js->>k': { $nin: ['a', 'b'] } }],
        ['cast', { 'value::text': '5' }],
        ['cast with operator', { 'ts::date': { $gte: '2020-01-01' } }],
        ['unicode column', { 中文: 1 }],
        ['underscore column', { _a_1: 1 }],
        ['unsafe integer number', { value: Number.MAX_SAFE_INTEGER + 2 }],
        ['negative zero', { value: -0 }],
        ['Object.create(null) find', Object.assign(Object.create(null), { name: 'aa' })],
    ]
    accepts.forEach(([label, f]) => {
        it(`should get the same SQL and values for ${label}`, function() {
            let nf = cvFind(f)
            assert.strictEqual(sqlOf(nf), sqlOf(f === undefined ? {} : f)) //S4
        })
    })

    it('should drop {} elements of $and exactly like mongo-sql does (still same output)', function() {
        let f = { $and: [{}, {}, { name: 'aa' }, {}] }
        assert.strictEqual(sqlOf(cvFind(f)), sqlOf({ name: 'aa' })) //S4
    })
})


describe('cvFind: unsupported or untranslatable finds throw (S2 S3 S5)', function() {
    let rejects = [
        ['undefined value', { a: undefined }],
        ['undefined in operator', { a: { $gt: undefined } }],
        ['undefined in $in', { a: { $in: [undefined] } }],
        ['undefined in $nin with others', { a: { $nin: [1, undefined] } }],
        ['undefined $and', { $and: undefined }],
        ['undefined in $and element', { $and: [{ a: undefined }] }],
        ['$nor', { $nor: [{ a: 1 }] }],
        ['$nor []', { $nor: [] }],
        ['$regex', { a: { $regex: 'x' } }],
        ['$regex RegExp', { a: { $regex: /x/ } }],
        ['$options', { a: { $options: 'i' } }],
        ['$eq', { a: { $eq: 1 } }],
        ['$exists', { a: { $exists: true } }],
        ['$exists subquery', { a: { $exists: { type: 'select', table: 't' } } }],
        ['$notExists', { a: { $notExists: { type: 'select', table: 't' } } }],
        ['$custom', { a: { $custom: ['true'] } }],
        ['$custom_array', { a: { $custom_array: ['true'] } }],
        ['$custom_object', { a: { $custom_object: { value: 'true', values: [] } } }],
        ['top $custom', { $custom: ['true'] }],
        ['$years_ago', { a: { $years_ago: 1 } }],
        ['$days_ago', { a: { $days_ago: 1 } }],
        ['$where', { $where: '1' }],
        ['$expr', { $expr: {} }],
        ['$jsonSchema {}', { $jsonSchema: {} }],
        ['$comment', { $comment: 'x' }],
        ['unknown $x', { a: { $x: 1 } }],
        ['lower-case gt', { a: { gt: 1 } }],
        ['top comparison', { $gt: 1 }],
        ['top $in', { $in: [1] }],
        ['top $not', { $not: { a: 1 } }],
        ['nested non-operator key', { a: { b: 1 } }],
        ['operator + non-operator key', { a: { $gt: 1, b: 2 } }],
        ['column-level $or', { a: { $or: [{ $gt: 1 }] } }],
        ['column-level $and', { a: { $and: [{ $gt: 1 }] } }],
        ['$or object', { $or: { a: 1 } }],
        ['$and object', { $and: { a: 1 } }],
        ['$and []', { $and: [] }],
        ['$or []', { $or: [] }],
        ['$or [{}]', { $or: [{}] }],
        ['$and [{}]', { $and: [{}] }],
        ['$and [{},{}]', { $and: [{}, {}] }],
        ['$or [{}, cond]', { $or: [{}, { a: 1 }] }],
        ['$or element null', { $or: [null, { a: 1 }] }],
        ['$or element scalar', { $or: [1] }],
        ['$or scalar', { $or: 5 }],
        ['$or null', { $or: null }],
        ['$and nested array element', { $and: [[{ a: 1 }]] }],
        ['$and sparse', { $and: [{ a: 1 }, , { b: 2 }] }],
        ['$and array with extra property', { $and: Object.assign([{ a: 1 }], { extra: { b: 2 } }) }],
        ['$in sparse', { a: { $in: [1, , 3] } }],
        ['$in array with extra property', { a: { $in: Object.assign([1], { extra: 2 }) } }],
        ['$in non-array', { a: { $in: 5 } }],
        ['$in string', { a: { $in: 'x' } }],
        ['$in null', { a: { $in: null } }],
        ['$in object (sub-query)', { a: { $in: { type: 'select', table: 't', columns: ['id'] } } }],
        ['$nin non-array', { a: { $nin: 5 } }],
        ['$nin subquery', { a: { $nin: { type: 'select', table: 't' } } }],
        ['$nin []', { a: { $nin: [] } }],
        ['$nin null and others', { a: { $nin: ['x', null] } }],
        ['$not {$in: []}', { a: { $not: { $in: [] } } }],
        ['$not null', { a: { $not: null } }],
        ['$not []', { a: { $not: [] } }],
        ['$not {}', { a: { $not: {} } }],
        ['$in nested array', { a: { $in: [[1]] } }],
        ['$in object element', { a: { $in: [{}] } }],
        ['$in RegExp element', { a: { $in: [/x/] } }],
        ['$in NaN element', { a: { $in: [NaN] } }],
        ['$in 65536 elements', { a: { $in: Array.from({ length: 65536 }, (_, i) => i) } }],
        ['$gt null', { a: { $gt: null } }],
        ['$gte null', { a: { $gte: null } }],
        ['$lt null', { a: { $lt: null } }],
        ['$lte null', { a: { $lte: null } }],
        ['$like null', { a: { $like: null } }],
        ['$ilike null', { a: { $ilike: null } }],
        ['$like number', { a: { $like: 5 } }],
        ['$null string', { a: { $null: 'yes' } }],
        ['$null object', { a: { $null: {} } }],
        ['$notNull zero', { a: { $notNull: 0 } }],
        ['empty operator object', { a: {} }],
        ['empty array value', { a: [] }],
        ['array value', { a: [1, 2] }],
        ['RegExp value', { a: /x/ }],
        ['Map value', { a: new Map() }],
        ['Set value', { a: new Set() }],
        ['class instance value', { a: new Foo() }],
        ['function value', { a: () => 1 }],
        ['Symbol value', { a: Symbol('s') }],
        ['String wrapper', { a: Object('x') }],
        ['Number wrapper', { a: Object(5) }],
        ['NaN', { a: NaN }],
        ['Infinity', { a: Infinity }],
        ['-Infinity', { a: { $gt: -Infinity } }],
        ['invalid Date', { a: new Date('x') }],
        ['lone surrogate', { a: '\ud800' }],
        ['lone low surrogate', { a: 'x\udc00y' }],
        ['NUL', { a: 'x\u0000y' }],
        ['$..$ string', { a: '$name$' }],
        ['$ string', { a: '$' }],
        ['$$ string', { a: { $ne: '$$' } }],
        ['$..$ in $not', { a: { $not: '$x$' } }],
        ['$..$ in $gt', { a: { $gt: '$x$' } }],
        ['$..$ in $like', { a: { $like: '$x$' } }],
        ['column with double quote', { 'a"b': 1 }],
        ['column with dot', { 'a.b': 1 }],
        ['column with space', { 'a b': 1 }],
        ['column with leading space', { ' a': 1 }],
        ['column with star', { '*': 1 }],
        ['column empty', { '': 1 }],
        ['column numeric', { 0: 1 }],
        ['column numeric 1.5', { '1.5': 1 }],
        ['column negative', { '-1': 1 }],
        ['column Infinity', { Infinity: 1 }],
        ['column __proto__ own', JSON.parse('{"__proto__":{"a":1}}')],
        ['column $x$', { $x$: 1 }],
        ['column with $ inside', { 'a$b': 1 }],
        ['column leading digit', { '1a': 1 }],
        ['column with semicolon', { 'a;b': 1 }],
        ['column with comment', { 'a--': 1 }],
        ['column with backtick', { 'a`b': 1 }],
        ['column with NUL', { 'a\u0000': 1 }],
        ['column longer than 63 bytes', { ['c'.repeat(64)]: 1 }],
        ['column longer than 63 bytes (multibyte)', { ['中'.repeat(22)]: 1 }],
        ['column longer than 200 chars', { ['c'.repeat(201)]: 1 }],
        ['column fullwidth letters mixed with space', { 'ａ　ｂ': 1 }],
        ['JSON injection tail', { 'js->>9 is null or time': 1 }],
        ['JSON stacked', { 'js->>1 is null; delete from t; --': null }],
        ['JSON part starts with digit', { 'js->1abc': 1 }],
        ['JSON part leading zero', { 'js->007': 1 }],
        ['JSON part quoted', { 'js->>\'k\'': 1 }],
        ['JSON path with cast', { 'js->>k::int': 1 }],
        ['JSON hstore operator', { 'js=>k': 1 }],
        ['JSON operator at end', { 'js->>': 1 }],
        ['cast with args', { 'a::varchar(10)': 1 }],
        ['double cast', { 'a::int::text': 1 }],
        ['cast to digit type', { 'a::2x': 1 }],
        ['top null-prototype with Symbol key', Object.assign(Object.create(null), { [Symbol('s')]: 1 })],
        ['top Date', new Date()],
        ['top RegExp', /x/],
        ['top Map', new Map([['a', 1]])],
        ['top Set', new Set([1])],
        ['top class instance', new Foo()],
        ['top function', () => 1],
        ['top bigint', 1n],
        ['top Symbol', Symbol('s')],
        ['top Promise', Promise.resolve({})],
        ['top Error', new Error('x')],
        ['top Buffer', Buffer.from('x')],
        ['top non-empty string', 'a=1'],
        ['top inherited property', Object.create({ a: 1 })],
        ['top non-enumerable property', Object.defineProperty({}, 'a', { value: 1, enumerable: false })],
        ['top Symbol key', { [Symbol('a')]: 1 }],
        ['top accessor property', {
            get a() {
                return 1
            }
        }],
        ['nested accessor property', {
            a: {
                get $gt() {
                    return 1
                }
            }
        }],
        ['array element accessor', {
            $and: Object.defineProperty([], '0', {
                get() {
                    return { a: 1 }
                },
                enumerable: true
            })
        }],
    ]
    rejects.forEach(([label, f]) => {
        it(`should throw invalid find for ${label}`, function() {
            throwsFind(f) //S2 S3 S5
        })
    })

    it('should throw for circular references and over-deep nesting (depth 32 accepted, 33 rejected)', function() {
        let circ = { $and: [] }
        circ.$and.push(circ)
        throwsFind(circ, /nesting is too deep/)
        let nest = (n) => {
            let f = { a: 1 }
            for (let i = 0; i < n; i++) {
                f = { $and: [f] }
            }
            return f
        }
        assert.doesNotThrow(() => cvFind(nest(32))) //S2 上限
        throwsFind(nest(33), /nesting is too deep/)
    })

    it('should throw for $not nested over the depth limit', function() {
        let f = { $gt: 1 }
        for (let i = 0; i < 40; i++) {
            f = { $not: f }
        }
        throwsFind({ a: f }, /nesting is too deep/)
    })

    it('should throw for shared references that expand exponentially (DAG), quickly', function() {
        let x = { a: 1 }
        for (let i = 0; i < 25; i++) { //深度在上限內, 但展開為 2^25 個節點
            x = { $and: [x, x] }
        }
        let t0 = Date.now()
        throwsFind(x, /condition is too large/)
        assert.ok(Date.now() - t0 < 5000, 'must fail fast')
    })

    it('should throw when total bound parameters exceed 65535 (two arrays)', function() {
        let a = Array.from({ length: 40000 }, (_, i) => i)
        throwsFind({ x: { $in: a }, y: { $in: a } }, /too many bound parameters/)
        assert.doesNotThrow(() => cvFind({ x: { $in: Array.from({ length: 65535 }, (_, i) => i) } }))
    })

    it('should throw for fake Buffer and fake Date objects (internal slot check)', function() {
        let fakeBuf = Object.create(Buffer.prototype, { 0: { value: '$' }, 1: { value: '$' }, length: { value: 2 }, substring: { value: () => 'x' } })
        throwsFind({ a: fakeBuf })
        let fakeDate = {
            [Symbol.toStringTag]: 'Date',
            getTime() {
                return 1
            }
        }
        throwsFind({ a: fakeDate })
        let proxyDate = new Proxy(new Date(1), {})
        throwsFind({ a: proxyDate })
        let proxyBuf = new Proxy(Buffer.from('ab'), {})
        throwsFind({ a: proxyBuf })
    })

    it('should not use an overridden getTime of a real Date, and read it only once', function() {
        let d = new Date(1)
        let calls = 0
        d.getTime = () => (++calls === 1 ? 1 : NaN)
        let nf = cvFind({ a: d })
        assert.strictEqual(nf.a.getTime(), 1)
        assert.strictEqual(calls, 0) //不經實例上被覆寫之方法
    })

    it('should include a readable path in the message', function() {
        throwsFind({ $and: [{ a: 1 }, { b: { $gt: undefined } }] }, /at \[find\.\$and\[1\]\.b\.\$gt\]$/)
        throwsFind({ a: { $foo: 1 } }, /unsupported operator \[\$foo\] at \[find\.a\.\$foo\]$/)
    })

    it('should truncate long paths and clean control characters in messages (S5)', function() {
        let f = { name: 'x' }
        for (let i = 0; i < 20; i++) {
            f = { $or: [f, { value: 1 }] }
        }
        f = { $and: [f, { z: undefined }] }
        let e
        try {
            cvFind(f)
        }
        catch (err) {
            e = err
        }
        assert.ok(e && e.message.length < 400, e && e.message.length)
        let e2
        try {
            cvFind({ 'a\nb\u0000': 1 })
        }
        catch (err) {
            e2 = err
        }
        assert.ok(e2 && !/[\u0000-\u001f]/.test(e2.message), JSON.stringify(e2 && e2.message))
        let e3
        try {
            cvFind({ ['$' + 'k'.repeat(1000000)]: 1 })
        }
        catch (err) {
            e3 = err
        }
        assert.ok(e3 && e3.message.length < 400)
    })
})


describe('cvFind: top-level value that is not a condition object rejects (user ruling B, dspec 〈一之一〉)', function() {
    //裁示 B: 僅 undefined(= 未給條件 = 全部)與一般物件({} 亦為全部)可作頂層 find; 其餘一律 reject, 不得視為 {}.
    class Cond {
        constructor() {
            this.name = 'aa'
        }
    }
    let bads = [
        ['null', null], ['false', false], ['true', true], ['0', 0], ['empty string', ''], ['number', 5], ['NaN', NaN], ['Infinity', Infinity], ['string', 'aa'],
        ['bigint', 10n], ['Symbol', Symbol('x')], ['[]', []], ['[{}, {}]', [{}, {}]], ['[{name}]', [{ name: 'aa' }]], ['AND-combined array', [{ name: 'aa' }, { value: { $gt: 2 } }]],
        ['nested array', [[{ name: 'aa' }]]], ['[1]', [1]], ['[null]', [null]], ['array with extra property', Object.assign([{ name: 'aa' }], { extra: 1 })],
        ['function', () => ({})], ['Date', new Date(0)], ['RegExp', /aa/], ['Map', new Map()], ['Set', new Set()], ['class instance', new Cond()],
    ]
    bads.forEach(([label, f]) => {
        it(`should reject ${label}`, function() {
            throwsFind(f)
        })
    })
    it('should accept undefined and {} as no condition', function() {
        assert.deepStrictEqual(Object.keys(cvFind()), [])
        assert.deepStrictEqual(Object.keys(cvFind(undefined)), [])
        assert.deepStrictEqual(Object.keys(cvFind({})), [])
    })
    it('should still accept arrays only as the $and/$or list, with the same output as mongo-sql gives', function() {
        let f = { $and: [{ name: 'aa' }, { value: { $gt: 2 } }] }
        assert.strictEqual(sqlOf(cvFind(f)), sqlOf(f))
    })
})


describe('cvFind: output is a fresh null-prototype copy that is immune to the caller (R1)', function() {
    it('should not modify the input and should return new null-prototype objects', function() {
        let inner = { $gt: 1 }
        let list = [{ a: 1 }, { b: inner }]
        let f = Object.freeze({ $or: Object.freeze(list), c: Object.freeze({ $in: Object.freeze([1, 2]) }) })
        let before = JSON.stringify(f)
        let nf = cvFind(f)
        assert.strictEqual(JSON.stringify(f), before)
        assert.strictEqual(Object.getPrototypeOf(nf), null)
        assert.strictEqual(Object.getPrototypeOf(nf.$or), null)
        assert.strictEqual(Object.getPrototypeOf(nf.$or[0]), null)
        assert.strictEqual(Object.getPrototypeOf(nf.c), null)
        assert.notStrictEqual(nf.$or[1].b, inner)
        assert.ok(Array.isArray(nf.c.$in)) //$in 須為真陣列
    })

    it('should copy Date and Buffer values', function() {
        let d = new Date(5)
        let b = Buffer.from('ab')
        let nf = cvFind({ d, b })
        assert.notStrictEqual(nf.d, d)
        assert.strictEqual(nf.d.getTime(), 5)
        assert.notStrictEqual(nf.b, b)
        assert.ok(nf.b.equals(b))
        b[0] = 0 //改原 Buffer 不影響複本
        assert.strictEqual(nf.b[0], 97)
    })

    it('should copy a Buffer by its internal slots and never call its own valueOf or read its own length', function() {
        let n = 0
        let b = Buffer.from('AAAA')
        b.valueOf = () => (++n === 1 ? 'first' : 'second') //Buffer.from(b) 會呼叫 valueOf
        Object.defineProperty(b, 'length', {
            get() {
                n += 100
                return 2
            }
        })
        let c1 = cvFind({ bin: b }).bin
        let c2 = cvFind({ bin: b }).bin
        assert.strictEqual(n, 0) //沒有呼叫呼叫端自有之 valueOf / length
        assert.ok(Buffer.isBuffer(c1) && Buffer.isBuffer(c2))
        assert.strictEqual(c1.toString(), 'AAAA')
        assert.strictEqual(c2.toString(), 'AAAA')
    })

    it('should copy a Buffer that is a view of a larger ArrayBuffer by its own offset and length', function() {
        let big = Buffer.from('xxABCDyy')
        let view = big.subarray(2, 6)
        let c = cvFind({ bin: view }).bin
        assert.strictEqual(c.toString(), 'ABCD')
        view[0] = 0x5a //改原視圖不影響複本
        assert.strictEqual(c.toString(), 'ABCD')
    })

    it('should read every property exactly once and use only that value (Proxy trap counts)', function() {
        let counts = {}
        let gets = []
        let target = { a: 1, b: { $gt: 2 } }
        let p = new Proxy(target, {
            getOwnPropertyDescriptor(t, k) {
                counts[k] = (counts[k] || 0) + 1
                let d = Reflect.getOwnPropertyDescriptor(t, k)
                if (counts[k] > 1) {
                    return { ...d, value: 'changed' }
                }
                return d
            },
            get(t, k) {
                gets.push(k)
                return Reflect.get(t, k)
            },
        })
        let nf = cvFind(p)
        assert.strictEqual(nf.a, 1)
        assert.strictEqual(counts.a, 1)
        assert.strictEqual(counts.b, 1)
        assert.deepStrictEqual(gets.filter((k) => typeof k === 'string'), []) //不經 get trap 讀資料屬性(僅 Object.prototype.toString 讀 Symbol.toStringTag)
    })

    it('should be immune to Object.prototype pollution (for..in in mongo-sql would see inherited properties)', function() {
        Object.prototype.$custom = { value: 'true or 1=1 /*polluted*/', values: [] }
        Object.prototype.zzpolluted = 'asc; drop table t; --'
        try {
            let nf = cvFind({ a: 1, $and: [{ b: 2 }, { c: { $gt: 3 } }], d: { $in: [1, 2] } })
            let no = cvOrder({ time: 'asc' })
            let s = mongoSql.sql({ type: 'delete', table: 't', where: nf })
            let s2 = mongoSql.sql({ type: 'select', table: 't', where: nf, order: no })
            assert.ok(!/polluted|1=1|drop/.test(s.query), s.query)
            assert.ok(!/polluted|1=1|drop/.test(s2.query), s2.query)
            assert.strictEqual(s.query, 'delete from "t" where "t"."a" = $1 and ("t"."b" = $2 and "t"."c" > $3) and "t"."d" in ($4, $5)')
        }
        finally {
            delete Object.prototype.$custom
            delete Object.prototype.zzpolluted
        }
    })

    it('should be immune to Array.prototype pollution of indexes used by $and/$or lists', function() {
        let saved = Object.getOwnPropertyDescriptor(Array.prototype, '5')
        Array.prototype[5] = { a: 'polluted' }
        try {
            let nf = cvFind({ $and: [{ b: 1 }, { c: 2 }] })
            let s = mongoSql.sql({ type: 'delete', table: 't', where: nf })
            assert.ok(!/polluted/.test(JSON.stringify(s.values)), JSON.stringify(s.values))
        }
        finally {
            delete Array.prototype[5]
            if (saved) {
                Object.defineProperty(Array.prototype, '5', saved)
            }
        }
    })
})


describe('cvFind: keys', function() {
    it('should accept identifier-like keys including unicode letters up to 63 bytes', function() {
        assert.doesNotThrow(() => cvFind({ ['c'.repeat(63)]: 1 }))
        assert.doesNotThrow(() => cvFind({ ['中'.repeat(21)]: 1 })) //63 bytes
        assert.doesNotThrow(() => cvFind({ Name: 1, name_2: 2, _x: 3 }))
    })
    it('should expose cvColumn for write paths: bare identifiers only', function() {
        assert.doesNotThrow(() => cvColumn('name'))
        assert.doesNotThrow(() => cvColumn('中文'))
        ;['', '$inc', 'a.b', 'a"b', 'a b', 'a->b', 'a::int', '1a', '__proto__', 'c'.repeat(64), 'a;b'].forEach((k) => {
            assert.throws(() => cvColumn(k), /unsupported column name|too long/, `cvColumn(${JSON.stringify(k)})`)
        })
    })
})


describe('cvOrder (S7)', function() {
    it('should accept undefined, null, {} and asc/desc (case-insensitive, nulls first|last)', function() {
        assert.deepStrictEqual(Object.keys(cvOrder(undefined)), [])
        assert.deepStrictEqual(Object.keys(cvOrder(null)), [])
        assert.deepStrictEqual(Object.keys(cvOrder({})), [])
        let o = cvOrder({ a: 'asc', b: 'DESC', c: 'desc nulls last', d: 'Asc  NULLS   FIRST' })
        assert.deepStrictEqual(Object.keys(o), ['a', 'b', 'c', 'd'])
        assert.strictEqual(Object.getPrototypeOf(o), null)
        assert.strictEqual(sqlOf({}, o).includes('order by'), true)
    })
    it('should accept the same JSON-path and cast keys as find', function() {
        assert.doesNotThrow(() => cvOrder({ 'js->>k': 'asc', 'ts::date': 'desc' }))
    })
    let bads = [
        ['injection', { a: 'asc; delete from t' }],
        ['subquery', { a: 'asc, (select 1)' }],
        ['comment', { a: 'asc --' }],
        ['empty string', { a: '' }],
        ['number 1', { a: 1 }],
        ['number -1', { a: -1 }],
        ['undefined', { a: undefined }],
        ['null', { a: null }],
        ['boolean', { a: true }],
        ['injection in key', { 'a) desc, (select 1': 'asc' }],
        ['key with space', { 'a b': 'asc' }],
        ['key with dot', { 'a.b': 'asc' }],
        ['empty key', { '': 'asc' }],
        ['raw string', 'a desc'],
        ['raw array', ['a desc']],
        ['number', 5],
        ['true', true],
        ['class instance', new Foo()],
        ['Map', new Map()],
        ['accessor', {
            get a() {
                return 'asc'
            }
        }],
        ['Symbol key', { [Symbol('a')]: 'asc' }],
    ]
    bads.forEach(([label, o]) => {
        it(`should throw invalid order for ${label}`, function() {
            assert.throws(() => cvOrder(o), (e) => e instanceof Error && /^invalid order: /.test(e.message), `cvOrder(${label})`)
        })
    })
    it('should be immune to Object.prototype pollution', function() {
        Object.prototype.zzo = 'asc; drop table t; --'
        try {
            let s = mongoSql.sql({ type: 'select', table: 't', where: cvFind({}), order: cvOrder({ a: 'asc' }) })
            assert.ok(!/drop/.test(s.query), s.query)
        }
        finally {
            delete Object.prototype.zzo
        }
    })
})


describe('cvKey: cache keys distinguish values that JSON.stringify would merge (S8)', function() {
    let k = (f, o = {}) => cvKey(cvFind(f), cvOrder(o))
    it('should be stable for equal input and differ for different order', function() {
        assert.strictEqual(k({ a: 1 }), k({ a: 1 }))
        assert.notStrictEqual(k({ a: 1 }), k({ a: 1 }, { a: 'asc' }))
        assert.notStrictEqual(k({ a: 1 }), k({ a: 2 }))
    })
    it('should distinguish Date from its ISO string, bigint from number and string, Buffer from its hex string', function() {
        let d = new Date('2020-01-01T00:00:00.000Z')
        assert.notStrictEqual(k({ a: d }), k({ a: d.toISOString() }))
        assert.notStrictEqual(k({ a: 3n }), k({ a: 3 }))
        assert.notStrictEqual(k({ a: 3n }), k({ a: '3' }))
        assert.notStrictEqual(k({ a: Buffer.from('ab') }), k({ a: '6162' }))
        assert.notStrictEqual(k({ a: Buffer.from('ab') }), k({ a: Buffer.from('ac') }))
        assert.notStrictEqual(k({ a: new Date(1) }), k({ a: new Date(2) }))
    })
    it('should distinguish null from other falsy values and the keys of $in lists', function() {
        assert.notStrictEqual(k({ a: null }), k({ a: 0 }))
        assert.notStrictEqual(k({ a: null }), k({ a: '' }))
        assert.notStrictEqual(k({ a: { $in: [null] } }), k({ a: { $in: [] } }))
        assert.notStrictEqual(k({ a: { $in: [1, 2] } }), k({ a: { $in: [2, 1] } }))
    })
    it('should not throw for bigint values (JSON.stringify would)', function() {
        assert.doesNotThrow(() => k({ a: { $in: [1n, 2n] } }))
    })
    it('should give the same key for selectByPk-style plain find and normalized select find', function() {
        let d = new Date(7)
        assert.strictEqual(cvKey({ time: d }, {}), k({ time: d }))
        assert.strictEqual(cvKey({ time: 'x' }, {}), k({ time: 'x' }))
    })
})


describe('cvFind: re-entrancy, hostile hooks and options (R1)', function() {
    it('should keep counting bound parameters of the outer call when a trap calls cvFind re-entrantly', function() {
        let a = Array.from({ length: 40000 }, (_, i) => i)
        let y = new Proxy({ $in: a }, {
            getOwnPropertyDescriptor(t, k) {
                cvFind({ z: 1 }) //可重入: 內層呼叫不得重置外層之預算
                return Reflect.getOwnPropertyDescriptor(t, k)
            },
        })
        throwsFind({ x: { $in: a }, y }, /too many bound parameters/)
    })

    it('should turn any exception of caller hooks into invalid find (Symbol.toStringTag getter, Proxy trap)', function() {
        let o = {
            get [Symbol.toStringTag]() {
                throw new Error('tag getter called')
            }
        }
        throwsFind({ a: o })
        throwsFind(o)
        throwsFind(new Proxy({ a: 1 }, {
            ownKeys() {
                throw new Error('keys trap')
            }
        }))
        assert.throws(() => cvOrder(o), (e) => /^invalid order: /.test(e.message))
        assert.throws(() => cvOrder({
            get [Symbol.toStringTag]() {
                throw new Error('t')
            }
        }), (e) => /^invalid order: /.test(e.message))
    })

    it('should not leak state between calls (a failed call does not affect the next one)', function() {
        let big = Array.from({ length: 65535 }, (_, i) => i)
        assert.doesNotThrow(() => cvFind({ x: { $in: big } }))
        assert.throws(() => cvFind({ x: { $in: big }, y: 1 }))
        assert.doesNotThrow(() => cvFind({ x: { $in: big } }))
    })

    it('should reject $nin only when opt.nin is false (table name breaks mongo-sql $nin rewrite)', function() {
        assert.doesNotThrow(() => cvFind({ a: { $nin: ['x'] } }))
        assert.doesNotThrow(() => cvFind({ a: { $nin: ['x'] } }, { nin: true }))
        throwsFind2({ a: { $nin: ['x'] } }, { nin: false }, /\$nin is not supported with this table name/)
        throwsFind2({ a: { $not: { $nin: ['x'] } } }, { nin: false }, /\$nin is not supported/)
        assert.doesNotThrow(() => cvFind({ a: { $in: ['x'], $not: { $in: ['y'] } } }, { nin: false })) //其他運算子不受影響
    })

    it('should accept unicode JSON path parts like mongo-sql and keep the same SQL', function() {
        let f = { 'js->>中文': 'x', 'js->a->>名稱': 'y' }
        assert.strictEqual(sqlOf(cvFind(f)), sqlOf(f))
        throwsFind({ 'js->>1中': 1 })
        throwsFind({ 'js->>٣': 1 }) //非 ASCII 數字開頭
        throwsFind({ 'js->>\u0301a': 1 }) //組合附加符號不可作首字元
        let g = { 'js->>a\u0301': 1, 'a\u0301': 2 } //字母後接組合附加符號(\p{M})為識別字之一部分, 與 mongo-sql 之 SQL 相同
        assert.strictEqual(sqlOf(cvFind(g)), sqlOf(g))
    })

    it('should give a distinct cache key for NaN and Infinity (JSON.stringify would merge them with null)', function() {
        let k = (v) => cvKey({ a: v }, {})
        assert.notStrictEqual(k(Infinity), k(null))
        assert.notStrictEqual(k(NaN), k(null))
        assert.notStrictEqual(k(Infinity), k(-Infinity))
        assert.notStrictEqual(k(NaN), k(Infinity))
    })
})

function throwsFind2(f, opt, re) {
    assert.throws(() => cvFind(f, opt), (e) => e instanceof Error && re.test(e.message))
}


describe('cvFind: caller hooks that throw hostile objects are still reported as invalid find (R1)', function() {
    let bomb = () => {
        let o = {}
        Object.defineProperty(o, 'message', {
            get() {
                throw o
            },
            enumerable: false
        })
        return o
    }
    it('should convert an exception whose message getter throws', function() {
        let b1 = bomb()
        throwsFind({
            a: {
                get [Symbol.toStringTag]() {
                    throw b1
                }
            }
        })
        let b2 = bomb()
        throwsFind(new Proxy({ a: 1 }, {
            ownKeys() {
                throw b2
            }
        }))
        let b3 = bomb()
        assert.throws(() => cvOrder({
            get [Symbol.toStringTag]() {
                throw b3
            }
        }), (e) => e instanceof Error && /^invalid order: /.test(e.message))
    })
    it('should convert non-Error throws (string, null)', function() {
        throwsFind({
            a: {
                get [Symbol.toStringTag]() {
                    throw 'plain string'
                }
            }
        }) // eslint-disable-line no-throw-literal
        throwsFind({
            a: {
                get [Symbol.toStringTag]() {
                    throw null
                }
            }
        }) // eslint-disable-line no-throw-literal
    })
})


describe('cvFind: arrays are read exactly once (length, elements) and stay in the node budget (Argon round 2)', function() {
    //以 Proxy 令 length 每次回傳不同值: 驗證期與複製期若各讀一次, 複本會少掉分支(如 $and 少一個條件 = 條件變寬)
    let withLength = (arr, seq) => {
        let calls = 0
        return new Proxy(arr, {
            get(t, p, r) {
                if (p === 'length') {
                    calls++
                    return seq[Math.min(calls - 1, seq.length - 1)]
                }
                return Reflect.get(t, p, r)
            }
        })
    }
    it('should keep every branch of $and / $or even if length changes between reads', function() {
        let a = cvFind({ $and: withLength([{ name: 'aa' }, { n: 10 }], [2, 2, 1]) })
        assert.deepStrictEqual(Object.keys(a.$and), ['0', '1'])
        let o = cvFind({ $or: withLength([{ name: 'aa' }, { n: 10 }], [2, 2, 1]) })
        assert.deepStrictEqual(Object.keys(o.$or), ['0', '1'])
        let s = cvFind({ n: { $in: withLength([1, 2], [2, 2, 1]) } })
        assert.deepStrictEqual(s.n.$in, [1, 2])
    })
    it('should reject non-enumerable array elements like non-enumerable properties', function() {
        let arr = [{ name: 'aa' }]
        Object.defineProperty(arr, '0', { value: { name: 'aa' }, enumerable: false, configurable: true, writable: true })
        throwsFind({ $or: arr }, /non-enumerable element/)
        let arr2 = [1]
        Object.defineProperty(arr2, '0', { value: 1, enumerable: false, configurable: true, writable: true })
        throwsFind({ n: { $in: arr2 } }, /non-enumerable element/)
    })
    it('should count dropped {} elements of $and in the node budget', function() {
        let big = Array.from({ length: 150001 }, (_, i) => (i === 150000 ? { name: 'aa' } : {}))
        throwsFind({ $and: big }, /too large/)
    })
})


describe('isCleanStr: strings that change on the wire are not clean (pk values, Argon round 2)', function() {
    it('should accept ordinary strings, emoji pairs and U+FFFD itself', function() {
        assert.strictEqual(isCleanStr('abc'), true)
        assert.strictEqual(isCleanStr('中文'), true)
        assert.strictEqual(isCleanStr('\ud83d\ude00'), true) //成對代理
        assert.strictEqual(isCleanStr('\ufffd'), true)
        assert.strictEqual(isCleanStr('a$b'), true)
    })
    it('should reject lone surrogates and NUL', function() {
        assert.strictEqual(isCleanStr('\ud800'), false)
        assert.strictEqual(isCleanStr('a\udc00b'), false)
        assert.strictEqual(isCleanStr('\ude00\ud83d'), false)
        assert.strictEqual(isCleanStr('a\u0000b'), false)
    })
})


describe('cvFind / cvOrder: only errors built by this module are rethrown as is (opus round 3)', function() {
    it('should wrap a thrown caller object that merely claims an "invalid find" message into a new Error', function() {
        let forged = { message: 'invalid find: forged' }
        let f = {
            a: new Proxy({}, {
                getPrototypeOf() {
                    throw forged
                }
            })
        }
        let e
        try {
            cvFind(f)
        }
        catch (err) {
            e = err
        }
        assert.ok(e instanceof Error)
        assert.notStrictEqual(e, forged)
        assert.ok(/^invalid find: /.test(e.message), e.message)
    })
    it('should wrap a thrown caller Error whose message starts with "invalid find: " instead of rethrowing that Error', function() {
        let mine = new Error('invalid find: pretend')
        let f = {
            a: new Proxy({}, {
                getPrototypeOf() {
                    throw mine
                }
            })
        }
        let e
        try {
            cvFind(f)
        }
        catch (err) {
            e = err
        }
        assert.notStrictEqual(e, mine)
        assert.ok(/^invalid find: invalid find: pretend at \[find\]$/.test(e.message), e.message)
    })
    it('should turn the same forged object into "invalid order" in cvOrder', function() {
        let forged = { message: 'invalid find: forged' }
        let e
        try {
            cvOrder({
                get [Symbol.toStringTag]() {
                    throw forged
                }
            })
        }
        catch (err) {
            e = err
        }
        assert.ok(e instanceof Error && e !== forged)
        assert.ok(/^invalid order: /.test(e.message), e.message)
    })
    it('should keep working when Object.prototype carries get / set (descriptor literals must not inherit them)', function() {
        Object.prototype.get = 1
        Object.prototype.set = 2
        try {
            let nf = cvFind({ a: 1, $or: [{ b: 2 }, { c: { $in: [1, 2] } }] })
            assert.strictEqual(nf.a, 1)
            assert.deepStrictEqual(nf.$or[1].c.$in, [1, 2])
            assert.deepStrictEqual(Object.keys(cvOrder({ time: 'asc' })), ['time'])
        }
        finally {
            delete Object.prototype.get
            delete Object.prototype.set
        }
    })
})
