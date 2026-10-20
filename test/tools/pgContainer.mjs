//測試用 PostgreSQL 容器(各 api- 測試檔共用, 同一 helper 只定義一次)
//各測試檔須以不同 name(mocha --parallel 時各檔各起容器, 啟動時會先 docker rm -f -v 同名容器, 同名即互殺);
//對外埠依下方 PORTS 表固定配發(本套件自管 8451-8459, 不隨機: 隨機埠於取得與綁定之間可被他程序取走而衝突), 僅綁 127.0.0.1;
//同機多工作區並行時以環境變數 WORM_TEST_PORT_BASE 整體平移埠段(確定性偏移, 非隨機), 容器名並帶 -<base> 後綴使各工作區互不 rm -f、互不搶埠
import pg from 'pg'
import { execFile } from 'child_process'
import { promisify } from 'util'


let execFileAsync = promisify(execFile)
let image = 'postgres:17-alpine'
let user = 'username'
let password = 'password'
let db = 'worm'

//PORTS, 容器名 -> 埠序號(實際埠 = base + 序號, base 預設 8451); 新增 api- 測試檔須在此登錄一行(序號 0-8, 即 8451-8459), 表外名稱 throw
export let PORTS = {
    'worm-test-postgresql': 0,
    'worm-test-postgresql-find': 1,
    'worm-test-postgresql-write': 2,
    'worm-test-pg33-whitelist': 3,
    'worm-test-pg-volume': 4,
    'worm-test-pg-matrix': 5,
    'worm-test-pg66-wellformed': 6,
}
let BASE_DEFAULT = 8451
let PORT_COUNT = 9

let delay = (ms) => {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

//baseOf, 埠段起點: WORM_TEST_PORT_BASE 未設為 8451; 須為整數, 且整段落在 8000-49000 內(避開常用服務埠與 OS 臨時埠區 49152+)
let baseOf = () => {
    let s = process.env.WORM_TEST_PORT_BASE
    if (s === undefined || s === '') {
        return BASE_DEFAULT
    }
    let n = Number(s)
    if (!Number.isInteger(n) || n < 8000 || n + PORT_COUNT - 1 > 49000) {
        throw new Error(`WORM_TEST_PORT_BASE must be an integer in 8000-${49000 - PORT_COUNT + 1}`)
    }
    return n
}

//plan, 由登錄名取得實際埠與容器名(表外名稱 throw, 不退回隨機)
let plan = (name) => {
    if (!Object.prototype.hasOwnProperty.call(PORTS, name)) {
        throw new Error(`container name [${name}] is not registered in PORTS of test/tools/pgContainer.mjs (ports 8451-8459 are managed by this package)`)
    }
    let base = baseOf()
    return { port: base + PORTS[name], cname: base === BASE_DEFAULT ? name : `${name}-${base}` }
}

/**
 * 取得實際容器名(WORM_TEST_PORT_BASE 不為預設時帶 -<base> 後綴)
 *
 * @param {String} name 容器名(須登錄於PORTS)
 * @returns {String} 回傳實際docker容器名
 */
export let cnameOf = (name) => plan(name).cname

//docker, 以陣列傳參不經shell, 避免路徑與引號轉譯問題
let docker = (args) => {
    return execFileAsync('docker', args)
}

//rmContainer, 移除容器及其匿名 volume: 必須帶 -v. postgres 映像宣告 VOLUME, docker run 未指定時建立匿名 volume;
//--rm 之自動移除與手動 docker rm -f 競爭時, 不帶 -v 之手動移除會遺留懸置 volume(日積月累吃滿磁碟)
let rmContainer = (cname) => {
    return docker(['rm', '-f', '-v', cname]).catch(() => {})
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
 * @param {String} name 容器名(須登錄於PORTS), 各測試檔須各異
 * @returns {Promise<Object>} 回傳{url,db,port}
 */
export let startPg = async (name) => {

    //plan, 先於任何docker操作(表外名稱直接throw)
    let { port, cname } = plan(name)

    //check docker
    await docker(['version', '--format', '{{.Server.Version}}'])
        .catch(() => {
            throw new Error('需先安裝並啟動docker才能執行postgresql測試')
        })

    //清除前次殘留容器(含其匿名volume)
    await rmContainer(cname)

    //run
    try {
        await docker(['run', '-d', '--rm', '--name', cname, '-e', `POSTGRES_USER=${user}`, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${db}`, '-p', `127.0.0.1:${port}:5432`, image])
    }
    catch (err) {
        let msg = String(err && (err.stderr || err.message))
        if (/port is already allocated|address already in use|Ports are not available|bind:/i.test(msg)) {
            throw new Error(`測試埠 127.0.0.1:${port} 已被占用(容器 ${cname}); 請釋放該埠, 或以環境變數 WORM_TEST_PORT_BASE 平移埠段(同機多工作區並行時各設不同值)`)
        }
        throw err
    }
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
 * 銷毀容器及其匿名volume
 *
 * @param {String} name 容器名(須登錄於PORTS)
 * @returns {Promise}
 */
export let stopPg = async (name) => {
    let { cname } = plan(name)
    await rmContainer(cname)
}

/**
 * 列出容器掛載之 volume 名稱(供驗證收尾後無遺留匿名 volume)
 *
 * @param {String} name 容器名(須登錄於PORTS)
 * @returns {Promise<Array>} 回傳volume名稱陣列
 */
export let volumesOfPg = async (name) => {
    let { cname } = plan(name)
    let r = await docker(['inspect', '-f', '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}', cname])
    return r.stdout.split(/\s+/).filter((s) => s !== '')
}

/**
 * 以docker查詢volume是否仍存在
 *
 * @param {String} vname volume名稱
 * @returns {Promise<Boolean>} 回傳是否存在
 */
export let hasVolume = async (vname) => {
    return docker(['volume', 'inspect', vname]).then(() => true).catch(() => false)
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
