//節點語意期望表之 pg 部分: 以 id 掛接 wsemi 共用契約表(wsemi/src/_lowerFindCases.mjs 之 semantics)與 pg 自有之期望 SQL 骨架.
//find / ir / hits / seed 列由 wsemi 擁有(IR 契約之人讀版本, 跨後端獨立對拍用), 本檔**不另存**; 本檔只存 pg 自有的 SQL 骨架(where 子句與綁定值),
//全部**手寫**(依 SQL 三值邏輯推導), 不由被測碼產生.
//掛接規則(unit-irsemantics 守住): ①SQL 之每個 id 須存在於 wsemi 表; ②wsemi 表之每個 id 須有 SQL 骨架, 或明列於 NO_SQL_SKELETON(免除).
//用途: unit-sqlbuild(IR -> SQL)、api-matrix(真 PostgreSQL 命中集合)共用 SEMANTICS.
//
//固定資料表 SEM_ROWS = wsemi 之 seed()(欄: id 主鍵, s 文字, n 整數, b 布林, d 時間; NULL 以 null 表示):
//  id s      n    b      d
//  1  'a'    1    true   2020-01-01
//  2  'b'    2    false  2021-01-01
//  3  null   null null   null
//  4  'a'    3    true   2022-01-01
//  5  '$x$'  4    false  null
//  6  ''     0    null   2023-01-01
import lowerFindCases from 'wsemi/src/_lowerFindCases.mjs'

export let SEM_ROWS = lowerFindCases.seed()

//norm: IR(或任何含 Date 之結構) -> 純 JSON 物件(Date -> { $date: ms }; -0 -> { $negZero: true }; null 原型 -> 一般物件), 為 wsemi 契約表之同一函數
export let norm = lowerFindCases.norm

let D = (iso) => ({ $date: new Date(iso).getTime() })

//每筆: where(期望 SQL where 子句, 空字串為無條件)、values(期望綁定值; Date 以 { $date })
export let SQL = {
    //---- cmp
    'eq-string': { where: 'where "s" = $1', values: ['a'] },
    'eq-string-explicit': { where: 'where "s" = $1', values: ['a'] },
    'eq-empty-string': { where: 'where "s" = $1', values: [''] },
    'eq-number-zero': { where: 'where "n" = $1', values: [0] },
    'ne-string': { where: 'where "s" != $1', values: ['a'] },
    'gt': { where: 'where "n" > $1', values: [1] },
    'gte': { where: 'where "n" >= $1', values: [2] },
    'lt': { where: 'where "n" < $1', values: [2] },
    'lte': { where: 'where "n" <= $1', values: [1] },
    'date-eq': { where: 'where "d" = $1', values: [D('2020-01-01T00:00:00Z')] },
    'date-gt': { where: 'where "d" > $1', values: [D('2021-06-01T00:00:00Z')] },
    'dollar-eq': { where: 'where "s" = $1', values: ['$x$'] },
    'dollar-ne': { where: 'where "s" != $1', values: ['$x$'] },
    'dollar-gte': { where: 'where "s" >= $1', values: ['$x$'] },
    //---- bool(SQL 三值: NULL 列不命中任何布林比較, 含 ne)
    'bool-eq-true': { where: 'where "b" IS TRUE', values: [] },
    'bool-eq-false': { where: 'where "b" IS FALSE', values: [] },
    'bool-ne-true': { where: 'where "b" IS FALSE', values: [] },
    'bool-ne-false': { where: 'where "b" IS TRUE', values: [] },
    'bool-gt-false': { where: 'where "b" > FALSE', values: [] },
    'bool-lte-true': { where: 'where "b" <= TRUE', values: [] },
    //---- null
    'null-eq': { where: 'where "s" is null', values: [] },
    'null-eq-explicit': { where: 'where "s" is null', values: [] },
    'null-ne': { where: 'where "s" is not null', values: [] },
    //---- in
    'in': { where: 'where "n" in ($1, $2)', values: [1, 3] },
    'in-empty': { where: 'where false', values: [] },
    'nin': { where: 'where "n" not in ($1, $2)', values: [1, 3] },
    'in-bool-elements': { where: 'where "b" in ($1)', values: [true] },
    'in-dollar': { where: 'where "s" in ($1)', values: ['$x$'] },
    //---- and / or / 展開 / 攤平 / 隱含 AND
    'multi-column-and': { where: 'where "s" = $1 and "b" IS TRUE', values: ['a'] },
    'same-column-ops': { where: 'where "n" > $1 and "n" < $2', values: [0, 3] },
    'or': { where: 'where ("s" = $1 or "n" > $2)', values: ['b', 3] },
    'and': { where: 'where "s" = $1 and "n" > $2', values: ['a', 1] },
    'or-single-item': { where: 'where "s" = $1', values: ['b'] },
    'and-single-item': { where: 'where "n" in ($1)', values: [1] },
    'or-flatten': { where: 'where ("s" = $1 or "s" = $2 or "s" = $3)', values: ['a', 'b', ''] },
    'and-flatten': { where: 'where "s" = $1 and "b" IS TRUE and "n" > $2', values: ['a', 1] },
    'nested-and-in-or': { where: 'where (("s" = $1 and "n" < $2) or "s" = $3)', values: ['a', 3, ''] },
    'column-beside-or': { where: 'where "b" IS TRUE and ("s" = $1 or "n" = $2)', values: ['a', 3] },
    //---- 無條件
    'empty-object': { where: '', values: [] },
    'undefined': { where: '', values: [] },
}

//免除: wsemi 表中本套件(尚)無 SQL 骨架之 id. 本批(第 94 項第①步)只掛接原有 40 筆骨架, 其餘 45 筆之 find -> IR -> hits 由 wsemi 契約測試以獨立求值器守住,
//未對真 PostgreSQL 執行(日後補骨架即自此清單移出, 由 unit-irsemantics 守住兩邊不重疊).
export let NO_SQL_SKELETON = [
    'bool-gte-true', 'bool-lt-true', 'nin-bool-elements', 'in-date',
    'multi-column-three', 'multi-op-eq-ne', 'multi-op-in-nin', 'multi-op-in-empty',
    'and-contradict', 'and-ne-null', 'or-null', 'or-ne-null',
    'single-item-chain', 'and-flatten-implicit', 'nested-or-in-and', 'same-column-and-or', 'bool-ne-in-or',
    'bool-gt-true', 'bool-gte-false', 'bool-lt-false', 'bool-lte-false',
    'in-bool-false', 'in-bool-both', 'nin-bool-false',
    'date-ne', 'date-gte', 'date-lt', 'date-lte', 'date-ms-eq', 'date-ms-gt', 'date-ms-lt', 'date-nonmidnight', 'nin-date',
    'ne-number', 'eq-negative-zero',
    'string-gt-empty', 'string-lte-empty', 'string-lt-collation', 'nin-string',
    'in-unsorted-duplicates', 'or-empty-in', 'or-empty-in-null',
    'numeric-string-eq', 'numeric-string-in', 'numeric-string-nonconvertible',
]

//SEMANTICS: wsemi 表中有 SQL 骨架者(依 wsemi 表之順序), 每筆 = wsemi 之 { id, node, find, ir, hits } + pg 之 { where, values }
export let SEMANTICS = lowerFindCases.semantics.filter((s) => Object.hasOwn(SQL, s.id)).map((s) => ({ ...s, ...SQL[s.id] }))
