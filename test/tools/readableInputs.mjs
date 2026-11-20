//讀取即拋錯之輸入夾具與事件收集(unit-readable-probe、unit-pk-given、unit-readable-align共用, 同一helper只定義一次)
//各夾具每次呼叫皆回傳新物件; 假驅動見fakePg.mjs(不連線、不需docker)
import assert from 'assert'
import { fakeOf, build } from './fakePg.mjs'


//UNREADABLE, 不可讀之固定詞彙(invalid <名稱>: must be a readable value)
export let UNREADABLE = (name) => `invalid ${name}: must be a readable value`


//revoked, 已撤銷之Proxy: 任何讀取(含內部標籤)皆拋TypeError
export let revoked = () => {
    let r = Proxy.revocable({}, {})
    r.revoke()
    return r.proxy
}

//tagThrow, Symbol.toStringTag為拋錯之存取器(判斷函數與Object.prototype.toString讀內部標籤即拋錯)
export let tagThrow = () => ({
    get [Symbol.toStringTag]() {
        throw new Error('tag boom')
    },
})

//lateTag, Symbol.toStringTag為有狀態之存取器: 第n次讀取(含判斷函數、chkReadable與Object.prototype.toString之各次讀取)才拋錯, 之前回傳'Object'
export let lateTag = (n) => {
    let c = 0
    return {
        get [Symbol.toStringTag]() {
            c++
            if (c >= n) {
                throw new Error('late tag boom')
            }
            return 'Object'
        },
    }
}

//tagCounter, Symbol.toStringTag為只計次之存取器(不拋錯): obj為受測值, reads()回傳至今之讀取次數(一次完整檢核所讀之總次數R, 供lateTag於第1至R次讀取各拋一次)
export let tagCounter = () => {
    let c = 0
    return {
        obj: {
            get [Symbol.toStringTag]() {
                c++
                return 'Object'
            },
        },
        reads: () => c,
    }
}

//ownKeysThrow, ownKeys陷阱拋錯之Proxy(內部標籤可讀, 列舉自有鍵即拋錯)
export let ownKeysThrow = () => new Proxy({}, {
    ownKeys() {
        throw new Error('ownKeys boom')
    },
})

//arrLenThrow, 讀length即拋錯之陣列Proxy(內部標籤為Array)
export let arrLenThrow = () => new Proxy([], {
    get(t, k) {
        if (k === 'length') {
            throw new Error('len boom')
        }
        return Reflect.get(t, k)
    },
})

//idxGetterThrow, 長度為1而[0]為拋錯存取器之陣列
export let idxGetterThrow = () => {
    let a = [1]
    Object.defineProperty(a, '0', {
        get() {
            throw new Error('idx boom')
        },
        enumerable: true,
    })
    return a
}

//getTrapThrow, get陷阱全拋錯之Proxy(內部標籤亦讀不到)
export let getTrapThrow = () => new Proxy({}, {
    get() {
        throw new Error('trap boom')
    },
})

//getTrapThrowOn, 只對鍵key之讀取拋錯之Proxy(內部標籤可讀, 即容器可讀而該成員拋錯)
export let getTrapThrowOn = (target, key) => new Proxy(target, {
    get(t, k, r) {
        if (k === key) {
            throw new Error('trap boom')
        }
        return Reflect.get(t, k, r)
    },
})

//withGetterThrow, 複製base並加上讀取即拋錯之存取器prop(容器可讀而成員拋錯)
export let withGetterThrow = (base, prop) => {
    let o = { ...base }
    Object.defineProperty(o, prop, {
        get() {
            throw new Error('getter boom')
        },
        enumerable: true,
    })
    return o
}

//withGetterValue, 以存取器回傳val之物件(存取器屬性: 檢核須拒絕, 但不可讀之探針不呼叫存取器)
export let withGetterValue = (prop, val) => {
    let o = {}
    Object.defineProperty(o, prop, {
        get() {
            return val
        },
        enumerable: true,
    })
    return o
}

