import WOrm from './src/WOrmPostgresql.mjs'
//import WOrm from './dist/w-orm-postgresql.umd.js'


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

async function test() {

    //wo
    let wo = WOrm(opt)
    // console.log('wo', wo)

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

    //on
    wo.on('change', function(mode, data, res) {
        console.log('change', mode)
    })

    //delAll
    await wo.delAll()
        .then(function(msg) {
            console.log('delAll then', msg)
        })
        .catch(function(msg) {
            console.log('delAll catch', msg)
        })

    //insert
    await wo.insert(rs)
        .then(function(msg) {
            console.log('insert then', msg)
        })
        .catch(function(msg) {
            console.log('insert catch', msg)
        })

    //save
    await wo.save(rsm, { autoInsert: true })
        .then(function(msg) {
            console.log('save then', msg)
        })
        .catch(function(msg) {
            console.log('save catch', msg)
        })

    //select all
    let ss = await wo.select()
    console.log('select all', ss)

    //select
    let so = await wo.select({ name: 'rosemary' })
    console.log('select by name', so)

    //select by $and, $gt, $lt
    let spa = await wo.select({ '$and': [{ value: { '$gt': 123 } }, { value: { '$lt': 200 } }] })
    console.log('select by $and, $gt, $lt', spa)

    //select by $or, $gte, $lte
    let spb = await wo.select({ '$or': [{ value: { '$lte': -1 } }, { value: { '$gte': 200 } }] })
    console.log('select by $or, $gte, $lte', spb)

    //select by $or, $and, $ne, $in, $nin
    let spc = await wo.select({ '$or': [{ '$and': [{ value: { '$ne': 123 } }, { value: { '$in': [123, 321, 123.456, 456] } }, { value: { '$nin': [456, 654] } }] }, { '$or': [{ value: { '$lte': -1 } }, { value: { '$gte': 400 } }] }] })
    console.log('select by $or, $and, $ne, $in, $nin', spc)

    // //select by regex
    // let sr = await wo.select({ name: { $regex: 'PeT', $options: '$i' } })
    // console.log('selectReg', sr)

    //del
    let d = {
        time: '2024-01-01T00:00:00Z',
    }
    await wo.del(d)
        .then(function(msg) {
            console.log('del then', msg)
        })
        .catch(function(msg) {
            console.log('del catch', msg)
        })

    //del
    let ds = ss.filter(function(v) {
        return v.name.indexOf('peter') >= 0 || v.name.indexOf('kettle') >= 0 || v.name.indexOf('sandler') >= 0
    })
    await wo.del(ds)
        .then(function(msg) {
            console.log('del then', msg)
        })
        .catch(function(msg) {
            console.log('del catch', msg)
        })

    //select all final
    let ss2 = await wo.select()
    console.log('select all final', ss2)

}
test()
// change delAll
// delAll then { n: 5, nDeleted: 5, ok: 1 }
// change insert
// insert then { n: 13, nInserted: 13, ok: 1 }
// change save
// save then [
//   { n: 1, nModified: 0, ok: 1 },
//   { n: 1, nModified: 1, ok: 1 },
//   { n: 1, nModified: 1, ok: 1 },
//   { n: 1, nModified: 1, ok: 1 },
//   { n: 1, nInserted: 1, ok: 1 }
// ]
// select all [
//   { time: 2025-01-01T00:00:00.000Z, name: 'peter', value: 123 },
//   { time: 2025-01-01T00:01:00.000Z, name: 'rosemary', value: 123.456 },
//   { time: 2025-01-01T00:02:00.000Z, name: 'kettle', value: 456 },
//   { time: 2025-01-01T00:03:00.000Z, name: 'peter', value: 200 },
//   { time: 2025-01-01T00:04:00.000Z, name: 'rosemary', value: 123.1236 },
//   { time: 2025-01-01T00:05:00.000Z, name: 'kettle', value: 488 },
//   { time: 2025-01-01T00:06:00.000Z, name: 'peter', value: 125 },
//   { time: 2025-01-01T00:07:00.000Z, name: 'rosemary', value: 124.76 },
//   { time: 2025-01-01T00:08:00.000Z, name: 'kettle', value: 524 },
//   { time: 2025-01-01T00:09:00.000Z, name: 'peter', value: 127 },
//   {
//     time: 2025-01-01T00:10:00.000Z,
//     name: 'rosemary(modify)',
//     value: 113.98
//   },
//   {
//     time: 2025-01-01T00:11:00.000Z,
//     name: 'kettle(modify)',
//     value: 447
//   },
//   { time: 2025-01-01T00:12:00.000Z, name: 'peter', value: 99 },
//   { time: 2025-01-01T00:13:00.000Z, name: 'sandler', value: null }
// ]
// select by name [
//   { time: 2025-01-01T00:01:00.000Z, name: 'rosemary', value: 123.456 },
//   { time: 2025-01-01T00:04:00.000Z, name: 'rosemary', value: 123.1236 },
//   { time: 2025-01-01T00:07:00.000Z, name: 'rosemary', value: 124.76 }
// ]
// select by $and, $gt, $lt [
//   { time: 2025-01-01T00:01:00.000Z, name: 'rosemary', value: 123.456 },
//   { time: 2025-01-01T00:04:00.000Z, name: 'rosemary', value: 123.1236 },
//   { time: 2025-01-01T00:06:00.000Z, name: 'peter', value: 125 },
//   { time: 2025-01-01T00:07:00.000Z, name: 'rosemary', value: 124.76 },
//   { time: 2025-01-01T00:09:00.000Z, name: 'peter', value: 127 }
// ]
// select by $or, $gte, $lte [
//   { time: 2025-01-01T00:02:00.000Z, name: 'kettle', value: 456 },
//   { time: 2025-01-01T00:03:00.000Z, name: 'peter', value: 200 },
//   { time: 2025-01-01T00:05:00.000Z, name: 'kettle', value: 488 },
//   { time: 2025-01-01T00:08:00.000Z, name: 'kettle', value: 524 },
//   {
//     time: 2025-01-01T00:11:00.000Z,
//     name: 'kettle(modify)',
//     value: 447
//   }
// ]
// select by $or, $and, $ne, $in, $nin [
//   { time: 2025-01-01T00:01:00.000Z, name: 'rosemary', value: 123.456 },
//   { time: 2025-01-01T00:02:00.000Z, name: 'kettle', value: 456 },
//   { time: 2025-01-01T00:05:00.000Z, name: 'kettle', value: 488 },
//   { time: 2025-01-01T00:08:00.000Z, name: 'kettle', value: 524 },
//   {
//     time: 2025-01-01T00:11:00.000Z,
//     name: 'kettle(modify)',
//     value: 447
//   }
// ]
// change del
// del then [ { n: 1, nDeleted: 0, ok: 1 } ]
// change del
// del then [
//   { n: 1, nDeleted: 1, ok: 1 },
//   { n: 1, nDeleted: 1, ok: 1 },
//   { n: 1, nDeleted: 1, ok: 1 },
//   { n: 1, nDeleted: 1, ok: 1 },
//   { n: 1, nDeleted: 1, ok: 1 },
//   { n: 1, nDeleted: 1, ok: 1 },
//   { n: 1, nDeleted: 1, ok: 1 },
//   { n: 1, nDeleted: 1, ok: 1 },
//   { n: 1, nDeleted: 1, ok: 1 },
//   { n: 1, nDeleted: 1, ok: 1 }
// ]
// select all final [
//   { time: 2025-01-01T00:01:00.000Z, name: 'rosemary', value: 123.456 },
//   { time: 2025-01-01T00:04:00.000Z, name: 'rosemary', value: 123.1236 },
//   { time: 2025-01-01T00:07:00.000Z, name: 'rosemary', value: 124.76 },
//   {
//     time: 2025-01-01T00:10:00.000Z,
//     name: 'rosemary(modify)',
//     value: 113.98
//   }
// ]

//node g-basic.mjs
