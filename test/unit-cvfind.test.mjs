/* eslint-disable no-extend-native, no-sparse-arrays, no-control-regex, no-throw-literal -- 測試刻意以稀疏陣列、控制字元與暫時汙染原型(finally 還原)驗證檢核器 */
import assert from 'assert'
import chkOrmStr from 'wsemi/src/chkOrmStr.mjs'
import { cvFind, cvOrder, cvKey, cvColumn } from '../src/cvFind.mjs'
import { buildSelect, buildDelete } from '../src/buildSql.mjs'
import { eqNode } from '../src/lowerFind.mjs'


//cvFind/cvOrder/cvKey/cvColumn 與 wsemi chkOrmStr(主鍵、表名、資料鍵之良構判定,第 66 項起取代本模組私有之 isCleanStr)之純函數測試(不連線, 不需 docker).
//規格句見 CLAUDE_rulebook.md 開頭(S1–S14)與 tmp/brief-tests.md 之行為變更:
//  S2 不支援之運算子與無法轉譯之值必須 reject  S3 空清單與 undefined 不得成為恆真
//  S4 受支援語意不變(預期 SQL 與 values 皆依 SQL 語意手寫, 不取自被測碼)
//  S5 訊息格式 invalid find: <原因> at [<路徑>]  S7 order  S8 快取鍵  S12 布林 $ne 三值
//  S13(新) 首尾皆 $ 之字串於所有運算子皆為字面值綁定參數  S14 JSON/轉型鍵 reject(find 與 order)
//cvFind 回傳方言中立 IR(見 src/lowerFind.mjs 檔頭); SQL 由 buildSelect/buildDelete 產生(表別名 "$t", 欄位不加表限定).
//IR 契約、maxParams、checkColumn 之單元測試在 unit-lowerfind; verifySql 與 buildSql 精確 SQL 在 unit-sqlbuild; 本檔不重複.


let S = 'select * from "t" as "$t"'
let D = 'delete from "t" as "$t"'
let sel = (f, o) => buildSelect('t', cvFind(f), o === undefined ? [] : cvOrder(o))
//expectSql: select 與 delete 之 where 子句與 values 皆須等於手寫預期(S1: 同一 find 之 select 與 delete 用同一條件)
let expectSql = (f, where, values) => {
    let ir = cvFind(f)
    let s = buildSelect('t', ir)
    assert.strictEqual(s.query, S + where)
    assert.deepStrictEqual(s.values, values)
    let d = buildDelete('t', ir)
    assert.strictEqual(d.query, D + where)
    assert.deepStrictEqual(d.values, values)
}
let throwsFind = (f, re = /^invalid find: /) => assert.throws(() => cvFind(f), (e) => e instanceof Error && re.test(e.message))
let msgOf = (fn) => {
    try {
        fn()
    }
    catch (err) {
        return err.message
    }
    return undefined
}
let N = (o) => Object.assign(Object.create(null), o) //手寫 IR 預期節點(null 原型)
let cols = (n, a) => Object.fromEntries(Array.from({ length: n }, (_, k) => [`x${k}`, { $in: a }]))
let range = (n) => Array.from({ length: n }, (_, i) => i)
class Foo {
    constructor() {
        this.name = 'aa'
    }
}


describe('cvFind: accepted finds produce the hand-written SQL and values (S4)', function() {
    let d = new Date('2020-01-01T00:00:00.000Z')
    //[label, find, 預期 where 子句(接在 from "t" as "$t" 之後), 預期 values]
    let accepts = [
        ['undefined', undefined, '', []],
        ['empty object', {}, '', []],
        ['eq string', { name: 'aa' }, ' where "name" = $1', ['aa']],
        ['eq null', { tag: null }, ' where "tag" is null', []],
        ['eq boolean true', { ok: true }, ' where "ok" IS TRUE', []],
        ['eq boolean false', { ok: false }, ' where "ok" IS FALSE', []],
        ['eq number', { value: 1.5 }, ' where "value" = $1', [1.5]],
        ['eq Date', { ts: d }, ' where "ts" = $1', [d]],
        ['eq string with quote', { name: 'it\'s' }, ' where "name" = $1', ['it\'s']],
        ['string starting with $', { name: '$a' }, ' where "name" = $1', ['$a']],
        ['string ending with $', { name: 'a$' }, ' where "name" = $1', ['a$']],
        ['$eq', { value: { $eq: 5 } }, ' where "value" = $1', [5]],
        ['$eq null', { tag: { $eq: null } }, ' where "tag" is null', []],
        ['$ne string', { name: { $ne: 'aa' } }, ' where "name" != $1', ['aa']],
        ['$ne number', { value: { $ne: 5 } }, ' where "value" != $1', [5]],
        ['$ne null', { name: { $ne: null } }, ' where "name" is not null', []],
        ['$gt', { value: { $gt: 1 } }, ' where "value" > $1', [1]],
        ['$gte', { value: { $gte: 2 } }, ' where "value" >= $1', [2]],
        ['$lt', { value: { $lt: 9 } }, ' where "value" < $1', [9]],
        ['$lte', { value: { $lte: 8 } }, ' where "value" <= $1', [8]],
        ['same column with $gt $gte $lt $lte (implicit AND, key order)', { value: { $gt: 1, $gte: 2, $lt: 9, $lte: 8 } }, ' where "value" > $1 and "value" >= $2 and "value" < $3 and "value" <= $4', [1, 2, 9, 8]],
        ['same column with $gt and $eq and $lt', { value: { $gt: 1, $eq: 5, $lt: 9 } }, ' where "value" > $1 and "value" = $2 and "value" < $3', [1, 5, 9]],
        ['$gte Date', { ts: { $gte: d } }, ' where "ts" >= $1', [d]],
        ['$in', { value: { $in: [1, 2, 3] } }, ' where "value" in ($1, $2, $3)', [1, 2, 3]],
        ['$in []: constant false, no parameter', { value: { $in: [] } }, ' where false', []],
        ['$in [] beside another column', { name: 'aa', value: { $in: [] } }, ' where "name" = $1 and false', ['aa']],
        ['$in Date', { ts: { $in: [d] } }, ' where "ts" in ($1)', [d]],
        ['$in booleans are bound parameters', { ok: { $in: [true, false] } }, ' where "ok" in ($1, $2)', [true, false]],
        ['$nin', { value: { $nin: [1, 2] } }, ' where "value" not in ($1, $2)', [1, 2]],
        ['$nin booleans are bound parameters', { ok: { $nin: [true] } }, ' where "ok" not in ($1)', [true]],
        ['multi columns (implicit AND)', { name: 'aa', value: { $gt: 1 }, tag: null }, ' where "name" = $1 and "value" > $2 and "tag" is null', ['aa', 1]],
        ['boolean does not take a placeholder number', { a: true, b: 1, c: null, e: 2 }, ' where "a" IS TRUE and "b" = $1 and "c" is null and "e" = $2', [1, 2]],
        ['$and is flattened into the root AND', { $and: [{ value: { $gt: 2 } }, { value: { $lt: 6 } }] }, ' where "value" > $1 and "value" < $2', [2, 6]],
        ['$or', { $or: [{ value: { $lte: 1 } }, { value: { $gte: 10 } }] }, ' where ("value" <= $1 or "value" >= $2)', [1, 10]],
        ['$and one element is unwrapped', { $and: [{ name: 'aa' }] }, ' where "name" = $1', ['aa']],
        ['$or one element is unwrapped', { $or: [{ name: 'aa' }] }, ' where "name" = $1', ['aa']],
        ['column + $or', { name: 'aa', $or: [{ value: 1 }, { value: 4 }] }, ' where "name" = $1 and ("value" = $2 or "value" = $3)', ['aa', 1, 4]],
        ['column + $and + $or', { name: 'aa', $and: [{ value: 1 }], $or: [{ tag: 'x' }, { tag: null }] }, ' where "name" = $1 and "value" = $2 and ("tag" = $3 or "tag" is null)', ['aa', 1, 'x']],
        ['$or of multi-key docs', { $or: [{ name: 'aa', value: 1 }, { tag: 'y' }] }, ' where (("name" = $1 and "value" = $2) or "tag" = $3)', ['aa', 1, 'y']],
        ['two $or groups joined by AND', { $and: [{ $or: [{ a: 1 }, { b: 2 }] }, { $or: [{ c: 3 }, { d: 4 }] }] }, ' where ("a" = $1 or "b" = $2) and ("c" = $3 or "d" = $4)', [1, 2, 3, 4]],
        ['nested $and is flattened', { $and: [{ $and: [{ a: 1 }, { b: 2 }] }, { c: 3 }] }, ' where "a" = $1 and "b" = $2 and "c" = $3', [1, 2, 3]],
        ['nested $or is flattened, $and inside $or keeps its parentheses', { $or: [{ $and: [{ value: { $ne: 4 } }, { value: { $in: [4, 5, 6] } }, { value: { $nin: [6, 7] } }] }, { $or: [{ value: { $lte: -1 } }, { value: { $gte: 10 } }] }] }, ' where (("value" != $1 and "value" in ($2, $3, $4) and "value" not in ($5, $6)) or "value" <= $7 or "value" >= $8)', [4, 4, 5, 6, 6, 7, -1, 10]],
        ['single-element $and inside $or is unwrapped', { $or: [{ $and: [{ a: 1 }] }, { b: 2 }] }, ' where ("a" = $1 or "b" = $2)', [1, 2]],
        ['$or inside $or element with AND', { $or: [{ a: 1, $or: [{ b: 2 }, { c: 3 }] }, { d: 4 }] }, ' where (("a" = $1 and ("b" = $2 or "c" = $3)) or "d" = $4)', [1, 2, 3, 4]],
        ['portable: exclude NULL', { $and: [{ tag: { $ne: null } }, { tag: { $ne: 'x' } }] }, ' where "tag" is not null and "tag" != $1', ['x']],
        ['portable: include NULL', { $or: [{ tag: null }, { tag: { $ne: 'x' } }] }, ' where ("tag" is null or "tag" != $1)', ['x']],
        ['unicode column', { 中文: 1 }, ' where "中文" = $1', [1]],
        ['underscore column', { _a_1: 1 }, ' where "_a_1" = $1', [1]],
        ['column named Infinity is legal', { Infinity: 1 }, ' where "Infinity" = $1', [1]],
        ['column named oid is legal', { oid: 1 }, ' where "oid" = $1', [1]],
        ['unsafe integer number', { value: Number.MAX_SAFE_INTEGER + 2 }, ' where "value" = $1', [Number.MAX_SAFE_INTEGER + 2]],
        ['negative zero', { value: -0 }, ' where "value" = $1', [-0]],
        ['Object.create(null) find', Object.assign(Object.create(null), { name: 'aa' }), ' where "name" = $1', ['aa']],
    ]
    accepts.forEach(([label, f, where, values]) => {
        it(`should get the hand-written SQL and values for ${label}`, function() {
            expectSql(f, where, values) //S4
        })
    })

    it('should reject {} elements of $and (they were dropped as constant true before the series whitelist)', function() {
        throwsFind({ $and: [{}, {}, { name: 'aa' }, {}] }, /empty condition/)
        throwsFind({ $and: [{ name: 'aa' }, {}] }, /empty condition/)
    })
})


