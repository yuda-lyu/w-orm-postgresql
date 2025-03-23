import assert from 'assert'
import wo from '../src/WOrmPostgresql.mjs'


function isWindows() {
    return process.platform === 'win32'
}


if (isWindows()) {
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

            //w
            let w = wo(opt)

            //on
            w.on('change', function(mode, data, res) {
                // console.log('change', mode)
            })

            await w.createTable(opt.cl, 'time', {
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
            vans[1] = { ok: 1 }
            await w.delAll()
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
            vans[2] = { n: 13, nInserted: 13, ok: 1 }
            await w.insert(rs)
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
            vans[3] = [
                { n: 1, nModified: 0, ok: 1 },
                { n: 1, nModified: 1, ok: 1 },
                { n: 1, nModified: 1, ok: 1 },
                { n: 1, nModified: 1, ok: 1 },
                { n: 1, nInserted: 1, ok: 1 }
            ]
            await w.save(rsm, { autoInsert: true })
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
                { time: new Date('2025-01-01T00:12:00.000Z'), name: 'peter', value: 99 },
                { time: new Date('2025-01-01T00:13:00.000Z'), name: 'sandler', value: null }
            ]
            await w.select()
                .then(function(msg) {
                    // console.log('select all then', msg)
                    rt = msg
                })
                .catch(function(msg) {
                    // console.log('select all catch', msg)
                    rt = msg.toString()
                })
            vget[4] = rt

            //select by name
            rt = null
            vans[5] = [
                { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
                { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
                { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 }
            ]
            await w.select({ name: 'rosemary' })
                .then(function(msg) {
                    // console.log('select all then', msg)
                    rt = msg
                })
                .catch(function(msg) {
                    // console.log('select all catch', msg)
                    rt = msg.toString()
                })
            vget[5] = rt

            //select by $and, $gt, $lt
            rt = null
            vans[6] = [
                { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
                { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
                { time: new Date('2025-01-01T00:06:00.000Z'), name: 'peter', value: 125 },
                { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
                { time: new Date('2025-01-01T00:09:00.000Z'), name: 'peter', value: 127 }
            ]
            await w.select({ '$and': [{ value: { '$gt': 123 } }, { value: { '$lt': 200 } }] })
                .then(function(msg) {
                    // console.log('select all then', msg)
                    rt = msg
                })
                .catch(function(msg) {
                    // console.log('select all catch', msg)
                    rt = msg.toString()
                })
            vget[6] = rt

            //select by $or, $gte, $lte
            rt = null
            vans[7] = [
                { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
                { time: new Date('2025-01-01T00:03:00.000Z'), name: 'peter', value: 200 },
                { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
                { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
                { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 }
            ]
            await w.select({ '$or': [{ value: { '$lte': -1 } }, { value: { '$gte': 200 } }] })
                .then(function(msg) {
                    // console.log('select all then', msg)
                    rt = msg
                })
                .catch(function(msg) {
                    // console.log('select all catch', msg)
                    rt = msg.toString()
                })
            vget[7] = rt

            //select by $or, $and, $ne, $in, $nin
            rt = null
            vans[8] = [
                { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
                { time: new Date('2025-01-01T00:02:00.000Z'), name: 'kettle', value: 456 },
                { time: new Date('2025-01-01T00:05:00.000Z'), name: 'kettle', value: 488 },
                { time: new Date('2025-01-01T00:08:00.000Z'), name: 'kettle', value: 524 },
                { time: new Date('2025-01-01T00:11:00.000Z'), name: 'kettle(modify)', value: 447 }
            ]
            await w.select({ '$or': [{ '$and': [{ value: { '$ne': 123 } }, { value: { '$in': [123, 321, 123.456, 456] } }, { value: { '$nin': [456, 654] } }] }, { '$or': [{ value: { '$lte': -1 } }, { value: { '$gte': 400 } }] }] })
                .then(function(msg) {
                    // console.log('select all then', msg)
                    rt = msg
                })
                .catch(function(msg) {
                    // console.log('select all catch', msg)
                    rt = msg.toString()
                })
            vget[8] = rt

            // //select by regex
            // rt = null
            // vans[9] = []
            // let sr = await w.select({ name: { $regex: 'PeT', $options: '$i' } })
            //  .then(function(msg) {
            //      // console.log('select all then', msg)
            //      rt = msg
            //  })
            //  .catch(function(msg) {
            //      // console.log('select all catch', msg)
            //      rt = msg.toString()
            //  })
            //  vget[9] = rt

            //del
            rt = null
            vans[10] = [{ n: 1, nDeleted: 0, ok: 1 }]
            let d = {
                time: '2024-01-01T00:00:00Z',
            }
            await w.del(d)
                .then(function(msg) {
                    // console.log('del then', msg)
                    rt = msg
                })
                .catch(function(msg) {
                    // console.log('del catch', msg)
                    rt = msg.toString()
                })
            vget[10] = rt

            //del
            rt = null
            vans[11] = [
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
            let ss = await w.select()
            let ds = ss.filter(function(v) {
                return v.name.indexOf('peter') >= 0 || v.name.indexOf('kettle') >= 0 || v.name.indexOf('sandler') >= 0
            })
            await w.del(ds)
                .then(function(msg) {
                    // console.log('del then', msg)
                    rt = msg
                })
                .catch(function(msg) {
                    // console.log('del catch', msg)
                    rt = msg.toString()
                })
            vget[11] = rt

            //select all final
            rt = null
            vans[12] = [
                { time: new Date('2025-01-01T00:01:00.000Z'), name: 'rosemary', value: 123.456 },
                { time: new Date('2025-01-01T00:04:00.000Z'), name: 'rosemary', value: 123.1236 },
                { time: new Date('2025-01-01T00:07:00.000Z'), name: 'rosemary', value: 124.76 },
                { time: new Date('2025-01-01T00:10:00.000Z'), name: 'rosemary(modify)', value: 113.98 }
            ]
            await w.select()
                .then(function(msg) {
                // console.log('select all then', msg)
                    rt = msg
                })
                .catch(function(msg) {
                // console.log('select all catch', msg)
                    rt = msg.toString()
                })
            vget[12] = rt

        })

        it(`should get ${JSON.stringify(vans[1])} for delAll`, async function() {
            assert.strict.deepStrictEqual(vget[1], vans[1])
        })

        it(`should get ${JSON.stringify(vans[2])} for insert`, async function() {
            assert.strict.deepStrictEqual(vget[2], vans[2])
        })

        it(`should get ${JSON.stringify(vans[3])} for save`, async function() {
            assert.strict.deepStrictEqual(vget[3], vans[3])
        })

        it(`should get ${JSON.stringify(vans[4])} for select all`, async function() {
            assert.strict.deepStrictEqual(vget[4], vans[4])
        })

        it(`should get ${JSON.stringify(vans[5])} for select by name`, async function() {
            assert.strict.deepStrictEqual(vget[5], vans[5])
        })

        it(`should get ${JSON.stringify(vans[6])} for select by $and, $gt, $lt`, async function() {
            assert.strict.deepStrictEqual(vget[6], vans[6])
        })

        it(`should get ${JSON.stringify(vans[7])} for select by $or, $gte, $lte`, async function() {
            assert.strict.deepStrictEqual(vget[7], vans[7])
        })

        it(`should get ${JSON.stringify(vans[8])} for select by $or, $and, $ne, $in, $nin`, async function() {
            assert.strict.deepStrictEqual(vget[8], vans[8])
        })

        // it(`should get ${JSON.stringify(vans[9])} for select by regex`, async function() {
        //     assert.strict.deepStrictEqual(vget[9], vans[9])
        // })

        it(`should get ${JSON.stringify(vans[10])} for del`, async function() {
            assert.strict.deepStrictEqual(vget[10], vans[10])
        })

        it(`should get ${JSON.stringify(vans[11])} for del`, async function() {
            assert.strict.deepStrictEqual(vget[11], vans[11])
        })

        it(`should get ${JSON.stringify(vans[12])} for select all final`, async function() {
            assert.strict.deepStrictEqual(vget[12], vans[12])
        })

    })
}

