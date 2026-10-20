/* eslint-disable no-extend-native -- 測試以暫時汙染原型(finally 還原)驗證 INSERT 產生器免疫 */
import assert from 'assert'
import { genInsert, cvColumns, quoteTable, quoteKey, isColumnName, cvTable, genConflict } from '../src/cvWrite.mjs'


//genInsert/cvColumns/genConflict/cvTable/isColumnName/quoteTable 之純函數測試(不連線, 不需 docker).
//規格句見 CLAUDE_rulebook.md 開頭: W1 物件值以 JSON 原樣寫入(全為綁定參數, 不被當成子查詢); W2 UPDATE 之資料鍵須為識別字;
//W4 createTable 之表名/欄名/pk 檢核與引用; W5 ON CONFLICT 之欄名引用與略過 undefined; W7 INSERT 資料鍵含 NUL/孤立代理字元之檢核錯誤
//mongo-sql 已移除: 原「與 mongo-sql 輸出逐字差分」之案改為手寫之預期 SQL 字串與值陣列(依 R7 之輸出格式推導)


class Foo {
    constructor() {
        this.type = 'select'
        this.x = 1
    }
}


describe('quoteTable: unquoted names are split on "." and each part double quoted; names containing a double quote are used as is', function() {
    //手寫表(輸入 → 輸出); 規則: 不含 " 者以 . 分段各加雙引號(不做其他檢核), 含 " 者視為呼叫端已引用之片段而原樣輸出
    let cases = [
        ['a', '"a"'],
        ['twrite', '"twrite"'],
        ['MixedCase', '"MixedCase"'], //不折為小寫
        ['s.t', '"s"."t"'],
        ['public.tprobe', '"public"."tprobe"'],
        ['db.s.t', '"db"."s"."t"'], //三段
        ['"Po_Q"', '"Po_Q"'], //預引號
        ['"s"."t"', '"s"."t"'],
        ['"rvo.dot"', '"rvo.dot"'], //含點之預引號: 不分段
        ['"a.b".c', '"a.b".c'], //含 " 者原樣(不補引號)
        ['a"b', 'a"b'],
        ['a$b', '"a$b"'],
        ['$t', '"$t"'],
        ['tt3$d', '"tt3$d"'],
        ['a?b', '"a?b"'], //? 不被當成佔位符
        ['?', '"?"'],
        ['中文表', '"中文表"'],
        ['ключ.表', '"ключ"."表"'],
        ['a'.repeat(63), `"${'a'.repeat(63)}"`], //63 bytes
        ['中'.repeat(21), `"${'中'.repeat(21)}"`], //63 bytes(UTF-8 每字 3 bytes)
        ['', '""'], //空字串
        ['a b', '"a b"'], //含空白
        [' a.b ', '" a"."b "'],
        ['a..b', '"a".""."b"'],
        ['rvo|p', '"rvo|p"'],
        ['x;y', '"x;y"'],
    ]
    cases.forEach(([t, want]) => {
        it(`should quote ${JSON.stringify(t.length > 20 ? t.slice(0, 20) + '...' : t)} as ${JSON.stringify(want.length > 24 ? want.slice(0, 24) + '...' : want)}`, function() {
            assert.strictEqual(quoteTable(t), want)
        })
    })
})