describe('cvFind: pg-specific semantics in SQL (S12 S13; $..$ strings are literals, booleans are three-valued)', function() {
    //[label, find, 預期 where 子句, 預期 values]
    let cases = [
        //S12: 布林等值與 $ne 用 IS TRUE/IS FALSE(NULL 列不命中); 其餘比較用字面值
        ['$eq true', { ok: { $eq: true } }, ' where "ok" IS TRUE', []],
        ['$eq false', { ok: { $eq: false } }, ' where "ok" IS FALSE', []],
        ['$ne true -> IS FALSE (not IS NOT TRUE)', { ok: { $ne: true } }, ' where "ok" IS FALSE', []],
        ['$ne false -> IS TRUE', { ok: { $ne: false } }, ' where "ok" IS TRUE', []],
        ['$ne string on a boolean-named column is an ordinary !=', { ok: { $ne: 'x' } }, ' where "ok" != $1', ['x']],
        ['$gt false', { ok: { $gt: false } }, ' where "ok" > FALSE', []],
        ['$gte true', { ok: { $gte: true } }, ' where "ok" >= TRUE', []],
        ['$lt true', { ok: { $lt: true } }, ' where "ok" < TRUE', []],
        ['$lte false', { ok: { $lte: false } }, ' where "ok" <= FALSE', []],
        //同欄多運算子: 每個運算子各成一項, 不得互相覆蓋或丟棄(含矛盾者)
        ['$eq false and $ne true on one column', { ok: { $eq: false, $ne: true } }, ' where "ok" IS FALSE and "ok" IS FALSE', []],
        ['$ne true before $eq true (contradiction kept)', { ok: { $ne: true, $eq: true } }, ' where "ok" IS FALSE and "ok" IS TRUE', []],
        ['boolean pair beside a user $and', { $and: [{ value: 1 }], ok: { $eq: true, $ne: true } }, ' where "value" = $1 and "ok" IS TRUE and "ok" IS FALSE', [1]],
        ['boolean pair inside an $or element that has a $and', { $or: [{ ok: { $ne: false, $eq: false }, $and: [{ value: 1 }] }, { value: 2 }] }, ' where (("ok" IS TRUE and "ok" IS FALSE and "value" = $1) or "value" = $2)', [1, 2]],
        //S13(新行為): 首尾皆 $ 之字串在所有運算子皆為字面值綁定參數, 不改寫為 $in/$nin
        ['$..$ string equality', { name: '$x$' }, ' where "name" = $1', ['$x$']],
        ['$ string equality', { name: '$' }, ' where "name" = $1', ['$']],
        ['$..$ string $eq', { name: { $eq: '$x$' } }, ' where "name" = $1', ['$x$']],
        ['$..$ string $ne', { name: { $ne: '$x$' } }, ' where "name" != $1', ['$x$']],
        ['$..$ string $gt', { name: { $gt: '$x$' } }, ' where "name" > $1', ['$x$']],
        ['$..$ string $gte', { name: { $gte: '$x$' } }, ' where "name" >= $1', ['$x$']],
        ['$..$ string $lt', { name: { $lt: '$x$' } }, ' where "name" < $1', ['$x$']],
        ['$..$ string $lte', { name: { $lte: '$x$' } }, ' where "name" <= $1', ['$x$']],
        ['$..$ strings in $in', { name: { $in: ['$name$', '$'] } }, ' where "name" in ($1, $2)', ['$name$', '$']],
        ['$..$ strings in $nin', { name: { $nin: ['$name$'] } }, ' where "name" not in ($1)', ['$name$']],
        ['$..$ string $eq beside $in on one column', { name: { $eq: '$x$', $in: ['a', 'b'] } }, ' where "name" = $1 and "name" in ($2, $3)', ['$x$', 'a', 'b']],
        ['$..$ string $ne beside $nin on one column', { name: { $ne: '$x$', $nin: ['a'] } }, ' where "name" != $1 and "name" not in ($2)', ['$x$', 'a']],
        ['$in before $..$ string $eq', { name: { $in: ['a', 'b'], $eq: '$x$' } }, ' where "name" in ($1, $2) and "name" = $3', ['a', 'b', '$x$']],
        ['$nin before $..$ string $ne beside a user $and', { $and: [{ value: 1 }], name: { $nin: ['a'], $ne: '$x$' } }, ' where "value" = $1 and "name" not in ($2) and "name" != $3', [1, 'a', '$x$']],
        ['two columns each with two operators', { ok: { $eq: true, $ne: false }, name: { $eq: '$x$', $in: ['a'] } }, ' where "ok" IS TRUE and "ok" IS TRUE and "name" = $1 and "name" in ($2)', ['$x$', 'a']],
        ['$..$ string inside $or elements', { $or: [{ name: '$x$' }, { name: 'aa' }] }, ' where ("name" = $1 or "name" = $2)', ['$x$', 'aa']],
    ]
    cases.forEach(([label, f, where, values]) => {
        it(`should get the hand-written SQL and values for ${label}`, function() {
            expectSql(f, where, values)
        })
    })

    it('should give $eq the same SQL and values as plain equality (non-null scalars, null and booleans)', function() {
        ;[[{ name: { $eq: 'aa' } }, { name: 'aa' }], [{ value: { $eq: 5 } }, { value: 5 }], [{ tag: { $eq: null } }, { tag: null }], [{ ok: { $eq: true } }, { ok: true }], [{ name: { $eq: '$x$' } }, { name: '$x$' }]].forEach(([a, b]) => {
            assert.strictEqual(sel(a).query, sel(b).query)
            assert.deepStrictEqual(sel(a).values, sel(b).values)
        })
    })

    it('should ignore a second argument: opt.nin no longer exists and $nin / $..$ $ne stay usable', function() {
        ;[{ nin: false }, { nin: true }, undefined].forEach((opt) => {
            let r = buildSelect('t', cvFind({ a: { $nin: ['x'] } }, opt))
            assert.strictEqual(r.query, `${S} where "a" not in ($1)`)
            assert.deepStrictEqual(r.values, ['x'])
            let r2 = buildSelect('t', cvFind({ name: { $ne: '$x$' } }, opt))
            assert.strictEqual(r2.query, `${S} where "name" != $1`)
            assert.deepStrictEqual(r2.values, ['$x$'])
        })
        let r3 = buildSelect('t', cvFind({ $and: [{ b: 1 }, { $or: [{ a: { $nin: ['x'] } }, { c: 2 }] }] }, { nin: false }))
        assert.strictEqual(r3.query, `${S} where "b" = $1 and ("a" not in ($2) or "c" = $3)`)
        assert.deepStrictEqual(r3.values, [1, 'x', 2])
    })

    it('should not echo values in messages of rejected finds', function() {
        let m1 = msgOf(() => cvFind({ name: { $like: '$secretcol$' } }))
        assert.ok(/^invalid find: unsupported operator \[\$like\] at \[find\.name\.\$like\]$/.test(m1), m1)
        let m2 = msgOf(() => cvFind({ name: { $gt: { secretkey: 1 } } }))
        assert.ok(/^invalid find: /.test(m2) && !/secretkey/.test(m2), m2)
        let m3 = msgOf(() => cvFind({ name: 'x\u0000secretval' }))
        assert.ok(/^invalid find: /.test(m3) && !/secretval/.test(m3), m3)
        let m4 = msgOf(() => cvFind({ name: { $in: ['secretin', null] } }))
        assert.ok(/^invalid find: /.test(m4) && !/secretin/.test(m4), m4)
    })
})


