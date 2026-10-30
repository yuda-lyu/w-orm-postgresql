import fs from 'fs'
import util from 'util'
import assert from 'assert'
import { USER, PW, leakErr, fakeOf, build, runOp } from './tools/fakePg.mjs'


//rulebook R18 站點19(第162項): 連線建立後驅動被後端或網路非同步中斷(無進行中語句時)發出之'error'事件須有監聽者,
//  否則為未捕捉例外而使行程終止並把後端錯誤印到stderr; 規格句:
//  C1 每個client(8個操作)建立時即掛'error'監聽, 中斷之'error'事件被吸收(行程不崩潰)
//  C2 該次操作以既有之失敗通道回報(驅動令其後之語句reject; 不另造通道, 不改回傳形狀): 整批reject、save預讀reject、del為逐筆err
//  C3 吸收時經單一出口diag輸出安全摘要: 標籤'client error'與{ mode, errType, errCode }, 預設不含錯誤原文與憑證; logDetail輸出遮罩後細節; funLog取代console
//  C4 R8: 交易控制語句BEGIN、COMMIT、ROLLBACK亦經pgq(null原型之設定物件、extended協定), 全檔pgRun之查詢引數恆為pgq(...)
//真驅動(後端被pg_terminate_backend)之行程不崩潰見api-clienterr; 此處以假驅動(tools/fakePg.mjs)逐一觸發, 不需docker


let OPS = [
    ['createTable', (w) => w.createTable('tdiag', 'id', { id: 'x', v: 1 })],
    ['select', (w) => w.select({ id: 'a' })],
    ['selectByPk', (w) => w.selectByPk('a')],
    ['insert', (w) => w.insert({ id: 'a', v: 1 })],
    ['insertBulk', (w) => w.insertBulk([{ id: 'a', v: 1 }])],
    ['save', (w) => w.save({ id: 'a', v: 1 })],
    ['del', (w) => w.del({ id: 'a' })],
    ['delAll', (w) => w.delAll({ id: 'a' })],
]

//cap, 擷取console各方法之輸出(以util.format格式化, 與實際輸出一致), 並記錄所用方法
async function cap(fn) {
    let lines = []
    let methods = []
    let ks = ['log', 'info', 'warn', 'error', 'debug']
    let olds = ks.map((k) => console[k])
    ks.forEach((k) => {
        console[k] = (...a) => {
            methods.push(k)
            lines.push(util.format(...a))
        }
    })
    try {
        await fn()
    }
    finally {
        ks.forEach((k, i) => {
            console[k] = olds[i]
        })
    }
    return { lines, methods }
}

//dead, 連線後被後端中斷之錯誤(含憑證之後端錯誤形態, code為SQLSTATE)
let dead = () => Object.assign(leakErr(), { message: `terminating connection due to administrator command (password ${PW})`, code: '57P01' })

//seamOf, 單一操作於連線後即被中斷之結果: 吸收(無未捕捉之'error')、失敗通道回報
let drive = async (name, run, ex = {}) => {
    let Fake = fakeOf({ dieAfterConnect: dead })
    let out = null
    let c = await cap(async () => {
        out = await runOp(build(Fake, ex), run)
    })
    return { Fake, out, ...c }
}


describe('C1 每個client建立時即掛error監聽, 連線後之中斷事件被吸收(行程不崩潰)', function() {

    for (let [name, run] of OPS) {
        it(`[${name}] 連線後被中斷: 'error'事件有監聽者(無'error事件無監聽者'紀錄)`, async function() {
            let { Fake } = await drive(name, run)
            assert.ok(Fake.instances.length === 1, `${name} client數: ${Fake.instances.length}`)
            assert.ok(!Fake.calls.includes('error事件無監聽者'), `${name}: 中斷之'error'事件無人監聽(真驅動即未捕捉例外): ${Fake.calls.join()}`)
            assert.strictEqual(Fake.instances[0].listenerCount('error'), 1, `${name}: client建立後恰掛1個error監聽`)
        })
    }

    it('連線失敗(connect reject)之client亦已掛監聽(建立即掛, 不待連線成功)', async function() {
        let Fake = fakeOf({ conn: () => new Error('ECONNREFUSED') })
        await runOp(build(Fake), OPS[1][1])
        assert.strictEqual(Fake.instances[0].listenerCount('error'), 1)
    })

})


