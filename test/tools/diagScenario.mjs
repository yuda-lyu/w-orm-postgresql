//診斷輸出測試(R18)之共用情境: 對一個WOrmPostgresql實例依序執行各操作(成功與失敗), 回傳各結果與事件payload, 供回傳契約之比對
//同一情境亦於修改前之程式(git HEAD)執行以產生固定預期值(golden), 故此檔不得依賴R18之任何新功能
//evs除事件payload外, 每個操作結算(resolve或reject)後插入['done', 序號]標記, 使事件與結果之先後(時機)亦納入比對


let ID = 'u-secret-001@example.com'
let PW = 'S3cretPw'


//settle, 結果以{ ok }或{ err, kind, code }表示: kind為reject值之型別(Error物件為其建構子名稱, 其餘為typeof), code為字串型錯誤代碼; 使「Error物件reject」與「字串reject」、後端錯誤類別與代碼納入比對
let settle = async (pm) => {
    try {
        return { ok: await pm }
    }
    catch (err) {
        let isErr = err instanceof Error
        return {
            err: String(err && err.message ? err.message : err),
            kind: isErr ? err.constructor.name : typeof err,
            code: isErr && typeof err.code === 'string' ? err.code : undefined,
        }
    }
}


//hook, 掛上change與error訂閱函數並記錄事件payload; withBadListener為true時訂閱函數皆拋錯(觸發診斷輸出之站點)
function hook(w, withBadListener) {
    let evs = []
    w.on('change', (m, d, r) => {
        evs.push(['change', m, d, r])
        if (withBadListener) {
            throw new Error(`listener ${ID} ${PW}`)
        }
    })
    w.on('error', (m, d, e) => {
        evs.push(['error', m, d, e])
        if (withBadListener) {
            throw new Error(`listener ${ID} ${PW}`)
        }
    })
    return evs
}


//step, 執行一個操作並記錄結果與結算標記
async function step(evs, out, pm) {
    let r = await settle(pm)
    evs.push(['done', out.length])
    out.push(r)
}


//scenario, 對可連線之資料庫依序執行各操作(表名cl須為不存在之新表, 主鍵欄為id)
async function scenario(w, cl, withBadListener) {
    let evs = hook(w, withBadListener)
    let out = []
    await step(evs, out, w.createTable(cl, 'id', { id: 'x', name: 'x', value: 1 }))
    await step(evs, out, w.createTable(cl, 'id', { id: 'x', name: 'x', value: 1 })) //已存在: 後端錯誤
    await step(evs, out, w.createTable('bad;name', 'id', { id: 'x' })) //表名不合: 連線前整批reject
    await step(evs, out, w.createTable(cl, 'id', 'not-an-object')) //樣本非物件: 連線前整批reject(訊息為既有契約, 含樣本原文)
    await step(evs, out, w.delAll({}))
    await step(evs, out, w.insert([{ id: 'a1', name: 'n1', value: 1 }, { id: 'a2', name: 'n2', value: 2 }]))
    await step(evs, out, w.insert({ id: 'a1', name: 'dup' }))
    await step(evs, out, w.insertBulk([{ id: 'a1', name: 'dup' }]))
    await step(evs, out, w.save([{ id: 'a1', name: 'n1x' }, { id: 'a3', name: 'n3' }]))
    await step(evs, out, w.select({ id: 'a1' }))
    await step(evs, out, w.selectByPk('a2'))
    await step(evs, out, w.select({ $foo: 1 }))
    await step(evs, out, w.del({ id: 'a2' }))
    await step(evs, out, w.delAll({}))
    return { out, evs }
}


//scenarioConn, 對不可連線之資料庫執行各操作(連線失敗之reject與error事件)
async function scenarioConn(w, withBadListener) {
    let evs = hook(w, withBadListener)
    let out = []
    await step(evs, out, w.createTable('tconn', 'id', { id: 'x' }))
    await step(evs, out, w.select({}))
    await step(evs, out, w.selectByPk('a1'))
    await step(evs, out, w.insert({ id: 'a1', name: 'n1' }))
    await step(evs, out, w.insertBulk([{ id: 'a1', name: 'n1' }]))
    await step(evs, out, w.save({ id: 'a1', name: 'n1' }))
    await step(evs, out, w.del({ id: 'a1' }))
    await step(evs, out, w.delAll({}))
    return { out, evs }
}


export { scenario, scenarioConn, settle, hook, ID, PW }
