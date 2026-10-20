/* eslint-disable no-extend-native -- 測試暫時於 Array.prototype 安裝數字索引 setter、於 Object.prototype 汙染屬性(finally 還原)驗證 IR 不受影響 */
import assert from 'assert'
import fs from 'fs'
import cvOrmFind from 'wsemi/src/cvOrmFind.mjs'
import cvCases from 'wsemi/src/_cvOrmFindCases.mjs'
import { lowerFind, eqNode } from '../src/lowerFind.mjs'
import { SEMANTICS, norm } from './tools/irSemantics.mjs'
import { buildSnapshots } from './tools/genIrSnapshots.mjs'


//lowerFind(cvOrmFind 複本 -> 方言中立 IR)之純函數測試(不連線, 不需 docker).
//規格句(帳本 R14 / L1–L9, 契約本文見 src/lowerFind.mjs 檔頭):
//  L1 { c: null } 與 $eq:null -> null 節點; $ne:null -> null not
//  L2 布林值 -> bool 節點(SQL 三值語意)
//  L3 $in:[] -> 恆假 in 節點, 不產生綁定參數
//  L4 單項 and/or 展開, 同型巢狀攤平(n 元)
//  L5 同欄多運算子與多欄鍵為隱含 AND
//  L6 綁定參數計數契約(cmp 1、in 每元素 1、bool/null/空 in 0)與 maxParams(必填, 核心不預設任何上限)
//  L7 checkColumn 掛鉤(方言專屬欄名檢核由呼叫端注入)
//  L8 零 import、不含任何資料庫/建構器專屬名稱(可整檔抽出為系列共用層)
//  L9 IR 為 null 原型, 陣列元素以 defineProperty 附加(不受 Array.prototype 數字索引 setter 影響)
//  L10 葉節點帶來源路徑 p(供後續映射遍回報 invalid find: 原因 at [路徑])

let lf = (find, opt = { maxParams: 65535 }) => lowerFind(cvOrmFind(find), opt)
let walk = (ir, fn) => {
    if (ir === null) {
        return
    }
    fn(ir)
    if (ir.t === 'and' || ir.t === 'or') {
        ir.a.forEach((x) => walk(x, fn))
    }
}
let LEAF = new Set(['cmp', 'bool', 'null', 'in'])
let SIX = new Set(['and', 'or', 'cmp', 'bool', 'null', 'in'])


describe('lowerFind: node semantics table (hand-written expectations, L1–L5 L10)', function() {
    SEMANTICS.forEach((s) => {
        it(`should lower [${s.id}] (${s.node}) to the expected IR`, function() {
            let ir = lf(s.find())
            assert.deepStrictEqual(norm(ir), s.ir)
        })
    })

    it('should cover every IR node type at least once in the table', function() {
        let seen = new Set()
        SEMANTICS.forEach((s) => walk(lf(s.find()), (n) => seen.add(n.t)))
        assert.deepStrictEqual([...seen].sort(), ['and', 'bool', 'cmp', 'in', 'null', 'or'])
    })
})


