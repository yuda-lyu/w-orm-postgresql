//假pg.Client(不連線、不需docker): 供unit-diaglog、unit-diagerr以腳本控制驅動於各階段(建構、connect、query、end)拋出或reject之值,
//令各接縫與站點可被逐一觸發(真驅動之後端錯誤難以造出含憑證之各形態; 真驅動之接線另見api-diaglog)
//WOrmPostgresql於建構時讀取pg.Client(let PgClient = pg.Client), 故須於建構期間暫時換入假類別, 建構後即還原
import pg from 'pg'
import WOrm from '../../src/WOrmPostgresql.mjs'


export let USER = 'dbuser'
export let PW = 'S3cretPw'

//urlOf, 測試用連線字串(不含資料庫名; 套件組成之連線字串為`${url}/${db}`)
export let urlOf = (pw = PW, user = USER) => `postgresql://${user}:${pw}@db.example.com:5432`

//leakErr, 含憑證之後端錯誤(整串連線字串與密碼皆在訊息內, 帳號亦在訊息內; code等為非秘密欄位)
export let leakErr = (pw = PW) => Object.assign(new Error(`password authentication failed for user "${USER}" (${urlOf(pw)}/app, password ${pw})`), { code: '28P01', severity: 'FATAL' })


/**
 * 產生假pg.Client類別
 *
 * @param {Object} [s={}] 腳本: nw()、conn()、end()回傳要拋出之值(未給為不拋出); query(text, q)回傳{ throws: 值 }者reject該值、回傳其他物件者resolve該物件、回傳undefined者resolve預設結果{ rows: [], rowCount: 0 }
 * @returns {Function} 回傳類別, 其靜態屬性calls為依序之呼叫紀錄(new、connect、各語句文字、end)
 */
export let fakeOf = (s = {}) => {
    let calls = []
    class FakeClient {
        constructor(cfg) {
            calls.push('new')
            if (s.nw) {
                throw s.nw()
            }
        }

        async connect() {
            calls.push('connect')
            if (s.conn) {
                throw s.conn()
            }
        }

        async query(q) {
            let text = typeof q === 'string' ? q : q.text
            calls.push(text)
            if (s.query) {
                let r = s.query(text, q)
                if (r !== undefined) {
                    if (Object.prototype.hasOwnProperty.call(r, 'throws')) {
                        throw r.throws
                    }
                    return r
                }
            }
            return { rows: [], rowCount: 0 }
        }

        async end() {
            calls.push('end')
            if (s.end) {
                throw s.end()
            }
        }
    }
    FakeClient.calls = calls
    return FakeClient
}


/**
 * 建構使用假pg.Client之WOrmPostgresql實例(建構期間暫時換入, 建構後還原)
 *
 * @param {Function} Fake 輸入fakeOf所產生之類別
 * @param {Object} [ex={}] 輸入追加之opt(如logDetail、funLog)
 * @param {Object} [o={}] 輸入{ pw, user, url }: 密碼、帳號與整串url(給url者不再由pw與user組成)
 * @returns {Object} 回傳實例
 */
export let build = (Fake, ex = {}, o = {}) => {
    let old = pg.Client
    pg.Client = Fake
    try {
        let url = o.url !== undefined ? o.url : urlOf(o.pw === undefined ? PW : o.pw, o.user === undefined ? USER : o.user)
        return WOrm({ url, db: 'app', cl: 'tdiag', pk: 'id', ...ex })
    }
    finally {
        pg.Client = old
    }
}


/**
 * 以原樣之opt物件建構實例(不展開、不複製: 供測試選項之getter、Proxy等; url、db、cl、pk由呼叫端自行給)
 *
 * @param {Function} Fake 輸入fakeOf所產生之類別
 * @param {Object} opt 輸入原樣之opt
 * @returns {Object} 回傳實例
 */
export let buildRaw = (Fake, opt) => {
    let old = pg.Client
    pg.Client = Fake
    try {
        return WOrm(opt)
    }
    finally {
        pg.Client = old
    }
}


/**
 * 執行操作並取得結果: 成功為{ ok }, reject為{ rej }(原值, 不轉字串, 保留身分), 並收集error事件之訊息引數
 *
 * @param {Object} w 輸入實例
 * @param {Function} run 輸入(w)=>Promise之操作
 * @returns {Promise} 回傳{ ok, rej, evs, has }, has為是否reject
 */
export let runOp = async (w, run) => {
    let evs = []
    w.on('error', (m, d, e) => evs.push({ m, e }))
    try {
        return { ok: await run(w), has: false, evs }
    }
    catch (e) {
        return { rej: e, has: true, evs }
    }
}
