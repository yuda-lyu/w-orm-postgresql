//節點語意期望表: IR 節點 -> find 構造 -> 期望 IR -> 期望 SQL 骨架(where 子句與綁定值) -> 期望命中集合.
//全部**手寫**(依 SQL 三值邏輯推導), 不由被測碼產生; 同時是 IR 契約的人讀版本(契約本文見 src/lowerFind.mjs 檔頭).
//用途: unit-lowerfind(find -> IR)、unit-sqlbuild(IR -> SQL)、api-matrix(真 PostgreSQL 命中集合)共用同一張表, 日後 IR 移至共用套件時隨之發布,
//使其他後端(如 reladb、mdb)的發射器可獨立以同一張表對拍.
//
//固定資料表 SEM_ROWS(欄: id 主鍵, s 文字, n 整數, b 布林, d 時間; NULL 以 null 表示):
//  id s      n    b      d
//  1  'a'    1    true   2020-01-01
//  2  'b'    2    false  2021-01-01
//  3  null   null null   null
//  4  'a'    3    true   2022-01-01
//  5  '$x$'  4    false  null
//  6  ''     0    null   2023-01-01
//期望 IR 以純物件表示(Date 以 { $date: 毫秒 }, 比對前先把 IR 正規化為同形); p 為來源路徑.

export let SEM_ROWS = [
    { id: 1, s: 'a', n: 1, b: true, d: new Date('2020-01-01T00:00:00Z') },
    { id: 2, s: 'b', n: 2, b: false, d: new Date('2021-01-01T00:00:00Z') },
    { id: 3, s: null, n: null, b: null, d: null },
    { id: 4, s: 'a', n: 3, b: true, d: new Date('2022-01-01T00:00:00Z') },
    { id: 5, s: '$x$', n: 4, b: false, d: null },
    { id: 6, s: '', n: 0, b: null, d: new Date('2023-01-01T00:00:00Z') },
]

//norm: IR(或任何含 Date 之結構) -> 純 JSON 物件(Date -> { $date: ms }; null 原型 -> 一般物件)
export let norm = (x) => JSON.parse(JSON.stringify(x, function(k, v) {
    let raw = this[k]
    return raw instanceof Date ? { $date: raw.getTime() } : v
}))

let D = (iso) => ({ $date: new Date(iso).getTime() })
let cmp = (c, op, v, p) => ({ t: 'cmp', c, op, v, p })
let bool = (c, op, v, p) => ({ t: 'bool', c, op, v, p })
let nul = (c, not, p) => ({ t: 'null', c, not, p })
let inn = (c, vs, not, p) => ({ t: 'in', c, vs, not, p })