describe('cvFind: IR leaves carry their source path p (diagnostics only)', function() {
    it('should set p of a top-level equality and operator leaf', function() {
        assert.deepStrictEqual(cvFind({ age: 1 }), N({ t: 'cmp', c: 'age', op: 'eq', v: 1, p: 'find.age' }))
        assert.deepStrictEqual(cvFind({ age: { $gt: 1 } }), N({ t: 'cmp', c: 'age', op: 'gt', v: 1, p: 'find.age.$gt' }))
    })
    it('should set p of bool, null and in leaves including the operator', function() {
        assert.deepStrictEqual(cvFind({ ok: { $eq: true } }), N({ t: 'bool', c: 'ok', op: 'eq', v: true, p: 'find.ok.$eq' }))
        assert.deepStrictEqual(cvFind({ ok: false }), N({ t: 'bool', c: 'ok', op: 'eq', v: false, p: 'find.ok' }))
        assert.deepStrictEqual(cvFind({ tag: null }), N({ t: 'null', c: 'tag', not: false, p: 'find.tag' }))
        assert.deepStrictEqual(cvFind({ tag: { $ne: null } }), N({ t: 'null', c: 'tag', not: true, p: 'find.tag.$ne' }))
        assert.deepStrictEqual(cvFind({ v: { $in: [1, 2] } }), N({ t: 'in', c: 'v', vs: [1, 2], not: false, p: 'find.v.$in' }))
        assert.deepStrictEqual(cvFind({ v: { $nin: [3] } }), N({ t: 'in', c: 'v', vs: [3], not: true, p: 'find.v.$nin' }))
        assert.deepStrictEqual(cvFind({ v: { $in: [] } }), N({ t: 'in', c: 'v', vs: [], not: false, p: 'find.v.$in' }))
    })
    it('should set p inside $or / $and with element indexes', function() {
        let ir = cvFind({ $or: [{ a: 1 }, { age: { $gt: 2 } }] })
        assert.deepStrictEqual(ir, N({
            t: 'or',
            a: [
                N({ t: 'cmp', c: 'a', op: 'eq', v: 1, p: 'find.$or[0].a' }),
                N({ t: 'cmp', c: 'age', op: 'gt', v: 2, p: 'find.$or[1].age.$gt' }),
            ],
        }))
        assert.strictEqual(cvFind({ $and: [{ x: null }] }).p, 'find.$and[0].x') //單項展開後仍保留原路徑
    })
    it('should keep the full path through flattened and nested groups', function() {
        let ir = cvFind({ $or: [{ $and: [{ a: 1 }, { b: { $lt: 2 } }] }, { $or: [{ c: 3 }, { d: { $nin: [4] } }] }] })
        assert.strictEqual(ir.t, 'or')
        assert.strictEqual(ir.a.length, 3) //內層 $or 已攤平
        assert.strictEqual(ir.a[0].t, 'and')
        assert.strictEqual(ir.a[0].a[0].p, 'find.$or[0].$and[0].a')
        assert.strictEqual(ir.a[0].a[1].p, 'find.$or[0].$and[1].b.$lt')
        assert.strictEqual(ir.a[1].p, 'find.$or[1].$or[0].c')
        assert.strictEqual(ir.a[2].p, 'find.$or[1].$or[1].d.$nin')
    })
    it('should set one p per operator of the same column, in key order', function() {
        let ir = cvFind({ v: { $gte: 1, $lt: 5 }, w: 2 })
        assert.deepStrictEqual(ir, N({
            t: 'and',
            a: [
                N({ t: 'cmp', c: 'v', op: 'gte', v: 1, p: 'find.v.$gte' }),
                N({ t: 'cmp', c: 'v', op: 'lt', v: 5, p: 'find.v.$lt' }),
                N({ t: 'cmp', c: 'w', op: 'eq', v: 2, p: 'find.w' }),
            ],
        }))
    })
    it('should return null (no condition) for undefined and {}', function() {
        assert.strictEqual(cvFind(), null)
        assert.strictEqual(cvFind(undefined), null)
        assert.strictEqual(cvFind({}), null)
    })
})


