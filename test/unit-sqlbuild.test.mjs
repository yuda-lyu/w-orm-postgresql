/* eslint-disable no-extend-native, no-sparse-arrays -- 測試暫時於內建原型安裝/汙染屬性(finally 還原)驗證建句不受影響 */
import assert from 'assert'
import fs from 'fs'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { cvFind, cvOrder } from '../src/cvFind.mjs'
import { buildSelect, buildDelete, verifySql, quoteTable, splitDots, isSysCol, dialectPg } from '../src/buildSql.mjs'
import * as buildSqlModule from '../src/buildSql.mjs'
import { SEMANTICS, norm } from './tools/irSemantics.mjs'
import { sweep, KEY_NAMES, VALUES, SYMBOL_NAMES, SYMBOL_VALUES, buildBaseline } from './tools/pollutionSweep.mjs'


//buildSql(IR + order -> PostgreSQL 語句, 以 knex 只建 SQL 不連線; 不需 docker)之純函數測試.
//規格句(帳本 R12 R13):
//  E1 emitKnex 只認 6 種節點, 識別子與值於發射端再檢(縱深)
//  E2 verifySql: knex 產出之文字須與由 IR 導出之詞彙序列及值逐一相等, 不符 fail-closed
//  E3 系統欄名(ctid tableoid xmin xmax cmin cmax)於 find 與 order 皆拒收
//  E4 表別名 "$t" 與欄位不加表限定(第 76 項之結構性機制; 真 PG 行為見 api-find)
//  E5 order 鍵僅識別字; 方向與 nulls 為固定字面值
//  E6 建句於連線之前完成, 失敗以固定格式 invalid find|order ... (statement check)(不洩漏 knex 內部訊息)
//  E7 不改動全域 Object.prototype/Array.prototype; 資料型汙染下不靜默改變 SQL(same 或 fail-closed)
//預期之 SQL 與值皆手寫(見 tools/irSemantics.mjs), 不由被測碼產生.

let HEAD_S = 'select * from "t" as "$t"'
let HEAD_D = 'delete from "t" as "$t"'


describe('buildSql: exact SQL and values per IR node (E4, node semantics table)', function() {
    SEMANTICS.forEach((s) => {
        it(`should build select for [${s.id}] (${s.node})`, function() {
            let r = buildSelect('t', cvFind(s.find()))
            assert.strictEqual(r.query, s.where === '' ? HEAD_S : `${HEAD_S} ${s.where}`)
            assert.deepStrictEqual(norm(r.values), s.values)
        })

        it(`should build delete for [${s.id}] with the same condition`, function() {
            let r = buildDelete('t', cvFind(s.find()))
            assert.strictEqual(r.query, s.where === '' ? HEAD_D : `${HEAD_D} ${s.where}`)
            assert.deepStrictEqual(norm(r.values), s.values)
        })
    })

    it('should return null-prototype { query, values } with a real array of values', function() {
        let r = buildSelect('t', cvFind({ a: 1 }))
        assert.strictEqual(Object.getPrototypeOf(r), null)
        assert.deepStrictEqual(Object.keys(r).sort(), ['query', 'values'])
        assert.ok(Array.isArray(r.values))
    })

    it('should bind a $in of 65535 elements as 65535 parameters in order, and every one of them as a $n placeholder', function() {
        //單一 $in 上限 10000(共用層): 6 欄各 10000 + 1 欄 5535 = 65535
        let find = {}
        for (let k = 0; k < 7; k++) {
            let n = k < 6 ? 10000 : 5535
            find[`c${k}`] = { $in: Array.from({ length: n }, (_, i) => k * 10000 + i) }
        }
        let r = buildSelect('t', cvFind(find))
        assert.strictEqual(r.values.length, 65535)
        assert.strictEqual(r.values[0], 0)
        assert.strictEqual(r.values[10000], 10000)
        assert.strictEqual(r.values[65534], 65534)
        assert.ok(r.query.endsWith('$65534, $65535)'))
        assert.ok(!r.query.includes('$65536'))
    })

    it('should hand out a snapshot of the verified values: changing a Date of the IR (or of a previous result) afterwards does not change the values to be sent (the value checked is the value used)', function() {
        let ir = cvFind({ d: new Date(1000), e: { $in: [new Date(2000), 5, 'x'] } })
        let r = buildSelect('t', ir)
        assert.deepStrictEqual(norm(r.values), [{ $date: 1000 }, { $date: 2000 }, 5, 'x'])
        ir.a[0].v.setTime(0) //改動 IR 內之 Date 實體(送出之值不可與之共用實體)
        ir.a[1].vs[0].setTime(0)
        assert.deepStrictEqual(norm(r.values), [{ $date: 1000 }, { $date: 2000 }, 5, 'x'])
        let r2 = buildSelect('t', ir)
        assert.notStrictEqual(r2.values[0], r.values[0]) //每次呼叫各有獨立實體
        assert.ok(r.values[0] instanceof Date && r.values[1] instanceof Date)
    })

    it('should reject, never send, a Date that is rewritten in place while knex reads its properties: knex only gets a private copy, so the rewrite shows up as a value mismatch (the value checked is the value used; external review sol F03)', function() {
        let touched = 0
        Object.defineProperty(Object.prototype, 'isRawInstance', {
            configurable: true,
            get() {
                if (this instanceof Date) {
                    touched += 1
                    this.setTime(0) //knex 讀 value.isRawInstance 時就地改寫它所拿到的 Date
                }
                return undefined
            },
        })
        try {
            let d = () => new Date(Date.UTC(2025, 0, 1))
            let calls = [
                () => buildSelect('t', cvFind({ d: d() })),
                () => buildDelete('t', cvFind({ d: d() })),
                () => buildSelect('t', cvFind({ d: { $in: [d(), 1] } })),
                () => buildDelete('t', cvFind({ d: { $nin: [d()] } })),
            ]
            calls.forEach((f) => {
                assert.throws(f, (err) => err.message === 'invalid find: internal statement check failed (statement check): values do not match the condition at [find]')
            })
            assert.ok(touched >= calls.length) //getter 確實被執行(否則上面的拒收不是由它造成)
        }
        finally {
            delete Object.prototype.isRawInstance
        }
        assert.ok(!Reflect.has(Object.prototype, 'isRawInstance'))
    })

    it('should keep the count contract: bool / null / empty in take no parameter, in takes one per element (booleans inside in are parameters)', function() {
        let r = buildSelect('t', cvFind({ a: true, b: null, c: { $ne: null }, d: { $in: [] }, e: { $in: [true, false] }, f: 'x' }))
        assert.strictEqual(r.query, `${HEAD_S} where "a" IS TRUE and "b" is null and "c" is not null and false and "e" in ($1, $2) and "f" = $3`)
        assert.deepStrictEqual(r.values, [true, false, 'x'])
    })
})