//每筆: id, node(涵蓋之節點/語意), find(工廠函數, 每次產生新物件), ir(期望), where(期望 SQL where 子句, 空字串為無條件), values(期望綁定值; Date 以 { $date }), hits(期望命中 id, 升冪)
export let SEMANTICS = [
    //---- cmp
    { id: 'eq-string', node: 'cmp eq', find: () => ({ s: 'a' }), ir: cmp('s', 'eq', 'a', 'find.s'), where: 'where "s" = $1', values: ['a'], hits: [1, 4] },
    { id: 'eq-string-explicit', node: 'cmp eq', find: () => ({ s: { $eq: 'a' } }), ir: cmp('s', 'eq', 'a', 'find.s.$eq'), where: 'where "s" = $1', values: ['a'], hits: [1, 4] },
    { id: 'eq-empty-string', node: 'cmp eq', find: () => ({ s: '' }), ir: cmp('s', 'eq', '', 'find.s'), where: 'where "s" = $1', values: [''], hits: [6] },
    { id: 'eq-number-zero', node: 'cmp eq', find: () => ({ n: 0 }), ir: cmp('n', 'eq', 0, 'find.n'), where: 'where "n" = $1', values: [0], hits: [6] },
    { id: 'ne-string', node: 'cmp ne (three-valued: NULL row never hits)', find: () => ({ s: { $ne: 'a' } }), ir: cmp('s', 'ne', 'a', 'find.s.$ne'), where: 'where "s" != $1', values: ['a'], hits: [2, 5, 6] },
    { id: 'gt', node: 'cmp gt', find: () => ({ n: { $gt: 1 } }), ir: cmp('n', 'gt', 1, 'find.n.$gt'), where: 'where "n" > $1', values: [1], hits: [2, 4, 5] },
    { id: 'gte', node: 'cmp gte', find: () => ({ n: { $gte: 2 } }), ir: cmp('n', 'gte', 2, 'find.n.$gte'), where: 'where "n" >= $1', values: [2], hits: [2, 4, 5] },
    { id: 'lt', node: 'cmp lt', find: () => ({ n: { $lt: 2 } }), ir: cmp('n', 'lt', 2, 'find.n.$lt'), where: 'where "n" < $1', values: [2], hits: [1, 6] },
    { id: 'lte', node: 'cmp lte', find: () => ({ n: { $lte: 1 } }), ir: cmp('n', 'lte', 1, 'find.n.$lte'), where: 'where "n" <= $1', values: [1], hits: [1, 6] },
    { id: 'date-eq', node: 'cmp eq Date', find: () => ({ d: new Date('2020-01-01T00:00:00Z') }), ir: cmp('d', 'eq', D('2020-01-01T00:00:00Z'), 'find.d'), where: 'where "d" = $1', values: [D('2020-01-01T00:00:00Z')], hits: [1] },
    { id: 'date-gt', node: 'cmp gt Date', find: () => ({ d: { $gt: new Date('2021-06-01T00:00:00Z') } }), ir: cmp('d', 'gt', D('2021-06-01T00:00:00Z'), 'find.d.$gt'), where: 'where "d" > $1', values: [D('2021-06-01T00:00:00Z')], hits: [4, 6] },
    { id: 'dollar-eq', node: 'cmp eq: $..$ string is a literal', find: () => ({ s: '$x$' }), ir: cmp('s', 'eq', '$x$', 'find.s'), where: 'where "s" = $1', values: ['$x$'], hits: [5] },
    { id: 'dollar-ne', node: 'cmp ne: $..$ string is a literal', find: () => ({ s: { $ne: '$x$' } }), ir: cmp('s', 'ne', '$x$', 'find.s.$ne'), where: 'where "s" != $1', values: ['$x$'], hits: [1, 2, 4, 6] },
    { id: 'dollar-gte', node: 'cmp gte: $..$ string is a literal (no longer rejected)', find: () => ({ s: { $gte: '$x$' } }), ir: cmp('s', 'gte', '$x$', 'find.s.$gte'), where: 'where "s" >= $1', values: ['$x$'], hits: null }, //排序規則依資料庫 collation, 命中集合不寫死(只驗 IR 與 SQL)
    //---- bool(SQL 三值: NULL 列不命中任何布林比較, 含 ne)
    { id: 'bool-eq-true', node: 'bool eq', find: () => ({ b: true }), ir: bool('b', 'eq', true, 'find.b'), where: 'where "b" IS TRUE', values: [], hits: [1, 4] },
    { id: 'bool-eq-false', node: 'bool eq', find: () => ({ b: false }), ir: bool('b', 'eq', false, 'find.b'), where: 'where "b" IS FALSE', values: [], hits: [2, 5] },
    { id: 'bool-ne-true', node: 'bool ne (three-valued)', find: () => ({ b: { $ne: true } }), ir: bool('b', 'ne', true, 'find.b.$ne'), where: 'where "b" IS FALSE', values: [], hits: [2, 5] },
    { id: 'bool-ne-false', node: 'bool ne (three-valued)', find: () => ({ b: { $ne: false } }), ir: bool('b', 'ne', false, 'find.b.$ne'), where: 'where "b" IS TRUE', values: [], hits: [1, 4] },
    { id: 'bool-gt-false', node: 'bool gt', find: () => ({ b: { $gt: false } }), ir: bool('b', 'gt', false, 'find.b.$gt'), where: 'where "b" > FALSE', values: [], hits: [1, 4] },
    { id: 'bool-lte-true', node: 'bool lte', find: () => ({ b: { $lte: true } }), ir: bool('b', 'lte', true, 'find.b.$lte'), where: 'where "b" <= TRUE', values: [], hits: [1, 2, 4, 5] },
    //---- null
    { id: 'null-eq', node: 'null', find: () => ({ s: null }), ir: nul('s', false, 'find.s'), where: 'where "s" is null', values: [], hits: [3] },
    { id: 'null-eq-explicit', node: 'null', find: () => ({ s: { $eq: null } }), ir: nul('s', false, 'find.s.$eq'), where: 'where "s" is null', values: [], hits: [3] },
    { id: 'null-ne', node: 'null not', find: () => ({ s: { $ne: null } }), ir: nul('s', true, 'find.s.$ne'), where: 'where "s" is not null', values: [], hits: [1, 2, 4, 5, 6] },
    //---- in
    { id: 'in', node: 'in', find: () => ({ n: { $in: [1, 3] } }), ir: inn('n', [1, 3], false, 'find.n.$in'), where: 'where "n" in ($1, $2)', values: [1, 3], hits: [1, 4] },
    { id: 'in-empty', node: 'in empty = constant false (no binding, no column reference)', find: () => ({ n: { $in: [] } }), ir: inn('n', [], false, 'find.n.$in'), where: 'where false', values: [], hits: [] },
    { id: 'nin', node: 'in not (three-valued: NULL row never hits)', find: () => ({ n: { $nin: [1, 3] } }), ir: inn('n', [1, 3], true, 'find.n.$nin'), where: 'where "n" not in ($1, $2)', values: [1, 3], hits: [2, 5, 6] },
    { id: 'in-bool-elements', node: 'in with boolean elements (bound as parameters)', find: () => ({ b: { $in: [true] } }), ir: inn('b', [true], false, 'find.b.$in'), where: 'where "b" in ($1)', values: [true], hits: [1, 4] },
    { id: 'in-dollar', node: 'in: $..$ string is a literal', find: () => ({ s: { $in: ['$x$'] } }), ir: inn('s', ['$x$'], false, 'find.s.$in'), where: 'where "s" in ($1)', values: ['$x$'], hits: [5] },
    //---- and / or / 展開 / 攤平 / 隱含 AND
    { id: 'multi-column-and', node: 'implicit AND of columns', find: () => ({ s: 'a', b: true }), ir: { t: 'and', a: [cmp('s', 'eq', 'a', 'find.s'), bool('b', 'eq', true, 'find.b')] }, where: 'where "s" = $1 and "b" IS TRUE', values: ['a'], hits: [1, 4] },
    { id: 'same-column-ops', node: 'implicit AND of operators on one column', find: () => ({ n: { $gt: 0, $lt: 3 } }), ir: { t: 'and', a: [cmp('n', 'gt', 0, 'find.n.$gt'), cmp('n', 'lt', 3, 'find.n.$lt')] }, where: 'where "n" > $1 and "n" < $2', values: [0, 3], hits: [1, 2] },
    { id: 'or', node: 'or', find: () => ({ $or: [{ s: 'b' }, { n: { $gt: 3 } }] }), ir: { t: 'or', a: [cmp('s', 'eq', 'b', 'find.$or[0].s'), cmp('n', 'gt', 3, 'find.$or[1].n.$gt')] }, where: 'where ("s" = $1 or "n" > $2)', values: ['b', 3], hits: [2, 5] },
    { id: 'and', node: 'and', find: () => ({ $and: [{ s: 'a' }, { n: { $gt: 1 } }] }), ir: { t: 'and', a: [cmp('s', 'eq', 'a', 'find.$and[0].s'), cmp('n', 'gt', 1, 'find.$and[1].n.$gt')] }, where: 'where "s" = $1 and "n" > $2', values: ['a', 1], hits: [4] },
    { id: 'or-single-item', node: 'single-item or is unwrapped', find: () => ({ $or: [{ s: 'b' }] }), ir: cmp('s', 'eq', 'b', 'find.$or[0].s'), where: 'where "s" = $1', values: ['b'], hits: [2] },
    { id: 'and-single-item', node: 'single-item and is unwrapped', find: () => ({ $and: [{ n: { $in: [1] } }] }), ir: inn('n', [1], false, 'find.$and[0].n.$in'), where: 'where "n" in ($1)', values: [1], hits: [1] },
    { id: 'or-flatten', node: 'same-type nesting is flattened (n-ary)', find: () => ({ $or: [{ $or: [{ s: 'a' }, { s: 'b' }] }, { s: '' }] }), ir: { t: 'or', a: [cmp('s', 'eq', 'a', 'find.$or[0].$or[0].s'), cmp('s', 'eq', 'b', 'find.$or[0].$or[1].s'), cmp('s', 'eq', '', 'find.$or[1].s')] }, where: 'where ("s" = $1 or "s" = $2 or "s" = $3)', values: ['a', 'b', ''], hits: [1, 2, 4, 6] },
    { id: 'and-flatten', node: 'same-type nesting is flattened (n-ary)', find: () => ({ $and: [{ $and: [{ s: 'a' }, { b: true }] }, { n: { $gt: 1 } }] }), ir: { t: 'and', a: [cmp('s', 'eq', 'a', 'find.$and[0].$and[0].s'), bool('b', 'eq', true, 'find.$and[0].$and[1].b'), cmp('n', 'gt', 1, 'find.$and[1].n.$gt')] }, where: 'where "s" = $1 and "b" IS TRUE and "n" > $2', values: ['a', 1], hits: [4] },
    { id: 'nested-and-in-or', node: 'and inside or keeps its parentheses', find: () => ({ $or: [{ $and: [{ s: 'a' }, { n: { $lt: 3 } }] }, { s: '' }] }), ir: { t: 'or', a: [{ t: 'and', a: [cmp('s', 'eq', 'a', 'find.$or[0].$and[0].s'), cmp('n', 'lt', 3, 'find.$or[0].$and[1].n.$lt')] }, cmp('s', 'eq', '', 'find.$or[1].s')] }, where: 'where (("s" = $1 and "n" < $2) or "s" = $3)', values: ['a', 3, ''], hits: [1, 6] },
    { id: 'column-beside-or', node: 'column key beside $or is ANDed with it', find: () => ({ b: true, $or: [{ s: 'a' }, { n: 3 }] }), ir: { t: 'and', a: [bool('b', 'eq', true, 'find.b'), { t: 'or', a: [cmp('s', 'eq', 'a', 'find.$or[0].s'), cmp('n', 'eq', 3, 'find.$or[1].n')] }] }, where: 'where "b" IS TRUE and ("s" = $1 or "n" = $2)', values: ['a', 3], hits: [1, 4] },
    //---- 無條件
    { id: 'empty-object', node: 'no condition = null IR (all rows)', find: () => ({}), ir: null, where: '', values: [], hits: [1, 2, 3, 4, 5, 6] },
    { id: 'undefined', node: 'no condition = null IR (all rows)', find: () => undefined, ir: null, where: '', values: [], hits: [1, 2, 3, 4, 5, 6] },
]
