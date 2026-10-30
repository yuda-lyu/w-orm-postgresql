import util from 'util'
import assert from 'assert'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startPg, stopPg, connectPg } from './tools/pgContainer.mjs'


//rulebook R18 站點19(第162項): 連線建立後後端非同步中斷, 行程不得崩潰、錯誤原文不得印到stderr. 真PostgreSQL(自建容器, 測畢即銷毀), 真pg驅動, 不mock接縫.
//  C1 client之後端被中斷(pg_terminate_backend, 後端先送FATAL錯誤訊息再關閉)或連線被異常關閉(本端銷毀socket, 無後端訊息)時, 行程不崩潰(離開碼0)、stderr不含後端原文
//  C2 該次操作以既有之失敗通道回報(整批reject、save預讀reject、del逐筆err), 資料不變
//  C3 吸收時經單一出口輸出安全摘要(預設一行label與{ mode, errType, errCode }, 不含後端原文; logDetail、funLog依既有語意)
//  控制組: 進行中之語句被中斷(驅動令該語句reject, 無'error'事件)修改前後行為相同
//驅動只在「無進行中語句」時於client發出'error'事件(有進行中語句時錯誤交給該語句而其後之'end'已因client.end()而不再報錯),
//故情境以驅動子類別於連線完成後(或BEGIN之後)令後端中斷並等到驅動之'end'事件, 使該段無進行中語句(見tools/clientErrScenario.mjs; 於真實環境對應事件迴圈延遲或操作間之空檔).
//須獨立行程: 未捕捉例外只會使mocha行程內之該測試失敗, 無法斷言「行程崩潰」與stderr內容


let ctName = 'worm-test-pg-clienterr'
let ct = null
let admin = null
let CL = 'tclienterr'
let scenario = fileURLToPath(new URL('./tools/clientErrScenario.mjs', import.meta.url))

let OPS = ['createTable', 'select', 'selectByPk', 'insert', 'insertBulk', 'save', 'del', 'delAll']

//後端錯誤原文(pg_terminate_backend所致之FATAL訊息)
let BACKEND_TEXT = ['terminating connection', 'administrator command']

//runChild, 以獨立行程執行情境, 回傳離開碼、stdout、stderr與RESULT行之解析
let runChild = (spec, ms = 90000) => new Promise((resolve) => {
    let ch = spawn(process.execPath, [scenario, JSON.stringify({ url: ct.url, db: ct.db, cl: CL, ...spec })], { windowsHide: true })
    let out = ''
    let err = ''
    ch.stdout.on('data', (d) => {
        out += d
    })
    ch.stderr.on('data', (d) => {
        err += d
    })
    let timer = setTimeout(() => ch.kill(), ms)
    ch.on('close', (code, signal) => {
        clearTimeout(timer)
        let m = out.split(/\r?\n/).filter((l) => l.startsWith('RESULT:')).pop()
        resolve({ code, signal, out, err, result: m ? JSON.parse(m.slice(7)) : null })
    })
})

//diagLines, stdout中本情境之診斷輸出行
let diagLines = (r) => r.out.split(/\r?\n/).filter((l) => l.startsWith('client error'))

//expectSurvived, 行程不崩潰: 正常結束(離開碼0)、有結果行、stderr不含後端原文與未捕捉例外之字樣
let expectSurvived = (r, msg) => {
    assert.strictEqual(r.code, 0, `${msg} 行程崩潰(離開碼${r.code}, ${r.signal}): stderr=${r.err.slice(0, 400)}`)
    assert.ok(r.result !== null, `${msg} 無RESULT行: ${r.out.slice(0, 300)}`)
    for (let s of [...BACKEND_TEXT, 'Unhandled', 'node:events']) {
        assert.ok(r.err.indexOf(s) < 0, `${msg} stderr含[${s}]: ${r.err.slice(0, 400)}`)
        assert.ok(r.out.indexOf(s) < 0 || /logDetail/.test(msg), `${msg} stdout含[${s}]: ${r.out.slice(0, 400)}`)
    }
    assert.strictEqual(r.err, '', `${msg} stderr應為空: ${r.err.slice(0, 400)}`)
}