//nullProtoDate, 原型為null之Date(可讀, 但無法複製: cloneDeep讀constructor而拋錯)
export let nullProtoDate = () => {
    let d = new Date(1700000000000)
    Object.setPrototypeOf(d, null)
    return d
}

//deepNest, n層巢狀物件(可讀, 但過深而無法複製: 遞迴超出呼叫堆疊)
export let deepNest = (n) => {
    let o = { v: 1 }
    for (let i = 0; i < n; i++) {
        o = { c: o }
    }
    return o
}

//unreadableData, 資料容器層級之不可讀夾具: [名稱, 工廠]
export let unreadableData = [
    ['revoked Proxy', revoked],
    ['Symbol.toStringTag throws', tagThrow],
    ['ownKeys trap throws', ownKeysThrow],
    ['array whose length throws', arrLenThrow],
    ['array whose [0] getter throws', idxGetterThrow],
]


/**
 * 去除區塊註解、字串字面值與單行註解後逐行回傳(盤點src用; 字串內含//如網址時不致把同行後方之程式碼誤當註解)
 *
 * @param {String} src 輸入原始碼
 * @returns {Array} 回傳各行(去註解與字串後)
 */
export let codeLines = (src) => {
    let s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    return s.split(/\r?\n/).map((line) => line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""').replace(/\/\/.*$/, ''))
}


/**
 * 建構使用假pg.Client之實例(連線資訊同fakePg之build: db app、cl tdiag、pk id)並回傳{ w, Fake }
 *
 * @param {Object} [ex={}] 輸入追加之opt
 * @param {Object} [s={}] 輸入fakeOf之腳本
 * @returns {Object} 回傳{ w, Fake }, Fake.calls為驅動之呼叫紀錄(空陣列即未建立client、未連線、未送任何語句)
 */
export let mk = (ex = {}, s = {}) => {
    let Fake = fakeOf(s)
    let w = build(Fake, ex)
    return { w, Fake }
}


/**
 * 執行操作並收集結果: 成功為{ ok }, reject為{ rej }(原值), evs為error事件之{ m, d, e }(模式、data引數原樣、訊息)
 *
 * @param {Object} w 輸入實例
 * @param {Function} run 輸入(w)=>Promise之操作
 * @returns {Promise} 回傳{ ok, rej, evs, has }
 */
export let collectOp = async (w, run) => {
    let evs = []
    w.on('error', (m, d, e) => evs.push({ m, d, e }))
    try {
        return { ok: await run(w), has: false, evs }
    }
    catch (e) {
        return { rej: e, has: true, evs }
    }
}


/**
 * 斷言入口階段之拒絕: Error、訊息為固定詞彙、error事件恰一次且data為null、未建立client(資料庫不變)
 *
 * @param {Object} r 輸入collectOp之結果
 * @param {String} mode 輸入入口名(error事件之mode)
 * @param {String} msg 輸入預期之固定詞彙訊息
 * @param {Object} Fake 輸入假驅動(Fake.calls為空陣列即未建立client、未連線、未送任何語句)
 */
export let expectRejectIn = (r, mode, msg, Fake) => {
    assert.ok(r.has, '應reject')
    assert.ok(r.rej instanceof Error)
    assert.strictEqual(r.rej.message, msg)
    assert.strictEqual(r.evs.length, 1, 'error事件恰一次')
    assert.strictEqual(r.evs[0].m, mode)
    //以ok而非strictEqual: 失敗時報告器會把actual(可能為已撤銷之Proxy)交給util.inspect而使mocha自身崩潰
    assert.ok(r.evs[0].d === null, 'error事件之data為null(不把不可讀之值交給訂閱函數)')
    assert.strictEqual(r.evs[0].e, msg)
    assert.deepStrictEqual(Fake.calls, [], '不建立client、不連線、不送任何語句')
}
