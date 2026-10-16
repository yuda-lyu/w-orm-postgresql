//測試用 PostgreSQL 容器(各 api- 測試檔共用, 同一 helper 只定義一次)
//各測試檔須以不同 name(mocha --parallel 時各檔各起容器, 啟動時會先 docker rm -f 同名容器, 同名即互殺),
//對外埠由系統配發空閒埠(避免與既有 PostgreSQL 服務搶 5432)
import net from 'net'
import pg from 'pg'
import { execFile } from 'child_process'
import { promisify } from 'util'


let execFileAsync = promisify(execFile)
let image = 'postgres:17-alpine'
let user = 'username'
let password = 'password'
let db = 'worm'


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

//probeReady, 以pg直連容器對外埠試跑SELECT 1
//不使用容器內pg_isready, 因postgres映像初始化期間會先啟動僅監聽unix socket之臨時服務,
//pg_isready預設亦走unix socket故會提早回報就緒, 直連TCP方為測試實際所走路徑
let probeReady = async (url) => {
    let client = new pg.Client({ connectionString: `${url}/${db}` })
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

/**
 * 創建容器並等待服務就緒
 * postgres映像以POSTGRES_USER、POSTGRES_PASSWORD、POSTGRES_DB即建妥帳號與資料庫, 無須另跑建置語句
 *
 * @param {String} name 容器名, 各測試檔須各異
 * @returns {Promise<Object>} 回傳{url,db,port}
 */
export let startPg = async (name) => {

    //check docker
    await docker(['version', '--format', '{{.Server.Version}}'])
        .catch(() => {
            throw new Error('需先安裝並啟動docker才能執行postgresql測試')
        })

    //清除前次殘留容器
    await docker(['rm', '-f', name]).catch(() => {})

    //run
    let port = await getFreePort()
    await docker(['run', '-d', '--rm', '--name', name, '-e', `POSTGRES_USER=${user}`, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${db}`, '-p', `${port}:5432`, image])
    let url = `postgresql://${user}:${password}@127.0.0.1:${port}`

    //等待服務就緒, 首次需拉取映像故給予較長時間
    for (let i = 0; i < 90; i++) {
        if (await probeReady(url)) {
            return { url, db, port }
        }
        await delay(2000)
    }

    throw new Error('postgresql容器啟動逾時')
}

/**
 * 銷毀容器
 *
 * @param {String} name 容器名
 * @returns {Promise}
 */
export let stopPg = async (name) => {
    await docker(['rm', '-f', name]).catch(() => {})
}

/**
 * 以pg直連容器供測試自行建表與驗證(不經被測套件)
 *
 * @param {Object} info startPg回傳之{url,db}
 * @returns {Promise<Object>} 回傳已連線之pg.Client, 用畢須end
 */
export let connectPg = async (info) => {
    let client = new pg.Client({ connectionString: `${info.url}/${info.db}` })
    await client.connect()
    return client
}