describe('genInsert: hand-written expected SQL text and values for ordinary rows (W1, R7 output format)', function() {
    let d = new Date('2020-01-02T03:04:05.000Z')
    let b = Buffer.from('ab')
    let check = (rows, query, values, table = 'tprobe') => {
        let r = genInsert(table, rows)
        assert.strictEqual(r.query, query)
        assert.deepStrictEqual(r.values, values)
        return r
    }
    it('should give a single row', function() {
        check([{ time: 1, name: 'a' }], 'insert into "tprobe" ("time", "name") values ($1, $2)', [1, 'a'])
    })
    it('should write null as the literal null (not a bound parameter) and number the other parameters in order', function() {
        check([{ time: 1, name: null, n: 5 }], 'insert into "tprobe" ("time", "name", "n") values ($1, null, $2)', [1, 5])
    })
    it('should bind boolean, number, string, Date, Buffer and bigint values as they are', function() {
        let r = check([{ time: 1, ok: true, n: 5, s: 'x', d, b, big: 10n }], 'insert into "tprobe" ("time", "ok", "n", "s", "d", "b", "big") values ($1, $2, $3, $4, $5, $6, $7)', [1, true, 5, 'x', d, b, 10n])
        assert.strictEqual(r.values[4], d)
        assert.strictEqual(r.values[5], b)
    })
    it('should bind array and object values as one parameter each', function() {
        let js = { a: 1, b: [1, { c: 2 }] }
        check([{ time: 1, arr: [1, 2, 3] }], 'insert into "tprobe" ("time", "arr") values ($1, $2)', [1, [1, 2, 3]])
        let r = check([{ time: 1, js }], 'insert into "tprobe" ("time", "js") values ($1, $2)', [1, js])
        assert.strictEqual(r.values[1], js)
    })
    it('should list the union of keys in order of first appearance and fill DEFAULT for a row without that value', function() {
        check([{ time: 1, name: 'a' }, { time: 2, tag: 'x', name: undefined }], 'insert into "tprobe" ("time", "name", "tag") values ($1, $2, DEFAULT), ($3, DEFAULT, $4)', [1, 'a', 2, 'x'])
    })
    it('should skip keys whose value is undefined in every row', function() {
        check([{ time: 1, name: undefined, n: 2 }], 'insert into "tprobe" ("time", "n") values ($1, $2)', [1, 2])
    })
    it('should tell null (literal null) from undefined or missing (DEFAULT) across rows', function() {
        check([{ a: null }, { a: 1 }, { a: undefined }, {}, { a: 2 }], 'insert into "tprobe" ("a") values (null), ($1), (DEFAULT), (DEFAULT), ($2)', [1, 2])
    })
    it('should number the parameters of many rows consecutively', function() {
        let rows = Array.from({ length: 50 }, (_, i) => ({ time: i, name: `n${i}`, v: i / 2 }))
        let tuples = []
        let values = []
        for (let i = 0; i < 50; i++) {
            tuples.push(`($${3 * i + 1}, $${3 * i + 2}, $${3 * i + 3})`)
            values.push(i, `n${i}`, i / 2)
        }
        check(rows, `insert into "tprobe" ("time", "name", "v") values ${tuples.join(', ')}`, values)
    })
    it('should quote keys with a dot or non-ASCII letters as one identifier each', function() {
        check([{ 'time': 1, 'a.b': 2 }], 'insert into "tprobe" ("time", "a.b") values ($1, $2)', [1, 2])
        check([{ time: 1, 中文: 'x' }], 'insert into "tprobe" ("time", "中文") values ($1, $2)', [1, 'x'])
    })
    it('should bind a string that starts and ends with $ as a literal value', function() {
        check([{ time: 1, name: '$name$' }], 'insert into "tprobe" ("time", "name") values ($1, $2)', [1, '$name$'])
        check([{ time: '$time$' }], 'insert into "tprobe" ("time") values ($1)', ['$time$'])
    })
    it('should double the double quotes inside a key', function() {
        check([{ 'time': 1, 'a"b': 2 }], 'insert into "tprobe" ("time", "a""b") values ($1, $2)', [1, 2])
    })
    it('should quote a schema-qualified table name part by part, and a mixed-case one without folding', function() {
        check([{ time: 1 }], 'insert into "public"."tprobe" ("time") values ($1)', [1], 'public.tprobe')
        check([{ time: 1 }], 'insert into "Tt3_Case" ("time") values ($1)', [1], 'Tt3_Case')
    })
})