describe('buildSql: table names are never parsed by knex (E4)', function() {
    //[輸入表名, 期望之引用結果]; 規則: 不含雙引號者以 . 分段各加雙引號, 含雙引號者視為已引用而原樣輸出
    let tables = [
        ['t', '"t"'],
        ['MixedCase', '"MixedCase"'],
        ['s.t', '"s"."t"'],
        ['a.b.c', '"a"."b"."c"'],
        ['we?rd', '"we?rd"'], //knex raw 會把 ? 改成 $1
        ['a$1b', '"a$1b"'],
        ['t as x', '"t as x"'], //knex 會把 as 解析為別名
        ['t*', '"t*"'],
        ['中文表', '"中文表"'],
        ['"Po_Q"', '"Po_Q"'],
        ['"s"."t"', '"s"."t"'],
        ['$tbl$', '"$tbl$"'], //與內部佔位詞同名也不得被誤換
    ]
    tables.forEach(([name, quoted]) => {
        it(`should render table ${JSON.stringify(name)} as ${quoted} with the fixed alias`, function() {
            assert.strictEqual(quoteTable(name), quoted)
            let r = buildSelect(name, cvFind({ a: 1 }))
            assert.strictEqual(r.query, `select * from ${quoted} as "$t" where "a" = $1`)
            assert.deepStrictEqual(r.values, [1])
            let d = buildDelete(name, cvFind({ a: 1 }))
            assert.strictEqual(d.query, `delete from ${quoted} as "$t" where "a" = $1`)
        })
    })

    it('should never put a table qualifier before a column name', function() {
        let r = buildSelect('t', cvFind({ $or: [{ concat: 'x' }, { time: 1 }] }), cvOrder({ concat: 'asc' }))
        assert.ok(!/"t"\."/.test(r.query), r.query)
        assert.ok(!/"\$t"\."/.test(r.query), r.query)
        assert.strictEqual(r.query, `${HEAD_S} where ("concat" = $1 or "time" = $2) order by "concat" asc`)
    })
})


describe('buildSql: order is built from fixed literals (E5)', function() {
    it('should render direction and nulls placement', function() {
        let r = buildSelect('t', null, cvOrder({ a: 'asc', b: 'DESC', c: 'desc nulls first', d: 'ASC  NULLS   LAST' }))
        assert.strictEqual(r.query, `${HEAD_S} order by "a" asc, "b" desc, "c" desc nulls first, "d" asc nulls last`)
        assert.deepStrictEqual(r.values, [])
    })

    it('should combine a condition with order, in order of keys', function() {
        let r = buildSelect('t', cvFind({ a: { $gt: 1 } }), cvOrder({ b: 'desc', a: 'asc' }))
        assert.strictEqual(r.query, `${HEAD_S} where "a" > $1 order by "b" desc, "a" asc`)
    })

    it('should reject direction / nulls values that are not fixed literals, even when handed over without cvOrder', function() {
        let item = (o) => [Object.assign(Object.create(null), { c: 'a', dir: 'asc', nulls: null }, o)]
        let bad = [{ dir: 'ASC' }, { dir: 'asc; drop table t' }, { dir: 'desc ' }, { dir: 1 }, { dir: undefined }, { nulls: 'first ' }, { nulls: 'FIRST' }, { nulls: 'x' }, { nulls: undefined }, { c: 'a.b' }, { c: 'a as b' }, { c: '*' }, { c: 'ctid' }, { c: 'a"b' }, { c: '' }, { c: 5 }, { c: { toString: () => 'a' } }]
        bad.forEach((b) => {
            assert.throws(() => buildSelect('t', null, item(b)), (err) => {
                assert.ok(/^invalid order: .+ at \[(emit|order)\]$/.test(err.message), `${JSON.stringify(b)}: ${err.message}`)
                return true
            }, JSON.stringify(b))
        })
    })

    it('should not accept JSON-path or cast keys (order keys are identifiers only)', function() {
        ;['j->a', 'j->>a', 'j#>a', 'j#>>a', 'v::text', 'j->>0', 'a.b'].forEach((k) => {
            assert.throws(() => cvOrder({ [k]: 'asc' }), /^Error: invalid order: unsupported column name \[.*\] at \[order\..*\]$/, k)
        })
    })

    it('should treat system column names as unsupported in order, as in find (E3)', function() {
        ;['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax'].forEach((k) => {
            assert.ok(isSysCol(k))
            assert.throws(() => cvOrder({ [k]: 'asc' }), new RegExp(`^Error: invalid order: unsupported column name \\[${k}\\] at \\[order\\.${k}\\]$`))
            assert.throws(() => cvFind({ [k]: 1 }), new RegExp(`^Error: invalid find: unsupported column name \\[${k}\\] at \\[find\\.${k}\\]$`))
        })
        assert.ok(!isSysCol('oid'))
        assert.doesNotThrow(() => cvFind({ oid: 1 })) //oid 在 PG >= 12 可建同名欄, 不拒收
    })
})


describe('buildSql: emitKnex re-checks identifiers and values (E1, defence in depth)', function() {
    let leaf = (o) => Object.assign(Object.create(null), o)
    let rejects = (ir, label) => {
        assert.throws(() => buildSelect('t', ir), (err) => {
            //須由發射端自己拒收(at [emit]): 不可靠 knex 或 verifySql 之後援(縱深防禦各層各自有效)
            assert.ok(/^invalid find: .+ at \[emit\]$/.test(err.message), `${label}: ${err.message}`)
            return true
        }, label)
        assert.throws(() => buildDelete('t', ir), /^Error: invalid find: /, label)
    }

    it('should accept a well-formed hand-built IR (the checks are not over-strict)', function() {
        let r = buildSelect('t', leaf({ t: 'cmp', c: 'a', op: 'eq', v: 1 }))
        assert.strictEqual(r.query, `${HEAD_S} where "a" = $1`)
        assert.deepStrictEqual(r.values, [1])
    })

    it('should reject identifiers that knex would parse specially (a.b, a as b, *, empty, quotes, non-strings, system columns, > 63 bytes)', function() {
        ;['a.b', 'a as b', 'A AS B', '*', '', 'a"b', 'a b', 'a-b', '1a', 'ctid', 'xmin', 'x'.repeat(64), '中'.repeat(22), 5, null, undefined, ['a'], { toString: () => 'a' }].forEach((c) => {
            rejects(leaf({ t: 'cmp', c, op: 'eq', v: 1 }), `cmp c=${String(c)}`)
            rejects(leaf({ t: 'null', c, not: false }), `null c=${String(c)}`)
            rejects(leaf({ t: 'in', c, vs: [1], not: false }), `in c=${String(c)}`)
        })
        assert.doesNotThrow(() => buildSelect('t', leaf({ t: 'cmp', c: 'x'.repeat(63), op: 'eq', v: 1 })))
        assert.doesNotThrow(() => buildSelect('t', leaf({ t: 'cmp', c: '中'.repeat(21), op: 'eq', v: 1 }))) //21 字 = 63 bytes
    })

    it('should reject non-scalar values: objects, arrays, functions, Raw-like objects, Symbol, bigint, NaN, invalid Date, null, undefined', function() {
        let raw = { isRawInstance: true, sql: 'true', bindings: [] }
        // eslint-disable-next-line no-new-wrappers
        let bad = [{ a: 1 }, [1], () => 1, raw, Symbol('x'), 10n, NaN, new Date(NaN), null, undefined, new Boolean(true), new String('x'), Object.create(null)]
        bad.forEach((v, i) => {
            rejects(leaf({ t: 'cmp', c: 'a', op: 'eq', v }), `cmp v#${i}`)
            rejects(leaf({ t: 'in', c: 'a', vs: [1, v], not: false }), `in v#${i}`)
            rejects(leaf({ t: 'in', c: 'a', vs: [v], not: true }), `nin v#${i}`)
        })
    })

    it('should reject a boolean value on a cmp node, a non-boolean on a bool node, unknown ops and unknown node types', function() {
        rejects(leaf({ t: 'cmp', c: 'a', op: 'eq', v: true }), 'cmp boolean')
        rejects(leaf({ t: 'bool', c: 'a', op: 'eq', v: 1 }), 'bool number')
        rejects(leaf({ t: 'bool', c: 'a', op: 'eq', v: 'true' }), 'bool string')
        ;['like', '~', '=', '<>', 'EQ', '', undefined, null, 'constructor'].forEach((op) => {
            rejects(leaf({ t: 'cmp', c: 'a', op, v: 1 }), `cmp op=${op}`)
            rejects(leaf({ t: 'bool', c: 'a', op, v: true }), `bool op=${op}`)
        })
        ;['raw', 'not', 'exists', 'sub', 'CMP', '', undefined, 5].forEach((t) => {
            rejects(leaf({ t, c: 'a', op: 'eq', v: 1 }), `type=${t}`)
        })
        rejects('oops', 'string as IR')
        rejects([], 'array as IR')
        rejects(7, 'number as IR')
    })

    it('should reject an empty not-in (cvOrmFind rejects $nin: [] upstream) instead of emitting a tautology', function() {
        rejects(leaf({ t: 'in', c: 'a', vs: [], not: true }), 'nin empty')
    })

    it('should reject a nested and/or whose child is malformed', function() {
        let ok = leaf({ t: 'cmp', c: 'a', op: 'eq', v: 1 })
        let bad = leaf({ t: 'cmp', c: 'a b', op: 'eq', v: 1 })
        rejects(leaf({ t: 'or', a: [ok, bad] }), 'or child')
        rejects(leaf({ t: 'and', a: [ok, leaf({ t: 'or', a: [ok, leaf({ t: 'zzz' })] })] }), 'deep child')
    })
})


describe('verifySql: the statement must be the one derived from the IR (E2, E6)', function() {
    let F = { $or: [{ a: 1, b: 2 }, { c: 3 }], d: { $in: [1, 2] }, e: { $ne: true }, f: null }
    let mk = () => {
        let ir = cvFind(F)
        let order = cvOrder({ a: 'desc nulls last', b: 'asc' })
        let r = buildSelect('t', ir, order)
        return { ir, order, text: r.query, values: [...r.values], head: HEAD_S }
    }
    let check = (b, text, values) => verifySql(text, values === undefined ? b.values : values, b.head, b.ir, b.order)
    let stmt = /^Error: invalid (find|order): internal statement check failed \(statement check\): .+ at \[(find|order)\]$/

    it('should pass the statement that buildSelect itself produced', function() {
        let b = mk()
        assert.strictEqual(b.text, `${HEAD_S} where (("a" = $1 and "b" = $2) or "c" = $3) and "d" in ($4, $5) and "e" IS FALSE and "f" is null order by "a" desc nulls last, "b" asc`)
        assert.doesNotThrow(() => check(b, b.text))
    })

    //語意竄改: 文字仍是合法 SQL、詞彙多重集合不變或幾乎不變, 但改變了命中集合; 序列驗證須全數拒收
    let tamper = [
        ['regroup parentheses (and/or precedence changed)', (t) => t.replace('(("a" = $1 and "b" = $2) or "c" = $3)', '("a" = $1 and ("b" = $2 or "c" = $3))')],
        ['swap two columns', (t) => t.replace('"a" = $1', '"b" = $1').replace('and "b" = $2', 'and "a" = $2')],
        ['swap an operator (= -> !=)', (t) => t.replace('"c" = $3', '"c" != $3')],
        ['shift not (in -> not in)', (t) => t.replace('"d" in (', '"d" not in (')],
        ['shift not the other way (is null -> is not null)', (t) => t.replace('"f" is null', '"f" is not null')],
        ['swap a boolean literal', (t) => t.replace('IS FALSE', 'IS TRUE')],
        ['move a parenthesis', (t) => t.replace('(("a" = $1 and "b" = $2) or "c" = $3)', '(("a" = $1) and "b" = $2 or "c" = $3)')],
        ['drop the or group parentheses', (t) => t.replace('(("a" = $1 and "b" = $2) or "c" = $3)', '("a" = $1 and "b" = $2) or "c" = $3')],
        ['and -> or between top-level conditions', (t) => t.replace('and "e" IS FALSE', 'or "e" IS FALSE')],
        ['or -> and inside the group', (t) => t.replace('or "c" = $3', 'and "c" = $3')],
        ['drop the first condition', (t) => t.replace('(("a" = $1 and "b" = $2) or "c" = $3) and ', '')],
        ['drop the last condition', (t) => t.replace(' and "f" is null', '')],
        ['append or true', (t) => t.replace(' order by', ' or true order by')],
        ['append a tautology', (t) => t.replace(' order by', ' and 1 = 1 order by')],
        ['remove the where clause altogether', (t) => t.replace(/ where .* order by/, ' order by')],
        ['direction change in order', (t) => t.replace('"b" asc', '"b" desc')],
        ['nulls change in order', (t) => t.replace('nulls last', 'nulls first')],
        ['order key swap', (t) => t.replace('order by "a" desc nulls last, "b" asc', 'order by "b" desc nulls last, "a" asc')],
    ]
    tamper.forEach(([label, fn]) => {
        it(`should reject a tampered statement: ${label}`, function() {
            let b = mk()
            let t = fn(b.text)
            assert.notStrictEqual(t, b.text, 'the tamper must change the text')
            assert.throws(() => check(b, t), stmt)
        })
    })

    //通用竄改: 附加危險片段/關鍵字/字面值, 一律拒收
    let generic = [
        ['limit', ' limit 1'], ['offset', ' offset 1'], ['distinct', null, (t) => t.replace('select *', 'select distinct *')], ['only', null, (t) => t.replace('from "t"', 'from only "t"')],
        ['returning', ' returning *'], ['using', ' using "u"'], ['union', ' union select * from "u"'], ['group by', ' group by "a"'], ['having', ' having 1 = 1'],
        ['join', null, (t) => t.replace(' where', ' inner join "u" on true where')], ['semicolon', '; drop table "t"'], ['line comment', ' --'], ['block comment', ' /* x */'], ['single-quoted literal', ` and 'x' = 'x'`],
        ['number literal', ' and 1'], ['cast', ' and "a"::text = $1'], ['json path', ' and "a"->>"b" = $1'], ['dollar quoting', ' and $$x$$ = $$x$$'], ['tab / newline are only whitespace but a new word is not', ' and\nsleep'],
        ['subquery', ' and "a" in (select 1)'], ['function call', ' and pg_sleep(1) is null'], ['backtick', ' and `a`'], ['brace', ' and {a}'], ['pipe', ' or "a" || "b"'],
        ['unexpected placeholder', ' and "z" = $6'], ['placeholder zero', ' and "z" = $0'],
    ]
    generic.forEach(([label, suffix, fn]) => {
        it(`should reject: ${label}`, function() {
            let b = mk()
            let t = fn ? fn(b.text) : b.text + suffix
            assert.throws(() => check(b, t), stmt)
        })
    })

    it('should reject a wrong head (table part replaced) even if the rest is intact', function() {
        let b = mk()
        assert.throws(() => check(b, b.text.replace('from "t"', 'from "other"')), /unexpected statement head/)
        assert.throws(() => check(b, b.text.replace('as "$t"', 'as "u"')), /unexpected statement head/)
        assert.throws(() => check(b, 'delete' + b.text.slice(6)), /unexpected statement head/)
        assert.throws(() => check(b, 5), /unexpected statement head/)
        assert.throws(() => check(b, undefined), /unexpected statement head/)
    })

    it('should reject placeholders that are out of order, missing, duplicated or not matching the values', function() {
        let b = mk()
        assert.throws(() => check(b, b.text.replace('$2', '$3').replace('$3 )', '$2 )')), stmt)
        assert.throws(() => check(b, b.text.replace('$5', '$4')), stmt)
        assert.throws(() => check(b, b.text, b.values.slice(0, 4)), /placeholder count does not match values/)
        assert.throws(() => check(b, b.text, [...b.values, 6]), /placeholder count does not match values/)
        assert.throws(() => check(b, b.text, 'nope'), stmt)
        assert.throws(() => check(b, b.text, null), stmt)
    })

    it('should reject values that differ from the IR in value, type or kind (strict equality, Dates by time value)', function() {
        let b = mk()
        for (let i = 0; i < b.values.length; i++) {
            let v = [...b.values]
            v[i] = v[i] + 1
            assert.throws(() => check(b, b.text, v), /values do not match the condition/, `value #${i}`)
            let s = [...b.values]
            s[i] = String(s[i])
            assert.throws(() => check(b, b.text, s), /values do not match the condition/, `type #${i}`)
        }
        let dir = cvFind({ d: new Date(1000) })
        let rd = buildSelect('t', dir)
        assert.doesNotThrow(() => verifySql(rd.query, [new Date(1000)], HEAD_S, dir, []))
        assert.throws(() => verifySql(rd.query, [new Date(1001)], HEAD_S, dir, []), /values do not match the condition/)
        assert.throws(() => verifySql(rd.query, [1000], HEAD_S, dir, []), /values do not match the condition/)
    })

    it('should reject non-scalar values even where the IR would hold the same non-scalar (the check is on the statement side)', function() {
        let b = mk()
        ;[{}, [], () => 1, null, undefined, Symbol('x'), 5n, NaN, new Date(NaN)].forEach((x, i) => {
            let v = [...b.values]
            v[0] = x
            assert.throws(() => check(b, b.text, v), /^Error: invalid find: internal statement check failed/, `non-scalar #${i}`)
        })
    })

    it('should reject a non-scalar value by the scalar guard itself when the IR holds the very same non-scalar (so a value mismatch cannot mask a removed guard; external review sol F05)', function() {
        ;[{}, [], () => 1, null, undefined, Symbol('x'), 5n, NaN, new Date(NaN)].forEach((x, i) => {
            let ir = cvFind({ a: 1 })
            let r = buildSelect('t', ir)
            let leaf = ir.t === 'cmp' ? ir : ir.a[0]
            leaf.v = x //IR 與 bindings 同為 x: 值相等, 只有純量防線能拒收
            assert.throws(() => verifySql(r.query, [x], HEAD_S, ir, []), (err) => err.message === 'invalid find: internal statement check failed (statement check): value is not a scalar at [find]', `non-scalar #${i}`)
        })
    })

    it('should name order as the failing part only when the difference lies in the order clause (or there is no condition)', function() {
        let b = mk()
        assert.throws(() => check(b, b.text.replace('"b" asc', '"b" desc')), /^Error: invalid order: internal statement check failed .* at \[order\]$/)
        assert.throws(() => check(b, b.text.replace('"c" = $3', '"c" != $3')), /^Error: invalid find: internal statement check failed .* at \[find\]$/)
        let ir0 = cvFind({})
        let o0 = cvOrder({ a: 'asc' })
        assert.throws(() => verifySql(`${HEAD_S} order by "a" desc`, [], HEAD_S, ir0, o0), /^Error: invalid order: internal statement check failed/)
        assert.throws(() => verifySql(`${HEAD_S} where "a" = $1`, [1], HEAD_S, ir0, []), /^Error: invalid find: internal statement check failed/)
    })

    it('should not echo values, column names or the table name in the failure message', function() {
        let ir = cvFind({ secretcol: 'SECRET-VALUE' })
        let r = buildSelect('secret_table', ir)
        let head = 'select * from "secret_table" as "$t"'
        try {
            verifySql(r.query.replace('=', '!='), ['SECRET-VALUE'], head, ir, [])
            assert.fail('must throw')
        }
        catch (err) {
            assert.ok(!/SECRET|secretcol|secret_table/i.test(err.message), err.message)
        }
    })

    it('should have no switch that disables verification (no environment variable, no option)', function() {
        let src = fs.readFileSync(new URL('../src/buildSql.mjs', import.meta.url), 'utf8')
        assert.ok(!/process\.env/.test(src), 'no process.env in buildSql')
        assert.ok(!/NOVERIFY|SKIP_?VERIFY|noverify/i.test(src))
        assert.strictEqual(typeof buildSelect, 'function')
        assert.strictEqual(buildSelect.length <= 3, true) //簽名只有 (table, ir, order=[]), 無 options 參數
        assert.strictEqual(buildDelete.length, 2)
    })

    it('should rebuild the statement from the IR, so a wrong IR value changes the SQL and a hand-built IR cannot smuggle text', function() {
        //IR 內的字串值只會成為綁定參數, 不會進入語句文字
        let r = buildSelect('t', cvFind({ a: 'x\'); drop table t; --', b: { $in: ['"; select 1', '$1'] } }))
        assert.strictEqual(r.query, `${HEAD_S} where "a" = $1 and "b" in ($2, $3)`)
        assert.deepStrictEqual(r.values, ['x\'); drop table t; --', '"; select 1', '$1'])
    })
})


describe('buildSql: no global prototype is touched, and polluted prototypes never change the SQL silently (E7, R2)', function() {
    it('should not export a prototype-cleaning helper and should leave foreign members of Object.prototype in place during the build', function() {
        assert.strictEqual(buildSqlModule.withCleanProto, undefined)
        Object.prototype.zzPolluted = 'still-here'
        Object.defineProperty(Array.prototype, '7', {
            configurable: true,
            get() {
                return undefined
            },
            set() {},
        })
        let has = (o, k) => Object.getOwnPropertyDescriptor(o, k) !== undefined
        try {
            let seen = null
            let ir = cvFind({ a: 1 })
            //建句進行中(knex 內部呼叫的 getter)觀察汙染成員仍在: 以 getter 偵測讀取不得被移除
            Object.defineProperty(Object.prototype, 'zzProbe', {
                configurable: true,
                get() {
                    seen = has(Object.prototype, 'zzPolluted')
                    return undefined
                },
            })
            buildSelect('t', ir)
            assert.ok(has(Object.prototype, 'zzPolluted'))
            assert.ok(has(Array.prototype, '7'))
            assert.ok(seen === null || seen === true)
        }
        finally {
            delete Object.prototype.zzPolluted
            delete Object.prototype.zzProbe
            delete Array.prototype['7']
        }
        assert.ok(!has(Object.prototype, 'zzPolluted'))
    })

    it('should give the same SQL or fail closed for every polluted high-risk name × value (never a silently different statement)', function() {
        let r = sweep({ names: KEY_NAMES, values: VALUES })
        assert.strictEqual(r.diff, 0, `silent change: ${JSON.stringify(r.diffs)}`)
        assert.strictEqual(r.leak, 0, `unexpected error shape: ${JSON.stringify(r.leaks)}`)
        assert.strictEqual(r.same + r.threw, KEY_NAMES.length * VALUES.length)
        assert.ok(r.threw > 0, 'some knex-internal names must make the build fail closed (limit, offset, join, having ...)')
        assert.ok(r.same > 0)
    })

    it('should give the same SQL or fail closed under pollution of the other built-in prototypes', function() {
        let protos = [Array.prototype, Function.prototype, String.prototype, Number.prototype, Boolean.prototype]
        protos.forEach((proto) => {
            let r = sweep({ proto, names: KEY_NAMES, values: VALUES })
            assert.strictEqual(r.diff, 0, `${Object.prototype.toString.call(proto)}: ${JSON.stringify(r.diffs)}`)
            assert.strictEqual(r.leak, 0)
        })
    })

    it('should not let well-known Symbol keys installed on the built-in prototypes (split, replace, match, ...) change the table part or any other part of the statement (opus F3)', function() {
        ;[Object.prototype, String.prototype, Array.prototype, Function.prototype].forEach((proto) => {
            let r = sweep({ proto, names: SYMBOL_NAMES, values: SYMBOL_VALUES })
            assert.strictEqual(r.diff, 0, `${Object.prototype.toString.call(proto)}: ${JSON.stringify(r.diffs.map((d) => d.map(String)))}`)
            assert.strictEqual(r.leak, 0)
            assert.ok(r.same + r.threw > 0)
        })
        //表名拆段不用 String.prototype.split: Symbol.split 函式不得改寫引用結果
        Object.defineProperty(Object.prototype, Symbol.split, { value: () => ['public', 'other'], configurable: true, writable: true })
        try {
            assert.strictEqual(quoteTable('sch.t'), '"sch"."t"')
            assert.strictEqual(buildSelect('t', cvFind({ a: 1 })).query, `${HEAD_S} where "a" = $1`)
            assert.strictEqual(buildDelete('s.t', cvFind({ a: 1 })).query, 'delete from "s"."t" as "$t" where "a" = $1')
        }
        finally {
            delete Object.prototype[Symbol.split]
        }
    })

    it('should name the statement head when knex does not start the text with the expected select / delete head (polluted distinct changes the head: select distinct * from …)', function() {
        Object.prototype.distinct = 'x'
        try {
            assert.throws(() => buildSelect('t', cvFind({ a: 1 })), /^Error: invalid find: internal statement check failed \(statement check\): unexpected statement head at \[find\]$/)
            assert.throws(() => buildSelect('t', null, cvOrder({ a: 'asc' })), /^Error: invalid order: internal statement check failed \(statement check\): unexpected statement head at \[order\]$/)
        }
        finally {
            delete Object.prototype.distinct
        }
    })

    it('should split a table name at dots by hand (splitDots): segments, empty segments and no dot', function() {
        assert.deepStrictEqual(splitDots('a'), ['a'])
        assert.deepStrictEqual(splitDots('a.b'), ['a', 'b'])
        assert.deepStrictEqual(splitDots('a.b.c'), ['a', 'b', 'c'])
        assert.deepStrictEqual(splitDots(''), [''])
        assert.deepStrictEqual(splitDots('.a.'), ['', 'a', ''])
        assert.deepStrictEqual(splitDots('a..b'), ['a', '', 'b'])
    })

    it('should fail closed with the fixed message (no knex internals) when a polluted name breaks knex', function() {
        let base = buildBaseline()
        assert.ok(base.length > 0)
        for (let name of ['limit', 'offset', 'order', 'having', 'join']) {
            Object.prototype[name] = 'x'
            try {
                assert.throws(() => buildSelect('t', cvFind({ a: 1 })), (err) => {
                    assert.ok(err instanceof Error)
                    assert.strictEqual(err.message, 'invalid find: internal statement check failed (statement check): the statement could not be built at [find]', name)
                    return true
                }, name)
                //order 單獨參與(無條件)時: 與基準相同或以 invalid order 的固定訊息 fail-closed
                let o = null
                try {
                    o = buildSelect('t', null, cvOrder({ a: 'asc' })).query
                }
                catch (err) {
                    assert.ok(/^invalid order: internal statement check failed \(statement check\): .+ at \[order\]$/.test(err.message), `${name}: ${err.message}`)
                }
                assert.ok(o === null || o === `${HEAD_S} order by "a" asc`, o)
                //delete 路徑: 與基準相同或同樣 fail-closed, 不得為第三種
                let d = null
                try {
                    d = buildDelete('t', cvFind({ a: 1 })).query
                }
                catch (err) {
                    assert.ok(/\(statement check\)/.test(err.message), err.message)
                }
                assert.ok(d === null || d === `${HEAD_D} where "a" = $1`, d)
            }
            finally {
                delete Object.prototype[name]
            }
        }
        assert.doesNotThrow(() => buildSelect('t', cvFind({ a: 1 }))) //還原後恢復正常
    })

    //non-configurable 汙染無法被移除或覆寫, 子行程中逐名測試: 結果須為 same 或 fail-closed
    let childCode = `
        import { pathToFileURL } from 'url'
        let u = (p) => pathToFileURL(p).href
        let { cvFind, cvOrder } = await import(u(process.env.T_CVFIND))
        let { buildSelect, buildDelete } = await import(u(process.env.T_BUILD))
        let name = process.env.T_NAME
        let value = JSON.parse(process.env.T_VALUE)
        if (name !== '') {
            Object.defineProperty(Object.prototype, name, { value, configurable: false, writable: false, enumerable: true })
        }
        let out
        try {
            let s = buildSelect('t', cvFind({ $or: [{ a: 1 }, { b: { $in: [1, 2] } }], c: { $ne: null } }), cvOrder({ a: 'asc' }))
            let d = buildDelete('t', cvFind({ a: 1 }))
            out = { ok: true, s: [s.query, s.values], d: [d.query, d.values] }
        }
        catch (e) {
            out = { ok: false, message: String(e && e.message) }
        }
        console.log('@@' + JSON.stringify(out))
    `
    let runChild = (name, value) => {
        let r = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
            env: { ...process.env, T_NAME: name, T_VALUE: JSON.stringify(value), T_CVFIND: fileURLToPath(new URL('../src/cvFind.mjs', import.meta.url)), T_BUILD: fileURLToPath(new URL('../src/buildSql.mjs', import.meta.url)) },
            encoding: 'utf8',
            timeout: 60000,
        })
        assert.strictEqual(r.status, 0, `child failed: ${r.stderr}`)
        let line = r.stdout.split('\n').find((x) => x.startsWith('@@'))
        return JSON.parse(line.slice(2))
    }

    it('should give the same SQL or fail closed when the pollution cannot be removed (non-configurable properties, child process)', function() {
        this.timeout(120000)
        let base = runChild('', null)
        assert.strictEqual(base.ok, true)
        let names = ['schema', 'only', 'distinct', 'returning', 'using', 'union', 'group', 'wrapIdentifier', 'limit', 'offset', 'columns', 'with']
        let nThrew = 0
        names.forEach((name) => {
            let r = runChild(name, 'zz')
            if (r.ok) {
                assert.deepStrictEqual(r.s, base.s, `${name}: select changed silently`)
                assert.deepStrictEqual(r.d, base.d, `${name}: delete changed silently`)
            }
            else {
                nThrew += 1
                assert.ok(/^invalid (find|order): internal statement check failed \(statement check\): .+ at \[(find|order)\]$/.test(r.message), `${name}: ${r.message}`)
            }
        })
        assert.ok(nThrew > 0, 'at least one non-removable pollution must be rejected')
    })

    it('should let a process end naturally after building statements (no pool, no timer: knex is used only to compile)', function() {
        this.timeout(60000)
        let code = `
            import { pathToFileURL } from 'url'
            let { cvFind } = await import(pathToFileURL(process.env.T_CVFIND).href)
            let { buildSelect } = await import(pathToFileURL(process.env.T_BUILD).href)
            for (let i = 0; i < 20; i++) buildSelect('t', cvFind({ a: i }))
            console.log('built')
        `
        let r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
            env: { ...process.env, T_CVFIND: fileURLToPath(new URL('../src/cvFind.mjs', import.meta.url)), T_BUILD: fileURLToPath(new URL('../src/buildSql.mjs', import.meta.url)) },
            encoding: 'utf8',
            timeout: 30000,
        })
        assert.strictEqual(r.error, undefined, 'the process must end by itself within 30 s')
        assert.strictEqual(r.status, 0, r.stderr)
        assert.ok(r.stdout.includes('built'))
    })
})