describe('lowerFind: IR shape invariants (L4 L9 L10)', function() {
    it('should return null (not an empty node) for no condition', function() {
        assert.strictEqual(lf({}), null)
        assert.strictEqual(lf(undefined), null)
    })

    it('should never produce an and/or node with fewer than 2 items', function() {
        let finds = [{ $or: [{ a: 1 }] }, { $and: [{ $or: [{ a: 1 }] }] }, { $or: [{ $and: [{ a: 1 }] }, { $and: [{ b: 2 }] }] }, { a: { $gt: 1, $lt: 5 }, $or: [{ b: 1 }] }, { $and: [{ a: 1 }, { $and: [{ b: 2 }] }] }]
        finds.forEach((f) => {
            walk(lf(f), (n) => {
                if (n.t === 'and' || n.t === 'or') {
                    assert.ok(n.a.length >= 2, JSON.stringify(f))
                    //同型子節點必已攤平
                    n.a.forEach((c) => assert.notStrictEqual(c.t, n.t, JSON.stringify(f)))
                }
            })
        })
    })

    it('should build only null-prototype nodes with plain dense arrays', function() {
        let ir = lf({ $or: [{ a: 1, b: { $in: [1, 2] } }, { c: { $nin: ['x'] } }] })
        walk(ir, (n) => {
            assert.strictEqual(Object.getPrototypeOf(n), null)
            assert.ok(SIX.has(n.t))
            if (n.t === 'and' || n.t === 'or') {
                assert.ok(Array.isArray(n.a))
                assert.deepStrictEqual(Object.keys(n.a), n.a.map((_, i) => String(i)))
            }
            if (n.t === 'in') {
                assert.ok(Array.isArray(n.vs))
                assert.strictEqual(Object.keys(n.vs).length, n.vs.length)
            }
        })
    })

    it('should give every leaf a string source path that starts with find (L10)', function() {
        let ir = lf({ a: 1, b: { $in: [1] }, $or: [{ c: null }, { d: true }, { e: { $ne: null } }] })
        let n = 0
        walk(ir, (x) => {
            if (LEAF.has(x.t)) {
                n += 1
                assert.strictEqual(typeof x.p, 'string')
                assert.ok(x.p.startsWith('find.'), x.p)
            }
            else {
                assert.strictEqual(x.p, undefined) //and/or 不帶 p
            }
        })
        assert.strictEqual(n, 5)
    })

    it('should lower every case of the shared wsemi table that cvOrmFind accepts into the six node types only', function() {
        let nOk = 0
        cvCases.cases.forEach((c) => {
            let copy = null
            try {
                copy = cvOrmFind(c.find())
            }
            catch (err) {
                return //共用層已拒收者不進 lowerFind
            }
            let ir = lowerFind(copy, { maxParams: Infinity })
            nOk += 1
            walk(ir, (x) => {
                assert.ok(SIX.has(x.t), `${c.id}: ${x.t}`)
                if (LEAF.has(x.t)) {
                    assert.strictEqual(typeof x.p, 'string', c.id)
                }
            })
        })
        assert.ok(nOk >= 70, `accepted cases: ${nOk}`) //案例表 OK/ALL 約 77 案
    })
})


describe('lowerFind: bound-parameter counting and opt.maxParams (L6)', function() {
    it('should require opt.maxParams and never default it to any dialect limit', function() {
        let copy = cvOrmFind({ a: 1 })
        let bad = [undefined, {}, { maxParams: 0 }, { maxParams: -1 }, { maxParams: NaN }, { maxParams: '5' }, { maxParams: null }, { checkColumn: () => '' }]
        bad.forEach((opt) => {
            assert.throws(() => lowerFind(copy, opt), /lowerFind: opt\.maxParams is required/, JSON.stringify(opt))
        })
    })

    it('should accept Infinity (no limit) and an inherited maxParams must not count', function() {
        let copy = cvOrmFind({ a: { $in: Array.from({ length: 5000 }, (_, i) => i) } })
        assert.strictEqual(lowerFind(copy, { maxParams: Infinity }).vs.length, 5000)
        Object.prototype.maxParams = 99999
        try {
            assert.throws(() => lowerFind(copy, {}), /maxParams is required/) //繼承值不算
        }
        finally {
            delete Object.prototype.maxParams
        }
    })

    it('should count 1 per cmp and 1 per in element, 0 per bool / null / empty in', function() {
        let count = (find) => {
            //找出恰不 throw 的最小 maxParams
            for (let m = 1; m < 200; m++) {
                try {
                    lf(find, { maxParams: m })
                    return m
                }
                catch (err) {
                    //繼續
                }
            }
            return -1
        }
        assert.strictEqual(count({ a: 1 }), 1)
        assert.strictEqual(count({ a: 1, b: 'x', c: { $gt: 5 } }), 3)
        assert.strictEqual(count({ a: { $in: [1, 2, 3, 4] } }), 4)
        assert.strictEqual(count({ a: { $nin: [true, false] } }), 2) //in 內布林為綁定參數
        assert.strictEqual(count({ a: true, b: { $ne: false }, c: null, d: { $ne: null }, e: { $in: [] } }), 1) //全為 0 個參數: maxParams 最小值 1 即通過
        assert.strictEqual(count({ a: true, b: 1, c: null, d: { $in: [1, 2] }, e: { $in: [] } }), 3) //b 1 + d 2
    })

    it('should reject exactly one parameter over the limit, with a path that points at the offending element', function() {
        assert.doesNotThrow(() => lf({ a: 1, b: { $in: [1, 2, 3] } }, { maxParams: 4 }))
        assert.throws(() => lf({ a: 1, b: { $in: [1, 2, 3] } }, { maxParams: 3 }), (err) => {
            assert.strictEqual(err.message, 'invalid find: too many bound parameters (> 3) at [find.b.$in[2]]')
            return true
        })
        assert.throws(() => lf({ a: 1, b: 2 }, { maxParams: 1 }), /^Error: invalid find: too many bound parameters \(> 1\) at \[find\.b\]$/)
    })
})


