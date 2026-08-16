import events from 'events'
import pg from 'pg'
import mongoSql from 'mongo-sql'
import size from 'lodash-es/size.js'
import get from 'lodash-es/get.js'
import map from 'lodash-es/map.js'
import keys from 'lodash-es/keys.js'
import filter from 'lodash-es/filter.js'
import omit from 'lodash-es/omit.js'
import trim from 'lodash-es/trim.js'
import isEqual from 'lodash-es/isEqual.js'
import cloneDeep from 'lodash-es/cloneDeep.js'
import isstr from 'wsemi/src/isstr.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isearr from 'wsemi/src/isearr.mjs'
import iseobj from 'wsemi/src/iseobj.mjs'
import isnum from 'wsemi/src/isnum.mjs'
import isint from 'wsemi/src/isint.mjs'
import isbol from 'wsemi/src/isbol.mjs'
import isDate from 'wsemi/src/isDate.mjs'
import haskey from 'wsemi/src/haskey.mjs'
import pmSeries from 'wsemi/src/pmSeries.mjs'


/**
 * 操作資料庫(PostgreSQL)
 *
 * 本套件之主鍵欄位由opt.pk指定，預設為time，select以外之五函數皆以此欄位認定主鍵。
 * 因主鍵得為承載業務語義之欄位(如時序資料之觀測時間)，insert與save於輸入未帶有效主鍵值時不自動補值，
 * 一律以reject回報；del亦不補值，該筆回ok:0與err。
 *
 * @class
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {String} [opt.url='postgresql://127.0.0.1:5432'] 輸入連接資料庫字串，預設'postgresql://127.0.0.1:5432'
 * @param {String} [opt.db='worm'] 輸入使用資料庫名稱字串，預設'worm'
 * @param {String} [opt.cl='test'] 輸入使用資料表名稱字串，預設'test'
 * @param {String} [opt.pk='time'] 輸入主鍵欄位名字串，預設'time'
 * @param {Boolean} [opt.useCache=false] 輸入是否使用select快取，適用於單程序操作，預設false
 * @returns {Object} 回傳操作資料庫物件，各事件功能詳見說明
 */
