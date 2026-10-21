import assert from 'assert'
import fs from 'fs'
import path from 'path'
import lowerFindCases from 'wsemi/src/_lowerFindCases.mjs'
import { cvFind } from '../src/cvFind.mjs'
import { SEMANTICS, SQL, NO_SQL_SKELETON, norm } from './tools/irSemantics.mjs'


//irSemantics 掛接(unit, 不連線): pg 自有之 SQL 骨架(tools/irSemantics.mjs 之 SQL)以 id 掛接 wsemi 共用契約表(_lowerFindCases 之 semantics);
//find / ir / hits 由 wsemi 擁有, 本套件不另存. 規格句(第 94 項第①步):
//  I1 SQL 骨架之每個 id 須存在於 wsemi 表(wsemi 刪改 id 時本套件即紅, 不靜默少測)
//  I2 wsemi 表之每個 id 須有 SQL 骨架, 或明列於 NO_SQL_SKELETON(免除); 兩者不得重疊, 免除清單不得有重複或不存在於 wsemi 之 id(wsemi 新增 id 時本套件即紅, 須補骨架或明列免除)
//  I3 SEMANTICS 之每筆 = wsemi 之 find / ir / hits + 本套件之 where / values(順序依 wsemi 表)
//  I4 經本套件 cvFind(含 pg 專屬 maxParams / checkColumn)所得之 IR = wsemi 表之期望 IR(pg 專屬限制不改變 IR)
//  I5 lowerFind / lowerFindEq 只自 wsemi 引入, src 內不持有本地副本(IR 契約單一擁有者 = wsemi)
let srcDir = path.resolve('./src')
let readSrc = (f) => fs.readFileSync(path.join(srcDir, f), 'utf8')
let table = lowerFindCases.semantics
let tableIds = table.map((s) => s.id)

describe('irSemantics(unit): pg SQL skeletons hooked to the wsemi lowerFind contract table by id (I1-I4)', function() {
    it('should have every SQL skeleton id in the wsemi table (I1)', function() {
        let stray = Object.keys(SQL).filter((id) => !tableIds.includes(id))
        assert.deepStrictEqual(stray, [], `skeleton ids missing from the wsemi table: ${stray.join(', ')}`)
    })

    it('should have every wsemi id either hooked to a SQL skeleton or explicitly exempted, never both (I2)', function() {
        assert.strictEqual(new Set(tableIds).size, tableIds.length, 'wsemi ids are unique')
        assert.strictEqual(new Set(NO_SQL_SKELETON).size, NO_SQL_SKELETON.length, 'exempt ids are unique')
        let stray = NO_SQL_SKELETON.filter((id) => !tableIds.includes(id))
        assert.deepStrictEqual(stray, [], `exempt ids missing from the wsemi table: ${stray.join(', ')}`)
        let both = NO_SQL_SKELETON.filter((id) => Object.hasOwn(SQL, id))
        assert.deepStrictEqual(both, [], `ids both hooked and exempted: ${both.join(', ')}`)
        let open = tableIds.filter((id) => !Object.hasOwn(SQL, id) && !NO_SQL_SKELETON.includes(id))
        assert.deepStrictEqual(open, [], `wsemi ids with neither a SQL skeleton nor an exemption: ${open.join(', ')}`)
        assert.strictEqual(Object.keys(SQL).length + NO_SQL_SKELETON.length, tableIds.length)
    })

    it('should build SEMANTICS from the wsemi entries plus the pg skeletons, in the order of the wsemi table (I3)', function() {
        assert.deepStrictEqual(SEMANTICS.map((s) => s.id), tableIds.filter((id) => Object.hasOwn(SQL, id)))
        SEMANTICS.forEach((s) => {
            let t = table.find((x) => x.id === s.id)
            assert.strictEqual(s.find, t.find, `${s.id}: find is the wsemi function`)
            assert.strictEqual(s.ir, t.ir, `${s.id}: ir is the wsemi value`)
            assert.strictEqual(s.hits, t.hits, `${s.id}: hits is the wsemi value`)
            assert.strictEqual(s.where, SQL[s.id].where, `${s.id}: where`)
            assert.strictEqual(s.values, SQL[s.id].values, `${s.id}: values`)
        })
    })

    it('should give the expected IR of every hooked case through cvFind with the pg options (I4)', function() {
        SEMANTICS.forEach((s) => {
            assert.deepStrictEqual(norm(cvFind(s.find())), s.ir, s.id)
        })
    })

    it('should take lowerFind and lowerFindEq from wsemi only and keep no local copy in src (I5)', function() {
        let files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.mjs'))
        assert.deepStrictEqual(files.filter((f) => /lowerfind/i.test(f)), [], 'no local lowerFind file in src')
        let count = (s, re) => (s.match(re) || []).length
        assert.strictEqual(count(readSrc('cvFind.mjs'), /^import lowerFind from 'wsemi\/src\/lowerFind\.mjs'$/gm), 1)
        assert.strictEqual(count(readSrc('WOrmPostgresql.mjs'), /^import lowerFindEq from 'wsemi\/src\/lowerFindEq\.mjs'$/gm), 1)
        for (let f of files) {
            let s = readSrc(f)
            assert.ok(!/from '\.\/lowerFind/.test(s), `${f}: no import of a local lowerFind`)
            assert.ok(!/\beqNode\b/.test(s), `${f}: eqNode is now lowerFindEq of wsemi`)
        }
    })
})