describe('genInsert: object values are always bound parameters, never sub-queries (W1)', function() {
    it('should bind a GeoJSON-like object as is (pg serializes it as JSON)', function() {
        let geo = { type: 'Point', coordinates: [1, 2] }
        let r = genInsert('t', [{ time: 1, js: geo }])
        assert.strictEqual(r.query, 'insert into "t" ("time", "js") values ($1, $2)')
        assert.deepStrictEqual(r.values, [1, geo])
        assert.strictEqual(r.values[1], geo)
    })
    it('should bind sub-query-looking objects, Dates, arrays and Buffers carrying a "type" property as values', function() {
        let evil = { type: 'select', table: 'tsecret', columns: ['pw'] }
        let d = Object.assign(new Date(1), { type: 'select', table: 'tsecret', columns: ['pw'] })
        let a = Object.assign([1, 2], { type: 'select', table: 'tsecret', columns: ['pw'] })
        let b = Object.assign(Buffer.from('x'), { type: 'select', table: 'tsecret', columns: ['pw'] })
        let r = genInsert('t', [{ time: 1, o: evil, d, a, b, f: new Foo() }])
        assert.strictEqual(r.query, 'insert into "t" ("time", "o", "d", "a", "b", "f") values ($1, $2, $3, $4, $5, $6)')
        assert.ok(!/select/.test(r.query))
    })
    it('should bind objects the same way even when Object.prototype or Array.prototype carries a "type" property', function() {
        Object.prototype.type = 'select'
        Array.prototype.type = 'select'
        try {
            let r = genInsert('t', [{ time: 1, o: { a: 1 }, a: [1], d: new Date(1) }])
            assert.strictEqual(r.query, 'insert into "t" ("time", "o", "a", "d") values ($1, $2, $3, $4)')
        }
        finally {
            delete Object.prototype.type
            delete Array.prototype.type
        }
    })
    it('should keep objects with toPostgres or toJSON untouched (pg decides serialization)', function() {
        let tp = {
            toPostgres() {
                return 'custom'
            }
        }
        let tj = {
            toJSON() {
                return 'j'
            }
        }
        let r = genInsert('t', [{ time: 1, tp, tj }])
        assert.strictEqual(r.values[1], tp)
        assert.strictEqual(r.values[2], tj)
    })
    it('should not call toJSON or any getter of the values', function() {
        let calls = 0
        let o = {
            toJSON() {
                calls++; return 'j'
            }
        }
        genInsert('t', [{ time: 1, o }])
        assert.strictEqual(calls, 0)
    })
})


describe('genInsert: keys and structure', function() {
    it('should double quote characters inside keys instead of breaking out of the identifier', function() {
        let r = genInsert('t', [{ 'time': 1, 'we"ird': 2, 'x") values (1); drop table t; --': 3 }])
        assert.strictEqual(r.query, 'insert into "t" ("time", "we""ird", "x"") values (1); drop table t; --") values ($1, $2, $3)')
        assert.deepStrictEqual(r.values, [1, 2, 3])
    })
    it('should keep the order of first appearance and fill DEFAULT for missing values', function() {
        let r = genInsert('t', [{ b: 1, a: 2 }, { c: 3, b: 4 }])
        assert.strictEqual(r.query, 'insert into "t" ("b", "a", "c") values ($1, $2, DEFAULT), ($3, DEFAULT, $4)')
        assert.deepStrictEqual(r.values, [1, 2, 4, 3])
    })
    it('should not modify the input rows', function() {
        let rows = [{ time: 1, js: { type: 'a' }, n: null }]
        let s = JSON.stringify(rows)
        genInsert('t', rows)
        assert.strictEqual(JSON.stringify(rows), s)
    })
    it('should throw when no column has a value', function() {
        assert.throws(() => genInsert('t', [{}]), /no column to insert/)
        assert.throws(() => genInsert('t', [{ a: undefined }]), /no column to insert/)
    })
    it('should bind own "__proto__" key as a column value without touching prototypes', function() {
        let row = JSON.parse('{"time":1,"__proto__":{"x":1}}')
        let r = genInsert('t', [row])
        assert.strictEqual(r.query, 'insert into "t" ("time", "__proto__") values ($1, $2)')
        assert.strictEqual(Object.getPrototypeOf(r.values[1]), Object.prototype)
    })
    it('should treat an own non-enumerable property like a missing key in a batch (Argon F-4: values are read only from own enumerable properties, like the column list)', function() {
        let r1 = { time: 1, role: 'user' }
        let r2 = { time: 2 }
        Object.defineProperty(r2, 'role', { value: 'hidden_admin', enumerable: false })
        assert.deepStrictEqual(genInsert('t', [r2]).values, [2])
        let r = genInsert('t', [r1, r2])
        assert.strictEqual(r.query, 'insert into "t" ("time", "role") values ($1, $2), ($3, DEFAULT)')
        assert.deepStrictEqual(r.values, [1, 'user', 2])
    })
    it('should not read values of keys that a row lacks from a polluted Object.prototype (fill DEFAULT)', function() {
        Object.prototype.role = 'admin'
        try {
            let r = genInsert('t', [{ time: 1, role: 'user' }, { time: 2 }])
            assert.strictEqual(r.query, 'insert into "t" ("time", "role") values ($1, $2), ($3, DEFAULT)')
            assert.deepStrictEqual(r.values, [1, 'user', 2])
        }
        finally {
            delete Object.prototype.role
        }
    })
    it('should use a table name that already contains double quotes as is (quoteTable)', function() {
        let r = genInsert('"rvo.dot"', [{ time: 1 }])
        assert.strictEqual(r.query, 'insert into "rvo.dot" ("time") values ($1)')
        assert.strictEqual(genInsert('"Po_Q"', [{ time: 1 }]).query, 'insert into "Po_Q" ("time") values ($1)')
    })
})