function WOrmPostgresql(opt = {}) {

    //_cache
    let _cache = null

    //url
    let url = get(opt, 'url')
    if (!isestr(url)) {
        url = 'postgresql://user:password@127.0.0.1:5432'
    }

    //db
    let db = get(opt, 'db')
    if (!isestr(db)) {
        db = 'worm'
    }

    //cl
    let cl = get(opt, 'cl')
    if (!isestr(cl)) {
        cl = 'test'
    }

    //useCache
    let useCache = get(opt, 'useCache')
    if (!isbol(useCache)) {
        useCache = false
    }

    //pkName, 主鍵欄位名, select以外之五函數皆以此欄位認定主鍵, 預設為time
    let pkName = get(opt, 'pk')
    if (!isestr(pkName)) {
        pkName = 'time'
    }

    //checkPk, 判定主鍵值是否有效
    //因主鍵欄位得由呼叫端指定, 其型別隨欄位而異, 故此處僅要求有給值而不限定型別,
    //型別與欄位不符者由PostgreSQL回報, 各函數再依其規格處置
    function checkPk(pkv) {
        return isestr(pkv) || isnum(pkv) || isbol(pkv) || isDate(pkv)
    }

    //isErrPkType, 判定錯誤是否為[主鍵值型別與欄位不符]
    //22P02為invalid_text_representation, 22007為invalid_datetime_format
    function isErrPkType(err) {
        let code = get(err, 'code')
        return code === '22P02' || code === '22007'
    }

    //getValueType
    function getValueType(value) {
        if (isstr(value)) {
            let isoTimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z)?$/
            return isoTimeRegex.test(value) ? 'TIMESTAMPTZ' : 'TEXT'
        }
        else if (isnum(value)) {
            return isint(value) ? 'INTEGER' : 'DOUBLE PRECISION'
        }
        else if (isbol(value)) {
            return 'BOOLEAN'
        }
        else if (value === null) {
            return 'TEXT'
        }
        else {
            return 'JSONB'
        }
    }

    //genSqlForCreateTable
    function genSqlForCreateTable(tableName, pk, obj) {

        //check
        if (!iseobj(obj)) {
            throw new Error(`obj[${obj}] is not an effective object`)
        }

        //columns
        let columns = Object.entries(obj).map(([key, value]) => {
            let type = getValueType(value)
            let c = `  ${key} ${type}`
            if (key === pk) {
                c = `${c} PRIMARY KEY`
            }
            return c
        })

        //c
        let c = `CREATE TABLE ${tableName} (\n${columns.join(',\n')}\n);`
        // console.log('c', c)

        return c
    }

    //genConflictSQL
    function genConflictSQL(obj) {

        //allKeys
        let allKeys = keys(obj)

        //conflictKeys
        let conflictKeys = [pkName]

        //updateKeys
        let updateKeys = filter(allKeys, (k) => {
            return !conflictKeys.includes(k)
        })

        //check
        if (size(updateKeys) === 0) {
            return ''
        }

        //updateClause
        let updateClause = updateKeys
            .map(key => `${key} = EXCLUDED.${key}`)
            .join(',\n  ')

        //c
        let c = `
            ON CONFLICT (${conflictKeys.join(', ')}) DO UPDATE SET
                ${updateClause}
        `

        //trim
        c = trim(c)

        return c
    }

    //connectionString
    let connectionString = `${url}/${db}`
    // console.log('connectionString', connectionString)

    //ee
    let ee = new events.EventEmitter()

    //PgClient
    let PgClient = pg.Client
    // console.log('PgClient', PgClient)

    //clearCache
    function clearCache() {
        _cache = null
    }

    //getCacheKey
    function getCacheKey(find = {}, order = {}) {
        return JSON.stringify({
            find,
            order,
        })
    }

    //getCache
    function getCache(find = {}, order = {}) {
        if (iseobj(_cache)) {
            let key = getCacheKey(find, order)
            if (haskey(_cache, key)) {
                return cloneDeep(_cache[key]) //與外部使用數據脫勾
            }
        }
        return null
    }

    //setCache
    function setCache(find = {}, order = {}, data = []) {
        if (!iseobj(_cache)) {
            _cache = {}
        }
        let key = getCacheKey(find, order)
        _cache[key] = cloneDeep(data) //與外部使用數據脫勾
    }

    /**
     * 創建資料表
     * 註: pk未給時採建構時之opt.pk。因insert與save倚賴主鍵之唯一約束達成原子性，
     * 若給予與opt.pk不同之欄位，將建出其餘函數無法正確操作之資料表，故一般應留空或給予相同值
     *
     * @memberOf WOrmPostgresql
     * @param {String} cl 輸入資料表名字串
     * @param {String} [pk=opt.pk] 輸入主鍵欄位名字串，預設為建構時之opt.pk
     * @param {Array|Object} arr 輸入數據物件陣列或數據物件
     * @returns {Promise} 回傳Promise，resolve回傳成功訊息，reject回傳錯誤訊息
     */
    async function createTable(cl, pk, arr) {

        //pk, 未給時採建構時設定之主鍵欄位
        if (!isestr(pk)) {
            pk = pkName
        }

        let isErr = false
        let res = null

        //client
        let client = new PgClient({ connectionString })

        //connect
        try {

            //connect
            await client.connect()

        }
        catch (err) {
            isErr = true
            res = err
            client = null
        }

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        try {

            //obj
            let obj = arr
            if (isearr(obj)) {
                obj = obj[0]
            }

            //check
            if (!iseobj(obj)) {
                throw new Error(`obj[${obj}] is not an effective object`)
            }

            //sql
            let sql = genSqlForCreateTable(cl, pk, obj)
            // console.log('sql', sql)

            //select
            await client.query(sql)
                .then(() => {
                    res = {
                        ok: 1,
                    }
                })
                .catch((err) => {
                    isErr = true
                    res = err.message
                })

        }
        catch (err) {
            isErr = true
            res = err
        }
        finally {
            await client.end()
            client = null
        }
        // console.log('res', res)

        //update
        if (useCache) {
            clearCache()
        }

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        return res
    }

    /**
     * 查詢數據
     *
     * @memberOf WOrmPostgresql
     * @param {Object} [find={}] 輸入查詢條件物件
     * @param {Object} [order={}] 輸入排序條件物件
     * @returns {Promise} 回傳Promise，resolve回傳數據，reject回傳錯誤訊息
     */
    async function select(find = {}, order = {}) {
        let isErr = false
        let res = null

        //cache
        if (useCache) {
            let cache = getCache(find, order)
            if (isarr(cache)) {
                return cache
            }
        }

        //client
        let client = new PgClient({ connectionString })

        //connect
        try {

            //connect
            await client.connect()

        }
        catch (err) {
            isErr = true
            res = err
            client = null
        }

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        try {

            //mr
            let mr = mongoSql.sql({
                type: 'select',
                table: cl,
                where: find,
                // limit: 10,
                order,
            })
            // console.log('mr', mr)
            // console.log('mr.query', mr.query)
            // console.log('mr.values', mr.values)

            //select
            let r = await client.query(mr.query, mr.values)
            // console.log('r', r)

            //res
            res = get(r, 'rows')

            //check
            if (!isarr(res)) {
                isErr = true
                res = `can not select by find[${JSON.stringify(find)}]`
            }

            //cache
            if (useCache && !isErr) {
                setCache(find, order, res)
            }

        }
        catch (err) {
            isErr = true
            res = err
        }
        finally {
            await client.end()
            client = null
        }
        // console.log('res', res)

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        return res
    }

    /**
     * 由主鍵查詢單筆數據，因直接由資料表主鍵索引取值，不需如select提取數據至前端再處理，故數據量大時效能較佳
     * 註: 本套件之主鍵欄位由建構時之opt.pk指定，預設為time
     *
     * 主鍵未命中或主鍵值無效皆回傳null而不reject，命中之判定基準與insert、save、del內對既有數據之認定一致。
     * 主鍵值之型別與欄位不符時PostgreSQL回報22P02或22007，亦屬主鍵值無效而回傳null。
     *
     * @memberOf WOrmPostgresql
     * @param {String|Number|Date} pk 輸入主鍵值，即數據之主鍵欄位值
     * @returns {Promise} 回傳Promise，resolve回傳數據物件，若無此主鍵則回傳null，reject回傳錯誤訊息
     */
    async function selectByPk(pk) {
        let isErr = false
        let res = null

        //check
        if (!checkPk(pk)) {
            //未給有效主鍵值視為查無數據, 判定基準與insert、save、del內對主鍵之認定一致
            return null
        }

        //find, 以建構時設定之主鍵欄位查找, 與insert、save、del、genConflictSQL之認定一致
        let find = {
            [pkName]: pk,
        }

        //cache, 與select共用快取, 因快取鍵值由find與order組成, 故此處等同select(find)之結果
        if (useCache) {
            let cache = getCache(find, {})
            if (isarr(cache)) {
                return get(cache, 0, null)
            }
        }

        //client
        let client = new PgClient({ connectionString })

        //connect
        try {

            //connect
            await client.connect()

        }
        catch (err) {
            isErr = true
            res = err
            client = null
        }

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        try {

            //mr, 不使用limit以令結果與select(find)完全等價, 方能安全共用快取,
            //time為主鍵時本就僅回傳1筆, 不會因此多拉數據
            let mr = mongoSql.sql({
                type: 'select',
                table: cl,
                where: find,
            })
            // console.log('mr', mr)
            // console.log('mr.query', mr.query)
            // console.log('mr.values', mr.values)

            //select
            let r = await client.query(mr.query, mr.values)
            // console.log('r', r)

            //rows
            let rows = get(r, 'rows')

            //check
            if (!isarr(rows)) {
                throw new Error(`can not select by pk[${pk}]`)
            }

            //cache
            if (useCache) {
                setCache(find, {}, rows)
            }

            //v
            let v = get(rows, 0, null)

            //check, 判定基準與save、del內對既有數據之認定一致
            if (iseobj(v)) {
                res = v
            }
            else {
                //不存在主鍵, 回傳null
                res = null
            }

        }
        catch (err) {

            //check, 主鍵值之型別與欄位不符者亦屬主鍵值無效, 依規格回傳null而不reject
            if (isErrPkType(err)) {
                res = null
            }
            else {
                isErr = true
                res = err
            }

        }
        finally {
            await client.end()
            client = null
        }
        // console.log('res', res)

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        return res
    }

    /**
     * 插入數據，僅於主鍵不存在時寫入，已存在者跳過且不覆寫
     *
     * n為輸入筆數，即本次嘗試插入之基準；nInserted為實際插入筆數，全數已存在而nInserted為0屬正常結果，
     * 不視為錯誤。同批含重複主鍵時僅首筆計入nInserted。
     * 因主鍵得承載業務語義，未帶有效主鍵值時不自動補值，一律以reject回報。
     *
     * @memberOf WOrmPostgresql
     * @param {Object|Array} data 輸入數據物件或陣列
     * @returns {Promise} 回傳Promise，resolve回傳插入結果物件{n,nInserted,ok}，reject回傳錯誤訊息
     */
    async function insert(data) {
        let isErr = false
        let res = null

        //check
        if (!iseobj(data) && !isearr(data)) {
            return {
                n: 0,
                nInserted: 0,
                ok: 1,
            }
        }

        //cloneDeep
        data = cloneDeep(data)

        //client
        let client = new PgClient({ connectionString })

        //connect
        try {

            //connect
            await client.connect()

        }
        catch (err) {
            isErr = true
            res = err
            client = null
        }

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        try {

            //check
            if (!isarr(data)) {
                data = [data]
            }

            //check pk, 因主鍵得承載業務語義故不自動補值, 未帶有效主鍵值者屬整批性錯誤
            data = map(data, function(v, k) {
                if (!checkPk(get(v, pkName))) {
                    throw new Error(`invalid data[${k}].${pkName}[${get(v, pkName)}]`)
                }
                return v
            })

            //mr
            let mr = mongoSql.sql({
                type: 'insert',
                table: cl,
                values: data,
            })
            // console.log('mr', mr)
            // console.log('mr.query', mr.query)
            // console.log('mr.values', mr.values)

            //添加conflict, 令已存在主鍵者跳過而不中斷整批插入, 主鍵認定與genConflictSQL一致
            //由PostgreSQL於單一語句內原子完成[檢查主鍵未存在]與[寫入], 併發時同一主鍵僅有一次成功,
            //同批含重複主鍵時亦僅首筆成功, 故不須逐筆插入即可取得實際插入筆數
            let sql = `${mr.query} ON CONFLICT (${pkName}) DO NOTHING`

            //nAll
            let nAll = size(data)

            //insert, ON CONFLICT DO NOTHING時rowCount即為實際插入筆數
            await client.query(sql, mr.values)
                .then((r) => {

                    //res
                    res = {
                        n: nAll,
                        nInserted: r.rowCount,
                        ok: 1,
                    }

                })
                .catch((err) => {
                    isErr = true
                    res = err.message
                })

        }
        catch (err) {
            isErr = true
            res = err
        }
        finally {
            await client.end()
            client = null
        }

        //update
        if (useCache) {
            clearCache()
        }

        //emit
        if (!isErr) {
            try {
                ee.emit('change', 'insert', data, res)
            }
            catch (err) {
                console.log(err)
            }
        }

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        return res
    }

    /**
     * 儲存數據，以主鍵time為準更新既有數據，未給之欄位保留
     *
     * 回傳陣列恆與輸入等長，輸入單一物件亦回傳長度1之陣列。
     * 各筆之n為主鍵命中筆數，值為0或1，命中(不論內容有無變更)或經插入而產生皆為1；
     * nInserted與nModified恆同時出現，無對應行為時填0。
     * [內容相同]之判定基準為待寫入物件合併進現值後與現值相同，非待寫入物件與現值全等，
     * 故只給部份欄位且該些欄位值皆與現值相同時，合併結果等於現值，nModified為0，
     * 令nModified忠實反映資料庫端是否真的寫入。
     * 因主鍵得承載業務語義，未帶有效主鍵值時不自動補值，一律以reject回報。
     *
     * @memberOf WOrmPostgresql
     * @param {Object|Array} data 輸入數據物件或陣列
     * @param {Object} [option={}] 輸入設定物件，預設為{}
     * @param {boolean} [option.autoInsert=true] 輸入是否於儲存時發現原本無數據，則自動改以插入處理，預設為true
     * @returns {Promise} 回傳Promise，resolve回傳儲存結果陣列[{n,nInserted,nModified,ok}]，reject回傳錯誤訊息
     */
    async function save(data, option = {}) {
        let isErr = false
        let res = null

        //check
        if (!iseobj(data) && !isearr(data)) {
            return []
        }

        //cloneDeep
        data = cloneDeep(data)

        //autoInsert
        let autoInsert = get(option, 'autoInsert', true)

        //client
        let client = new PgClient({ connectionString })

        //connect
        try {

            //connect
            await client.connect()

        }
        catch (err) {
            isErr = true
            res = err
            client = null
        }

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        try {

            //check
            if (!isarr(data)) {
                data = [data]
            }

            //check pk, 因主鍵得承載業務語義故不自動補值, 未帶有效主鍵值者屬整批性錯誤
            data = map(data, function(v, k) {
                if (!checkPk(get(v, pkName))) {
                    throw new Error(`invalid data[${k}].${pkName}[${get(v, pkName)}]`)
                }
                return v
            })

            //pmSeries
            res = await pmSeries(data, async(v) => {

                //rest
                let rest = null

                //pkv
                let pkv = get(v, pkName)

                //_v
                let _v = null
                if (true) {

                    //mr
                    let mr = mongoSql.sql({
                        type: 'select',
                        table: cl,
                        where: {
                            [pkName]: pkv,
                        },
                        // limit: 10,
                        // order,
                    })
                    // console.log('mr', mr)
                    // console.log('mr.query', mr.query)
                    // console.log('mr.values', mr.values)

                    //select
                    let r = await client.query(mr.query, mr.values)
                    // console.log('r', r)

                    //rows
                    let rows = get(r, 'rows')
                    // console.log('rows', rows)

                    //_v
                    _v = get(rows, 0, null)
                    // console.log('_v', _v)

                }

                //快速路徑, 先不寫入直接由前述預讀判斷內容是否相同, 內容相同者本就不須寫入,
                //預讀值縱使已被其他寫入者更動而過期亦不影響正確性, 因內容相同時本次save等價於無操作,
                //無操作可視為於預讀當下即已完成, 其後他人之寫入結果與[本次save先執行再輪到他人]相同
                if (iseobj(_v)) {

                    //_vt
                    let _vt = omit(_v, pkName)
                    // console.log('_vt', _vt)

                    //vt, [內容相同]之判定基準為[待寫入物件合併進現值後與現值相同],
                    //非[待寫入物件與現值全等], 故只給部份欄位且該些欄位值皆與現值相同時視為相同而不寫入,
                    //合併採淺層覆蓋, 與後端以EXCLUDED整欄取代之寫入行為一致
                    let vt = {
                        ..._vt,
                        ...omit(v, pkName),
                    }
                    // console.log('vt', vt)

                    if (isEqual(vt, _vt)) {
                        //相同時不更新

                        //rest
                        rest = {
                            n: 1,
                            nInserted: 0,
                            nModified: 0,
                            ok: 1,
                        }
                        // console.log('相同時不更新', rest, v)

                        return rest
                    }

                }
                else {

                    //check
                    if (!autoInsert) {
                        //不存在且未開啟autoInsert則不寫入

                        //rest
                        rest = {
                            n: 0,
                            nInserted: 0,
                            nModified: 0,
                            ok: 1,
                        }
                        // console.log('不存在', rest, v)

                        return rest
                    }

                }

                //check
                if (autoInsert) {
                    //由PostgreSQL於單一語句內原子完成[查找time]與[插入或更新],
                    //併發時不會因他方已先插入同一time而報錯, 亦不會有兩方各自讀到同一舊值再各自寫入

                    //mr
                    let mr = mongoSql.sql({
                        type: 'insert',
                        table: cl,
                        values: v,
                    })
                    // console.log('mr', mr)
                    // console.log('mr.query', mr.query)
                    // console.log('mr.values', mr.values)

                    //添加conflict, 僅有主鍵欄位時genConflictSQL無可更新欄位而回傳空字串,
                    //此時退回DO NOTHING, 以免併發插入同一主鍵者報錯
                    let conflict = genConflictSQL(v)
                    if (!isestr(conflict)) {
                        conflict = `ON CONFLICT (${pkName}) DO NOTHING`
                    }

                    //sql, xmax為0表該列由本語句插入, 非0表係由DO UPDATE更新而來,
                    //衝突且落入DO NOTHING時不回傳任何列, 代表該time已存在且未變更
                    let sql = `${mr.query} ${conflict} RETURNING (xmax = 0) AS inserted`

                    //save
                    await client.query(sql, mr.values)
                        .then((r) => {

                            //rows
                            let rows = get(r, 'rows')

                            //check
                            if (!isearr(rows)) {
                                //衝突且未更新

                                //rest
                                rest = {
                                    n: 1,
                                    nInserted: 0,
                                    nModified: 0,
                                    ok: 1,
                                }

                            }
                            else if (get(rows, '0.inserted') === true) {
                                //原不存在而插入

                                //rest
                                rest = {
                                    n: 1,
                                    nInserted: 1,
                                    nModified: 0,
                                    ok: 1,
                                }
                                // console.log('之前不存在且可自動插入', rest, v)

                            }
                            else {
                                //原已存在而更新

                                //rest
                                rest = {
                                    n: 1,
                                    nInserted: 0,
                                    nModified: 1,
                                    ok: 1,
                                }
                                // console.log('不相同時須更新', rest, v)

                            }

                        })
                        .catch((err) => {

                            //rest
                            rest = {
                                n: 1,
                                nInserted: 0,
                                nModified: 0,
                                ok: 0,
                                err: err.message,
                            }

                        })

                }
                else {
                    //未開啟autoInsert則僅能更新既有數據, 不可用INSERT以免無中生有,
                    //由UPDATE...WHERE主鍵原子完成[查找主鍵]與[更新], 併發時不會遺失更新

                    //mr
                    let mr = mongoSql.sql({
                        type: 'update',
                        table: cl,
                        updates: omit(v, pkName),
                        where: {
                            [pkName]: pkv,
                        },
                    })
                    // console.log('mr', mr)
                    // console.log('mr.query', mr.query)
                    // console.log('mr.values', mr.values)

                    //save
                    await client.query(mr.query, mr.values)
                        .then((r) => {

                            //check
                            if (r.rowCount > 0) {
                                //已更新

                                //rest
                                rest = {
                                    n: 1,
                                    nInserted: 0,
                                    nModified: 1,
                                    ok: 1,
                                }
                                // console.log('不相同時須更新', rest, v)

                            }
                            else {
                                //預讀後至更新前已被他人刪除, 視為不存在

                                //rest
                                rest = {
                                    n: 0,
                                    nInserted: 0,
                                    nModified: 0,
                                    ok: 1,
                                }

                            }

                        })
                        .catch((err) => {

                            //rest
                            rest = {
                                n: 1,
                                nInserted: 0,
                                nModified: 0,
                                ok: 0,
                                err: err.message,
                            }

                        })

                }

                return rest
            })

        }
        catch (err) {
            isErr = true
            res = err
        }
        finally {
            await client.end()
            client = null
        }

        //update
        if (useCache) {
            clearCache()
        }

        //emit
        if (!isErr) {
            try {
                ee.emit('change', 'save', data, res)
            }
            catch (err) {
                console.log(err)
            }
        }

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        return res
    }

    /**
     * 刪除數據
     *
     * 回傳陣列恆與輸入等長，各筆之n與nDeleted皆為主鍵命中筆數，值為0或1，未命中為0且屬正常結果。
     * 判斷某筆是否真的被刪除一律以nDeleted為準。
     * 未帶有效主鍵值者為該筆之輸入問題，回ok:0與err且不送查詢，不中斷其餘筆數，
     * 以此與[主鍵未命中]之ok:1區辨。
     *
     * @memberOf WOrmPostgresql
     * @param {Object|Array} data 輸入數據物件或陣列
     * @returns {Promise} 回傳Promise，resolve回傳刪除結果陣列[{n,nDeleted,ok}]，reject回傳錯誤訊息
     */
    async function del(data) {
        let isErr = false
        let res = null

        //check
        if (!iseobj(data) && !isearr(data)) {
            return []
        }

        //cloneDeep
        data = cloneDeep(data)

        //client
        let client = new PgClient({ connectionString })

        //connect
        try {

            //connect
            await client.connect()

        }
        catch (err) {
            isErr = true
            res = err
            client = null
        }

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        try {

            // //database, collection
            // let database = client.db(opt.db)
            // let collection = database.collection(opt.cl)

            //check
            if (!isarr(data)) {
                data = [data]
            }

            //pmSeries
            res = await pmSeries(data, async(v) => {

                //rest
                let rest = null

                //pkv
                let pkv = get(v, pkName)

                //check pk, 未帶有效主鍵者不補值亦不送查詢,
                //因mongo-sql會將無效值轉為null而誤中其他數據, 故直接視為該筆無法處理
                if (!checkPk(pkv)) {

                    //rest
                    rest = {
                        n: 0,
                        nDeleted: 0,
                        ok: 0,
                        err: `invalid ${pkName}[${pkv}]`,
                    }

                    return rest
                }

                //mr
                let mr = mongoSql.sql({
                    type: 'delete',
                    table: cl,
                    where: {
                        [pkName]: pkv,
                    },
                })
                // console.log('mr', mr)
                // console.log('mr.query', mr.query)
                // console.log('mr.values', mr.values)

                //del, n與nDeleted皆為主鍵命中筆數, 未命中為0
                await client.query(mr.query, mr.values)
                    .then((r) => {

                        //res
                        rest = {
                            n: r.rowCount,
                            nDeleted: r.rowCount,
                            ok: 1,
                        }

                    })
                    .catch((err) => {

                        //rest
                        rest = {
                            n: 1,
                            nDeleted: 0,
                            ok: 0,
                            err: err.message,
                        }

                    })

                return rest
            })

        }
        catch (err) {
            isErr = true
            res = err
        }
        finally {
            await client.end()
            client = null
        }

        //update
        if (useCache) {
            clearCache()
        }

        //emit
        if (!isErr) {
            try {
                ee.emit('change', 'del', data, res)
            }
            catch (err) {
                console.log(err)
            }
        }

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        return res
    }

    /**
     * 刪除全部數據，需與del分開，避免未傳數據導致直接刪除全表
     *
     * n與nDeleted皆為實際刪除筆數，不取全表筆數。find未給或為空物件時刪除全部數據，
     * 條件無命中時回{n:0,nDeleted:0,ok:1}，不視為錯誤。
     *
     * @memberOf WOrmPostgresql
     * @param {Object} [find={}] 輸入刪除條件物件
     * @returns {Promise} 回傳Promise，resolve回傳刪除結果物件{n,nDeleted,ok}，reject回傳錯誤訊息
     */
    async function delAll(find = {}) {
        let isErr = false
        let res = null

        //client
        let client = new PgClient({ connectionString })

        //connect
        try {

            //connect
            await client.connect()

        }
        catch (err) {
            isErr = true
            res = err
            client = null
        }

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        try {

            // //database, collection
            // let database = client.db(opt.db)
            // let collection = database.collection(opt.cl)

            // //deleteMany
            // res = await collection.deleteMany(find)

            // //res
            // res = {
            //     n: res.deletedCount,
            //     nDeleted: res.deletedCount,
            //     ok: res.acknowledged ? 1 : 0,
            // }

            //mr
            let mr = mongoSql.sql({
                type: 'delete',
                table: cl,
                where: find,
            })
            // console.log('mr', mr)
            // console.log('mr.query', mr.query)
            // console.log('mr.values', mr.values)

            //delAll
            await client.query(mr.query, mr.values)
                .then((r) => {

                    //res
                    res = {
                        n: r.rowCount,
                        nDeleted: r.rowCount,
                        ok: 1,
                    }

                })
                .catch((err) => {
                    isErr = true
                    res = err.message
                })

        }
        catch (err) {
            isErr = true
            res = err
        }
        finally {
            await client.end()
            client = null
        }

        //update
        if (useCache) {
            clearCache()
        }

        //emit
        if (!isErr) {
            try {
                ee.emit('change', 'delAll', null, res)
            }
            catch (err) {
                console.log(err)
            }
        }

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        return res
    }

    //save
    ee.createTable = createTable
    ee.select = select
    ee.selectByPk = selectByPk
    ee.insert = insert
    ee.save = save
    ee.del = del
    ee.delAll = delAll

    return ee
}


export default WOrmPostgresql
