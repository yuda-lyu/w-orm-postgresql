import assert from 'assert'
import WOrm from '../src/WOrmPostgresql.mjs'


describe('basic', function() {
    let rt = null
    let vans = {}
    let vget = {}

    before(async function () {

        let opt = {
            url: 'postgresql://username:password@127.0.0.1:5432',
            db: 'worm',
            cl: 'users',
        }

        //probe, 偵測postgres是否可用, 不可用則skip全部測試
        //pg預設無connect timeout, 連不到時會等到OS socket timeout (~75s), 故用Promise.race包3s timeout
        try {
            let probe = WOrm(opt)
            await Promise.race([
                probe.select(),
                new Promise((_resolve, reject) => setTimeout(() => reject(new Error('probe timeout')), 3000)),
            ])
        }
        catch (err) {
            let msg = err && err.message ? err.message : err
            console.log(`PostgreSQL unavailable, skip tests: ${msg}`)
            this.skip()
            return
        }

        let rs = [
            {
                time: '2025-01-01T00:00:00Z',
                name: 'peter',
                value: 123,
            },
            {
                time: '2025-01-01T00:01:00Z',
                name: 'rosemary',
                value: 123.456,
            },
            {
                time: '2025-01-01T00:02:00Z',
                name: 'kettle',
                value: 456,
            },
            {
                time: '2025-01-01T00:03:00Z',
                name: 'peter',
                value: 200,
            },
            {
                time: '2025-01-01T00:04:00Z',
                name: 'rosemary',
                value: 123.1236,
            },
            {
                time: '2025-01-01T00:05:00Z',
                name: 'kettle',
                value: 488,
            },
            {
                time: '2025-01-01T00:06:00Z',
                name: 'peter',
                value: 125,
            },
            {
                time: '2025-01-01T00:07:00Z',
                name: 'rosemary',
                value: 124.76,
            },
            {
                time: '2025-01-01T00:08:00Z',
                name: 'kettle',
                value: 524,
            },
            {
                time: '2025-01-01T00:09:00Z',
                name: 'peter',
                value: 127,
            },
            {
                time: '2025-01-01T00:10:00Z',
                name: 'rosemary',
                value: 113.98,
            },
            {
                time: '2025-01-01T00:11:00Z',
                name: 'kettle',
                value: 447,
            },
            {
                time: '2025-01-01T00:12:00Z',
                name: 'peter',
                value: 131,
            },
        ]

        let rsm = [
            { //相同
                time: '2025-01-01T00:09:00Z',
                name: 'peter',
                value: 127,
            },
            { //name變更
                time: '2025-01-01T00:10:00Z',
                name: 'rosemary(modify)',
                value: 113.98,
            },
            { //name變更
                time: '2025-01-01T00:11:00Z',
                name: 'kettle(modify)',
                value: 447,
            },
            { //無name且value變更
                time: '2025-01-01T00:12:00Z',
                // name: 'peter',
                value: 99,
            },
            { //無time須新增且新增數據無value
                time: '2025-01-01T00:13:00Z',
                name: 'sandler',
            },
        ]

        let rsa = [
            {
                time: '2025-01-01T00:13:00Z',
                name: 'sandler',
            },
        ]

        //wo
        let wo = WOrm(opt)

        //on
        wo.on('change', function(mode, data, res) {
            // console.log('change', mode)
        })

        await wo.createTable(opt.cl, 'time', {
            time: '2000-01-01T00:00:00Z', //time
            name: 'abc', //string
            value: 0.1, //float
        })
            .then(function(msg) {
                // console.log('createTable then', msg)
            })
            .catch(function(msg) {
                // console.log('createTable catch', msg)
            })

        //delAll
        rt = null
        // vans[1] = { ok: 1 }
        await wo.delAll()
            .then(function(msg) {
                // console.log('delAll then', msg)
                //考慮有不同初始狀態, 僅比對ok欄位
                rt = {
                    ok: msg.ok,
                }
            })
            .catch(function(msg) {
                // console.log('delAll catch', msg)
                rt = msg.toString()
            })
        vget[1] = rt

        //insert
        rt = null
        // vans[2] = { n: 13, nInserted: 13, ok: 1 }
        await wo.insert(rs)
            .then(function(msg) {
                // console.log('insert then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('insert catch', msg)
                rt = msg.toString()
            })
        vget[2] = rt

        //save
        rt = null
        // vans[3] = [
        //     { n: 1, nModified: 0, ok: 1 },
        //     { n: 1, nModified: 1, ok: 1 },
        //     { n: 1, nModified: 1, ok: 1 },
        //     { n: 1, nModified: 1, ok: 1 },
        //     { n: 0, nModified: 0, ok: 1 }
        // ]
        await wo.save(rsm, { autoInsert: false })
            .then(function(msg) {
                // console.log('save then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('save catch', msg)
                rt = msg.toString()
            })
        vget[3] = rt

        //select all
        rt = null
        // vans[4] = [
        //     { time: new Date('2025-01-01T00:00:00.000Z'), name: 'peter', value: 123 },
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        //     { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        //     { time: new Date('2025-01-01T00:03:00.000Z'), name: 'peter', value: 200 },
        //     { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        //     { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
        //     { time: new Date('2025-01-01T00:06:00.000Z'), name: 'peter', value: 125 },
        //     { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
        //     { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
        //     { time: new Date('2025-01-01T00:09:00.000Z'), name: 'peter', value: 127 },
        //     { time: new Date('2025-01-01T00:10:00.000Z'), name: 'rosemary(modify)', value: 113.98 },
        //     { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 },
        //     { time: new Date('2025-01-01T00:12:00.000Z'), name: 'peter', value: 99 }
        // ]
        await wo.select()
            .then(function(msg) {
                // console.log('select all then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('select all catch', msg)
                rt = msg.toString()
            })
        vget[4] = rt

        //select all by cache
        rt = null
        // vans[5] = vans[4]
        await wo.select()
            .then(function(msg) {
                // console.log('select all by cache then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('select all by cache catch', msg)
                rt = msg.toString()
            })
        vget[5] = rt

        //select by name
        rt = null
        // vans[6] = [
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        //     { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        //     { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 }
        // ]
        await wo.select({ name: 'rosemary' })
            .then(function(msg) {
                // console.log('select all then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('select all catch', msg)
                rt = msg.toString()
            })
        vget[6] = rt

        //select by $and, $gt, $lt
        rt = null
        // vans[7] = [
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        //     { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        //     { time: new Date('2025-01-01T00:06:00.000Z'), name: 'peter', value: 125 },
        //     { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
        //     { time: new Date('2025-01-01T00:09:00.000Z'), name: 'peter', value: 127 }
        // ]
        await wo.select({ '$and': [{ value: { '$gt': 123 } }, { value: { '$lt': 200 } }] })
            .then(function(msg) {
                // console.log('select all then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('select all catch', msg)
                rt = msg.toString()
            })
        vget[7] = rt

        //select by $or, $gte, $lte
        rt = null
        // vans[8] = [
        //     { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        //     { time: new Date('2025-01-01T00:03:00.000Z'), name: 'peter', value: 200 },
        //     { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
        //     { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
        //     { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 }
        // ]
        await wo.select({ '$or': [{ value: { '$lte': -1 } }, { value: { '$gte': 200 } }] })
            .then(function(msg) {
                // console.log('select all then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('select all catch', msg)
                rt = msg.toString()
            })
        vget[8] = rt

        //select by $or, $and, $ne, $in, $nin
        rt = null
        // vans[9] = [
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        //     { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        //     { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
        //     { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
        //     { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 }
        // ]
        await wo.select({ '$or': [{ '$and': [{ value: { '$ne': 123 } }, { value: { '$in': [123, 321, 123.456, 456] } }, { value: { '$nin': [456, 654] } }] }, { '$or': [{ value: { '$lte': -1 } }, { value: { '$gte': 400 } }] }] })
            .then(function(msg) {
                // console.log('select all then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('select all catch', msg)
                rt = msg.toString()
            })
        vget[9] = rt

        // //select by regex
        // rt = null
        // vans[14] = []
        // let sr = await wo.select({ name: { $regex: 'PeT', $options: '$i' } })
        //  .then(function(msg) {
        //      // console.log('select all then', msg)
        //      rt = msg
        //  })
        //  .catch(function(msg) {
        //      // console.log('select all catch', msg)
        //      rt = msg.toString()
        //  })
        //  vget[14] = rt

        //save
        rt = null
        // vans[10] = [{ n: 1, nInserted: 1, ok: 1 }]
        await wo.save(rsa, { autoInsert: true })
            .then(function(msg) {
                // console.log('save then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('save catch', msg)
                rt = msg.toString()
            })
        vget[10] = rt

        //del
        rt = null
        // vans[11] = [{ n: 1, nDeleted: 0, ok: 1 }]
        let d = {
            time: '2024-01-01T00:00:00Z',
        }
        await wo.del(d)
            .then(function(msg) {
                // console.log('del then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('del catch', msg)
                rt = msg.toString()
            })
        vget[11] = rt

        //del
        rt = null
        // vans[12] = [
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 },
        //     { n: 1, nDeleted: 1, ok: 1 }
        // ]
        let ss = await wo.select()
        let ds = ss.filter(function(v) {
            return v.name.indexOf('peter') >= 0 || v.name.indexOf('kettle') >= 0 || v.name.indexOf('sandler') >= 0
        })
        await wo.del(ds)
            .then(function(msg) {
                // console.log('del then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('del catch', msg)
                rt = msg.toString()
            })
        vget[12] = rt

        //select all final
        rt = null
        // vans[13] = [
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        //     { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        //     { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
        //     { time: new Date('2025-01-01T00:10:00.000Z'), name: 'rosemary(modify)', value: 113.98 }
        // ]
        await wo.select()
            .then(function(msg) {
            // console.log('select all then', msg)
                rt = msg
            })
            .catch(function(msg) {
            // console.log('select all catch', msg)
                rt = msg.toString()
            })
        vget[13] = rt

        //清除數據, 後續cache測試共用users表
        await wo.delAll()

        //woc, 啟用useCache
        let woc = WOrm({
            ...opt,
            useCache: true,
        })

        let rsc = [
            {
                time: '2025-01-01T00:00:00Z',
                name: 'peter',
                value: 123,
            },
            {
                time: '2025-01-01T00:01:00Z',
                name: 'rosemary',
                value: 123.456,
            },
            {
                time: '2025-01-01T00:02:00Z',
                name: 'kettle',
                value: 456,
            },
        ]

        let rscm = [
            {
                time: '2025-01-01T00:01:00Z',
                name: 'rosemary(modify)',
                value: 654.321,
            },
        ]

        //insert
        await woc.insert(rsc)

        //select all (1st time, 從DB讀取並填入快取)
        rt = null
        // vans[14] = [
        //     { time: new Date('2025-01-01T00:00:00.000Z'), name: 'peter', value: 123 },
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        //     { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        // ]
        await woc.select()
            .then(function(msg) {
                // console.log('select 1st then', msg)
                //依time排序, postgres UPDATE後物理順序可能改變
                rt = msg.sort((a, b) => a.time - b.time)
            })
            .catch(function(msg) {
                // console.log('select 1st catch', msg)
                rt = msg.toString()
            })
        vget[14] = rt

        //select all (2nd time, 命中快取, 內容須與第一次相同)
        rt = null
        // vans[15] = vans[14]
        await woc.select()
            .then(function(msg) {
                // console.log('select 2nd then', msg)
                rt = msg.sort((a, b) => a.time - b.time)
            })
            .catch(function(msg) {
                // console.log('select 2nd catch', msg)
                rt = msg.toString()
            })
        vget[15] = rt

        //save (更新rosemary, 觸發快取重設)
        rt = null
        // vans[16] = [{ n: 1, nModified: 1, ok: 1 }]
        await woc.save(rscm, { autoInsert: false })
            .then(function(msg) {
                // console.log('save then', msg)
                rt = msg
            })
            .catch(function(msg) {
                // console.log('save catch', msg)
                rt = msg.toString()
            })
        vget[16] = rt

        //select all (3rd time, 快取已重設, 從DB重新讀取, 須反映rosemary更新)
        rt = null
        // vans[17] = [
        //     { time: new Date('2025-01-01T00:00:00.000Z'), name: 'peter', value: 123 },
        //     { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary(modify)', value: 654.321 },
        //     { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        // ]
        await woc.select()
            .then(function(msg) {
                // console.log('select 3rd then', msg)
                rt = msg.sort((a, b) => a.time - b.time)
            })
            .catch(function(msg) {
                // console.log('select 3rd catch', msg)
                rt = msg.toString()
            })
        vget[17] = rt

    })

    vans[1] = { ok: 1 }
    it(`should get ${JSON.stringify(vans[1])} for delAll`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = { n: 13, nInserted: 13, ok: 1 }
    it(`should get ${JSON.stringify(vans[2])} for insert`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = [
        { n: 1, nModified: 0, ok: 1 },
        { n: 1, nModified: 1, ok: 1 },
        { n: 1, nModified: 1, ok: 1 },
        { n: 1, nModified: 1, ok: 1 },
        { n: 0, nModified: 0, ok: 1 }
    ]
    it(`should get ${JSON.stringify(vans[3])} for save(autoInsert=false)`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = [
        { time: new Date('2025-01-01T00:00:00.000Z'), name: 'peter', value: 123 },
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        { time: new Date('2025-01-01T00:03:00.000Z'), name: 'peter', value: 200 },
        { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
        { time: new Date('2025-01-01T00:06:00.000Z'), name: 'peter', value: 125 },
        { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
        { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
        { time: new Date('2025-01-01T00:09:00.000Z'), name: 'peter', value: 127 },
        { time: new Date('2025-01-01T00:10:00.000Z'), name: 'rosemary(modify)', value: 113.98 },
        { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 },
        { time: new Date('2025-01-01T00:12:00.000Z'), name: 'peter', value: 99 }
    ]
    it(`should get ${JSON.stringify(vans[4])} for select all`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = vans[4]
    it(`should get ${JSON.stringify(vans[5])} for select all by cache`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = [
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 }
    ]
    it(`should get ${JSON.stringify(vans[6])} for select by name`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = [
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        { time: new Date('2025-01-01T00:06:00.000Z'), name: 'peter', value: 125 },
        { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
        { time: new Date('2025-01-01T00:09:00.000Z'), name: 'peter', value: 127 }
    ]
    it(`should get ${JSON.stringify(vans[7])} for select by $and, $gt, $lt`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = [
        { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        { time: new Date('2025-01-01T00:03:00.000Z'), name: 'peter', value: 200 },
        { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
        { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
        { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 }
    ]
    it(`should get ${JSON.stringify(vans[8])} for select by $or, $gte, $lte`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = [
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
        { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
        { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
        { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 }
    ]
    it(`should get ${JSON.stringify(vans[9])} for select by $or, $and, $ne, $in, $nin`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

    // vans[14] = []
    // it(`should get ${JSON.stringify(vans[14])} for select by regex`, async function() {
    //     assert.strict.deepStrictEqual(vget[14], vans[14])
    // })

    vans[10] = [{ n: 1, nInserted: 1, ok: 1 }]
    it(`should get ${JSON.stringify(vans[10])} for save(autoInsert=true)`, async function() {
        assert.strict.deepStrictEqual(vget[10], vans[10])
    })

    vans[11] = [{ n: 1, nDeleted: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[11])} for del`, async function() {
        assert.strict.deepStrictEqual(vget[11], vans[11])
    })

    vans[12] = [
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 1, nDeleted: 1, ok: 1 }
    ]
    it(`should get ${JSON.stringify(vans[12])} for del`, async function() {
        assert.strict.deepStrictEqual(vget[12], vans[12])
    })

    vans[13] = [
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
        { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
        { time: new Date('2025-01-01T00:10:00.000Z'), name: 'rosemary(modify)', value: 113.98 }
    ]
    it(`should get ${JSON.stringify(vans[13])} for select all final`, async function() {
        assert.strict.deepStrictEqual(vget[13], vans[13])
    })

    vans[14] = [
        { time: new Date('2025-01-01T00:00:00.000Z'), name: 'peter', value: 123 },
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
        { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
    ]
    it(`should get ${JSON.stringify(vans[14])} for select all (1st, fill cache)`, async function() {
        assert.strict.deepStrictEqual(vget[14], vans[14])
    })

    vans[15] = vans[14]
    it(`should get ${JSON.stringify(vans[15])} for select all (2nd, cache hit)`, async function() {
        assert.strict.deepStrictEqual(vget[15], vans[15])
    })

    vans[16] = [{ n: 1, nModified: 1, ok: 1 }]
    it(`should get ${JSON.stringify(vans[16])} for save (invalidate cache)`, async function() {
        assert.strict.deepStrictEqual(vget[16], vans[16])
    })

    vans[17] = [
        { time: new Date('2025-01-01T00:00:00.000Z'), name: 'peter', value: 123 },
        { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary(modify)', value: 654.321 },
        { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
    ]
    it(`should get ${JSON.stringify(vans[17])} for select all (3rd, reload after save)`, async function() {
        assert.strict.deepStrictEqual(vget[17], vans[17])
    })

})