describe('cvColumns: data keys of UPDATE must be bare identifiers (W2)', function() {
    it('should accept identifier keys (incl. Infinity and oid)', function() {
        assert.doesNotThrow(() => cvColumns(['name', 'n_1', '中文', 'Name', 'Infinity', 'oid']))
    })
    let bads = ['$inc', '$dec', '$custom', 'a.b', 'a"b', 'a b', 'a->b', 'a::int', '', '1a', '__proto__', 'c'.repeat(64), 'a;b', 'a--', 'ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax']
    bads.forEach((k) => {
        it(`should throw unsupported column name for ${JSON.stringify(k.length > 20 ? k.slice(0, 20) + '...' : k)}`, function() {
            assert.throws(() => cvColumns(['name', k]), /unsupported column name|too long/)
        })
    })
})


describe('genInsert: keys that exist on Object.prototype are ordinary column names (Argon round 2)', function() {
    it('should fill DEFAULT for a row that lacks an own "constructor" column instead of binding Object', function() {
        let r = genInsert('users', [{ id: 1, constructor: 'admin' }, { id: 2 }])
        assert.strictEqual(r.query, 'insert into "users" ("id", "constructor") values ($1, $2), ($3, DEFAULT)')
        assert.deepStrictEqual(r.values, [1, 'admin', 2])
    })
})


describe('genInsert: data keys with NUL or a lone surrogate throw a clear check error (W7)', function() {
    let bads = [['NUL', 'a\u0000b'], ['lone high surrogate', 'a\ud800b'], ['lone low surrogate', 'a\udc00b']]
    bads.forEach(([label, k]) => {
        it(`should throw invalid data key for ${label} without echoing it`, function() {
            assert.throws(() => genInsert('t', [{ time: 1, [k]: 1 }]), (e) => e instanceof Error && /^invalid data key/.test(e.message) && !e.message.includes(k))
        })
        it(`should throw for ${label} found in a later row`, function() {
            assert.throws(() => genInsert('t', [{ time: 1 }, { time: 2, [k]: 1 }]), /^Error: invalid data key/)
        })
        it(`should ignore ${label} when its value is undefined (keys are checked only when written)`, function() {
            let r = genInsert('t', [{ time: 1, [k]: undefined }])
            assert.strictEqual(r.query, 'insert into "t" ("time") values ($1)')
        })
    })
    it('should accept well-formed surrogate pairs and other control characters in keys (quoted)', function() {
        let r = genInsert('t', [{ 'time': 1, 'a😀b': 2, 'a\tb': 3 }])
        assert.strictEqual(r.query, 'insert into "t" ("time", "a😀b", "a\tb") values ($1, $2, $3)')
    })
})