//expectFailed, 以既有之失敗通道回報: del為逐筆err(resolve), 其餘為reject(createTable與delAll為字串, 其餘為Error之訊息); 皆為驅動之not queryable
let expectFailed = (r, op, msg) => {
    if (op === 'del') {
        assert.ok(Array.isArray(r.result.ok) && r.result.ok.length === 1, `${msg} ${JSON.stringify(r.result)}`)
        assert.strictEqual(r.result.ok[0].ok, 0, msg)
        assert.ok(/not queryable/.test(r.result.ok[0].err), `${msg} ${JSON.stringify(r.result)}`)
    }
    else {
        assert.ok(typeof r.result.rej === 'string' && /not queryable/.test(r.result.rej), `${msg} 應reject: ${JSON.stringify(r.result)}`)
    }
}

let rows = async () => (await admin.query(`SELECT * FROM ${CL} ORDER BY id`)).rows
//expectUnchanged, 操作失敗後資料不變、createTable未建出表
let expectUnchanged = async (msg) => {
    assert.deepStrictEqual(await rows(), [{ id: 'a', v: 1 }], `${msg} 資料被改動`)
    assert.strictEqual((await admin.query(`SELECT to_regclass('${CL}_c') AS t`)).rows[0].t, null, `${msg} 不應建出表`)
}


before(async function() {
    this.timeout(600000)
    ct = await startPg(ctName)
    admin = await connectPg(ct)
})

after(async function() {
    this.timeout(120000)
    if (admin) {
        await admin.end().catch(() => {})
    }
    await stopPg(ctName)
})

beforeEach(async function() {
    await admin.query(`DROP TABLE IF EXISTS ${CL}`)
    await admin.query(`DROP TABLE IF EXISTS ${CL}_c`)
    await admin.query(`CREATE TABLE ${CL} (id TEXT PRIMARY KEY, v INTEGER)`)
    await admin.query(`INSERT INTO ${CL} VALUES ('a', 1)`)
})


describe('連線後後端被中斷(pg_terminate_backend; 後端先送FATAL錯誤訊息): 行程不崩潰, 操作以既有之失敗通道回報(C1、C2、C3)', function() {
    this.timeout(120000)

    for (let op of OPS) {
        it(`[${op}] 連線完成後後端被終止: 行程離開碼0, stderr無後端原文; 操作失敗(not queryable), 資料不變; stdout為安全摘要`, async function() {
            let r = await runChild({ op, kind: 'terminate', hold: 'connect' })
            expectSurvived(r, op)
            expectFailed(r, op, op)
            await expectUnchanged(op)
            //C3 預設輸出: 第一個'error'事件為後端之FATAL訊息(DatabaseError, SQLSTATE 57P01), 其後驅動另報連線已結束; 皆只有label與摘要
            let lines = diagLines(r)
            assert.ok(lines.length >= 1, r.out.slice(0, 400))
            assert.strictEqual(lines[0], util.format('client error', { mode: op, errType: 'DatabaseError', errCode: '57P01' }))
            for (let l of lines) {
                assert.ok(l.startsWith(`client error { mode: '${op}'`), l)
            }
        })
    }

    it('[insert、insertBulk] 交易中(BEGIN之後)後端被終止: 行程不崩潰, INSERT失敗(not queryable), 無資料寫入', async function() {
        for (let op of ['insert', 'insertBulk']) {
            await admin.query(`DELETE FROM ${CL} WHERE id <> 'a'`)
            let r = await runChild({ op, kind: 'terminate', hold: 'tx' })
            expectSurvived(r, `${op} tx`)
            expectFailed(r, op, `${op} tx`)
            await expectUnchanged(`${op} tx`)
        }
    })

})