describe('C2 該次操作以既有之失敗通道回報(回傳形狀不變)', function() {

    //形狀同unit-diagerr F3: createTable與delAll以訊息字串reject, del為逐筆err(resolve), 其餘為Error物件(save為預讀之reject)
    let shapes = { createTable: 'str', select: 'err', selectByPk: 'err', insert: 'err', insertBulk: 'err', save: 'err', del: 'row', delAll: 'str' }

    for (let [name, run] of OPS) {
        it(`[${name}] 連線後被中斷: 其後之語句reject, 以${shapes[name]}形態回報, error事件發出一次且訊息為驅動之not queryable`, async function() {
            let { out: r } = await drive(name, run)
            if (shapes[name] === 'row') {
                assert.ok(!r.has, 'del之資料庫錯誤為逐筆結果, 不reject')
                assert.strictEqual(r.ok.length, 1)
                assert.strictEqual(r.ok[0].ok, 0)
                assert.ok(/not queryable/.test(r.ok[0].err), r.ok[0].err)
            }
            else {
                assert.ok(r.has, `${name} should reject`)
                let msg = typeof r.rej === 'string' ? r.rej : r.rej.message
                assert.ok(/not queryable/.test(msg), msg)
                assert.strictEqual(typeof r.rej, shapes[name] === 'str' ? 'string' : 'object')
            }
            assert.strictEqual(r.evs.length, 1)
            assert.ok(/not queryable/.test(r.evs[0].e), r.evs[0].e)
        })
    }

    it('insert、insertBulk於交易中(BEGIN之後)被中斷: INSERT reject、ROLLBACK照送(其reject被吞下)、不送COMMIT', async function() {
        for (let [name, run] of [OPS[3], OPS[4]]) {
            let Fake = fakeOf({ dieAfterQuery: (t) => (t === 'BEGIN' ? dead() : null) })
            let r = null
            await cap(async () => {
                r = await runOp(build(Fake), run)
            })
            assert.ok(r.has && /not queryable/.test(r.rej.message), `${name}: ${r.rej && r.rej.message}`)
            assert.ok(!Fake.calls.includes('error事件無監聽者'), Fake.calls.join())
            assert.ok(Fake.calls.includes('ROLLBACK') && !Fake.calls.includes('COMMIT'), Fake.calls.join())
        }
    })

    it('操作成功(未被中斷): 結果與error事件不變, 且無診斷輸出(監聽只在中斷時作用)', async function() {
        let Fake = fakeOf()
        let r = null
        let c = await cap(async () => {
            r = await runOp(build(Fake), OPS[1][1])
        })
        assert.ok(!r.has)
        assert.deepStrictEqual(r.ok, [])
        assert.deepStrictEqual(r.evs, [])
        assert.deepStrictEqual(c.lines, [])
        assert.strictEqual(Fake.instances[0].listenerCount('error'), 1)
    })

})