describe('dialectPg: column checks and boolean literals', function() {
    it('should reject > 63 bytes (UTF-8) and system columns, and nothing else', function() {
        assert.strictEqual(dialectPg.checkColumn('a'), '')
        assert.strictEqual(dialectPg.checkColumn('x'.repeat(63)), '')
        assert.strictEqual(dialectPg.checkColumn('中'.repeat(21)), '')
        assert.match(dialectPg.checkColumn('x'.repeat(64)), /column name is too long \(> 63 bytes\)/)
        assert.match(dialectPg.checkColumn('中'.repeat(22)), /too long/)
        ;['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax'].forEach((c) => assert.match(dialectPg.checkColumn(c), /unsupported column name/))
        ;['oid', 'Ctid', 'concat', 'time', 'Infinity'].forEach((c) => assert.strictEqual(dialectPg.checkColumn(c), ''))
        assert.strictEqual(dialectPg.maxParams, 65535)
    })

    it('should render boolean equality as IS TRUE / IS FALSE (never as an operator expression that PG would re-resolve) and comparisons as literals', function() {
        assert.strictEqual(dialectPg.boolRaw('b', '=', true).sql, '?? IS TRUE')
        assert.strictEqual(dialectPg.boolRaw('b', '=', false).sql, '?? IS FALSE')
        assert.strictEqual(dialectPg.boolRaw('b', '!=', true).sql, '?? IS FALSE')
        assert.strictEqual(dialectPg.boolRaw('b', '!=', false).sql, '?? IS TRUE')
        assert.strictEqual(dialectPg.boolRaw('b', '>=', true).sql, '?? >= TRUE')
        assert.strictEqual(dialectPg.boolRaw('b', '<', false).sql, '?? < FALSE')
    })
})