describe('cvFind: features removed by the series whitelist now throw invalid find (R11, S9 S14; previously accepted)', function() {
    let removed = [
        ['$equals', { name: { $equals: 'aa' } }],
        ['$equals null', { name: { $equals: null } }],
        ['$like', { name: { $like: 'a%' } }],
        ['$ilike', { name: { $ilike: 'A_' } }],
        ['$null true', { tag: { $null: true } }],
        ['$null false', { tag: { $null: false } }],
        ['$notNull true', { tag: { $notNull: true } }],
        ['$notNull false', { tag: { $notNull: false } }],
        ['$not scalar', { name: { $not: 'aa' } }],
        ['$not true', { ok: { $not: true } }],
        ['$not operator object', { value: { $not: { $gt: 5, $lt: 9 } } }],
        ['$not $not', { value: { $not: { $not: { $gt: 5 } } } }],
        ['$not $in', { name: { $not: { $in: ['aa', 'bb'] } } }],
        ['$in with null', { tag: { $in: ['x', null] } }],
        ['$in [null]', { tag: { $in: [null] } }],
        ['$nin [null]', { tag: { $nin: [null] } }],
        ['$or with $in null', { $or: [{ tag: { $in: ['x', null] } }, { name: 'aa' }] }],
        ['eq bigint', { time: 3n }],
        ['$gt bigint', { time: { $gt: 3n } }],
        ['$in bigint', { time: { $in: [3n] } }],
        ['eq Buffer', { bin: Buffer.from('ab') }],
        ['$in Buffer', { bin: { $in: [Buffer.from('ab')] } }],
        ['$and with {} element', { $and: [{ name: 'aa' }, {}] }],
        ['$and with {} first', { $and: [{}, { name: 'aa' }, { value: 1 }] }],
        ['JSON path ->>', { 'js->>k': '1' }],
        ['JSON path ->', { 'js->k': '1' }],
        ['JSON path #>>', { 'js#>>k': '1' }],
        ['JSON path #>', { 'js#>k': '1' }],
        ['JSON path multi', { 'js->a->>b': 'x' }],
        ['JSON path array index', { 'js->>0': 'x' }],
        ['JSON path with $nin', { 'js->>k': { $nin: ['a', 'b'] } }],
        ['JSON path with unicode part', { 'js->>中文': 'x' }],
        ['cast', { 'value::text': '5' }],
        ['cast with operator', { 'ts::date': { $gte: '2020-01-01' } }],
        ['$or with 1001 elements', { $or: Array.from({ length: 1001 }, (_, i) => ({ value: i })) }],
        ['$and with 1001 elements', { $and: Array.from({ length: 1001 }, (_, i) => ({ value: i })) }],
        ['$in with 10001 elements', { value: { $in: range(10001) } }],
        ['$nin with 10001 elements', { value: { $nin: range(10001) } }],
        ['column of 129 chars', { ['c'.repeat(129)]: 1 }],
        ['top Map with null prototype', Object.setPrototypeOf(new Map([['name', 'aa']]), null)],
        ['top empty Proxy', new Proxy({}, {})],
    ]
    removed.forEach(([label, f]) => {
        it(`should throw invalid find for ${label}`, function() {
            throwsFind(f)
        })
    })
    it('should accept the limits exactly: $or / $and with 1000 elements, $in / $nin with 10000 elements, columns of 63 bytes', function() {
        assert.strictEqual(buildSelect('t', cvFind({ $or: Array.from({ length: 1000 }, (_, i) => ({ value: i })) })).values.length, 1000)
        assert.strictEqual(buildSelect('t', cvFind({ $and: Array.from({ length: 1000 }, (_, i) => ({ value: i })) })).values.length, 1000)
        assert.strictEqual(buildSelect('t', cvFind({ value: { $in: range(10000) } })).values.length, 10000)
        assert.strictEqual(buildSelect('t', cvFind({ value: { $nin: range(10000) } })).values.length, 10000)
        expectSql({ ['c'.repeat(63)]: 1 }, ` where "${'c'.repeat(63)}" = $1`, [1])
    })
    it('should keep the same message format and carry the path for removed features', function() {
        throwsFind({ name: { $like: 'a%' } }, /^invalid find: unsupported operator \[\$like\] at \[find\.name\.\$like\]$/)
        throwsFind({ 'js->>k': 1 }, /^invalid find: unsupported column name .* at \[find\.js->>k\]$/)
        throwsFind({ time: 3n }, /^invalid find: unsupported value type .* at \[find\.time\]$/)
        throwsFind({ tag: { $in: [null] } }, /^invalid find: null is not allowed here at \[find\.tag\.\$in\[0\]\]$/)
    })
})


