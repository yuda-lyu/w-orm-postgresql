//產生 IR 契約快照 test/tools/ir-snapshots.json: wsemi 共用案例表中 cvOrmFind 接受者 -> lowerFind 之 IR(Date 以 { $date: 毫秒 }).
//快照是跨後端契約的對拍資料(日後 IR 移至共用套件、其他後端採用時, 以此逐筆對拍其發射器之輸入); unit-lowerfind 逐筆比對現行 lowerFind 輸出, 差異即契約變更, 須有意識地重產:
//  node test/tools/genIrSnapshots.mjs        (直接執行即重產; 然後審閱 git diff 再提交)
//超過 20000 字元之案(大型 $in)不入快照.
import fs from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import cvOrmFind from 'wsemi/src/cvOrmFind.mjs'
import cvCases from 'wsemi/src/_cvOrmFindCases.mjs'
import { lowerFind } from '../../src/lowerFind.mjs'
import { norm } from './irSemantics.mjs'

export let buildSnapshots = () => {
    let items = []
    for (let c of cvCases.cases) {
        let ir = null
        try {
            ir = lowerFind(cvOrmFind(c.find()), { maxParams: Infinity })
        }
        catch (err) {
            continue //共用層拒收者無 IR
        }
        let n = norm(ir)
        if (JSON.stringify(n).length <= 20000) {
            items.push({ id: `wsemi:${c.id}`, ir: n })
        }
    }
    return items
}

let file = fileURLToPath(new URL('./ir-snapshots.json', import.meta.url))
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    let items = buildSnapshots()
    fs.writeFileSync(file, JSON.stringify(items, null, 1))
    console.log('wrote', file, items.length)
}