describe('genConflict: ON CONFLICT clause with quoted names, only defined non-pk columns (W5, W6)', function() {
    it('should give DO NOTHING when no row is given or the row has nothing to update', function() {
        assert.strictEqual(genConflict('time'), 'ON CONFLICT ("time") DO NOTHING')
        assert.strictEqual(genConflict('time', {}), 'ON CONFLICT ("time") DO NOTHING')
        assert.strictEqual(genConflict('time', { time: 1 }), 'ON CONFLICT ("time") DO NOTHING')
        assert.strictEqual(genConflict('time', { time: 1, a: undefined, b: undefined }), 'ON CONFLICT ("time") DO NOTHING')
    })
    it('should set every defined non-pk column from EXCLUDED, in key order, with quoted names', function() {
        assert.strictEqual(genConflict('time', { time: 1, name: 'a', n: 0, z: null }), 'ON CONFLICT ("time") DO UPDATE SET "name" = EXCLUDED."name", "n" = EXCLUDED."n", "z" = EXCLUDED."z"')
        assert.strictEqual(genConflict('time', { name: 'a', time: 1 }), 'ON CONFLICT ("time") DO UPDATE SET "name" = EXCLUDED."name"')
    })
    it('should skip keys whose value is undefined (the column is not in the INSERT list and must keep its value)', function() {
        assert.strictEqual(genConflict('time', { time: 1, name: undefined, n: 2 }), 'ON CONFLICT ("time") DO UPDATE SET "n" = EXCLUDED."n"')
        let evil = 'name = (SELECT pw FROM tsecret LIMIT 1) --'
        let c = genConflict('time', { time: 1, [evil]: undefined, n: 2 })
        assert.ok(!c.includes('tsecret') && !c.includes('SELECT'), c)
    })
    it('should keep case, spaces and hyphens (quoted) and double the double quotes inside names', function() {
        assert.strictEqual(genConflict('Id', { 'Id': 1, 'userName': 'x', 'my col': 1, 'n-1': 2 }), 'ON CONFLICT ("Id") DO UPDATE SET "userName" = EXCLUDED."userName", "my col" = EXCLUDED."my col", "n-1" = EXCLUDED."n-1"')
        assert.strictEqual(genConflict('a"b', { 'a"b': 1, 'x"; drop table t; --': 2 }), 'ON CONFLICT ("a""b") DO UPDATE SET "x""; drop table t; --" = EXCLUDED."x""; drop table t; --"')
    })
    it('should list exactly the columns that genInsert lists (same selection, so EXCLUDED."k" is always an inserted column)', function() {
        let rows = [
            { time: 1, a: 1, b: undefined, c: null, d: 'x' },
            { 'time': 2, 'we"ird': 1, 'e': undefined },
            { a: undefined, f: [] },
        ]
        rows.forEach((r) => {
            let ins = genInsert('t', [r]).query.match(/\(([^)]*)\) values/)[1].split(', ')
            let set = (genConflict('time', r).match(/SET (.*)$/) || [null, ''])[1].split(', ').filter((x) => x).map((x) => x.split(' = ')[0])
            let expected = ins.filter((x) => x !== '"time"')
            assert.deepStrictEqual(set, expected)
        })
    })
    it('should ignore inherited keys (a polluted Object.prototype adds no column)', function() {
        Object.prototype.role = 'admin'
        try {
            assert.strictEqual(genConflict('time', { time: 1, name: 'a' }), 'ON CONFLICT ("time") DO UPDATE SET "name" = EXCLUDED."name"')
        }
        finally {
            delete Object.prototype.role
        }
    })
    it('should throw invalid data key for a written key with NUL or a lone surrogate, and ignore it when undefined', function() {
        assert.throws(() => genConflict('time', { 'time': 1, 'a\u0000b': 1 }), /^Error: invalid data key/)
        assert.throws(() => genConflict('time', { 'time': 1, 'a\ud800b': 1 }), /^Error: invalid data key/)
        assert.strictEqual(genConflict('time', { 'time': 1, 'a\u0000b': undefined }), 'ON CONFLICT ("time") DO NOTHING')
    })
    it('should quote a pk name that has capitals or quotes', function() {
        assert.strictEqual(genConflict('Time'), 'ON CONFLICT ("Time") DO NOTHING')
        assert.strictEqual(genConflict('a"b'), 'ON CONFLICT ("a""b") DO NOTHING')
    })
})


describe('quoteKey: double quotes the name and doubles the quotes inside it', function() {
    it('should quote', function() {
        assert.strictEqual(quoteKey('time'), '"time"')
        assert.strictEqual(quoteKey('Id'), '"Id"')
        assert.strictEqual(quoteKey('a"b'), '"a""b"')
    })
})


