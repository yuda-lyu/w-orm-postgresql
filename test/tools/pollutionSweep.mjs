//汙染掃描器: 以資料型汙染(內建原型被加上屬性)逐一測 buildSelect/buildDelete, 比對輸出與無汙染基準.
//背景: knex 內部以一般物件承載 limit/schema/only/distinct/returning 等選項並讀取其繼承值, 原型被汙染時其 SQL 可能靜默改變或拋 TypeError;
//本套件不改動全域原型, 由 verifySql(詞彙序列 + 值逐一比對)與建句例外轉換 fail-closed. 判準(每一組 [原型, 屬性名, 值]):
//  same  : 輸出與基準逐字相同
//  threw : 以固定格式 invalid find|order ... (statement check) 拒絕(fail-closed), 不洩漏 knex 內部訊息
//  diff  : 輸出不同於基準而未拒絕 = 靜默改變, 須為 0
//  leak  : 以其他格式拋錯(洩漏內部訊息或非預期例外), 須為 0
//用法:
//  單元測試: import { sweep, KEY_NAMES, VALUES, buildBaseline } from './tools/pollutionSweep.mjs'
//  全量掃描(升版 knex 時須重跑; 母體 = node_modules/knex/lib 內出現過之屬性名, 不證明無未知名稱——證明力來自 verifySql 不論名稱皆比對全文):
//    node test/tools/pollutionSweep.mjs --all                 Object.prototype × 全部屬性名 × 7 種值
//    node test/tools/pollutionSweep.mjs --all --protos        另掃 Array/Function/String/Number/Boolean/Symbol 原型
//  non-configurable 變體(無法被移除之汙染)請由 unit-sqlbuild 的子行程測試覆蓋.
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import cvOrmFind from 'wsemi/src/cvOrmFind.mjs'
import { lowerFind } from '../../src/lowerFind.mjs'
import { buildSelect, buildDelete, dialectPg } from '../../src/buildSql.mjs'

//KEY_NAMES: 高風險屬性名(knex 查詢建構器的選項/內部狀態名)
export let KEY_NAMES = ['limit', 'offset', 'join', 'having', 'schema', 'only', 'distinct', 'returning', 'using', 'union', 'group', 'columns', 'where', 'order', 'wrapIdentifier', 'client', '_single', '_statements', '_method', 'alias', 'table', 'with', 'hint', 'timeout']
export let VALUES = [5, 'x', ['a'], { a: 1 }, true]

//SYMBOL_NAMES / SYMBOL_VALUES: well-known Symbol 鍵(split、replace、match… 以字串為引數之內建方法會查 arg[Symbol.xxx], 內建原型被加上函式值可改寫結果; 需程式碼執行權, 非資料型汙染, 但縱深防禦須不受影響; 外審 opus F3)
export let SYMBOL_NAMES = [Symbol.split, Symbol.replace, Symbol.match, Symbol.matchAll, Symbol.search, Symbol.iterator, Symbol.toPrimitive, Symbol.isConcatSpreadable, Symbol.species, Symbol.hasInstance, Symbol.toStringTag, Symbol.unscopables, Symbol.asyncIterator]
export let SYMBOL_VALUES = [() => [], function() {
    return ['x']
}, () => 'zz', () => true, 5, 'x', { a: 1 }, null]

//buildAll: 以代表性的 find/order 建 select 與 delete 語句(含巢狀 or/and、in/not in、恆假 in、布林、null、schema.table 表名、order 多鍵)
let ir = null
let order = null
export let buildAll = () => {
    if (ir === null) {
        ir = lowerFind(cvOrmFind({ $or: [{ s: 'a', i: { $gt: 1 } }, { b: { $ne: true } }, { d: null }], n: { $in: [1, 2, 3] }, x: { $nin: ['q'] }, e: { $in: [] } }), { maxParams: dialectPg.maxParams, checkColumn: dialectPg.checkColumn })
        order = [Object.assign(Object.create(null), { c: 'i', dir: 'desc', nulls: 'last' }), Object.assign(Object.create(null), { c: 'j', dir: 'asc', nulls: null })]
    }
    let s = buildSelect('sch.t', ir, order)
    let d = buildDelete('sch.t', ir)
    let s2 = buildSelect('t', null)
    let s3 = buildSelect('t', null, order)
    return JSON.stringify([s.query, s.values, d.query, d.values, s2.query, s2.values, s3.query, s3.values])
}
export let buildBaseline = () => buildAll()

//classify: 在目前狀態(已汙染)下建句, 回傳 same|threw|diff|leak
let classify = (base) => {
    let r = null
    try {
        r = buildAll()
    }
    catch (err) {
        let m = String(err && err.message)
        return /^invalid (find|order): internal statement check failed \(statement check\): .+ at \[(find|order)\]$/.test(m) ? 'threw' : 'leak'
    }
    return r === base ? 'same' : 'diff'
}

