# w-orm-postgresql
An operator for postgresql in nodejs.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg) 
[![npm version](http://img.shields.io/npm/v/w-orm-postgresql.svg?style=flat)](https://npmjs.org/package/w-orm-postgresql) 
[![license](https://img.shields.io/npm/l/w-orm-postgresql.svg?style=flat)](https://npmjs.org/package/w-orm-postgresql) 
[![npm download](https://img.shields.io/npm/dt/w-orm-postgresql.svg)](https://npmjs.org/package/w-orm-postgresql) 
[![npm download](https://img.shields.io/npm/dm/w-orm-postgresql.svg)](https://npmjs.org/package/w-orm-postgresql) 
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-orm-postgresql.svg)](https://www.jsdelivr.com/package/npm/w-orm-postgresql)

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-orm-postgresql/WOrm.html).

## Installation

### Using npm(ES6 module):
```alias
npm i w-orm-postgresql
```

#### Example for collection
> **Link:** [[dev source code](https://github.com/yuda-lyu/w-orm-postgresql/blob/master/g-basic.mjs)]
```alias
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

let rsa = [
    {
        time: '2025-01-01T00:13:00Z',
        name: 'sandler',
    },
]

let rsb = [
    {
        time: '2025-01-01T00:20:00Z',
        name: 'bulk-1',
        value: 201,
    },
    {
        time: '2025-01-01T00:21:00Z',
        name: 'bulk-2',
        value: 202,
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
    wo.on('error', function(mode, data, err) {
        console.log('error', mode, err)
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

    //insertBulk, 全批視為一個單位, 全部插入成功或一筆都不寫入
    await wo.insertBulk(rsb)
        .then(function(msg) {
            console.log('insertBulk then', msg)
        })
        .catch(function(msg) {
            console.log('insertBulk catch', msg)
        })

    //insertBulk by pk existed, 任一筆之主鍵已存在即整批reject且不寫入任何一筆
    await wo.insertBulk(rsb)
        .then(function(msg) {
            console.log('insertBulk by pk existed then', msg)
        })
        .catch(function(msg) {
            console.log('insertBulk by pk existed catch', `${msg}`) //reject回傳Error物件, 以樣板字串取其訊息以免印出堆疊
        })

    //save
    await wo.save(rsm, { autoInsert: false })
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

    //selectByPk
    let sb = await wo.selectByPk('2025-01-01T00:10:00Z')
    console.log('selectByPk', sb)

    //selectByPk by pk not existed
    let sbn = await wo.selectByPk('2024-01-01T00:00:00Z')
    console.log('selectByPk by pk not existed', sbn)

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

    //save
    await wo.save(rsa, { autoInsert: true })
        .then(function(msg) {
            console.log('save then', msg)
        })
        .catch(function(msg) {
            console.log('save catch', msg)
        })

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

    //del by data without pk, 該筆無法處理故ok為0並附err, 整批仍resolve且另發出error事件
    await wo.del({ name: 'no-pk' })
        .then(function(msg) {
            console.log('del by data without pk then', msg)
        })
        .catch(function(msg) {
            console.log('del by data without pk catch', msg)
        })

    //del
    let ssDel = await wo.select()
    let ds = ssDel.filter(function(v) {
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
    let sc1 = await woc.select()
    sc1 = sc1.sort((a, b) => a.time - b.time)
    console.log('select all 1st (fill cache)', sc1)

    //select all (2nd time, 命中快取, 內容須與第一次相同)
    let sc2 = await woc.select()
    sc2 = sc2.sort((a, b) => a.time - b.time)
    console.log('select all 2nd (cache hit)', sc2)

    //save (更新rosemary, 觸發快取重設)
    await woc.save(rscm, { autoInsert: false })
        .then(function(msg) {
            console.log('save (invalidate cache) then', msg)
        })
        .catch(function(msg) {
            console.log('save (invalidate cache) catch', msg)
        })

    //select all (3rd time, 快取已重設, 從DB重新讀取, 須反映rosemary更新)
    let sc3 = await woc.select()
    sc3 = sc3.sort((a, b) => a.time - b.time)
    console.log('select all 3rd (reload after save)', sc3)

}
test()
// change delAll
// delAll then { n: 0, nDeleted: 0, ok: 1 }
// change insert
// insert then { n: 13, nInserted: 13, ok: 1 }
// change insertBulk
// insertBulk then { n: 2, nInserted: 2, ok: 1 }
// error insertBulk duplicate key value violates unique constraint "users_pkey"
// insertBulk by pk existed catch error: duplicate key value violates unique constraint "users_pkey"
// change save
// save then [
//   { n: 1, nInserted: 0, nModified: 0, ok: 1 },
//   { n: 1, nInserted: 0, nModified: 1, ok: 1 },
//   { n: 1, nInserted: 0, nModified: 1, ok: 1 },
//   { n: 1, nInserted: 0, nModified: 1, ok: 1 },
//   { n: 0, nInserted: 0, nModified: 0, ok: 1 }
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
//   { time: 2025-01-01T00:20:00.000Z, name: 'bulk-1', value: 201 },
//   { time: 2025-01-01T00:21:00.000Z, name: 'bulk-2', value: 202 },
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
//   { time: 2025-01-01T00:12:00.000Z, name: 'peter', value: 99 }
// ]
// select by name [
//   { time: 2025-01-01T00:01:00.000Z, name: 'rosemary', value: 123.456 },
//   { time: 2025-01-01T00:04:00.000Z, name: 'rosemary', value: 123.1236 },
//   { time: 2025-01-01T00:07:00.000Z, name: 'rosemary', value: 124.76 }
// ]
// selectByPk {
//   time: 2025-01-01T00:10:00.000Z,
//   name: 'rosemary(modify)',
//   value: 113.98
// }
// selectByPk by pk not existed null
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
//   { time: 2025-01-01T00:20:00.000Z, name: 'bulk-1', value: 201 },
//   { time: 2025-01-01T00:21:00.000Z, name: 'bulk-2', value: 202 },
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
// change insert
// change save
// save then [ { n: 1, nInserted: 1, nModified: 0, ok: 1 } ]
// change del
// del then [ { n: 0, nDeleted: 0, ok: 1 } ]
// error del invalid time[undefined]
// change del
// del by data without pk then [ { n: 0, nDeleted: 0, ok: 0, err: 'invalid time[undefined]' } ]
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
//   { time: 2025-01-01T00:20:00.000Z, name: 'bulk-1', value: 201 },
//   { time: 2025-01-01T00:21:00.000Z, name: 'bulk-2', value: 202 },
//   {
//     time: 2025-01-01T00:10:00.000Z,
//     name: 'rosemary(modify)',
//     value: 113.98
//   }
// ]
// change delAll
// select all 1st (fill cache) [
//   { time: 2025-01-01T00:00:00.000Z, name: 'peter', value: 123 },
//   { time: 2025-01-01T00:01:00.000Z, name: 'rosemary', value: 123.456 },
//   { time: 2025-01-01T00:02:00.000Z, name: 'kettle', value: 456 }
// ]
// select all 2nd (cache hit) [
//   { time: 2025-01-01T00:00:00.000Z, name: 'peter', value: 123 },
//   { time: 2025-01-01T00:01:00.000Z, name: 'rosemary', value: 123.456 },
//   { time: 2025-01-01T00:02:00.000Z, name: 'kettle', value: 456 }
// ]
// save (invalidate cache) then [ { n: 1, nInserted: 0, nModified: 1, ok: 1 } ]
// select all 3rd (reload after save) [
//   { time: 2025-01-01T00:00:00.000Z, name: 'peter', value: 123 },
//   {
//     time: 2025-01-01T00:01:00.000Z,
//     name: 'rosemary(modify)',
//     value: 654.321
//   },
//   { time: 2025-01-01T00:02:00.000Z, name: 'kettle', value: 456 }
// ]
```
