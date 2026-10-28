import fs from 'fs'
import util from 'util'
import assert from 'assert'
import WOrm from '../src/WOrmPostgresql.mjs'
import { startPg, stopPg, connectPg } from './tools/pgContainer.mjs'
import { scenario, scenarioConn, settle, ID, PW } from './tools/diagScenario.mjs'


//rulebook R18: 診斷輸出(console)之預設安全與可控; 真PostgreSQL(自建容器, 測畢即銷毀), 不mock接縫
//  R18-1 預設只輸出標籤與不含個資之摘要(不含資料值、id、後端錯誤原文、連線憑證)
//  R18-2 opt.logDetail為true還原舊版細節輸出(格式與舊版一致), 連線字串與帳密一律以***遮罩
//  R18-3 opt.funLog(label, safe, detail)取代console收完整細節(憑證仍遮罩); 型別錯誤之選項忽略並用預設(同本套件其他選項)
//  R18-4 診斷輸出不得影響各操作之resolve/reject內容、事件payload與時機(以修改前HEAD產生之golden逐項比對)
//  R18-5 連線憑證不出現在任何輸出管道(console、funLog、連線失敗之reject與error事件)
//  單一出口(R18-7)與建構函式訊息(R18-8)見unit-diaglog


let ctName = 'worm-test-pg-diaglog'
let ct = null
let admin = null

let USER = 'tuser'
let NAME = 'AliceSecret'
let URL_BAD = `postgresql://${USER}:${PW}@127.0.0.1:1` //不可連線之位址(含自訂帳密)


//capture, 擷取console各方法之輸出(以util.format格式化, 與實際輸出一致)
async function capture(fn) {
    let lines = []
    let ks = ['log', 'info', 'warn', 'error', 'debug']
    let olds = ks.map((k) => console[k])
    ks.forEach((k) => {
        console[k] = (...a) => lines.push(util.format(...a))
    })
    let res
    try {
        res = await fn()
    }
    finally {
        ks.forEach((k, i) => {
            console[k] = olds[i]
        })
    }
    return { res, lines }
}


//credsCt、credsBad, 兩種實例之連線憑證(容器url之帳密與連線字串; 不可連線url之自訂帳密與url)
let credsCt = () => ['password', 'username', 'username:password', ct.url, `${ct.url}/${ct.db}`]
let credsBad = () => [PW, USER, `${USER}:${PW}`, URL_BAD]

//noCred, 文字中不得含指定之連線憑證(預設為兩種實例之全部: 用於預設輸出, 其本就不含錯誤原文; logDetail與funLog只檢該實例自身之憑證)
let noCred = (text, msg = '', list = [...credsCt(), ...credsBad()]) => {
    for (let s of list) {
        assert.ok(text.indexOf(s) < 0, `${msg}輸出含連線憑證[${s}]: ${text.slice(0, 400)}`)
    }
}


//noData, 文字中不得含資料值、id、訂閱函數之錯誤原文、後端錯誤原文
let noData = (text, msg = '') => {
    noCred(text, msg)
    for (let s of [ID, NAME, 'u-secret', 'listener', 'duplicate key', 'already exists', 'ECONNREFUSED', '127.0.0.1', 'invalid find: unsupported', 'at Object', 'node_modules', '.mjs']) {
        assert.ok(text.indexOf(s) < 0, `${msg}輸出含不該出現之內容[${s}]: ${text.slice(0, 400)}`)
    }
}


let mk = (cl, ex = {}) => WOrm({ url: ct.url, db: ct.db, cl, pk: 'id', ...ex })
let mkc = (ex = {}) => WOrm({ url: URL_BAD, db: 'worm', cl: 'tconn', pk: 'id', ...ex })

//listenerMsg, 訂閱函數拋出之錯誤訊息: 含id、容器連線字串與其帳密(預設輸出不得出現; logDetail與funLog須遮罩憑證、保留其餘)
let listenerMsg = () => `listener ${ID} ${ct.url}/${ct.db} username:password`

//thrower, 掛上拋錯之訂閱函數, 回傳其拋出之錯誤清單
let thrower = (w, events = ['change', 'error']) => {
    let thrown = []
    for (let ev of events) {
        w.on(ev, () => {
            let e = new Error(listenerMsg())
            thrown.push(e)
            throw e
        })
    }
    return thrown
}