describe('連線後被異常關閉(本端銷毀socket, 無後端錯誤訊息): 行程不崩潰, 操作以既有之失敗通道回報(C1、C2、C3)', function() {
    this.timeout(120000)

    for (let op of OPS) {
        it(`[${op}] 連線完成後連線被關閉: 行程離開碼0, 操作失敗(not queryable), 資料不變; stdout為安全摘要(errType為Error, 無errCode)`, async function() {
            let r = await runChild({ op, kind: 'drop', hold: 'connect' })
            expectSurvived(r, op)
            expectFailed(r, op, op)
            await expectUnchanged(op)
            let lines = diagLines(r)
            assert.ok(lines.length >= 1, r.out.slice(0, 400))
            for (let l of lines) {
                assert.strictEqual(l, util.format('client error', { mode: op, errType: 'Error' }))
            }
        })
    }

    it('[insert、insertBulk] 交易中(BEGIN之後)連線被關閉: 行程不崩潰, INSERT失敗, 無資料寫入', async function() {
        for (let op of ['insert', 'insertBulk']) {
            let r = await runChild({ op, kind: 'drop', hold: 'tx' })
            expectSurvived(r, `${op} tx`)
            expectFailed(r, op, `${op} tx`)
            await expectUnchanged(`${op} tx`)
        }
    })

})


describe('診斷輸出選項(C3; 比照既有二站: logDetail輸出遮罩後細節, funLog取代console)', function() {
    this.timeout(120000)

    it('預設: stdout不含後端原文(只有label與摘要)', async function() {
        let r = await runChild({ op: 'select', kind: 'terminate' })
        expectSurvived(r, 'default')
        for (let l of diagLines(r)) {
            for (let s of BACKEND_TEXT) {
                assert.ok(l.indexOf(s) < 0, l)
            }
        }
    })

    it('logDetail: 輸出label與遮罩後細節(明示要細節, 後端訊息可在stdout), stderr仍為空、行程不崩潰', async function() {
        let r = await runChild({ op: 'select', kind: 'terminate', opt: { logDetail: true } })
        expectSurvived(r, 'logDetail')
        assert.ok(r.out.indexOf('client error') >= 0 && r.out.indexOf('administrator command') >= 0, r.out.slice(0, 400))
    })

    it('funLog: 取代console(stdout無診斷行), funLog收到(label, safe)', async function() {
        let r = await runChild({ op: 'select', kind: 'terminate', opt: { funLog: true } })
        expectSurvived(r, 'funLog')
        assert.deepStrictEqual(diagLines(r), [])
        assert.deepStrictEqual(r.result.logs[0], ['client error', { mode: 'select', errType: 'DatabaseError', errCode: '57P01' }])
    })

})


describe('控制組: 進行中之語句被中斷(修改前後行為相同: 該語句reject, 行程不崩潰)', function() {
    this.timeout(120000)

    it('select卡在後端(表被他連線鎖住)時其後端被終止: select以後端訊息reject, 行程離開碼0, stderr為空', async function() {
        //mon, 另開連線觀察與終止(pg_stat_activity之快照於交易內快取, 持鎖之admin在交易中輪詢會一直看到舊狀態)
        let mon = await connectPg(ct)
        await admin.query('BEGIN')
        try {
            await admin.query(`LOCK TABLE ${CL} IN ACCESS EXCLUSIVE MODE`)
            let p = runChild({ op: 'select', kind: 'none' })
            //等到該語句確實卡在鎖上(查觀察狀態, 非固定等待), 再終止其後端
            let pid = null
            for (let i = 0; i < 300 && pid === null; i++) {
                let q = await mon.query(`SELECT pid FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`, [ct.db])
                if (q.rows.length > 0) {
                    pid = q.rows[0].pid
                }
                else {
                    await new Promise((resolve) => setTimeout(resolve, 100))
                }
            }
            assert.ok(pid !== null, '逾時仍未見語句等鎖')
            await mon.query('SELECT pg_terminate_backend($1)', [pid])
            let r = await p
            assert.strictEqual(r.code, 0, `離開碼${r.code}: ${r.err.slice(0, 300)}`)
            assert.ok(r.result && typeof r.result.rej === 'string' && /terminating connection due to administrator command/.test(r.result.rej), JSON.stringify(r.result))
            assert.strictEqual(r.err, '', r.err.slice(0, 300))
        }
        finally {
            await admin.query('ROLLBACK')
            await mon.end().catch(() => {})
        }
    })

})