describe('lowerFind: opt.checkColumn hook (L7)', function() {
    it('should call the hook for every column key (not for $and/$or) and let it reject with its own reason', function() {
        let seen = []
        let hook = (c) => {
            seen.push(c)
            return c === 'bad' ? 'unsupported column name [bad]' : ''
        }
        lf({ a: 1, $or: [{ b: 2 }, { $and: [{ c: { $gt: 1 } }] }] }, { maxParams: 10, checkColumn: hook })
        assert.deepStrictEqual(seen.sort(), ['a', 'b', 'c'])
        assert.throws(() => lf({ a: 1, $or: [{ b: 2 }, { bad: 3 }] }, { maxParams: 10, checkColumn: hook }), (err) => {
            assert.strictEqual(err.message, 'invalid find: unsupported column name [bad] at [find.$or[1].bad]')
            return true
        })
    })

    it('should pass all columns when no hook is given or the hook is not a function; an inherited hook must not count', function() {
        assert.doesNotThrow(() => lf({ ctid: 1 }, { maxParams: 5 }))
        assert.doesNotThrow(() => lf({ ctid: 1 }, { maxParams: 5, checkColumn: 'nope' }))
        Object.prototype.checkColumn = () => 'rejected by pollution'
        try {
            assert.doesNotThrow(() => lf({ a: 1 }, { maxParams: 5 }))
        }
        finally {
            delete Object.prototype.checkColumn
        }
    })

    it('should not echo the value in any error', function() {
        assert.throws(() => lf({ a: { $in: ['SECRET-VALUE-1', 'SECRET-VALUE-2'] } }, { maxParams: 1 }), (err) => !/SECRET/.test(err.message))
    })
})


describe('eqNode: single-column equality IR for primary-key conditions', function() {
    it('should build cmp eq for string / number / Date / ±Infinity and bool eq for boolean', function() {
        let d = new Date(5)
        assert.deepStrictEqual(norm(eqNode('time', 'k1')), { t: 'cmp', c: 'time', op: 'eq', v: 'k1', p: 'find.time' })
        assert.deepStrictEqual(norm(eqNode('time', 7)), { t: 'cmp', c: 'time', op: 'eq', v: 7, p: 'find.time' })
        assert.deepStrictEqual(norm(eqNode('time', d)), { t: 'cmp', c: 'time', op: 'eq', v: { $date: 5 }, p: 'find.time' })
        assert.deepStrictEqual(norm(eqNode('time', true)), { t: 'bool', c: 'time', op: 'eq', v: true, p: 'find.time' })
        assert.strictEqual(eqNode('time', Infinity).v, Infinity) //float8 主鍵可有 Infinity, checkPk 接受
    })

    it('should equal the IR lowered from the same find (selectByPk shares the cache key with select)', function() {
        assert.deepStrictEqual(norm(eqNode('s', 'a')), norm(lf({ s: 'a' })))
        assert.deepStrictEqual(norm(eqNode('b', false)), norm(lf({ b: false })))
        assert.strictEqual(Object.getPrototypeOf(eqNode('s', 'a')), null)
    })
})


