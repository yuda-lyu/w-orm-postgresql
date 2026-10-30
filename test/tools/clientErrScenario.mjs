//子行程情境(供api-clienterr): 以真pg驅動與真後端, 令操作之client於連線後(無進行中語句時)被中斷, 回報行程是否存活與操作結果;
//須獨立行程: 未捕捉例外會使行程終止, 在mocha行程內只會被當成該測試失敗而無法分辨「行程崩潰」與stderr內容
//用法: node clientErrScenario.mjs <JSON規格>; 規格 { url, db, cl, op, kind, hold, opt }
//  kind: 'terminate' 以另一連線對該client之後端執行pg_terminate_backend(後端先送出FATAL錯誤訊息再關閉); 'drop' 於本端銷毀socket(無後端錯誤訊息, 連線異常關閉); 'none' 不中斷
//  hold: 'connect' 連線完成後即中斷並等到驅動之'end'事件(此時client無進行中語句); 'tx' 於交易之BEGIN完成後同樣中斷
//  opt: 追加之WOrmPostgresql選項; opt.funLog為true者以收集函數取代, 收到之引數列於結果
//輸出: 診斷輸出照常走stdout; 最後一行'RESULT:<JSON>'為操作結果(ok或rej); 行程正常結束離開碼為0, 崩潰時由node印錯誤至stderr並以非0結束
import pg from 'pg'
import WOrm from '../../src/WOrmPostgresql.mjs'


let spec = JSON.parse(process.argv[2])
let { url, db, cl, op, kind = 'terminate', hold = 'connect' } = spec
let opt = { ...(spec.opt || {}) }
let logs = []
if (opt.funLog === true) {
    opt.funLog = (...a) => logs.push(a)
}

let ctl = new pg.Client({ connectionString: `${url}/${db}` })
await ctl.connect()

//strike, 令client之後端中斷, 並等到驅動確認連線已結束('end'事件, 於其'error'事件之後); 須先掛'end'再中斷, 以免事件早於監聽
let strike = async (client) => {
    let ended = new Promise((resolve) => client.once('end', resolve))
    if (kind === 'terminate') {
        await ctl.query('SELECT pg_terminate_backend($1)', [client.processID])
    }
    else {
        client.connection.stream.destroy()
    }
    await ended
}

class Hold extends pg.Client {
    async connect(...a) {
        let r = await super.connect(...a)
        if (kind !== 'none' && hold === 'connect') {
            await strike(this)
        }
        return r
    }

    async query(q, ...rest) {
        let r = await super.query(q, ...rest)
        if (kind !== 'none' && hold === 'tx' && (typeof q === 'string' ? q : q.text) === 'BEGIN') {
            await strike(this)
        }
        return r
    }
}

//WOrmPostgresql於建構時讀取pg.Client, 故於建構期間暫時換入, 建構後即還原
let old = pg.Client
pg.Client = Hold
let w = WOrm({ url, db, cl, pk: 'id', ...opt })
pg.Client = old

let ops = {
    createTable: () => w.createTable(`${cl}_c`, 'id', { id: 'x' }),
    select: () => w.select({ id: 'a' }),
    selectByPk: () => w.selectByPk('a'),
    insert: () => w.insert({ id: 'z', v: 1 }),
    insertBulk: () => w.insertBulk([{ id: 'z', v: 1 }]),
    save: () => w.save({ id: 'a', v: 2 }),
    del: () => w.del({ id: 'a' }),
    delAll: () => w.delAll({ id: 'a' }),
}

let out = {}
try {
    out.ok = await ops[op]()
}
catch (e) {
    out.rej = typeof e === 'string' ? e : String(e && e.message)
}
if (opt.funLog) {
    out.logs = logs.map((a) => [a[0], a[1]])
}
console.log('RESULT:' + JSON.stringify(out))
await ctl.end().catch(() => {})
process.exit(0)