describe('cvFind: pg column name rules (system columns, 63 bytes, Infinity)', function() {
    ;['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax'].forEach((c) => {
        it(`should reject the system column ${c} in find with the exact message`, function() {
            assert.strictEqual(msgOf(() => cvFind({ [c]: 1 })), `invalid find: unsupported column name [${c}] at [find.${c}]`)
            assert.strictEqual(msgOf(() => cvFind({ $or: [{ a: 1 }, { [c]: { $gt: 1 } }] })), `invalid find: unsupported column name [${c}] at [find.$or[1].${c}]`)
        })
    })
    it('should accept 63-byte column names and reject 64-byte ones (ASCII and multibyte)', function() {
        assert.doesNotThrow(() => cvFind({ ['c'.repeat(63)]: 1 }))
        assert.doesNotThrow(() => cvFind({ ['中'.repeat(21)]: 1 })) //63 bytes
        assert.strictEqual(msgOf(() => cvFind({ ['c'.repeat(64)]: 1 })), `invalid find: column name is too long (> 63 bytes) at [find.${'c'.repeat(30)}...]`)
        throwsFind({ ['中'.repeat(22)]: 1 }, /^invalid find: column name is too long \(> 63 bytes\) at /)
    })
    it('should accept Infinity and oid as ordinary column names', function() {
        assert.deepStrictEqual(cvFind({ Infinity: 1 }), N({ t: 'cmp', c: 'Infinity', op: 'eq', v: 1, p: 'find.Infinity' }))
        assert.deepStrictEqual(cvFind({ oid: { $ne: 2 } }), N({ t: 'cmp', c: 'oid', op: 'ne', v: 2, p: 'find.oid.$ne' }))
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
        ['$in 65536 elements', { a: { $in: range(65536) } }],
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
        ['$..$ in $not', { a: { $not: '$x$' } }],
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
        ['system column ctid', { ctid: '(0,1)' }],
        ['system column xmin inside $and', { $and: [{ a: 1 }, { xmin: { $gt: 1 } }] }],
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
        let ir = cvFind(nest(32)) //S2 上限
        assert.strictEqual(ir.p, `find${'.$and[0]'.repeat(32)}.a`) //單項 $and 逐層展開
        throwsFind(nest(33), /nesting is too deep/)
    })

    it('should throw for a deep $not chain (the operator itself is no longer in the whitelist)', function() {
        let f = { $gt: 1 }
        for (let i = 0; i < 40; i++) {
            f = { $not: f }
        }
        throwsFind({ a: f }, /unsupported operator \[\$not\]/)
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

    it('should throw when total bound parameters exceed 65535 (pg-specific, 7 arrays of 10000) while 6 arrays of 10000 plus 5535 are accepted', function() {
        let a = range(10000)
        throwsFind(cols(7, a), /too many bound parameters/)
        assert.strictEqual(buildSelect('t', cvFind({ ...cols(6, a), y: { $in: range(5535) } })).values.length, 65535) //剛好 65535
        throwsFind({ ...cols(6, a), y: { $in: range(5536) } }, /^invalid find: too many bound parameters \(> 65535\) at \[find\.y\.\$in\[5535\]\]$/)
        throwsFind({ x: { $in: range(40000) } }, /array is too large/) //共用層上限 10000 先於綁定參數上限
    })

    it('should keep the shared node limit of 100000 (not lowered by this package): about 91000 nodes are accepted, about 111000 are rejected', function() {
        //布林與 null 不佔綁定參數, 故只受節點上限約束; 1000 個文件(每個一個節點)各含 per 個欄位條件
        let mk = (per) => ({ $or: Array.from({ length: 1000 }, () => Object.fromEntries(Array.from({ length: per }, (_, j) => [`c${j}`, j % 2 === 0 ? null : true]))) })
        assert.doesNotThrow(() => cvFind(mk(90)))
        throwsFind(mk(110), /condition is too large/)
    })

    it('should count a $..$ string once (equality, $eq, $ne, $gt and $in each send exactly one bound parameter), at the 65535 / 65536 boundary', function() {
        let a = range(10000)
        let rest = range(5534)
        let mkf = (s) => ({ ...cols(6, a), y: { $in: rest }, ...s }) //60000 + 5534 + 1 = 65535
        let ss = [{ s: '$x$' }, { s: { $eq: '$x$' } }, { s: { $ne: '$x$' } }, { s: { $gt: '$x$' } }, { s: { $in: ['$x$'] } }, { s: 'plain' }]
        ss.forEach((s) => {
            let r = buildSelect('t', cvFind(mkf(s)))
            assert.strictEqual(r.values.length, 65535, `sent parameters for ${JSON.stringify(s)}`) //計數與實際送出之參數個數一致
            assert.strictEqual(r.values[65534], Object.values(s)[0] === 'plain' ? 'plain' : '$x$') //最後一個參數即該字面值
        })
        ss.forEach((s) => {
            throwsFind({ ...cols(6, a), y: { $in: [...rest, 1] }, ...s }, /too many bound parameters/) //65536
        })
    })

    it('should send exactly the contract count of bound parameters: cmp 1, each $in/$nin element 1, bool / null / empty $in 0', function() {
        let mixed = { a: true, b: false, c: null, d: { $eq: true }, e: { $ne: false }, f: { $ne: null }, g: { $eq: null }, h: { $gt: false }, i: 'x', j: 5, k: new Date(0), l: { $gt: 1, $lte: 9 }, m: { $in: [true, false, 1] }, n: '$a$', o: { $nin: ['$b$'] }, p: { $ne: true }, q: { $in: [] } }
        let r = sel(mixed)
        //i1 j1 k1 l2 m3 n1 o1 = 10; a b c d e f g h p q 皆不佔參數
        assert.strictEqual(r.query, `${S} where "a" IS TRUE and "b" IS FALSE and "c" is null and "d" IS TRUE and "e" IS TRUE and "f" is not null and "g" is null and "h" > FALSE` +
            ' and "i" = $1 and "j" = $2 and "k" = $3 and "l" > $4 and "l" <= $5 and "m" in ($6, $7, $8) and "n" = $9 and "o" not in ($10) and "p" IS FALSE and false')
        assert.deepStrictEqual(r.values, ['x', 5, new Date(0), 1, 9, true, false, 1, '$a$', '$b$'])
        let base = r.values.length
        let fill = (n) => ({ ...mixed, ...cols(6, range(10000)), y: { $in: range(n) } })
        let room = 65535 - 60000 - base
        assert.strictEqual(buildSelect('t', cvFind(fill(room))).values.length, 65535) //實際送出剛好 65535: 計數器恰好放行
        throwsFind(fill(room + 1), /too many bound parameters/) //65536: 計數器恰好拒收
        //僅布林與 null(皆不佔參數)再多也不超限
        let flags = { $or: Array.from({ length: 1000 }, (_, i) => ({ [`c${i}`]: i % 2 === 0 ? null : true })) }
        assert.strictEqual(sel(flags).values.length, 0)
    })

    it('should send the same number of bound parameters as it counts for several $..$ strings and mixed operators', function() {
        let f = { a: '$a$', b: { $eq: '$b$' }, c: { $ne: '$c$' }, d: { $in: ['$d$', 'x'] }, e: 1, g: { $gt: 2, $lt: 5 }, h: true, i: null }
        let r = sel(f)
        //a b c: 各 1; d: 2; e: 1; g: 2; h: 布林不佔參數; i: null 不佔參數
        assert.deepStrictEqual(r.values, ['$a$', '$b$', '$c$', '$d$', 'x', 1, 2, 5])
    })

    it('should not let a numeric-index setter on Array.prototype swallow the checked copy (elements are defined, never assigned)', function() {
        let n = 0
        let d = Object.getOwnPropertyDescriptor(Array.prototype, '0')
        let fs = [
            { $and: [{ s: 'aa' }, { t: 1 }] },
            { $or: [{ s: 'aa' }, { t: 1 }] },
            { s: { $in: ['aa', 'bb'] } },
            { s: { $nin: ['aa'] } },
            { ok: { $eq: false, $ne: true } },
            { s: { $eq: '$x$', $in: ['a'] } },
            { $and: [{ s: 1 }], ok: { $eq: true, $ne: true } },
        ]
        let outs = Object.create(null) //視窗內不碰陣列之索引指派(本測試自己的程式碼也會被 setter 影響)
        Object.defineProperty(Array.prototype, '0', {
            configurable: true,
            get() {
                return undefined
            },
            set() {
                n += 1 //吞掉指派
            }
        })
        try {
            for (let i = 0; i < fs.length; i++) {
                outs[i] = cvFind(fs[i])
            }
        }
        finally {
            if (d) {
                Object.defineProperty(Array.prototype, '0', d)
            }
            else {
                delete Array.prototype[0]
            }
        }
        assert.strictEqual(n, 0, 'cvFind must not assign array indexes')
        let q = (ir) => buildSelect('t', ir)
        assert.strictEqual(q(outs[0]).query, `${S} where "s" = $1 and "t" = $2`)
        assert.strictEqual(q(outs[1]).query, `${S} where ("s" = $1 or "t" = $2)`)
        assert.deepStrictEqual(outs[2].vs, ['aa', 'bb'])
        assert.deepStrictEqual(outs[3].vs, ['aa'])
        assert.strictEqual(q(outs[4]).query, `${S} where "ok" IS FALSE and "ok" IS FALSE`)
        assert.strictEqual(q(outs[5]).query, `${S} where "s" = $1 and "s" in ($2)`)
        assert.deepStrictEqual(q(outs[5]).values, ['$x$', 'a'])
        assert.strictEqual(q(outs[6]).query, `${S} where "s" = $1 and "ok" IS TRUE and "ok" IS FALSE`)
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
        assert.strictEqual(nf.t, 'cmp')
        assert.strictEqual(Date.prototype.getTime.call(nf.v), 1)
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
        let e = msgOf(() => cvFind(f))
        assert.ok(e && e.length < 400, e && e.length)
        let e2 = msgOf(() => cvFind({ 'a\nb\u0000': 1 }))
        assert.ok(e2 && !/[\u0000-\u001f]/.test(e2), JSON.stringify(e2))
        let e3 = msgOf(() => cvFind({ ['$' + 'k'.repeat(1000000)]: 1 }))
        assert.ok(e3 && e3.length < 400)
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
    it('should accept undefined and {} as no condition (no where clause in select and delete)', function() {
        ;[undefined, {}].forEach((f) => {
            assert.strictEqual(cvFind(f), null)
            expectSql(f, '', [])
        })
    })
    it('should still accept arrays only as the $and/$or list', function() {
        expectSql({ $and: [{ name: 'aa' }, { value: { $gt: 2 } }] }, ' where "name" = $1 and "value" > $2', ['aa', 2])
    })
})


describe('cvFind: output is a fresh null-prototype copy that is immune to the caller (R1, S10)', function() {
    //walk: 走訪 IR 每個節點, 節點須為 null 原型, 清單(a、vs)須為真陣列
    let walk = (n, out = []) => {
        out.push(n)
        if (n.a !== undefined) {
            assert.ok(Array.isArray(n.a))
            n.a.forEach((x) => walk(x, out))
        }
        if (n.vs !== undefined) {
            assert.ok(Array.isArray(n.vs))
        }
        return out
    }

    it('should not modify the input and should return new null-prototype nodes of every type', function() {
        let inner = { $gt: 1 }
        let list = [{ a: 1 }, { b: inner }, { ok: true }, { tag: null }]
        let f = Object.freeze({ $or: Object.freeze(list), c: Object.freeze({ $in: Object.freeze([1, 2]) }) })
        let before = JSON.stringify(f)
        let nf = cvFind(f)
        assert.strictEqual(JSON.stringify(f), before)
        let nodes = walk(nf)
        assert.deepStrictEqual(nodes.map((x) => x.t), ['and', 'or', 'cmp', 'cmp', 'bool', 'null', 'in'])
        nodes.forEach((x) => assert.strictEqual(Object.getPrototypeOf(x), null, x.t))
        assert.notStrictEqual(nodes[6].vs, f.c.$in)
    })

    it('should not be affected by later changes of the caller objects', function() {
        let inner = { $gt: 1 }
        let arr = [1, 2]
        let list = [{ a: 1 }, { b: inner }]
        let f = { $or: list, c: { $in: arr } }
        let nf = cvFind(f)
        inner.$gt = 99
        arr.push(3)
        list.push({ z: 1 })
        f.d = 5
        let r = buildSelect('t', nf)
        assert.strictEqual(r.query, `${S} where ("a" = $1 or "b" > $2) and "c" in ($3, $4)`)
        assert.deepStrictEqual(r.values, [1, 1, 1, 2])
    })

    it('should copy Date values (a new Date, unaffected by later changes of the original), in $in as well', function() {
        let d = new Date(5)
        let e = new Date(6)
        let nf = cvFind({ d, x: { $in: [e] } })
        assert.notStrictEqual(nf.a[0].v, d)
        assert.notStrictEqual(nf.a[1].vs[0], e)
        d.setTime(99) //改原 Date 不影響複本
        e.setTime(98)
        let r = buildSelect('t', nf)
        assert.strictEqual(r.query, `${S} where "d" = $1 and "x" in ($2)`)
        assert.deepStrictEqual(r.values.map((x) => x.getTime()), [5, 6])
    })

    it('should reject Buffer values (a series whitelist scalar is string, finite number, boolean, valid Date), also views and Buffers with overridden members', function() {
        let n = 0
        let b = Buffer.from('AAAA')
        b.valueOf = () => (++n === 1 ? 'first' : 'second')
        Object.defineProperty(b, 'length', {
            get() {
                n += 100
                return 2
            }
        })
        throwsFind({ bin: b })
        throwsFind({ bin: Buffer.from('xxABCDyy').subarray(2, 6) })
        throwsFind({ bin: { $in: [Buffer.from('ab')] } })
        assert.strictEqual(n, 0) //沒有呼叫呼叫端自有之 valueOf / length
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
        assert.strictEqual(nf.a[0].v, 1)
        assert.strictEqual(nf.a[1].v, 2)
        assert.strictEqual(counts.a, 1)
        assert.strictEqual(counts.b, 1)
        assert.deepStrictEqual(gets.filter((k) => typeof k === 'string'), []) //不經 get trap 讀資料屬性(僅 Object.prototype.toString 讀 Symbol.toStringTag)
    })

    it('should be immune to Object.prototype pollution of operator-like and column-like names', function() {
        Object.prototype.$custom = { value: 'true or 1=1 /*polluted*/', values: [] }
        Object.prototype.zzpolluted = 'asc; drop table t; --'
        let nf
        let no
        try {
            nf = cvFind({ a: 1, $and: [{ b: 2 }, { c: { $gt: 3 } }], d: { $in: [1, 2] } })
            no = cvOrder({ time: 'asc' })
        }
        finally {
            delete Object.prototype.$custom
            delete Object.prototype.zzpolluted
        }
        let s = buildDelete('t', nf)
        assert.strictEqual(s.query, `${D} where "a" = $1 and "b" = $2 and "c" > $3 and "d" in ($4, $5)`)
        assert.deepStrictEqual(s.values, [1, 2, 3, 1, 2])
        let s2 = buildSelect('t', nf, no)
        assert.strictEqual(s2.query, `${S} where "a" = $1 and "b" = $2 and "c" > $3 and "d" in ($4, $5) order by "time" asc`)
    })

    it('should be immune to Array.prototype pollution of indexes used by $and/$or lists', function() {
        let saved = Object.getOwnPropertyDescriptor(Array.prototype, '5')
        Array.prototype[5] = { a: 'polluted' }
        let nf
        try {
            nf = cvFind({ $or: [{ b: 1 }, { c: 2 }] })
        }
        finally {
            delete Array.prototype[5]
            if (saved) {
                Object.defineProperty(Array.prototype, '5', saved)
            }
        }
        let s = buildDelete('t', nf)
        assert.strictEqual(s.query, `${D} where ("b" = $1 or "c" = $2)`)
        assert.deepStrictEqual(s.values, [1, 2])
    })
})


describe('cvFind / cvColumn: keys', function() {
    it('should accept identifier-like keys including unicode letters up to 63 bytes', function() {
        expectSql({ Name: 1, name_2: 2, _x: 3 }, ' where "Name" = $1 and "name_2" = $2 and "_x" = $3', [1, 2, 3])
        expectSql({ 'á': 2, '中文': 1 }, ' where "á" = $1 and "中文" = $2', [2, 1]) //字母後接組合附加符號(\p{M})為識別字之一部分
    })
    it('should reject every JSON path key in find, also with unicode or combining parts', function() {
        throwsFind({ 'js->>中文': 'x', 'js->a->>名稱': 'y' })
        throwsFind({ 'js->>1中': 1 })
        throwsFind({ 'js->>٣': 1 }) //非 ASCII 數字開頭
        throwsFind({ 'js->>́a': 1 }) //組合附加符號不可作首字元
        throwsFind({ 'js->>á': 1 })
    })
    it('should expose cvColumn for write paths: bare identifiers only (system columns rejected, Infinity and oid accepted)', function() {
        ;['name', '中文', 'Infinity', 'oid', 'c'.repeat(63)].forEach((k) => {
            assert.doesNotThrow(() => cvColumn(k), `cvColumn(${JSON.stringify(k)})`)
        })
        ;['', '$inc', 'a.b', 'a"b', 'a b', 'a->b', 'a::int', '1a', '__proto__', 'c'.repeat(64), 'a;b', 'ctid', 'xmax'].forEach((k) => {
            assert.throws(() => cvColumn(k), /unsupported column name|too long/, `cvColumn(${JSON.stringify(k)})`)
        })
        assert.throws(() => cvColumn('tableoid'), (e) => e.message === 'unsupported column name [tableoid]')
        assert.throws(() => cvColumn('c'.repeat(64)), (e) => e.message === 'column name is too long (> 63 bytes)')
    })
})


describe('cvOrder (S7, S14)', function() {
    it('should accept undefined, null and {} as no order', function() {
        ;[undefined, null, {}].forEach((o) => {
            let r = cvOrder(o)
            assert.ok(Array.isArray(r))
            assert.strictEqual(r.length, 0)
        })
        assert.strictEqual(buildSelect('t', null, cvOrder({})).query, S)
    })
    it('should return an ordered array of null-prototype {c, dir, nulls} items (dir lower-cased, nulls null or first/last)', function() {
        let o = cvOrder({ a: 'asc', b: 'DESC', c: 'desc nulls last', d: 'Asc  NULLS   FIRST' })
        assert.ok(Array.isArray(o))
        assert.deepStrictEqual(o, [
            N({ c: 'a', dir: 'asc', nulls: null }),
            N({ c: 'b', dir: 'desc', nulls: null }),
            N({ c: 'c', dir: 'desc', nulls: 'last' }),
            N({ c: 'd', dir: 'asc', nulls: 'first' }),
        ])
        o.forEach((x) => {
            assert.strictEqual(Object.getPrototypeOf(x), null)
            assert.deepStrictEqual(Object.keys(x), ['c', 'dir', 'nulls']) //無 path、cast
        })
    })
    it('should give the hand-written order by clause, after the where clause', function() {
        assert.strictEqual(sel(undefined, { name: 'desc nulls last', a: 'ASC', b: 'desc', c: 'asc nulls first' }).query, `${S} order by "name" desc nulls last, "a" asc, "b" desc, "c" asc nulls first`)
        let r = sel({ value: { $gt: 2 } }, { value: 'desc' })
        assert.strictEqual(r.query, `${S} where "value" > $1 order by "value" desc`)
        assert.deepStrictEqual(r.values, [2])
    })
    it('should accept Infinity, oid and 63-byte keys', function() {
        assert.deepStrictEqual(cvOrder({ Infinity: 'asc', oid: 'desc' }), [N({ c: 'Infinity', dir: 'asc', nulls: null }), N({ c: 'oid', dir: 'desc', nulls: null })])
        assert.strictEqual(cvOrder({ ['c'.repeat(63)]: 'asc' })[0].c, 'c'.repeat(63))
        assert.strictEqual(cvOrder({ ['中'.repeat(21)]: 'asc' }).length, 1)
    })
    ;['js->>k', 'js->k', 'js#>k', 'js#>>k', 'ts::date', 'js->a->>b'].forEach((k) => {
        it(`should reject the JSON-path / cast key ${k} (order keys are identifiers only, like find)`, function() {
            assert.strictEqual(msgOf(() => cvOrder({ [k]: 'asc' })), `invalid order: unsupported column name [${k}] at [order.${k}]`)
        })
    })
    ;['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax'].forEach((c) => {
        it(`should reject the system column ${c} in order`, function() {
            assert.strictEqual(msgOf(() => cvOrder({ a: 'asc', [c]: 'desc' })), `invalid order: unsupported column name [${c}] at [order.${c}]`)
        })
    })
    it('should reject keys longer than 63 bytes', function() {
        assert.strictEqual(msgOf(() => cvOrder({ ['c'.repeat(64)]: 'asc' })), `invalid order: column name is too long (> 63 bytes) at [order.${'c'.repeat(30)}...]`)
        assert.ok(/^invalid order: column name is too long \(> 63 bytes\) at /.test(msgOf(() => cvOrder({ ['中'.repeat(22)]: 'asc' }))))
    })
    let bads = [
        ['injection', { a: 'asc; delete from t' }],
        ['subquery', { a: 'asc, (select 1)' }],
        ['comment', { a: 'asc --' }],
        ['empty string', { a: '' }],
        ['nulls without first/last', { a: 'asc nulls' }],
        ['nulls only', { a: 'nulls first' }],
        ['number 1', { a: 1 }],
        ['number -1', { a: -1 }],
        ['undefined', { a: undefined }],
        ['null', { a: null }],
        ['boolean', { a: true }],
        ['injection in key', { 'a) desc, (select 1': 'asc' }],
        ['key with space', { 'a b': 'asc' }],
        ['key with dot', { 'a.b': 'asc' }],
        ['key with double quote', { 'a"b': 'asc' }],
        ['operator key', { $a: 'asc' }],
        ['empty key', { '': 'asc' }],
        ['__proto__ key', JSON.parse('{"__proto__":"asc"}')],
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
        let o
        try {
            o = cvOrder({ a: 'asc' })
        }
        finally {
            delete Object.prototype.zzo
        }
        assert.deepStrictEqual(o, [N({ c: 'a', dir: 'asc', nulls: null })])
        assert.strictEqual(buildSelect('t', null, o).query, `${S} order by "a" asc`)
    })
})


describe('cvKey: cache keys distinguish values that JSON.stringify would merge (S8)', function() {
    let k = (f, o = {}) => cvKey(cvFind(f), cvOrder(o))
    it('should be stable for equal input and differ for different values, columns, operators and order', function() {
        assert.strictEqual(k({ a: 1 }), k({ a: 1 }))
        assert.notStrictEqual(k({ a: 1 }), k({ a: 1 }, { a: 'asc' }))
        assert.notStrictEqual(k({ a: 1 }, { a: 'asc' }), k({ a: 1 }, { a: 'desc' }))
        assert.notStrictEqual(k({ a: 1 }, { a: 'asc' }), k({ a: 1 }, { a: 'asc nulls first' }))
        assert.notStrictEqual(k({ a: 1 }), k({ a: 2 }))
        assert.notStrictEqual(k({ a: 1 }), k({ b: 1 }))
        assert.notStrictEqual(k({ a: 1 }), k({ a: { $ne: 1 } }))
        assert.notStrictEqual(k({ a: 1 }), k({ a: { $gt: 1 } }))
        assert.notStrictEqual(k({ $and: [{ a: 1 }, { b: 2 }] }), k({ $or: [{ a: 1 }, { b: 2 }] }))
        assert.notStrictEqual(k({ a: { $in: [1] } }), k({ a: { $nin: [1] } }))
        assert.notStrictEqual(k({ a: null }), k({ a: { $ne: null } }))
    })
    it('should ignore the source path p of IR leaves', function() {
        assert.strictEqual(k({ a: 1 }), k({ $and: [{ a: 1 }] })) //p: find.a vs find.$and[0].a
        assert.strictEqual(k({ a: 1 }), k({ $or: [{ a: 1 }] }))
        assert.strictEqual(k({ a: { $eq: 1 } }), k({ a: 1 })) //p: find.a.$eq vs find.a; IR 相同
        assert.strictEqual(k({ ok: { $eq: true } }), k({ ok: true }))
        assert.strictEqual(k({ tag: { $eq: null } }), k({ tag: null }))
        assert.notStrictEqual(k({ ok: { $ne: true } }), k({ ok: { $ne: false } }))
    })
    it('should give the same key for selectByPk-style eqNode and the normalized select find', function() {
        let d = new Date(7)
        assert.strictEqual(cvKey(eqNode('a', 1), []), k({ a: 1 }))
        assert.strictEqual(cvKey(eqNode('time', d), []), k({ time: new Date(7) }))
        assert.strictEqual(cvKey(eqNode('time', 'x'), []), k({ $and: [{ time: { $eq: 'x' } }] }))
        assert.strictEqual(cvKey(eqNode('ok', true), []), k({ ok: { $eq: true } }))
        assert.notStrictEqual(cvKey(eqNode('a', 1), []), k({ a: '1' }))
    })
    it('should distinguish Date from its ISO string and Date values from each other', function() {
        let d = new Date('2020-01-01T00:00:00.000Z')
        assert.notStrictEqual(k({ a: d }), k({ a: d.toISOString() }))
        assert.notStrictEqual(k({ a: new Date(1) }), k({ a: new Date(2) }))
        assert.notStrictEqual(k({ a: { $in: [new Date(1)] } }), k({ a: { $in: [new Date(1).toISOString()] } }))
    })
    //find 路徑已不可能含 bigint、Buffer、非有限數值: 直接以手造 IR 葉節點呼叫 cvKey 驗證其區分能力
    let kr = (v) => cvKey(N({ t: 'cmp', c: 'a', op: 'eq', v, p: 'find.a' }), [])
    it('should still distinguish bigint from number and string, Buffer from its hex string when cvKey is called directly', function() {
        assert.notStrictEqual(kr(3n), kr(3))
        assert.notStrictEqual(kr(3n), kr('3'))
        assert.notStrictEqual(kr(Buffer.from('ab')), kr('6162'))
        assert.notStrictEqual(kr(Buffer.from('ab')), kr(Buffer.from('ac')))
    })
    it('should distinguish null from other falsy values and the elements of $in lists', function() {
        assert.notStrictEqual(k({ a: null }), k({ a: 0 }))
        assert.notStrictEqual(k({ a: null }), k({ a: '' }))
        assert.notStrictEqual(k({ a: 0 }), k({ a: false }))
        assert.notStrictEqual(k({ a: { $in: [1] } }), k({ a: { $in: [] } }))
        assert.notStrictEqual(k({ a: { $in: [1, 2] } }), k({ a: { $in: [2, 1] } }))
        assert.notStrictEqual(k({ a: { $in: [1] } }), k({ a: { $in: ['1'] } }))
    })
    it('should not throw for bigint values (JSON.stringify would) when cvKey is called directly', function() {
        assert.doesNotThrow(() => cvKey(N({ t: 'in', c: 'a', vs: [1n, 2n], not: false, p: 'find.a.$in' }), []))
    })
    it('should give a distinct cache key for NaN and Infinity (JSON.stringify would merge them with null)', function() {
        assert.notStrictEqual(kr(Infinity), cvKey(N({ t: 'null', c: 'a', not: false, p: 'find.a' }), []))
        assert.notStrictEqual(kr(Infinity), kr(null))
        assert.notStrictEqual(kr(NaN), kr(null))
        assert.notStrictEqual(kr(Infinity), kr(-Infinity))
        assert.notStrictEqual(kr(NaN), kr(Infinity))
    })
})


describe('cvFind: re-entrancy, hostile hooks and options (R1)', function() {
    it('should keep counting bound parameters of the outer call when a trap calls cvFind re-entrantly', function() {
        let a = range(10000)
        let y = new Proxy({ $in: a }, {
            getOwnPropertyDescriptor(t, k) {
                cvFind({ z: 1 }) //可重入: 內層呼叫不得重置外層之預算
                return Reflect.getOwnPropertyDescriptor(t, k)
            },
        })
        let f = { y }
        for (let i = 0; i < 6; i++) {
            f[`x${i}`] = { $in: a }
        }
        throwsFind(f, /too many bound parameters/) //7 x 10000 > 65535
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
        let a = range(10000)
        assert.doesNotThrow(() => cvFind(cols(6, a)))
        assert.throws(() => cvFind(cols(7, a)))
        assert.strictEqual(buildSelect('t', cvFind(cols(6, a))).values.length, 60000)
        assert.throws(() => cvFind({ ctid: 1 }))
        assert.deepStrictEqual(cvFind({ a: { $nin: ['x'] } }), N({ t: 'in', c: 'a', vs: ['x'], not: true, p: 'find.a.$nin' }))
    })
})


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
        })
        throwsFind({
            a: {
                get [Symbol.toStringTag]() {
                    throw null
                }
            }
        })
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
        let a = sel({ $and: withLength([{ name: 'aa' }, { n: 10 }], [2, 2, 1]) })
        assert.strictEqual(a.query, `${S} where "name" = $1 and "n" = $2`)
        assert.deepStrictEqual(a.values, ['aa', 10])
        let o = sel({ $or: withLength([{ name: 'aa' }, { n: 10 }], [2, 2, 1]) })
        assert.strictEqual(o.query, `${S} where ("name" = $1 or "n" = $2)`)
        let s = cvFind({ n: { $in: withLength([1, 2], [2, 2, 1]) } })
        assert.deepStrictEqual(s.vs, [1, 2])
    })
    it('should reject non-enumerable array elements like non-enumerable properties', function() {
        let arr = [{ name: 'aa' }]
        Object.defineProperty(arr, '0', { value: { name: 'aa' }, enumerable: false, configurable: true, writable: true })
        throwsFind({ $or: arr }, /non-enumerable element/)
        let arr2 = [1]
        Object.defineProperty(arr2, '0', { value: 1, enumerable: false, configurable: true, writable: true })
        throwsFind({ n: { $in: arr2 } }, /non-enumerable element/)
    })
    it('should reject a huge $and list at once (length limit 1000 comes before any element is read)', function() {
        let big = Array.from({ length: 150001 }, (_, i) => (i === 150000 ? { name: 'aa' } : {}))
        throwsFind({ $and: big }, /array is too large/)
    })
})


