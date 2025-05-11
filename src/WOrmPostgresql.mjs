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
import pmSeries from 'wsemi/src/pmSeries.mjs'


/**
 * 操作資料庫(PostgreSQL)
 *
 * @class
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {String} [opt.url='postgresql://127.0.0.1:5432'] 輸入連接資料庫字串，預設'postgresql://127.0.0.1:5432'
 * @param {String} [opt.db='worm'] 輸入使用資料庫名稱字串，預設'worm'
 * @param {String} [opt.cl='test'] 輸入使用資料表名稱字串，預設'test'
 * @returns {Object} 回傳操作資料庫物件，各事件功能詳見說明
 */
function WOrmPostgresql(opt = {}) {

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
        let conflictKeys = ['time']

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

    /**
     * 創建資料表
     *
     * @memberOf WOrmPostgresql
     * @param {String} cl 輸入資料表名字串
     * @param {String} pk 輸入主鍵字串
     * @param {Array|Object} arr 輸入數據物件陣列或數據物件
     * @returns {Promise} 回傳Promise，resolve回傳成功訊息，reject回傳錯誤訊息
     */
    async function createTable(cl, pk, arr) {
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
     * 插入數據
     *
     * @memberOf WOrmPostgresql
     * @param {Object|Array} data 輸入數據物件或陣列
     * @returns {Promise} 回傳Promise，resolve回傳插入結果，reject回傳錯誤訊息
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

            //check time
            data = map(data, function(v, k) {
                if (!isDate(v.time)) {
                    throw new Error(`invalid data[${k}].time[${v.time}]`)
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

            //nAll, nInsert
            let nAll = size(data)
            let nInsert = nAll //一次插入全部數據加速, 但也因此沒法個別處理conflict, 無法個別計算已插入數量

            //insert
            await client.query(mr.query, mr.values)
                .then(() => {

                    //res
                    res = {
                        n: nAll,
                        nInserted: nInsert,
                        ok: 1,
                    }

                    //emit
                    ee.emit('change', 'insert', data, res)

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

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        return res
    }

    /**
     * 儲存數據
     *
     * @memberOf WOrmPostgresql
     * @param {Object|Array} data 輸入數據物件或陣列
     * @param {Object} [option={}] 輸入設定物件，預設為{}
     * @param {boolean} [option.autoInsert=true] 輸入是否於儲存時發現原本無數據，則自動改以插入處理，預設為true
     * @returns {Promise} 回傳Promise，resolve回傳儲存結果，reject回傳錯誤訊息
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

            //check time
            data = map(data, function(v, k) {
                if (!isDate(v.time)) {
                    throw new Error(`invalid data[${k}].time[${v.time}]`)
                }
                return v
            })

            //pmSeries
            res = await pmSeries(data, async(v) => {

                //rest
                let rest = null

                //_v
                let _v = null
                if (true) {

                    //mr
                    let mr = mongoSql.sql({
                        type: 'select',
                        table: cl,
                        where: {
                            time: v.time,
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

                //check
                if (iseobj(_v)) {
                    //存在

                    //_vt
                    let _vt = omit(_v, 'time')
                    // console.log('_vt', _vt)

                    //vt
                    let vt = omit(v, 'time')
                    // console.log('vt', vt)

                    if (isEqual(_vt, vt)) {
                        //相同時不更新

                        //rest
                        rest = {
                            n: 1,
                            nModified: 0,
                            ok: 1,
                        }
                        // console.log('相同時不更新', rest, v)

                    }
                    else {
                        //不相同時須更新

                        //mr
                        let mr = mongoSql.sql({
                            type: 'insert',
                            table: cl,
                            values: v,
                        })
                        // console.log('mr', mr)
                        // console.log('mr.query', mr.query)
                        // console.log('mr.values', mr.values)

                        //添加conflict
                        let conflict = genConflictSQL(v)

                        //sql
                        let sql = `${mr.query} ${conflict}`

                        //save
                        await client.query(sql, mr.values)
                            .then(() => {

                                //rest
                                rest = {
                                    n: 1,
                                    nModified: 1,
                                    ok: 1,
                                }
                                // console.log('不相同時須更新', rest, vt)

                            })
                            .catch((err) => {

                                //rest
                                rest = {
                                    n: 1,
                                    nModified: 0,
                                    ok: 0,
                                    err: err.message,
                                }

                            })

                    }
                }
                else {
                    //不存在

                    //rest
                    rest = {
                        n: 0,
                        nModified: 0,
                        ok: 1,
                    }
                    // console.log('不存在', rest, v)

                }

                //autoInsert
                if (autoInsert && rest.n === 0) {
                    //之前不存在(rest.n)且可自動插入(autoInsert=true)

                    //mr
                    let mr = mongoSql.sql({
                        type: 'insert',
                        table: cl,
                        values: v,
                    })
                    // console.log('mr', mr)
                    // console.log('mr.query', mr.query)
                    // console.log('mr.values', mr.values)

                    //save
                    await client.query(mr.query, mr.values)
                        .then(() => {

                            //rest
                            rest = {
                                n: 1,
                                nInserted: 1,
                                ok: 1,
                            }
                            // console.log('之前不存在且可自動插入', rest, v)

                        })
                        .catch((err) => {

                            //rest
                            rest = {
                                n: 1,
                                nInserted: 0,
                                ok: 0,
                                err: err.message,
                            }

                        })

                }

                return rest
            })

            //emit
            ee.emit('change', 'save', data, res)

        }
        catch (err) {
            isErr = true
            res = err
        }
        finally {
            await client.end()
            client = null
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
     * @memberOf WOrmPostgresql
     * @param {Object|Array} data 輸入數據物件或陣列
     * @returns {Promise} 回傳Promise，resolve回傳刪除結果，reject回傳錯誤訊息
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

            //check time
            data = map(data, function(v, k) {
                if (!isDate(v.time)) {
                    throw new Error(`invalid data[${k}].time[${v.time}]`)
                }
                return v
            })

            //pmSeries
            res = await pmSeries(data, async(v) => {

                //rest
                let rest = null

                //mr
                let mr = mongoSql.sql({
                    type: 'delete',
                    table: cl,
                    where: {
                        time: v.time,
                    },
                })
                // console.log('mr', mr)
                // console.log('mr.query', mr.query)
                // console.log('mr.values', mr.values)

                //del
                await client.query(mr.query, mr.values)
                    .then((r) => {

                        //res
                        rest = {
                            n: 1,
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

            //emit
            ee.emit('change', 'del', data, res)

        }
        catch (err) {
            isErr = true
            res = err
        }
        finally {
            await client.end()
            client = null
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
     * @memberOf WOrmPostgresql
     * @param {Object} [find={}] 輸入刪除條件物件
     * @returns {Promise} 回傳Promise，resolve回傳刪除結果，reject回傳錯誤訊息
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

                    //emit
                    ee.emit('change', 'delAll', null, res)

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

        //check
        if (isErr) {
            return Promise.reject(res)
        }

        return res
    }

    //save
    ee.createTable = createTable
    ee.select = select
    ee.insert = insert
    ee.save = save
    ee.del = del
    ee.delAll = delAll

    return ee
}


export default WOrmPostgresql