describe('isColumnName: plain identifier test shared with the find and UPDATE key grammar (W4, W6)', function() {
    it('should accept identifiers (letters incl. non-ASCII, digits, underscore; up to 63 bytes)', function() {
        for (let k of ['time', 'Name', '_x', 'a1', 'n_1', '中文', 'ключ', 'a'.repeat(63), '中'.repeat(21)]) {
            assert.strictEqual(isColumnName(k), true, k)
        }
    })
    it('should reject everything else, and non-strings', function() {
        for (let k of ['', 'a b', 'a"b', 'a;b', 'a.b', 'a-b', 'a$b', '$a', '1a', 'a->b', 'a::int', '__proto__', 'a\u0000b', 'a\ud800b', 'a\nb', 'a'.repeat(64), '中'.repeat(22), null, undefined, 1, {}, [], Symbol('x'), true]) {
            assert.strictEqual(isColumnName(k), false, String(typeof k === 'symbol' ? 'symbol' : k))
        }
    })
    it('should accept Infinity and other number-like words (the Infinity ban came from mongo-sql reading numeric keys as array indexes; knex has no such rule)', function() {
        //舊規格斷言 isColumnName('Infinity') 為 false: 該限制源自 mongo-sql 以 +key>=0 判陣列索引而產生字面 undefined; 換 knex 後已無此限制(行為變更 2)
        for (let k of ['Infinity', 'infinity', 'NaN', 'Infinity2', 'e5', '_1']) {
            assert.strictEqual(isColumnName(k), true, k)
        }
    })
    it('should reject the system column names ctid, tableoid, xmin, xmax, cmin, cmax (an unqualified reference resolves to them), but accept oid and other cases', function() {
        //行為變更 3: 欄名不加表限定後, 系統欄可被未限定識別字解析(PG 不允許建立同名欄), 一律拒收; oid 自 PG 12 起非系統欄
        for (let k of ['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax']) {
            assert.strictEqual(isColumnName(k), false, k)
        }
        for (let k of ['oid', 'XMIN', 'Ctid', 'xmin2', '_ctid']) {
            assert.strictEqual(isColumnName(k), true, k) //引用後大小寫有別, "XMIN" 不是系統欄 xmin
        }
    })
})


describe('cvTable: table name for DDL must be plain or fully quoted identifiers (W4)', function() {
    it('should give the same text as quoteTable for ordinary names', function() {
        for (let t of ['tt', 'Tt', 'a.b', 'public.tt', '"x.y"', '"a"."b"', '"a""b"', 'a$b', '中文表', '_x1', 'a'.repeat(63)]) {
            assert.strictEqual(cvTable(t), quoteTable(t), t)
        }
        assert.strictEqual(cvTable('tt'), '"tt"')
        assert.strictEqual(cvTable('a.b'), '"a"."b"')
        assert.strictEqual(cvTable('"x.y"'), '"x.y"')
        assert.strictEqual(cvTable('Tt3_Case'), '"Tt3_Case"')
    })
    it('should reject unquoted names that are not plain identifiers (spaces, hyphens, ;, |, keywords such as IF NOT EXISTS, symbols, digit first, over 63 bytes)', function() {
        for (let t of ['a b', 'a;b', 'a|b', 'a-b', 'IF NOT EXISTS t', 'TEMP t', 'a/*', '*', '1abc', 'a.1b', '😀', 'a\tb', 'a\nb', 'a'.repeat(64), '中'.repeat(22), 'a.b c']) {
            assert.throws(() => cvTable(t), (e) => e instanceof Error && /^invalid table name/.test(e.message) && (t === '' || !e.message.replace('invalid table name', '').includes(t)), JSON.stringify(t))
        }
    })
    it('should throw invalid table name (no echo) for names whose quoted form is not made of quoted identifiers only', function() {
        let bads = ['a"b', '"a"b', '"a" b', 'a"; drop table x; --', '"a"; drop table x; --', 'a->1; drop table x; --', 'a->>b', 'a#>b', 'a::int', 'a.*', 'a..b', '.a', 'a.', '', '""', '"a"."', 'a\u0000b', 'a\ud800b']
        for (let t of bads) {
            assert.throws(() => cvTable(t), (e) => e instanceof Error && /^invalid table name/.test(e.message) && (t === '' || !e.message.replace('invalid table name', '').includes(t)), JSON.stringify(t))
        }
    })
    it('should throw for non-string table names', function() {
        for (let t of [null, undefined, 1, {}, [], Symbol('x'), true, () => 'a']) {
            assert.throws(() => cvTable(t), /^Error: invalid table name/)
        }
    })
})
