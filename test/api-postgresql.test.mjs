import assert from 'assert'
import net from 'net'
import path from 'path'
import pg from 'pg'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import isestr from 'wsemi/src/isestr.mjs'
import WOrm from '../src/WOrmPostgresql.mjs'


//測試自行創建docker容器供PostgreSQL服務, 測試結束即銷毀, 故僅需環境已安裝docker


let execFileAsync = promisify(execFile)

let ctName = 'worm-test-postgresql'
let ctImage = 'postgres:17-alpine'
let ctUser = 'username'
let ctPassword = 'password'
let ctDb = 'worm'
let ctPort = null //容器對外埠, 由getFreePort動態取得, 避免與既有PostgreSQL服務搶5432


let delay = (ms) => {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

//getFreePort, 由系統配發空閒埠
let getFreePort = () => {
    return new Promise((resolve, reject) => {
        let srv = net.createServer()
        srv.on('error', reject)
        srv.listen(0, () => {
            let port = srv.address().port
            srv.close(() => {
                resolve(port)
            })
        })
    })
}

//docker, 以陣列傳參不經shell, 避免路徑與引號轉譯問題
let docker = (args) => {
    return execFileAsync('docker', args)
}

//genUrl
let genUrl = () => {
    return `postgresql://${ctUser}:${ctPassword}@127.0.0.1:${ctPort}`
}

//genOpt
let genOpt = (cl = 'users', useCache = false) => {
    return {
        url: genUrl(),
        db: ctDb,
        cl,
        useCache,
    }
}

//probeReady, 以pg直連容器對外埠試跑SELECT 1
//不使用容器內pg_isready, 因postgres映像初始化期間會先啟動僅監聽unix socket之臨時服務,
//pg_isready預設亦走unix socket故會提早回報就緒, 直連TCP方為測試實際所走路徑
let probeReady = async () => {
    let client = new pg.Client({ connectionString: `${genUrl()}/${ctDb}` })
    let ok = false
    try {
        await client.connect()
        await client.query('SELECT 1')
        ok = true
    }
    catch (err) {
        ok = false
    }
    finally {
        await client.end().catch(() => {})
    }
    return ok
}

//startContainer, 創建容器並等待服務就緒
//postgres映像以POSTGRES_USER、POSTGRES_PASSWORD、POSTGRES_DB即建妥帳號與資料庫, 無須另跑建置語句
let startContainer = async () => {

    //check docker
    await docker(['version', '--format', '{{.Server.Version}}'])
        .catch(() => {
            throw new Error('需先安裝並啟動docker才能執行postgresql測試')
        })

    //清除前次殘留容器
    await docker(['rm', '-f', ctName]).catch(() => {})

    //run
    ctPort = await getFreePort()
    await docker(['run', '-d', '--rm', '--name', ctName, '-e', `POSTGRES_USER=${ctUser}`, '-e', `POSTGRES_PASSWORD=${ctPassword}`, '-e', `POSTGRES_DB=${ctDb}`, '-p', `${ctPort}:5432`, ctImage])

    //等待服務就緒, 首次需拉取映像故給予較長時間
    let ready = false
    for (let i = 0; i < 90; i++) {
        let ok = await probeReady()
        if (ok) {
            ready = true
            break
        }
        await delay(2000)
    }
    if (!ready) {
        throw new Error('postgresql容器啟動逾時')
    }

}

//stopContainer, 銷毀容器
let stopContainer = async () => {
    await docker(['rm', '-f', ctName]).catch(() => {})
}


before(async function() {
    this.timeout(600000) //含拉取映像與服務啟動
    await startContainer()
})

after(async function() {
    this.timeout(120000)
    await stopContainer()
})


describe('basic', function() {
    let rt = null
    let vans = {}
    let vget = {}

    before(async function () {

        let opt = genOpt('users')

        let rs = [
            {
                time: '2025-01-01T00:00:00Z',
                name: 'peter',
                value: 123,
            },
            {
                time: '2025-01-01T00:01:00Z',
                name: 'rosemary',
                value: 123.456,
            },
            {
                time: '2025-01-01T00:02:00Z',
                name: 'kettle',
                value: 456,
            },
            {
                time: '2025-01-01T00:03:00Z',
                name: 'peter',
                value: 200,
            },
            {
                time: '2025-01-01T00:04:00Z',
                name: 'rosemary',
                value: 123.1236,
            },
            {
                time: '2025-01-01T00:05:00Z',
                name: 'kettle',
                value: 488,
            },
            {
                time: '2025-01-01T00:06:00Z',
                name: 'peter',
                value: 125,
            },
            {
                time: '2025-01-01T00:07:00Z',
                name: 'rosemary',
                value: 124.76,
            },
            {
                time: '2025-01-01T00:08:00Z',
                name: 'kettle',
                value: 524,
            },
            {
                time: '2025-01-01T00:09:00Z',
                name: 'peter',
                value: 127,
            },
            {
                time: '2025-01-01T00:10:00Z',
                name: 'rosemary',
                value: 113.98,
            },
            {
                time: '2025-01-01T00:11:00Z',
                name: 'kettle',
                value: 447,
            },
            {
                time: '2025-01-01T00:12:00Z',
                name: 'peter',
                value: 131,
            },
        ]

        let rsm = [
            { //相同
                time: '2025-01-01T00:09:00Z',
                name: 'peter',
                value: 127,
            },
            { //name變更
                time: '2025-01-01T00:10:00Z',
                name: 'rosemary(modify)',
                value: 113.98,
            },
            { //name變更
                time: '2025-01-01T00:11:00Z',
                name: 'kettle(modify)',
                value: 447,
            },
            { //無name且value變更
                time: '2025-01-01T00:12:00Z',
                // name: 'peter',
                value: 99,
            },
            { //無time須新增且新增數據無value
                time: '2025-01-01T00:13:00Z',
                name: 'sandler',
            },
        ]

        let rsa = [
            {
                time: '2025-01-01T00:13:00Z',
                name: 'sandler',
            },
        ]

        //wo
        let wo = WOrm(opt)

        //on
        wo.on('change', function(mode, data, res) {
            // console.log('change', mode)
        })

        await wo.createTable(opt.cl, 'time', {
            time: '2000-01-01T00:00:00Z', //time
            name: 'abc', //string
            value: 0.1, //float
        })
            .then(function(msg) {
                // console.log('createTable then', msg)
            })
            .catch(function(msg) {
                // console.log('createTable catch', msg)
            })

        //delAll
        rt = null
        // vans[1] = { ok: 1 }
        await wo.delAll()
            .then(function(msg) {
                // console.log('delAll then', msg)
                //考慮有不同初始狀態, 僅比對ok欄位
                rt = {
                    ok: msg.ok,
                }
            })
            .catch(function(msg) {
                // console.log('delAll catch', msg)
                rt = msg.toString()
            })
        vget[1] = rt

        //insert
        rt = null
        // vans[2] = { n: 13, nInserted: 13, ok: 1 }
        await wo.insert(rs)
            .then(function(msg) {
                // console.log('insert then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('insert catch', msg)
                rt = msg.toString()
            })
        vget[2] = rt

        //save
        rt = null
        // vans[3] = [
        //     { n: 1, nModified: 0, ok: 1 },
        //     { n: 1, nModified: 1, ok: 1 },
        //     { n: 1, nModified: 1, ok: 1 },
        //     { n: 1, nModified: 1, ok: 1 },
        //     { n: 0, nModified: 0, ok: 1 }
        // ]
        await wo.save(rsm, { autoInsert: false })
            .then(function(msg) {
                // console.log('save then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('save catch', msg)
                rt = msg.toString()
            })
        vget[3] = rt

        //select all
        rt = null
        // vans[4] = [
        //     { time: new Date('2025-01-01T00:00:00.000Z'), name: 'peter', value: 123 },
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        //     { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        //     { time: new Date('2025-01-01T00:03:00.000Z'), name: 'peter', value: 200 },
        //     { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        //     { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
        //     { time: new Date('2025-01-01T00:06:00.000Z'), name: 'peter', value: 125 },
        //     { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
        //     { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
        //     { time: new Date('2025-01-01T00:09:00.000Z'), name: 'peter', value: 127 },
        //     { time: new Date('2025-01-01T00:10:00.000Z'), name: 'rosemary(modify)', value: 113.98 },
        //     { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 },
        //     { time: new Date('2025-01-01T00:12:00.000Z'), name: 'peter', value: 99 }
        // ]
        await wo.select()
            .then(function(msg) {
                // console.log('select all then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('select all catch', msg)
                rt = msg.toString()
            })
        vget[4] = rt

        //select all by cache
        rt = null
        // vans[5] = vans[4]
        await wo.select()
            .then(function(msg) {
                // console.log('select all by cache then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('select all by cache catch', msg)
                rt = msg.toString()
            })
        vget[5] = rt

        //select by name
        rt = null
        // vans[6] = [
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        //     { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        //     { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 }
        // ]
        await wo.select({ name: 'rosemary' })
            .then(function(msg) {
                // console.log('select all then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('select all catch', msg)
                rt = msg.toString()
            })
        vget[6] = rt

        //selectByTime
        rt = null
        // vans[18] = { time: new Date('2025-01-01T00:10:00.000Z'), name: 'rosemary(modify)', value: 113.98 }
        await wo.selectByTime('2025-01-01T00:10:00Z')
            .then(function(msg) {
                // console.log('selectByTime then', msg)
                // selectByTime { time: 2025-01-01T00:10:00.000Z, name: 'rosemary(modify)', value: 113.98 }
                rt = msg
            })
            .catch(function(msg) {
                // console.log('selectByTime catch', msg)
                rt = msg.toString()
            })
        vget[18] = rt

        //selectByTime by time not existed
        rt = null
        // vans[19] = null
        await wo.selectByTime('2024-01-01T00:00:00Z')
            .then(function(msg) {
                // console.log('selectByTime by time not existed then', msg)
                // selectByTime by time not existed null
                rt = msg
            })
            .catch(function(msg) {
                // console.log('selectByTime by time not existed catch', msg)
                rt = msg.toString()
            })
        vget[19] = rt

        //selectByTime by time invalid, 未給有效主鍵值視為查無數據
        rt = null
        // vans[20] = null
        await wo.selectByTime('abc')
            .then(function(msg) {
                // console.log('selectByTime by time invalid then', msg)
                // selectByTime by time invalid null
                rt = msg
            })
            .catch(function(msg) {
                // console.log('selectByTime by time invalid catch', msg)
                rt = msg.toString()
            })
        vget[20] = rt

        //select by $and, $gt, $lt
        rt = null
        // vans[7] = [
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        //     { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        //     { time: new Date('2025-01-01T00:06:00.000Z'), name: 'peter', value: 125 },
        //     { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
        //     { time: new Date('2025-01-01T00:09:00.000Z'), name: 'peter', value: 127 }
        // ]
        await wo.select({ '$and': [{ value: { '$gt': 123 } }, { value: { '$lt': 200 } }] })
            .then(function(msg) {
                // console.log('select all then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('select all catch', msg)
                rt = msg.toString()
            })
        vget[7] = rt

        //select by $or, $gte, $lte
        rt = null
        // vans[8] = [
        //     { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        //     { time: new Date('2025-01-01T00:03:00.000Z'), name: 'peter', value: 200 },
        //     { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
        //     { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
        //     { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 }
        // ]
        await wo.select({ '$or': [{ value: { '$lte': -1 } }, { value: { '$gte': 200 } }] })
            .then(function(msg) {
                // console.log('select all then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('select all catch', msg)
                rt = msg.toString()
            })
        vget[8] = rt

        //select by $or, $and, $ne, $in, $nin
        rt = null
        // vans[9] = [
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        //     { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        //     { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
        //     { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
        //     { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 }
        // ]
        await wo.select({ '$or': [{ '$and': [{ value: { '$ne': 123 } }, { value: { '$in': [123, 321, 123.456, 456] } }, { value: { '$nin': [456, 654] } }] }, { '$or': [{ value: { '$lte': -1 } }, { value: { '$gte': 400 } }] }] })
            .then(function(msg) {
                // console.log('select all then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('select all catch', msg)
                rt = msg.toString()
            })
        vget[9] = rt

        // //select by regex
        // rt = null
        // vans[14] = []
        // let sr = await wo.select({ name: { $regex: 'PeT', $options: '$i' } })
        //  .then(function(msg) {
        //      // console.log('select all then', msg)
        //      rt = msg
        //  })
        //  .catch(function(msg) {
        //      // console.log('select all catch', msg)
        //      rt = msg.toString()
        //  })
        //  vget[14] = rt

        //save
        rt = null
        // vans[10] = [{ n: 1, nInserted: 1, ok: 1 }]
        await wo.save(rsa, { autoInsert: true })
            .then(function(msg) {
                // console.log('save then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('save catch', msg)
                rt = msg.toString()
            })
        vget[10] = rt

        //del
        rt = null
        // vans[11] = [{ n: 1, nDeleted: 0, ok: 1 }]
        let d = {
            time: '2024-01-01T00:00:00Z',
        }
        await wo.del(d)
            .then(function(msg) {
                // console.log('del then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('del catch', msg)
                rt = msg.toString()
            })
        vget[11] = rt

        //del
        rt = null
        // vans[12] = [
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 }
        // ]
        let ss = await wo.select()
        let ds = ss.filter(function(v) {
            return v.name.indexOf('peter') >= 0 || v.name.indexOf('kettle') >= 0 || v.name.indexOf('sandler') >= 0
        })
        await wo.del(ds)
            .then(function(msg) {
                // console.log('del then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('del catch', msg)
                rt = msg.toString()
            })
        vget[12] = rt

        //select all final
        rt = null
        // vans[13] = [
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        //     { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        //     { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
        //     { time: new Date('2025-01-01T00:10:00.000Z'), name: 'rosemary(modify)', value: 113.98 }
        // ]
        await wo.select()
            .then(function(msg) {
            // console.log('select all then', msg)
                rt = msg
            })
            .catch(function(msg) {
            // console.log('select all catch', msg)
                rt = msg.toString()
            })
        vget[13] = rt

        //清除數據, 後續cache測試共用users表
        await wo.delAll()

        //woc, 啟用useCache
        let woc = WOrm({
            ...opt,
            useCache: true,
        })

        let rsc = [
            {
                time: '2025-01-01T00:00:00Z',
                name: 'peter',
                value: 123,
            },
            {
                time: '2025-01-01T00:01:00Z',
                name: 'rosemary',
                value: 123.456,
            },
            {
                time: '2025-01-01T00:02:00Z',
                name: 'kettle',
                value: 456,
            },
        ]

        let rscm = [
            {
                time: '2025-01-01T00:01:00Z',
                name: 'rosemary(modify)',
                value: 654.321,
            },
        ]

        //insert
        await woc.insert(rsc)

        //select all (1st time, 從DB讀取並填入快取)
        rt = null
        // vans[14] = [
        //     { time: new Date('2025-01-01T00:00:00.000Z'), name: 'peter', value: 123 },
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        //     { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        // ]
        await woc.select()
            .then(function(msg) {
                // console.log('select 1st then', msg)
                //依time排序, postgres UPDATE後物理順序可能改變
                rt = msg.sort((a, b) => a.time - b.time)
            })
            .catch(function(msg) {
                // console.log('select 1st catch', msg)
                rt = msg.toString()
            })
        vget[14] = rt

        //select all (2nd time, 命中快取, 內容須與第一次相同)
        rt = null
        // vans[15] = vans[14]
        await woc.select()
            .then(function(msg) {
                // console.log('select 2nd then', msg)
                rt = msg.sort((a, b) => a.time - b.time)
            })
            .catch(function(msg) {
                // console.log('select 2nd catch', msg)
                rt = msg.toString()
            })
        vget[15] = rt

        //save (更新rosemary, 觸發快取重設)
        rt = null
        // vans[16] = [{ n: 1, nModified: 1, ok: 1 }]
        await woc.save(rscm, { autoInsert: false })
            .then(function(msg) {
                // console.log('save then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('save catch', msg)
                rt = msg.toString()
            })
        vget[16] = rt

        //select all (3rd time, 快取已重設, 從DB重新讀取, 須反映rosemary更新)
        rt = null
        // vans[17] = [
        //     { time: new Date('2025-01-01T00:00:00.000Z'), name: 'peter', value: 123 },
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary(modify)', value: 654.321 },
        //     { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        // ]
        await woc.select()
            .then(function(msg) {
                // console.log('select 3rd then', msg)
                rt = msg.sort((a, b) => a.time - b.time)
            })
            .catch(function(msg) {
                // console.log('select 3rd catch', msg)
                rt = msg.toString()
            })
        vget[17] = rt

        //selectByTime (1st time, 從DB讀取並填入快取)
        rt = null
        // vans[21] = { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary(modify)', value: 654.321 }
        await woc.selectByTime('2025-01-01T00:01:00Z')
            .then(function(msg) {
                // console.log('selectByTime 1st then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('selectByTime 1st catch', msg)
                rt = msg.toString()
            })
        vget[21] = rt

        //selectByTime (2nd time, 命中快取, 內容須與第一次相同)
        rt = null
        // vans[22] = vans[21]
        await woc.selectByTime('2025-01-01T00:01:00Z')
            .then(function(msg) {
                // console.log('selectByTime 2nd then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('selectByTime 2nd catch', msg)
                rt = msg.toString()
            })
        vget[22] = rt

    })

    vans[1] = { ok: 1 }
    it(`should get ${JSON.stringify(vans[1])} for delAll`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = { n: 13, nInserted: 13, ok: 1 }
    it(`should get ${JSON.stringify(vans[2])} for insert`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = [
        { n: 1, nInserted: 0, nModified: 0, ok: 1 },
        { n: 1, nInserted: 0, nModified: 1, ok: 1 },
        { n: 1, nInserted: 0, nModified: 1, ok: 1 },
        { n: 1, nInserted: 0, nModified: 1, ok: 1 },
        { n: 0, nInserted: 0, nModified: 0, ok: 1 }
    ]
    it(`should get ${JSON.stringify(vans[3])} for save(autoInsert=false)`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = [
        { time: new Date('2025-01-01T00:00:00.000Z'), name: 'peter', value: 123 },
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        { time: new Date('2025-01-01T00:03:00.000Z'), name: 'peter', value: 200 },
        { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
        { time: new Date('2025-01-01T00:06:00.000Z'), name: 'peter', value: 125 },
        { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
        { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
        { time: new Date('2025-01-01T00:09:00.000Z'), name: 'peter', value: 127 },
        { time: new Date('2025-01-01T00:10:00.000Z'), name: 'rosemary(modify)', value: 113.98 },
        { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 },
        { time: new Date('2025-01-01T00:12:00.000Z'), name: 'peter', value: 99 }
    ]
    it(`should get ${JSON.stringify(vans[4])} for select all`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = vans[4]
    it(`should get ${JSON.stringify(vans[5])} for select all by cache`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = [
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 }
    ]
    it(`should get ${JSON.stringify(vans[6])} for select by name`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    //vans[18]~vans[22]為後續新增之selectByTime, 為不更動既有編號故接續於末號之後
    vans[18] = { time: new Date('2025-01-01T00:10:00.000Z'), name: 'rosemary(modify)', value: 113.98 }
    it(`should get ${JSON.stringify(vans[18])} for selectByTime`, async function() {
        assert.strict.deepStrictEqual(vget[18], vans[18])
    })

    vans[19] = null
    it(`should get ${JSON.stringify(vans[19])} for selectByTime by time not existed`, async function() {
        assert.strict.deepStrictEqual(vget[19], vans[19])
    })

    vans[20] = null
    it(`should get ${JSON.stringify(vans[20])} for selectByTime by time invalid`, async function() {
        assert.strict.deepStrictEqual(vget[20], vans[20])
    })

    vans[7] = [
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        { time: new Date('2025-01-01T00:06:00.000Z'), name: 'peter', value: 125 },
        { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
        { time: new Date('2025-01-01T00:09:00.000Z'), name: 'peter', value: 127 }
    ]
    it(`should get ${JSON.stringify(vans[7])} for select by $and, $gt, $lt`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = [
        { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        { time: new Date('2025-01-01T00:03:00.000Z'), name: 'peter', value: 200 },
        { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
        { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
        { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 }
    ]
    it(`should get ${JSON.stringify(vans[8])} for select by $or, $gte, $lte`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = [
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
        { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
        { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 }
    ]
    it(`should get ${JSON.stringify(vans[9])} for select by $or, $and, $ne, $in, $nin`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

    // vans[14] = []
    // it(`should get ${JSON.stringify(vans[14])} for select by regex`, async function() {
    //     assert.strict.deepStrictEqual(vget[14], vans[14])
    // })

    vans[10] = [{ n: 1, nInserted: 1, nModified: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[10])} for save(autoInsert=true)`, async function() {
        assert.strict.deepStrictEqual(vget[10], vans[10])
    })

    vans[11] = [{ n: 0, nDeleted: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[11])} for del`, async function() {
        assert.strict.deepStrictEqual(vget[11], vans[11])
    })

    vans[12] = [
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 }
    ]
    it(`should get ${JSON.stringify(vans[12])} for del`, async function() {
        assert.strict.deepStrictEqual(vget[12], vans[12])
    })

    vans[13] = [
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
        { time: new Date('2025-01-01T00:10:00.000Z'), name: 'rosemary(modify)', value: 113.98 }
    ]
    it(`should get ${JSON.stringify(vans[13])} for select all final`, async function() {
        assert.strict.deepStrictEqual(vget[13], vans[13])
    })

    vans[14] = [
        { time: new Date('2025-01-01T00:00:00.000Z'), name: 'peter', value: 123 },
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
    ]
    it(`should get ${JSON.stringify(vans[14])} for select all (1st, fill cache)`, async function() {
        assert.strict.deepStrictEqual(vget[14], vans[14])
    })

    vans[15] = vans[14]
    it(`should get ${JSON.stringify(vans[15])} for select all (2nd, cache hit)`, async function() {
        assert.strict.deepStrictEqual(vget[15], vans[15])
    })

    vans[16] = [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }]
    it(`should get ${JSON.stringify(vans[16])} for save (invalidate cache)`, async function() {
        assert.strict.deepStrictEqual(vget[16], vans[16])
    })

    vans[17] = [
        { time: new Date('2025-01-01T00:00:00.000Z'), name: 'peter', value: 123 },
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary(modify)', value: 654.321 },
        { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
    ]
    it(`should get ${JSON.stringify(vans[17])} for select all (3rd, reload after save)`, async function() {
        assert.strict.deepStrictEqual(vget[17], vans[17])
    })

    vans[21] = { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary(modify)', value: 654.321 }
    it(`should get ${JSON.stringify(vans[21])} for selectByTime (1st, fill cache)`, async function() {
        assert.strict.deepStrictEqual(vget[21], vans[21])
    })

    vans[22] = vans[21]
    it(`should get ${JSON.stringify(vans[22])} for selectByTime (2nd, cache hit)`, async function() {
        assert.strict.deepStrictEqual(vget[22], vans[22])
    })

})


//insert與save之併發測試, 因各操作皆各自new PgClient另開連線, 原子性全由PostgreSQL提供,
//故同行程以Promise.all併發即等價於跨行程併發, 不須另起行程


describe('insert nInserted', function() {
    let vans = {}
    let vget = {}

    before(async function() {
        this.timeout(120000)

        //wo
        let cl = 'insertcnt'
        let wo = WOrm(genOpt(cl))

        //createTable
        await wo.createTable(cl, 'time', {
            time: '2000-01-01T00:00:00Z',
            name: 'abc',
            value: 0.1,
        }).catch(() => {})
        await wo.delAll()

        //全新3筆
        vget[1] = await wo.insert([
            { time: '2025-02-01T00:00:00Z', name: 'peter', value: 1 },
            { time: '2025-02-01T00:01:00Z', name: 'rosemary', value: 2 },
            { time: '2025-02-01T00:02:00Z', name: 'kettle', value: 3 },
        ])

        //重複插入同3筆, 全數已存在故皆不插入
        vget[2] = await wo.insert([
            { time: '2025-02-01T00:00:00Z', name: 'peter', value: 1 },
            { time: '2025-02-01T00:01:00Z', name: 'rosemary', value: 2 },
            { time: '2025-02-01T00:02:00Z', name: 'kettle', value: 3 },
        ])

        //部份重複, 1筆已存在2筆為新
        vget[3] = await wo.insert([
            { time: '2025-02-01T00:01:00Z', name: 'rosemary', value: 2 },
            { time: '2025-02-01T00:03:00Z', name: 'sandler', value: 4 },
            { time: '2025-02-01T00:04:00Z', name: 'joyce', value: 5 },
        ])

        //同批含重複time, 僅首筆成功
        vget[4] = await wo.insert([
            { time: '2025-02-01T00:05:00Z', name: 'dup-1', value: 6 },
            { time: '2025-02-01T00:05:00Z', name: 'dup-2', value: 7 },
            { time: '2025-02-01T00:06:00Z', name: 'uniq', value: 8 },
        ])

        //併發對同一time插入10次, nInserted總和須為1
        let rs = await Promise.all(Array.from({ length: 10 }, (v, k) => {
            return wo.insert({ time: '2025-02-01T00:07:00Z', name: `race-${k}`, value: k })
        }))
        vget[5] = rs.reduce((sum, v) => sum + v.nInserted, 0)

        //併發皆不得報錯
        vget[6] = rs.filter((v) => v.ok !== 1).length

        //最終筆數, 3+0+2+2+1=8
        let ss = await wo.select()
        vget[7] = ss.length

        //同批重複者僅首筆入庫
        let vdup = await wo.selectByTime('2025-02-01T00:05:00Z')
        vget[8] = vdup.name

    })

    vans[1] = { n: 3, nInserted: 3, ok: 1 }
    it(`should get ${JSON.stringify(vans[1])} for insert 3 new records`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = { n: 3, nInserted: 0, ok: 1 }
    it(`should get ${JSON.stringify(vans[2])} for insert 3 existed records`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = { n: 3, nInserted: 2, ok: 1 }
    it(`should get ${JSON.stringify(vans[3])} for insert 1 existed and 2 new records`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = { n: 3, nInserted: 2, ok: 1 }
    it(`should get ${JSON.stringify(vans[4])} for insert with duplicated time in same batch`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = 1
    it(`should get ${JSON.stringify(vans[5])} for sum of nInserted by 10 concurrent insert with same time`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = 0
    it(`should get ${JSON.stringify(vans[6])} for count of ok!==1 in 10 concurrent insert`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = 8
    it(`should get ${JSON.stringify(vans[7])} for records after all insert`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = 'dup-1'
    it(`should get ${JSON.stringify(vans[8])} for keeping first one of duplicated time in same batch`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

})


describe('save concurrency', function() {
    let vans = {}
    let vget = {}

    before(async function() {
        this.timeout(120000)

        //wo
        let cl = 'saverace'
        let wo = WOrm(genOpt(cl))

        //createTable
        await wo.createTable(cl, 'time', {
            time: '2000-01-01T00:00:00Z',
            name: 'abc',
            value: 0.1,
        }).catch(() => {})
        await wo.delAll()

        //併發save對既有time之不同欄位, 各欄位皆須保留
        let tMerge = '2025-03-01T00:00:00Z'
        await wo.insert({ time: tMerge, name: 'origin', value: 1 })
        await Promise.all([
            wo.save({ time: tMerge, name: 'merge-name' }),
            wo.save({ time: tMerge, value: 99 }),
        ])
        vget[1] = await wo.selectByTime(tMerge)

        //併發save對全新time, autoInsert僅一次且不得報錯
        let tNew = '2025-03-01T00:01:00Z'
        let rsn = await Promise.all(Array.from({ length: 5 }, (v, k) => {
            return wo.save({ time: tNew, name: `new-${k}` })
        }))
        vget[2] = rsn.filter((v) => v[0].nInserted === 1).length
        vget[3] = rsn.filter((v) => v[0].ok !== 1).length
        vget[4] = (await wo.select({ time: tNew })).length

        //save內容相同不更新
        let tSame = '2025-03-01T00:02:00Z'
        await wo.insert({ time: tSame, name: 'same', value: 5 })
        vget[5] = await wo.save({ time: tSame, name: 'same', value: 5 })

        //save內容不同須更新, 未給之欄位須保留
        let tDiff = '2025-03-01T00:03:00Z'
        await wo.insert({ time: tDiff, name: 'diff', value: 5 })
        vget[6] = await wo.save({ time: tDiff, value: 6 })
        vget[7] = await wo.selectByTime(tDiff)

        //save(autoInsert=false)對不存在之time不得插入
        let tNone = '2025-03-01T00:04:00Z'
        vget[8] = await wo.save({ time: tNone, name: 'none' }, { autoInsert: false })
        vget[9] = await wo.selectByTime(tNone)

        //併發save(autoInsert=false)對既有time之不同欄位, 各欄位皆須保留且不得報錯
        let tUpd = '2025-03-01T00:05:00Z'
        await wo.insert({ time: tUpd, name: 'origin', value: 1 })
        let rsu = await Promise.all([
            wo.save({ time: tUpd, name: 'upd-name' }, { autoInsert: false }),
            wo.save({ time: tUpd, value: 88 }, { autoInsert: false }),
        ])
        vget[10] = rsu.filter((v) => v[0].ok !== 1).length
        vget[11] = await wo.selectByTime(tUpd)

    })

    vans[1] = { time: new Date('2025-03-01T00:00:00.000Z'), name: 'merge-name', value: 99 }
    it(`should get ${JSON.stringify(vans[1])} for fields after 2 concurrent save with different field`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = 1
    it(`should get ${JSON.stringify(vans[2])} for count of nInserted===1 in 5 concurrent save with time not existed`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = 0
    it(`should get ${JSON.stringify(vans[3])} for count of ok!==1 in 5 concurrent save with time not existed`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = 1
    it(`should get ${JSON.stringify(vans[4])} for records after 5 concurrent save with time not existed`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = [{ n: 1, nInserted: 0, nModified: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[5])} for save with same content`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }]
    it(`should get ${JSON.stringify(vans[6])} for save with different content`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = { time: new Date('2025-03-01T00:03:00.000Z'), name: 'diff', value: 6 }
    it(`should get ${JSON.stringify(vans[7])} for keeping field not given in save`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = [{ n: 0, nInserted: 0, nModified: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[8])} for save(autoInsert=false) with time not existed`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = null
    it(`should get ${JSON.stringify(vans[9])} for record after save(autoInsert=false) with time not existed`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

    vans[10] = 0
    it(`should get ${JSON.stringify(vans[10])} for count of ok!==1 in 2 concurrent save(autoInsert=false)`, async function() {
        assert.strict.deepStrictEqual(vget[10], vans[10])
    })

    vans[11] = { time: new Date('2025-03-01T00:05:00.000Z'), name: 'upd-name', value: 88 }
    it(`should get ${JSON.stringify(vans[11])} for fields after 2 concurrent save(autoInsert=false) with different field`, async function() {
        assert.strict.deepStrictEqual(vget[11], vans[11])
    })

})


describe('spec compliance', function() {
    let vans = {}
    let vget = {}

    before(async function() {
        this.timeout(120000)

        //wo
        let cl = 'specok'
        let wo = WOrm(genOpt(cl))

        //createTable
        await wo.createTable(cl, 'time', {
            time: '2000-01-01T00:00:00Z',
            name: 'abc',
            value: 0.1,
        }).catch(() => {})
        await wo.delAll()

        //save只給部份欄位且值皆與現值相同, 合併後等於現值故不寫入
        let tPart = '2025-04-01T00:00:00Z'
        await wo.insert({ time: tPart, name: 'peter', value: 5 })
        vget[1] = await wo.save({ time: tPart, value: 5 })
        vget[2] = await wo.selectByTime(tPart)

        //save單筆失敗不中斷整批, 失敗筆須帶err
        let tOk = '2025-04-01T00:01:00Z'
        let tBad = '2025-04-01T00:02:00Z'
        let rsf = await wo.save([
            { time: tOk, name: 'ok' },
            { time: tBad, notexistcol: 1 },
        ])
        vget[3] = rsf.length
        vget[4] = rsf[0]
        vget[5] = {
            n: rsf[1].n,
            nInserted: rsf[1].nInserted,
            nModified: rsf[1].nModified,
            ok: rsf[1].ok,
            hasErr: isestr(rsf[1].err),
        }

        //del未帶有效主鍵者回ok:0且不中斷整批
        let tDel = '2025-04-01T00:03:00Z'
        await wo.insert({ time: tDel, name: 'todel' })
        let rsd = await wo.del([
            { time: tDel },
            { name: 'no-time' },
        ])
        vget[6] = rsd.length
        vget[7] = rsd[0]
        vget[8] = {
            n: rsd[1].n,
            nDeleted: rsd[1].nDeleted,
            ok: rsd[1].ok,
            hasErr: isestr(rsd[1].err),
        }

        //T6例外, insert與save未帶有效time時不補值而reject
        vget[9] = await wo.insert({ name: 'no-time' })
            .then(() => 'resolved')
            .catch(() => 'rejected')
        vget[10] = await wo.save({ name: 'no-time' })
            .then(() => 'resolved')
            .catch(() => 'rejected')

        //T5輸入無效
        vget[11] = await wo.insert(null)
        vget[12] = await wo.save(null)
        vget[13] = await wo.del(null)

        //delAll帶條件且僅部份命中
        let clPart = 'specdelall'
        let woPart = WOrm(genOpt(clPart))
        await woPart.createTable(clPart, 'time', {
            time: '2000-01-01T00:00:00Z',
            name: 'abc',
            value: 0.1,
        }).catch(() => {})
        await woPart.delAll()
        await woPart.insert([
            { time: '2025-05-01T00:00:00Z', name: 'aa', value: 1 },
            { time: '2025-05-01T00:01:00Z', name: 'aa', value: 2 },
            { time: '2025-05-01T00:02:00Z', name: 'bb', value: 3 },
            { time: '2025-05-01T00:03:00Z', name: 'bb', value: 4 },
        ])
        vget[16] = await woPart.delAll({ name: 'aa' })
        vget[17] = (await woPart.select()).length

        //delAll條件無命中
        vget[18] = await woPart.delAll({ name: 'notexist' })

    })

    vans[1] = [{ n: 1, nInserted: 0, nModified: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[1])} for save with partial fields all equal to current`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = { time: new Date('2025-04-01T00:00:00.000Z'), name: 'peter', value: 5 }
    it(`should get ${JSON.stringify(vans[2])} for record unchanged after save with partial fields`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = 2
    it(`should get ${JSON.stringify(vans[3])} for length of save result with 1 failed record`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = { n: 1, nInserted: 1, nModified: 0, ok: 1 }
    it(`should get ${JSON.stringify(vans[4])} for succeeded record in save with 1 failed record`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = { n: 1, nInserted: 0, nModified: 0, ok: 0, hasErr: true }
    it(`should get ${JSON.stringify(vans[5])} for failed record in save`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = 2
    it(`should get ${JSON.stringify(vans[6])} for length of del result with 1 invalid time`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = { n: 1, nDeleted: 1, ok: 1 }
    it(`should get ${JSON.stringify(vans[7])} for succeeded record in del with 1 invalid time`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = { n: 0, nDeleted: 0, ok: 0, hasErr: true }
    it(`should get ${JSON.stringify(vans[8])} for record without valid time in del`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = 'rejected'
    it(`should get ${JSON.stringify(vans[9])} for insert without valid time`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

    vans[10] = 'rejected'
    it(`should get ${JSON.stringify(vans[10])} for save without valid time`, async function() {
        assert.strict.deepStrictEqual(vget[10], vans[10])
    })

    vans[11] = { n: 0, nInserted: 0, ok: 1 }
    it(`should get ${JSON.stringify(vans[11])} for insert with invalid data`, async function() {
        assert.strict.deepStrictEqual(vget[11], vans[11])
    })

    vans[12] = []
    it(`should get ${JSON.stringify(vans[12])} for save with invalid data`, async function() {
        assert.strict.deepStrictEqual(vget[12], vans[12])
    })

    vans[13] = []
    it(`should get ${JSON.stringify(vans[13])} for del with invalid data`, async function() {
        assert.strict.deepStrictEqual(vget[13], vans[13])
    })

    vans[16] = { n: 2, nDeleted: 2, ok: 1 }
    it(`should get ${JSON.stringify(vans[16])} for delAll with find matched partially`, async function() {
        assert.strict.deepStrictEqual(vget[16], vans[16])
    })

    vans[17] = 2
    it(`should get ${JSON.stringify(vans[17])} for records after delAll with find matched partially`, async function() {
        assert.strict.deepStrictEqual(vget[17], vans[17])
    })

    vans[18] = { n: 0, nDeleted: 0, ok: 1 }
    it(`should get ${JSON.stringify(vans[18])} for delAll with find matched nothing`, async function() {
        assert.strict.deepStrictEqual(vget[18], vans[18])
    })

})


//runProc, 另起行程對同一資料表操作, 用於驗證跨行程之原子性
//子行程以--input-type=module執行, 並以pathToFileURL轉換src路徑, 避免專案路徑含非ASCII字元而無法import
function runProc(tag, opt, mode, payload) {
    return new Promise(function(resolve) {
        let code = `
import { pathToFileURL } from 'url'
let { default: WOrm } = await import(pathToFileURL(process.env.SRC).href)
let wo = WOrm({ url: process.env.URL, db: process.env.DB, cl: process.env.CL })
let payload = JSON.parse(process.env.PAYLOAD)
let tag = process.env.TAG
if (process.env.MODE === 'insert') {
    let n = 0
    for (let time of payload) {
        let r = await wo.insert({ time, name: tag, value: 1 })
        n += r.nInserted
    }
    console.log(JSON.stringify({ tag, nInserted: n }))
}
else {
    let nInserted = 0
    let nModified = 0
    for (let f of payload.fields) {
        let r = await wo.save({ time: payload.time, [f]: tag })
        nInserted += r[0].nInserted
        nModified += r[0].nModified
    }
    console.log(JSON.stringify({ tag, nInserted, nModified }))
}
`
        let out = ''
        let p = spawn(process.execPath, ['--input-type=module', '-e', code], {
            shell: false,
            env: {
                ...process.env,
                SRC: path.resolve('./src/WOrmPostgresql.mjs'),
                URL: opt.url,
                DB: opt.db,
                CL: opt.cl,
                MODE: mode,
                PAYLOAD: JSON.stringify(payload),
                TAG: tag,
            },
        })
        p.stdout.on('data', function(d) {
            out += d.toString()
        })
        p.stderr.on('data', function(d) {
            out += d.toString()
        })
        p.on('close', function() {
            let r = null
            try {
                r = JSON.parse(out.trim())
            }
            catch (err) {
                r = { tag, error: out.trim() }
            }
            resolve(r)
        })
    })
}


describe('cross-process concurrency', function() {
    let vans = {}
    let vget = {}

    before(async function() {
        this.timeout(300000)

        //跨行程insert, 兩行程各自對相同20個time插入, nInserted總和須為20且資料表僅20筆
        let clIns = 'xprocinsert'
        let optIns = genOpt(clIns)
        let woIns = WOrm(optIns)
        await woIns.createTable(clIns, 'time', {
            time: '2000-01-01T00:00:00Z',
            name: 'abc',
            value: 0.1,
        }).catch(() => {})
        await woIns.delAll()

        let times = Array.from({ length: 20 }, (v, k) => {
            return `2025-06-01T00:${`${k}`.padStart(2, '0')}:00Z`
        })
        let rps = await Promise.all([
            runProc('p1', optIns, 'insert', times),
            runProc('p2', optIns, 'insert', times),
        ])
        vget[1] = rps.filter((v) => v.error !== undefined).length
        vget[2] = rps.reduce((sum, v) => sum + (v.nInserted || 0), 0)
        vget[3] = (await woIns.select()).length

        //跨行程save對同一time之不同欄位, 兩行程各寫5欄, 10欄須全數保留
        let clSav = 'xprocsave'
        let optSav = genOpt(clSav)
        let woSav = WOrm(optSav)
        let vSample = { time: '2000-01-01T00:00:00Z' }
        Array.from({ length: 10 }, (v, k) => k).forEach((k) => {
            vSample[`f${k}`] = 'abc'
        })
        await woSav.createTable(clSav, 'time', vSample).catch(() => {})
        await woSav.delAll()

        let tSav = '2025-06-02T00:00:00Z'
        let rpss = await Promise.all([
            runProc('p1', optSav, 'save', { time: tSav, fields: ['f0', 'f1', 'f2', 'f3', 'f4'] }),
            runProc('p2', optSav, 'save', { time: tSav, fields: ['f5', 'f6', 'f7', 'f8', 'f9'] }),
        ])
        vget[4] = rpss.filter((v) => v.error !== undefined).length

        //兩行程對同一新time各自save, 恰有一方之nInserted為1
        vget[5] = rpss.reduce((sum, v) => sum + (v.nInserted || 0), 0)

        //10欄須全數保留且值為各自行程之tag
        let vSav = await woSav.selectByTime(tSav)
        vget[6] = Array.from({ length: 10 }, (v, k) => k)
            .filter((k) => {
                let tag = k <= 4 ? 'p1' : 'p2'
                return vSav[`f${k}`] === tag
            }).length

    })

    vans[1] = 0
    it(`should get ${JSON.stringify(vans[1])} for count of errored process in cross-process insert`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = 20
    it(`should get ${JSON.stringify(vans[2])} for sum of nInserted by 2 processes inserting same 20 times`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = 20
    it(`should get ${JSON.stringify(vans[3])} for records after cross-process insert`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = 0
    it(`should get ${JSON.stringify(vans[4])} for count of errored process in cross-process save`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = 1
    it(`should get ${JSON.stringify(vans[5])} for sum of nInserted by 2 processes saving same new time`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = 10
    it(`should get ${JSON.stringify(vans[6])} for count of fields kept after cross-process save with different field`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

})