describe('C3 吸收時經單一出口diag輸出安全摘要(不含錯誤原文與憑證)', function() {

    for (let [name, run] of OPS) {
        it(`[${name}] 預設: 恰一行console.log(label, safe), safe為{ mode, errType, errCode }; 不含訊息原文、密碼、帳號`, async function() {
            let { lines, methods } = await drive(name, run)
            let mine = lines.filter((l) => l.startsWith('client error'))
            assert.strictEqual(mine.length, 1, lines.join('\n'))
            assert.strictEqual(methods[lines.indexOf(mine[0])], 'log', '預設走console.log(與既有二站一致, 無stderr站)')
            assert.strictEqual(mine[0], util.format('client error', { mode: name, errType: 'Error', errCode: '57P01' }))
            for (let l of lines) {
                for (let s of [PW, USER, 'terminating', 'administrator', 'password authentication']) {
                    assert.ok(l.indexOf(s) < 0, `${name} 輸出含[${s}]: ${l}`)
                }
            }
        })
    }

    it('logDetail: 輸出console.log(label, 遮罩後細節): 細節含訊息但憑證為***, 不含密碼', async function() {
        let { lines } = await drive('select', OPS[1][1], { logDetail: true })
        let mine = lines.filter((l) => l.startsWith('client error'))
        assert.strictEqual(mine.length, 1, lines.join('\n'))
        assert.ok(mine[0].indexOf('terminating connection due to administrator command') >= 0 && mine[0].indexOf('***') >= 0, mine[0].slice(0, 300))
        assert.ok(mine[0].indexOf(PW) < 0, mine[0].slice(0, 300))
    })

    it('funLog: 取代console(無console輸出), 收(label, safe, detail), detail已遮罩', async function() {
        let got = []
        let { lines } = await drive('select', OPS[1][1], { funLog: (...a) => got.push(a) })
        assert.deepStrictEqual(lines, [])
        assert.strictEqual(got.length, 1)
        assert.strictEqual(got[0][0], 'client error')
        assert.deepStrictEqual(got[0][1], { mode: 'select', errType: 'Error', errCode: '57P01' })
        let text = util.inspect(got[0][2], { depth: null, showHidden: true })
        assert.ok(text.indexOf(PW) < 0 && text.indexOf('***') >= 0, text.slice(0, 300))
    })

    it('funLog拋錯或console拋錯不致使行程終止(診斷輸出永不拋出)', async function() {
        let boom = () => {
            throw new Error('funLog boom')
        }
        let { out } = await drive('select', OPS[1][1], { funLog: boom })
        assert.ok(out.has && /not queryable/.test(out.rej.message))
    })

})


describe('C4 R8: 交易控制語句經pgq', function() {

    let src = fs.readFileSync('./src/WOrmPostgresql.mjs', 'utf8')
    let code = src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, ''))

    it('src內pgRun之呼叫(接縫定義除外)第二引數恆為pgq(...), 無字串形式之查詢', function() {
        let calls = code.filter((l) => /\bpgRun\(client,/.test(l) && !/async function pgRun/.test(l))
        assert.ok(calls.length >= 12, `pgRun呼叫數: ${calls.length}`)
        let bads = calls.filter((l) => !/\bpgRun\(client, pgq\(/.test(l))
        assert.deepStrictEqual(bads, [], `下列pgRun呼叫之查詢不經pgq:\n${bads.join('\n')}`)
    })

    it('insert、insertBulk成功與失敗路徑送給驅動之BEGIN、COMMIT、ROLLBACK皆為null原型且queryMode為extended之設定物件', async function() {
        for (let [name, run] of [OPS[3], OPS[4]]) {
            //成功: BEGIN、INSERT、COMMIT
            let ok = fakeOf()
            await runOp(build(ok), run)
            assert.deepStrictEqual(ok.calls.filter((t) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(t)), ['BEGIN', 'COMMIT'], name)
            //失敗: BEGIN、INSERT(reject)、ROLLBACK
            let ng = fakeOf({ query: (t) => (/^insert/i.test(t) ? { throws: new Error('boom') } : undefined) })
            await runOp(build(ng), run)
            assert.deepStrictEqual(ng.calls.filter((t) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(t)), ['BEGIN', 'ROLLBACK'], name)
            for (let Fake of [ok, ng]) {
                assert.ok(Fake.raw.length >= 3)
                for (let q of Fake.raw) {
                    assert.strictEqual(typeof q, 'object', `${name}: 送給驅動之查詢不得為字串: ${typeof q === 'string' ? q : ''}`)
                    assert.strictEqual(Object.getPrototypeOf(q), null, `${name}: 須為null原型: ${q.text.slice(0, 20)}`)
                    assert.strictEqual(q.queryMode, 'extended', `${name}: ${q.text.slice(0, 20)}`)
                }
            }
        }
    })

})