/**
 * 掃描
 *
 * @param {Object} opt { proto: 被汙染之原型(預設 Object.prototype), names, values, onThrew(name, value, kind) }
 * @returns {Object} { same, threw, diff, leak, diffs:[...], leaks:[...] }
 */
export let sweep = (opt = {}) => {
    let proto = opt.proto || Object.prototype
    let names = opt.names || KEY_NAMES
    let values = opt.values || VALUES
    let base = buildBaseline()
    let res = { same: 0, threw: 0, diff: 0, leak: 0, diffs: [], leaks: [], threws: [] }
    for (let n of names) {
        if (Object.prototype.hasOwnProperty.call(proto, n)) {
            continue //不覆寫內建成員(那是程式碼執行權層級, 非資料型汙染)
        }
        for (let v of values) {
            Object.defineProperty(proto, n, { value: v, configurable: true, writable: true, enumerable: true })
            let k = null
            try {
                k = classify(base)
            }
            finally {
                delete proto[n]
            }
            res[k] += 1
            if (k === 'threw') {
                res.threws.push(n)
            }
            if (k === 'diff') {
                res.diffs.push([n, typeof v === 'function' ? 'fn' : JSON.stringify(v)])
            }
            if (k === 'leak') {
                res.leaks.push([n, typeof v === 'function' ? 'fn' : JSON.stringify(v)])
            }
        }
    }
    return res
}

//namesFromKnexLib: 掃 node_modules/knex/lib 內出現過之屬性名(.name 與 ['name'])
export let namesFromKnexLib = () => {
    let root = path.join(path.dirname(createRequire(import.meta.url).resolve('knex')), 'lib')
    let names = new Set()
    let walk = (d) => {
        for (let f of fs.readdirSync(d, { withFileTypes: true })) {
            let p = path.join(d, f.name)
            if (f.isDirectory()) {
                if (!/dialects$/.test(d) || f.name === 'postgres') {
                    walk(p)
                }
            }
            else if (f.name.endsWith('.js')) {
                let s = fs.readFileSync(p, 'utf8')
                for (let m of s.matchAll(/\.([A-Za-z_$][\w$]*)/g)) {
                    names.add(m[1])
                }
                for (let m of s.matchAll(/\[['"]([A-Za-z_$][\w$]*)['"]\]/g)) {
                    names.add(m[1])
                }
            }
        }
    }
    walk(root)
    for (let n of ['connection', 'pool', 'client', 'dialect', 'version', 'searchPath', 'wrapIdentifier', 'postProcessResponse']) {
        names.add(n)
    }
    let skip = new Set(['constructor', 'prototype', '__proto__'])
    return [...names].filter((n) => !skip.has(n))
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    let all = process.argv.includes('--all')
    let names = all ? namesFromKnexLib() : KEY_NAMES
    let values = all ? ['zz', 1, true, { a: 1 }, ['x', 'y'], () => 1, null] : VALUES
    if (process.argv.includes('--symbols')) {
        //另掃 well-known Symbol 鍵(函式/資料值)
        for (let proto of [Object.prototype, Array.prototype, String.prototype, Function.prototype]) {
            let r = sweep({ proto, names: SYMBOL_NAMES, values: SYMBOL_VALUES })
            console.log('symbols', Object.prototype.toString.call(proto), JSON.stringify({ same: r.same, threw: r.threw, diff: r.diff, leak: r.leak }))
            if (r.diff > 0 || r.leak > 0) {
                process.exitCode = 1
            }
        }
    }
    let protos = process.argv.includes('--protos') ? [Object.prototype, Array.prototype, Function.prototype, String.prototype, Number.prototype, Boolean.prototype, Symbol.prototype] : [Object.prototype]
    console.log('names', names.length, 'values', values.length, 'prototypes', protos.length)
    let tot = { same: 0, threw: 0, diff: 0, leak: 0 }
    for (let proto of protos) {
        let r = sweep({ proto, names, values })
        for (let k of Object.keys(tot)) {
            tot[k] += r[k]
        }
        console.log(Object.prototype.toString.call(proto), JSON.stringify({ same: r.same, threw: r.threw, diff: r.diff, leak: r.leak }))
        if (process.argv.includes('--list-threw')) {
            console.log('  THREW names:', [...new Set(r.threws)].join(' '))
        }
        r.diffs.slice(0, 10).forEach((d) => console.log('  SILENT DIFF', d.join(' | ')))
        r.leaks.slice(0, 10).forEach((d) => console.log('  LEAK', d.join(' | ')))
    }
    console.log('TOTAL', JSON.stringify(tot), tot.diff === 0 && tot.leak === 0 ? 'OK (no silent change, no leak)' : 'FAILED')
    process.exitCode = tot.diff === 0 && tot.leak === 0 ? 0 : 1
}