describe('chkOrmStr (wsemi, the single owner of the well-formed check): strings that change on the wire are not clean (pk values, Argon round 2)', function() {
    it('should accept ordinary strings, emoji pairs and U+FFFD itself', function() {
        assert.strictEqual(chkOrmStr('abc'), null)
        assert.strictEqual(chkOrmStr('中文'), null)
        assert.strictEqual(chkOrmStr('😀'), null) //成對代理
        assert.strictEqual(chkOrmStr('�'), null)
        assert.strictEqual(chkOrmStr('a$b'), null)
        assert.strictEqual(chkOrmStr('$x$'), null) //首尾皆 $ 亦為一般字串
    })
    it('should reject lone surrogates and NUL', function() {
        assert.strictEqual(chkOrmStr('\ud800'), 'string contains lone surrogate')
        assert.strictEqual(chkOrmStr('a\udc00b'), 'string contains lone surrogate')
        assert.strictEqual(chkOrmStr('\ude00\ud83d'), 'string contains lone surrogate')
        assert.strictEqual(chkOrmStr('a\u0000b'), 'string contains NUL')
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
        assert.ok(e instanceof Error)
        assert.notStrictEqual(e, mine)
        assert.ok(/^invalid find: .+ at \[.*\]$/.test(e.message), e.message)
        assert.ok(!/pretend/.test(e.message), `must not echo what the caller hook threw: ${e.message}`) //cvOrmFind 不轉述呼叫端之錯誤訊息
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
        let nf
        let no
        try {
            nf = cvFind({ a: 1, $or: [{ b: 2 }, { c: { $in: [1, 2] } }] })
            no = cvOrder({ time: 'asc' })
        }
        finally {
            delete Object.prototype.get
            delete Object.prototype.set
        }
        assert.strictEqual(nf.a[0].v, 1)
        assert.deepStrictEqual(nf.a[1].a[1].vs, [1, 2])
        assert.deepStrictEqual(no, [N({ c: 'time', dir: 'asc', nulls: null })])
        let r = buildSelect('t', nf, no)
        assert.strictEqual(r.query, `${S} where "a" = $1 and ("b" = $2 or "c" in ($3, $4)) order by "time" asc`)
        assert.deepStrictEqual(r.values, [1, 2, 1, 2])
    })
})