//drops, 刪除情境所建之表, 使同一情境可重複執行
let drops = async () => {
    for (let t of ['tdiag_ok', 'tdiag_bad', 'tdiag_a', 'tdiag_b']) {
        await admin.query(`DROP TABLE IF EXISTS ${t}`)
    }
}

//golden, 回傳契約之固定預期值: 以修改前之程式(git HEAD)執行tools/diagScenario.mjs之情境所得(不含R18新功能), 與本檔無關之程式不得改動它
let golden = JSON.parse(fs.readFileSync('./test/tools/diagGolden.json', 'utf8'))
let plain = (v) => JSON.parse(JSON.stringify(v))


describe('diaglog', function() {

    before(async function() {
        ct = await startPg(ctName)
        admin = await connectPg(ct)
        await admin.query('DROP TABLE IF EXISTS tdiag_c')
        await admin.query('CREATE TABLE tdiag_c (id TEXT PRIMARY KEY, name TEXT, value INTEGER)')
    })

    after(async function() {
        if (admin) {
            await admin.end().catch(() => {})
        }
        await stopPg(ctName)
    })


    describe('預設(R18-1)', function() {

        it('change訂閱函數拋錯: 輸出有標籤與操作別, 不含資料值、id、錯誤原文、憑證; insert之resolve不變', async function() {
            let w = mk('tdiag_c')
            thrower(w, ['change'])
            let { res, lines } = await capture(() => settle(w.insert({ id: ID, name: NAME, value: 1 })))
            assert.deepStrictEqual(res, { ok: { n: 1, nInserted: 1, ok: 1 } })
            assert.strictEqual(lines.length, 1, lines.join('|'))
            assert.ok(lines[0].indexOf('change handler threw') >= 0 && lines[0].indexOf('insert') >= 0, lines[0])
            assert.ok(lines[0].indexOf('errType') >= 0 && lines[0].indexOf('Error') >= 0, lines[0])
            noData(lines.join('\n'))
            await mk('tdiag_c').del({ id: ID })
        })

        it('error訂閱函數拋錯: 輸出不含訂閱函數之錯誤原文與find內容; select之reject不變', async function() {
            let w = mk('tdiag_c')
            thrower(w, ['error'])
            let { res, lines } = await capture(() => settle(w.select({ $foo: ID })))
            assert.ok(res.err !== undefined && res.err.indexOf('invalid find: unsupported operator [$foo]') === 0, JSON.stringify(res))
            assert.strictEqual(lines.length, 1, lines.join('|'))
            assert.ok(lines[0].indexOf('error handler threw') >= 0 && lines[0].indexOf('select') >= 0, lines[0])
            noData(lines.join('\n'))
        })

        it('連線失敗(含自訂帳密之url)且error訂閱函數拋出含該url之錯誤: 輸出不含url、帳密、後端錯誤原文; reject不變', async function() {
            let w = mkc()
            w.on('error', () => {
                throw new Error(`conn ${URL_BAD}/worm ${USER}:${PW} ${ID}`)
            })
            let { res, lines } = await capture(() => settle(w.insert({ id: ID, name: NAME })))
            assert.strictEqual(res.err, 'connect ECONNREFUSED 127.0.0.1:1')
            assert.strictEqual(lines.length, 1, lines.join('|'))
            assert.ok(lines[0].indexOf('error handler threw') >= 0 && lines[0].indexOf('insert') >= 0, lines[0])
            noData(lines.join('\n'))
        })

        it('訂閱函數拋出非Error值(字串含url、數值、null、undefined、物件、Symbol): 預設只列型別; funLog之detail遮罩憑證、保留其餘', async function() {
            let cases = [
                [`str ${URL_BAD}/worm ${USER}:${PW} ${ID}`, 'string'],
                [12345, 'number'],
                [null, 'null'],
                [undefined, 'undefined'],
                [{ message: ID, code: ID, url: URL_BAD }, 'object'],
                [Symbol(`${ID} ${PW}`), 'symbol'],
            ]
            for (let [v, errType] of cases) {
                let w = mkc()
                w.on('error', () => {
                    throw v
                })
                let { res, lines } = await capture(() => settle(w.select({})))
                assert.strictEqual(res.err, 'connect ECONNREFUSED 127.0.0.1:1', errType)
                assert.strictEqual(lines.length, 1, `${errType}: ${lines.join('|')}`)
                assert.strictEqual(lines[0], `error handler threw { mode: 'select', errType: '${errType}' }`)
                noData(lines.join('\n'), `${errType} `)
            }
            let got = []
            let w2 = mkc({ funLog: (...a) => got.push(a) })
            w2.on('error', () => {
                throw cases[0][0]
            })
            await capture(() => settle(w2.select({})))
            assert.strictEqual(got.length, 1)
            assert.deepStrictEqual(got[0][1], { mode: 'select', errType: 'string' })
            assert.strictEqual(typeof got[0][2], 'string')
            noCred(got[0][2], 'funLog ', credsBad())
            assert.ok(got[0][2].indexOf(ID) >= 0 && got[0][2].indexOf('***') >= 0, got[0][2])
        })

        it('連線失敗之8個操作(createTable、select、selectByPk、insert、insertBulk、save、del、delAll)各自之error事件拋錯 -> 各恰一行, 操作別全集齊備(外審 E-3)', async function() {
            let { res, lines } = await capture(() => scenarioConn(mkc(), true))
            assert.strictEqual(res.out.length, 8)
            assert.strictEqual(lines.length, 8, lines.join('\n'))
            let modes = lines.map((v) => /mode: '([A-Za-z]+)'/.exec(v)?.[1])
            assert.deepStrictEqual(modes, ['createTable', 'select', 'selectByPk', 'insert', 'insertBulk', 'save', 'del', 'delAll'])
            assert.ok(lines.every((v) => /^error handler threw \{ mode: '[A-Za-z]+', errType: 'Error' \}$/.test(v)), lines.join('\n'))
            noData(lines.join('\n'))
        })

        it('5個寫入操作(insert、insertBulk、save、del、delAll)成功時之change事件拋錯 -> 各恰一行, 操作別齊備', async function() {
            let w = mk('tdiag_c')
            thrower(w, ['change'])
            let { res, lines } = await capture(async () => {
                let out = []
                out.push(await settle(w.insert({ id: 'cm1', name: 'n' })))
                out.push(await settle(w.insertBulk([{ id: 'cm2', name: 'n' }])))
                out.push(await settle(w.save({ id: 'cm1', name: 'n2' })))
                out.push(await settle(w.del({ id: 'cm1' })))
                out.push(await settle(w.delAll({ id: 'cm2' })))
                return out
            })
            assert.ok(res.every((v) => v.ok !== undefined), JSON.stringify(res))
            assert.deepStrictEqual(lines.map((v) => /mode: '([A-Za-z]+)'/.exec(v)?.[1]), ['insert', 'insertBulk', 'save', 'del', 'delAll'])
            assert.ok(lines.every((v) => /^change handler threw \{ mode: '[A-Za-z]+', errType: 'Error' \}$/.test(v)), lines.join('\n'))
            noData(lines.join('\n'))
        })

        it('Object.prototype被資料型汙染(mode、errType、errCode、code、message等為可寫之資料屬性, 如不安全merge了{"__proto__":{…}}): 摘要不採用繼承值, 輸出與寫入結果不變(外審 D-1)', async function() {
            let names = ['mode', 'errType', 'errCode', 'code']
            for (let n of names) {
                // eslint-disable-next-line no-extend-native
                Object.defineProperty(Object.prototype, n, { value: 'POLLUTED', writable: true, enumerable: true, configurable: true })
            }
            let got = null
            try {
                let w = mk('tdiag_c')
                thrower(w, ['change'])
                let r1 = await capture(() => settle(w.insert({ id: 'pl1', name: 'n' })))
                let w2 = mkc()
                thrower(w2, ['error'])
                let r2 = await capture(() => settle(w2.select({})))
                got = JSON.stringify([r1.res, r1.lines, r2.res, r2.lines])
            }
            finally {
                for (let n of names) {
                    delete Object.prototype[n]
                }
            }
            //斷言於汙染移除後進行(斷言失敗時AssertionError本身會讀寫被汙染的名稱)
            let [res1, lines1, res2, lines2] = JSON.parse(got)
            assert.deepStrictEqual(res1, { ok: { n: 1, nInserted: 1, ok: 1 } }, got)
            assert.strictEqual(lines1.length, 1, got)
            assert.strictEqual(lines1[0], 'change handler threw { mode: \'insert\', errType: \'Error\' }', got)
            assert.strictEqual(res2.err, 'connect ECONNREFUSED 127.0.0.1:1', got)
            assert.deepStrictEqual(lines2, ['error handler threw { mode: \'select\', errType: \'Error\' }'], got)
            await mk('tdiag_c').del({ id: 'pl1' })
        })

        it('每個操作之change與error事件各一次拋錯 -> 各恰一行輸出(站點全集: 2處×各操作別), 皆無個資', async function() {
            let { res, lines } = await capture(async () => {
                await drops()
                return scenario(mk('tdiag_a'), 'tdiag_a', true)
            })
            let nEv = res.evs.filter((v) => v[0] === 'change' || v[0] === 'error').length
            assert.ok(nEv >= 10, `事件數 ${nEv}`)
            assert.strictEqual(lines.length, nEv, `輸出行數 ${lines.length} 應等於事件數 ${nEv}`)
            let modes = new Set(lines.map((v) => /mode: '([A-Za-z]+)'/.exec(v)?.[1]))
            for (let m of ['createTable', 'delAll', 'insert', 'insertBulk', 'save', 'select', 'del']) {
                assert.ok(modes.has(m), `缺操作別[${m}]: ${[...modes].join(',')}`)
            }
            assert.ok(lines.every((v) => /^(change|error) handler threw \{/.test(v)), lines.join('\n'))
            noData(lines.join('\n'))
            await drops()
        })

        it('未掛拋錯訂閱函數: 成功與失敗之各操作無任何console輸出', async function() {
            await drops()
            let { lines } = await capture(async () => {
                await scenario(mk('tdiag_b'), 'tdiag_b', false)
                await scenarioConn(mkc(), false)
            })
            assert.deepStrictEqual(lines, [])
            await drops()
        })

        it('選項型別錯誤者忽略並用預設(不拋錯、不洩漏): logDetail為字串或1、funLog為字串或物件', async function() {
            for (let ex of [{ logDetail: 'true' }, { logDetail: 1 }, { logDetail: {} }, { funLog: 'x' }, { funLog: {} }, { logDetail: 'yes', funLog: 123 }]) {
                let w = mk('tdiag_c', ex)
                thrower(w, ['change'])
                let { res, lines } = await capture(() => settle(w.insert({ id: ID, name: NAME })))
                assert.deepStrictEqual(res, { ok: { n: 1, nInserted: 1, ok: 1 } }, JSON.stringify(ex))
                assert.strictEqual(lines.length, 1, JSON.stringify(ex))
                noData(lines.join('\n'), `${JSON.stringify(ex)} `)
                await mk('tdiag_c').del({ id: ID })
            }
        })

        it('選項快照於建構時固定: 其後改動opt或opt之getter前後不同, 不影響輸出', async function() {
            let n = 0
            let opt = {
                url: ct.url,
                db: ct.db,
                cl: 'tdiag_c',
                pk: 'id',
                get logDetail() {
                    n++
                    return n === 1
                },
            }
            let w = WOrm(opt)
            thrower(w, ['change'])
            let { lines } = await capture(async () => {
                await w.insert({ id: ID, name: NAME })
                await w.del({ id: ID })
            })
            assert.strictEqual(n, 1, 'logDetail只應被讀取一次')
            assert.ok(lines.length >= 1 && lines[0].indexOf('listener') >= 0, `應為logDetail輸出: ${lines.join('|')}`)
        })

    })


    describe('logDetail(R18-2)', function() {

        it('還原舊版輸出: 只輸出訂閱函數拋出之錯誤(無標籤); 無憑證之錯誤格式與舊版console.log(err)逐字相同', async function() {
            let w = mk('tdiag_c', { logDetail: true })
            let thrown = []
            w.on('change', () => {
                let e = new Error(`listener ${ID} ${NAME}`)
                thrown.push(e)
                throw e
            })
            let { res, lines } = await capture(() => settle(w.insert({ id: ID, name: NAME })))
            assert.deepStrictEqual(res, { ok: { n: 1, nInserted: 1, ok: 1 } })
            assert.strictEqual(lines.length, 1)
            assert.strictEqual(lines[0], util.format(thrown[0]), '格式須與舊版console.log(err)一致')
            assert.ok(lines[0].indexOf(ID) >= 0, '還原細節應含錯誤原文')
            await mk('tdiag_c').del({ id: ID })
        })

        it('連線字串與帳密一律遮罩(含容器url、自訂帳密、帳號:密碼); 其餘細節保留', async function() {
            let w = mk('tdiag_c', { logDetail: true })
            thrower(w, ['change'])
            let { lines } = await capture(() => settle(w.insert({ id: ID, name: NAME })))
            assert.strictEqual(lines.length, 1)
            assert.ok(lines[0].indexOf(ID) >= 0 && lines[0].indexOf('listener') >= 0, '非憑證之細節被誤遮')
            assert.ok(lines[0].indexOf('***') >= 0)
            noCred(lines[0], 'logDetail ', credsCt())
            await mk('tdiag_c').del({ id: ID })
        })

        it('連線失敗之error訂閱函數拋錯: 自訂帳密與url遮罩, 其餘保留', async function() {
            let w = mkc({ logDetail: true })
            w.on('error', () => {
                throw new Error(`conn ${URL_BAD}/worm ${USER}:${PW} ${ID}`)
            })
            let { lines } = await capture(() => settle(w.select({})))
            assert.strictEqual(lines.length, 1)
            noCred(lines[0], 'logDetail ', credsBad())
            assert.ok(lines[0].indexOf(ID) >= 0 && lines[0].indexOf('conn ***') >= 0, lines[0].slice(0, 200))
        })

        it('funLog與logDetail並給: funLog取代console', async function() {
            let got = []
            let w = mk('tdiag_c', { logDetail: true, funLog: (...a) => got.push(a) })
            thrower(w, ['change'])
            let { lines } = await capture(() => settle(w.insert({ id: ID, name: NAME })))
            assert.deepStrictEqual(lines, [])
            assert.strictEqual(got.length, 1)
            await mk('tdiag_c').del({ id: ID })
        })

    })


    describe('funLog(R18-3)', function() {

        it('change訂閱函數拋錯: funLog收(label, safe, detail), detail為完整錯誤(含id)但憑證遮罩; 不寫console', async function() {
            let got = []
            let w = mk('tdiag_c', { funLog: (...a) => got.push(a) })
            thrower(w, ['change'])
            let { res, lines } = await capture(() => settle(w.insert({ id: ID, name: NAME })))
            assert.deepStrictEqual(res, { ok: { n: 1, nInserted: 1, ok: 1 } })
            assert.deepStrictEqual(lines, [])
            assert.strictEqual(got.length, 1)
            let [label, safe, detail] = got[0]
            assert.strictEqual(label, 'change handler threw')
            assert.deepStrictEqual(safe, { mode: 'insert', errType: 'Error' })
            assert.ok(detail instanceof Error)
            assert.ok(detail.message.indexOf(ID) >= 0 && detail.message.indexOf('listener') >= 0, '完整細節應含原文')
            noCred(util.inspect({ safe, detail }, { depth: null, showHidden: true }), 'funLog ', credsCt()) //連同cause、Symbol鍵、不可列舉屬性
            assert.ok(detail.message.indexOf('***') >= 0)
            await mk('tdiag_c').del({ id: ID })
        })

        it('error訂閱函數拋錯: label為error handler threw, safe含操作別, detail為完整錯誤', async function() {
            let got = []
            let w = mk('tdiag_c', { funLog: (...a) => got.push(a) })
            thrower(w, ['error'])
            let { res } = await capture(() => settle(w.select({ $foo: 1 })))
            assert.ok(res.err.indexOf('invalid find') === 0)
            assert.strictEqual(got.length, 1)
            assert.strictEqual(got[0][0], 'error handler threw')
            assert.deepStrictEqual(got[0][1], { mode: 'select', errType: 'Error' })
            assert.ok(got[0][2] instanceof Error && got[0][2].message.indexOf(ID) >= 0)
        })

        it('funLog拋錯或回傳reject之promise: 不影響操作之結果, 不成為unhandledRejection', async function() {
            let bad = []
            let fn = (e) => bad.push(e)
            process.on('unhandledRejection', fn)
            try {
                for (let funLog of [() => {
                    throw new Error('x')
                }, () => Promise.reject(new Error('rej')), () => ({ then: () => Promise.reject(new Error('rej2')) })]) {
                    let w = mk('tdiag_c', { funLog })
                    thrower(w, ['change'])
                    let { res, lines } = await capture(() => settle(w.insert({ id: ID, name: NAME })))
                    assert.deepStrictEqual(res, { ok: { n: 1, nInserted: 1, ok: 1 } })
                    assert.deepStrictEqual(lines, [])
                    await mk('tdiag_c').del({ id: ID })
                }
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
            finally {
                process.off('unhandledRejection', fn)
            }
            assert.deepStrictEqual(bad.map((v) => v.message), [])
        })

    })


    describe('回傳契約不變(R18-4)', function() {

        //各選項組合下之情境結果與事件須逐項等於golden(修改前HEAD所得): 預設、logDetail、funLog、funLog拋錯、兩者並給; 每組皆跑一般與壞訂閱函數兩種情境
        let funLogThrow = () => {
            throw new Error('x')
        }
        let variants = [
            ['預設', () => ({})],
            ['logDetail', () => ({ logDetail: true })],
            ['funLog', () => ({ funLog: () => {} })],
            ['funLog拋錯', () => ({ funLog: funLogThrow })],
            ['logDetail+funLog', () => ({ logDetail: true, funLog: () => {} })],
        ]

        for (let [name, getEx] of variants) {
            it(`[${name}] 可連線情境(createTable、delAll、insert、insertBulk、save、select、selectByPk、del): resolve/reject、事件payload與先後同golden`, async function() {
                await drops()
                let r1 = await capture(() => scenario(mk('tdiag_ok', getEx()), 'tdiag_ok', false))
                assert.deepStrictEqual(plain(r1.res), golden.ok)
                await drops()
                let r2 = await capture(() => scenario(mk('tdiag_bad', getEx()), 'tdiag_bad', true))
                assert.deepStrictEqual(plain(r2.res), golden.bad, '訂閱函數拋錯不得影響結果與事件')
                await drops()
            })

            it(`[${name}] 連線失敗情境: reject、error事件payload與先後同golden`, async function() {
                let r1 = await capture(() => scenarioConn(mkc(getEx()), false))
                assert.deepStrictEqual(plain(r1.res), golden.conn)
                let r2 = await capture(() => scenarioConn(mkc(getEx()), true))
                assert.deepStrictEqual(plain(r2.res), golden.connBad)
            })
        }

        it('golden本身有實質內容(防空殼): 各情境結果≥8筆、含成功與失敗、含change與error事件與done標記', function() {
            for (let k of ['ok', 'bad']) {
                assert.ok(golden[k].out.length >= 13, k)
                assert.ok(golden[k].out.some((v) => v.ok !== undefined) && golden[k].out.some((v) => v.err !== undefined), k)
                for (let t of ['change', 'error', 'done']) {
                    assert.ok(golden[k].evs.some((v) => v[0] === t), `${k} 缺${t}`)
                }
            }
            for (let k of ['conn', 'connBad']) {
                assert.strictEqual(golden[k].out.length, 8)
                assert.ok(golden[k].out.every((v) => v.err === 'connect ECONNREFUSED 127.0.0.1:1'), k)
                assert.strictEqual(golden[k].evs.filter((v) => v[0] === 'error').length, 8)
            }
        })

    })


    describe('連線憑證不出現在任何輸出管道(R18-5)', function() {

        //pg自身對不合格網址之錯誤(Invalid URL)已把input改為REDACTED; 本測試鎖住此行為(pg升版若改變即轉紅, 交主控裁示)
        it('網址解析失敗(port非數字、IPv6括號不成對): reject之訊息、input屬性、stack、error事件payload皆不含帳密', async function() {
            for (let url of [`postgresql://${USER}:${PW}@127.0.0.1:abc`, `postgresql://${USER}:${PW}@[::1`]) {
                let w = WOrm({ url, db: 'worm', cl: 'tconn', pk: 'id' })
                let evs = []
                w.on('error', (m, d, e) => evs.push(e))
                let err = null
                try {
                    await w.select({})
                }
                catch (e) {
                    err = e
                }
                assert.ok(err instanceof Error, url)
                let text = JSON.stringify([err.message, err.input, err.stack, Object.getOwnPropertyNames(err).map((k) => String(err[k])), evs])
                noCred(text, `${url} `)
                assert.ok(text.indexOf('127.0.0.1:abc') < 0 && text.indexOf('[::1') < 0, `含網址: ${text}`)
            }
        })

        it('連線失敗(拒絕連線、無法解析主機、無scheme之網址): reject與error事件payload不含帳密', async function() {
            //無scheme之網址(tuser:S3cretPw@127.0.0.1:1)不列入: pg會改連localhost:5432並把密碼當成資料庫名, 結果隨本機是否有PostgreSQL而異(見下一案之logDetail遮罩)
            for (let url of [URL_BAD, `postgresql://${USER}:${PW}@no-such-host.invalid:5432`, `postgresql://${USER}:${PW.replace(/.$/, '@x')}@127.0.0.1:1`]) {
                let w = WOrm({ url, db: 'worm', cl: 'tconn', pk: 'id' })
                let evs = []
                w.on('error', (m, d, e) => evs.push(e))
                let err = null
                try {
                    await w.insert({ id: 'a', name: 'n' })
                }
                catch (e) {
                    err = e
                }
                assert.ok(err !== null, url)
                let inner = err && err.errors ? err.errors.map((x) => [x.message, x.stack, x.address, x.hostname]) : []
                let text = JSON.stringify([err && err.message, err && err.stack, inner, evs])
                noCred(text, `${url} `)
                assert.ok(text.indexOf(PW.replace(/.$/, '@x')) < 0)
            }
        })

        it('畸形網址(密碼含@後接未編碼/): pg把密碼片段當主機名而出現在後端錯誤訊息, 訂閱函數轉拋該訊息時, 預設與logDetail輸出皆不含該片段(外審 A-3)', async function() {
            let url = 'postgresql://tuser:p@S3cretHostPw.invalid/rest@127.0.0.1:1'
            for (let ex of [{}, { logDetail: true }]) {
                let w = WOrm({ url, db: 'worm', cl: 'tconn', pk: 'id', ...ex })
                w.on('error', (m, d, msg) => {
                    throw new Error(`rethrow ${msg}`)
                })
                let { res, lines } = await capture(() => settle(w.select({})))
                assert.ok(res.err.indexOf('ENOTFOUND') >= 0, res.err) //回傳契約: reject仍為後端原文(含片段)
                assert.strictEqual(lines.length, 1)
                assert.ok(lines[0].indexOf('S3cretHostPw') < 0, `${JSON.stringify(ex)}: ${lines[0]}`)
                if (ex.logDetail) {
                    assert.ok(lines[0].indexOf('rethrow') >= 0 && lines[0].indexOf('***') >= 0, lines[0].slice(0, 200))
                }
            }
        })

        it('url密碼為純數字(含數值型之錯誤代碼同值): 預設與funLog之摘要不洩漏', async function() {
            let url = 'postgresql://numuser:123456@127.0.0.1:1'
            let got = []
            let w = WOrm({ url, db: 'worm', cl: 'tconn', pk: 'id', funLog: (...a) => got.push(a) })
            w.on('error', () => {
                let e = new Error('listener 123456 numuser')
                e.code = 123456
                throw e
            })
            let { lines } = await capture(() => settle(w.select({})))
            assert.deepStrictEqual(lines, [])
            assert.strictEqual(got.length, 1)
            let text = JSON.stringify([got[0][0], got[0][1], got[0][2].message, got[0][2].code])
            assert.ok(text.indexOf('123456') < 0 && text.indexOf('numuser') < 0, text)
            assert.deepStrictEqual(got[0][1], { mode: 'select', errType: 'Error' }, '數值code不進摘要')
        })

    })

})