describe('lowerFind: immune to prototype pollution and index setters (L9)', function() {
    it('should produce the same IR while an Array.prototype numeric-index setter swallows index assignment', function() {
        let find = { a: 1, b: { $in: [1, 2, 3] }, $or: [{ c: 'x' }, { $and: [{ d: true }, { e: { $ne: null } }] }, { f: { $nin: [4, 5] } }] }
        let want = norm(lf(find))
        let copy = cvOrmFind(find) //複本先於汙染建立: 只驗 lowerFind 自身不以索引指派/push 建陣列
        let hits = 0
        for (let i = 0; i < 12; i++) {
            Object.defineProperty(Array.prototype, String(i), {
                configurable: true,
                get() {
                    return undefined
                },
                set() {
                    hits += 1 //被呼叫即代表有程式碼以索引指派寫入陣列
                },
            })
        }
        let got = null
        try {
            got = norm(lowerFind(copy, { maxParams: 65535 }))
        }
        finally {
            for (let i = 0; i < 12; i++) {
                delete Array.prototype[String(i)]
            }
        }
        assert.strictEqual(hits, 0, 'lowerFind must not assign array elements by index')
        assert.deepStrictEqual(got, want)
    })

    it('should ignore Object.prototype pollution of IR field names', function() {
        let want = norm(lf({ a: 1, b: { $in: [1, 2] } }))
        let names = ['t', 'c', 'op', 'v', 'vs', 'not', 'a', 'p']
        names.forEach((k) => {
            Object.prototype[k] = 'POLLUTED'
        })
        let got = null
        try {
            got = norm(lf({ a: 1, b: { $in: [1, 2] } }))
        }
        finally {
            names.forEach((k) => {
                delete Object.prototype[k]
            })
        }
        assert.deepStrictEqual(got, want)
    })
})


describe('lowerFind.mjs is an extractable, dialect-neutral shared layer (L8)', function() {
    let src = fs.readFileSync(new URL('../src/lowerFind.mjs', import.meta.url), 'utf8')

    it('should import nothing (no import / require / dynamic import)', function() {
        assert.ok(!/^\s*import\s/m.test(src), 'no import statements')
        assert.ok(!/\brequire\s*\(/.test(src), 'no require')
        assert.ok(!/\bimport\s*\(/.test(src), 'no dynamic import')
        assert.ok(!/^\s*export\s+.*\bfrom\b/m.test(src), 'no re-export from other modules')
    })

    it('should not mention any database, query builder or driver by name', function() {
        assert.ok(!/\b(pg|knex|postgres|postgresql|pgsql|sequelize|sqlite|mssql|mysql|jet|mongo)\b/i.test(src), 'dialect-neutral wording only')
    })

    it('should export exactly lowerFind and eqNode, and state the contract (six node types, maxParams, p) in the header', function() {
        let exported = [...src.matchAll(/^export (?:async )?(?:function|let|const) (\w+)/gm)].map((m) => m[1]).sort()
        assert.deepStrictEqual(exported, ['eqNode', 'lowerFind'])
        let head = src.slice(0, src.indexOf('let isDate'))
        for (let w of ['and', 'or', 'cmp', 'bool', 'null', 'in', 'maxParams', 'checkColumn', '恆假', '三值']) {
            assert.ok(head.includes(w), `header must mention ${w}`)
        }
        assert.ok(/不得影響結果集/.test(head), 'empty in must not affect the result set')
        assert.ok(/p:\s*來源路徑/.test(head), 'leaf source path p')
    })
})


describe('IR contract snapshot (cross-backend contract data, R8)', function() {
    let snap = JSON.parse(fs.readFileSync(new URL('./tools/ir-snapshots.json', import.meta.url), 'utf8'))

    it('should hold one entry per accepted wsemi case, with unique ids and only the six node types', function() {
        assert.ok(snap.length >= 70, `snapshots: ${snap.length}`)
        assert.strictEqual(new Set(snap.map((x) => x.id)).size, snap.length)
        snap.forEach((x) => {
            let types = []
            let w = (n) => {
                if (n === null) {
                    return
                }
                types.push(n.t)
                if (n.a) {
                    n.a.forEach(w)
                }
            }
            w(x.ir)
            types.forEach((t) => assert.ok(SIX.has(t), `${x.id}: ${t}`))
        })
    })

    it('should equal the IR that the current lowerFind produces (a difference is a contract change: regenerate with node test/tools/genIrSnapshots.mjs and review the diff)', function() {
        assert.deepStrictEqual(buildSnapshots(), snap)
    })
})
