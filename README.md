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

## Condition (`find`) whitelist and `order`
`select(find, order)` and `delAll(find)` take a MongoDB-style condition object and translate it to SQL: the checked copy is lowered to a dialect-neutral intermediate representation (`lowerFind` of wsemi, a shared layer with no imports) and the statement is built by [knex](https://knexjs.org), which is used **only to build SQL text** (no connection pool; connections, transactions, error objects and the extended query protocol stay with `pg`). The built statement is then verified token by token against the condition before it is sent, which ties the package to the text format knex produces: **`knex` is pinned to an exact version (`3.3.0`, no `^`)** so that an install never picks up a newer minor whose output format differs (every `select`/`delAll` would be rejected by the statement check). Before raising the pinned version run `unit-sqlbuild` and `node test/tools/pollutionSweep.mjs --all --protos --symbols`, and regenerate the contract assets (`test/tools/ir-snapshots.json`) if they change. Requires PostgreSQL 12 or later (tested on 17) and a UTF8 server encoding. `find` follows the **w-orm series condition whitelist**: its shape is checked by `cvOrmFind` of [wsemi](https://github.com/yuda-lyu/wsemi) (one shared implementation for the whole series) and only the checked fresh copy is used afterwards, then the PostgreSQL-specific limits and translations are applied. The check is the same for both functions, so a `find` that selects rows is the `find` that deletes them. **Anything outside the whitelist is rejected** with an `Error` (`invalid find: <reason> at [<path>]`) before a connection is made or any statement is sent, one `error` event is emitted, and no row is touched. Nothing is silently ignored.

| Level | Supported |
|---|---|
| top level | omitted, `undefined` or `{}` = all rows; anything else must be a condition object |
| equality | `{ col: value }` (several columns are ANDed); `null` is `is null` |
| column operators | `$eq` `$ne` `$gt` `$gte` `$lt` `$lte` (scalar value; `$eq`/`$ne` also accept `null`), `$in` `$nin` (array of scalars; `$in: []` matches nothing, `$nin: []` is rejected) |
| document | `$and`, `$or` (non-empty arrays of non-empty conditions, at most 1000 items) |
| scalar | string (no NUL, no lone surrogate), finite number, boolean, valid `Date` |
| column name | identifier (`[letters_][letters digits _]*`, Unicode letters allowed), at most 63 bytes counted as UTF-8 (PostgreSQL limit), not `__proto__`, not a system column name (`ctid`, `tableoid`, `xmin`, `xmax`, `cmin`, `cmax`); `Infinity` and `oid` are ordinary names |
| limits | nesting depth 32, `$in`/`$nin` 10000 items, 100000 nodes, 65535 bound parameters |

```alias
await wo.select({ $and: [{ value: { $gt: 123 } }, { name: { $in: ['peter', 'kettle'] } }] })
await wo.select({ name: { $eq: 'peter' }, ok: { $ne: true } }, { time: 'desc' })
await wo.delAll({ name: 'peter' }) //delAll() or delAll({}) deletes all rows, use delAll with care
```

Rejected, among others: `$not`, `$nor`, `$regex`, `$options`, `$exists`, `$like`, `$ilike`, `$null`, `$notNull`, `$equals`, `$custom`, `$where`, `$expr`, sub-queries, column-level `$and`/`$or`, JSON path keys (`js->>k`) and cast keys (`v::text`), `undefined` anywhere (drop the key instead), `null` inside `$in`/`$nin` or as the value of `$gt` `$gte` `$lt` `$lte`, `bigint`, `Buffer`, `NaN`, `Infinity`, an invalid `Date`, `RegExp`, `Map`, class instances, functions, symbol keys, getters, empty `$and`/`$or`/`$nin`/operator objects, `{}` inside `$and`/`$or`, nested non-operator keys, and column names with quotes, dots, spaces or hyphens.

- Comparison follows SQL three-valued logic: `$ne` and `$nin` (boolean `$ne` included) do not match rows whose column is `NULL`; the MongoDB-style backends of the series do. Spellings that give the same rows on every backend: exclude NULL `{ $and: [{ f: { $ne: null } }, { f: { $ne: x } }] }`, include NULL `{ $or: [{ f: null }, { f: { $ne: x } }] }`. `{ $in: [] }` matches nothing. There is no `$regex` and no `LIKE`: filter the rows in memory after `select` when needed.
- Every string value is a bound-parameter literal. A string that starts and ends with `$` (for example `'$name$'`) has **no special meaning** any more: it is an ordinary literal for equality, `$eq`, `$ne`, `$gt` `$gte` `$lt` `$lte`, `$in` and `$nin`, and as a primary-key value (the column-reference meaning belonged to the former SQL builder). The table name has no influence on `$nin`.
- The existence of a column is checked by PostgreSQL, not by the validator. Column names are written unqualified and the table gets a fixed alias (`"$t"`; `$` cannot be part of a valid column name), so a misspelled column is reported by PostgreSQL as a missing column (`42703`, nothing is deleted by `delAll`) in every condition that references the column (the one exception is `{ column: { $in: [] } }`, an always-false condition written as `false` that does not reference the column at all, so it matches nothing without an error) even when it happens to be a function name (`concat`, `to_json`, ...) or equals the table name. (The previous version wrote `"table"."column"`, which PostgreSQL resolves as the function call `name("table")` when the column is missing, so `{ concat: { $ne: 'x' } }` matched every row.) The six system column names (`ctid`, `tableoid`, `xmin`, `xmax`, `cmin`, `cmax`) exist on every table (partitioned and inherited ones included; views have none) and PostgreSQL never allows a user column with such a name when creating a table, so they are rejected with `invalid find` / `invalid order` / `invalid data`. Known limits: a view output column named like a system column is rejected too (the check is on the name used in the condition, not on the relation kind); the 63-byte limit is counted as UTF-8, so the server encoding must be UTF8 (with another encoding a long multi-byte name can be cut by the server to the name of another column); PostgreSQL 12 or later (`oid` is a system column before 12).
- `order` is an object of `column: 'asc' | 'desc'` (optionally followed by `nulls first|last`); strings, arrays, `1`/`-1` and anything else are rejected. The keys follow the same grammar as `find` columns (identifiers only); the JSON path keys (`js->>k`, `js->k`, `js#>k`) and cast keys (`v::text`) that earlier versions accepted in `order` are rejected (`invalid order`).
- The top-level `find` must be omitted (`undefined`) or a plain object; both `undefined` and `{}` mean all rows. Any other top-level value (`null`, an array including `[]` and `[{...}]`, a string, a number, a boolean, a function, `Date`, `RegExp`, `Map`, `Set`, a class instance, `new Proxy({}, {})`, ...) is rejected as a whole and is never treated as `{}`, so `delAll(null)` and `delAll([])` delete nothing. (Breaking change: they used to delete all rows.)
- `delAll(find)` deletes every row when `find` is omitted, `undefined` or `{}`; give a condition to delete part of the table, and prefer `select(find)` first to check what a condition matches. A value that is not a condition object, or anything outside the whitelist, is rejected and nothing is deleted.
- A primary-key value is valid only if it is a non-empty string, a number (any number but `NaN`; `±Infinity` is accepted because a FLOAT8 key can hold it, unlike a value inside `find`, where only finite numbers are accepted), a boolean or a plain valid `Date`. A string that contains NUL or a lone surrogate (UTF-8 would turn it into U+FFFD and match another row), a wrapper object (`Object(5)`), an invalid `Date` and a `Date` that carries own properties or a subclass are invalid: `selectByPk` returns `null`, `del` reports `ok: 0` for that record, and `insert`/`insertBulk`/`save` reject the whole batch before writing (a string that contains a lone surrogate or NUL is the exception for `save`: only that record fails, see *Well-formed strings* below).
- The primary key of a record is read only from its own enumerable properties. A key that exists only on the prototype (a class getter, `Object.create({ time: 1 })`, a polluted `Object.prototype.time`) counts as a missing key: `del` reports `ok: 0` for that record, and `insert`/`insertBulk`/`save` reject the whole batch before writing. (Breaking change: they used to read the inherited value and act on the row it points to.)
- `opt.pk` must be a plain identifier (letters including non-ASCII ones, digits, underscore, not starting with a digit, at most 63 bytes); `WOrmPostgresql(opt)` throws `invalid opt.pk` otherwise (this includes names with `$`, which used to work, and the system column names `ctid`, `tableoid`, `xmin`, `xmax`, `cmin`, `cmax`).
- Every statement (select, delete, insert, update and `createTable`) is sent with the extended query protocol and a null-prototype query config, so a statement can never be stacked behind another one and a polluted `Object.prototype` cannot change how `pg` runs a query (the query config). The *connection* parameters are read by `pg` itself from a plain object (`options`, `host`, `ssl`, ... may be inherited from a polluted `Object.prototype`, for example `options: '-c search_path=other'`); that is outside what this package can guard, as before. Column, primary-key and table names that are put into SQL text are always double-quoted, so they are case-sensitive and must match the column exactly.
- `createTable(cl, pk, sample)` checks the table name, `pk` and every key of the sample object before sending anything: keys and `pk` must be plain identifiers (as for `find`; `$`, spaces, quotes, dots, over 63 bytes and the system column names are rejected), the sample must have at least one own key, and a table name must be a plain name (letters, digits, `_`, `$`, up to 63 bytes), a schema-qualified name (`schema.table`) or a fully double-quoted name; anything else (including DDL fragments such as `IF NOT EXISTS t`) is rejected with `invalid createTable: ...`. Column names are created case-sensitively (`{ userName: 'x' }` creates `"userName"`, which is what `insert`/`save`/`select` use; it used to be folded to `username`, so give the sample lowercase keys if your data uses lowercase keys, and write `{ userName: 'x' }` instead of `{ '"userName"': 'x' }`). A fully double-quoted table name (for example `'"Po_Q"'`) works as `opt.cl` for every function; the table name is a trusted setting (it is not validated except by `createTable`, and by the well-formed check of `opt.cl` at construction) and a name that contains a double quote is put into the SQL text as is.
- A data key that contains a lone surrogate (whatever its value, `undefined` included) is refused by the shared well-formed check (`invalid data: string contains lone surrogate at [data[k].<invalid key>]`, see below); `insert`/`insertBulk` reject a data key (with a value other than `undefined`) that contains NUL with `invalid data key: contains NUL at [data[k].<invalid key>]` before the connection is made; for `save` that record fails with `ok: 0` and the same message. In `save` (with `autoInsert: true`) a key whose value is `undefined` is ignored and the stored column is kept, the same as with `autoInsert: false`.
- Object values written by `insert`, `insertBulk` and `save` are stored as JSON (a value such as `{ type: 'Point', coordinates: [1, 2] }` is stored as is). `save(data, { autoInsert: false })` updates with bound parameters, and its data keys must be plain column names.

## Well-formed strings (w-orm series rule)
PostgreSQL stores text as UTF-8, and a lone surrogate (half of a UTF-16 surrogate pair, `s.isWellFormed() === false`) cannot be encoded: `pg` sends it as `U+FFFD`. Before this rule two different primary keys (`'a\ud800'` and `'a�'`) were the same key (`del` removed the other row, `save` overwrote it), a value was read back different from the written one, two data keys of one record could become one column, and a table name with a lone surrogate silently addressed another table (`cl: 't\ud800'` selected, and `delAll()` emptied, the table named `'t�'`). Now the check is made on a copy of the argument, before any connection is made or any statement is sent (`createTable` validates its table name, `pk` and sample keys the same way, before it connects), by the shared functions `chkOrmStr` and `chkOrmData` of [wsemi](https://github.com/yuda-lyu/wsemi) (the same rule in every `w-orm-*` package; `U+FFFD` itself and well-formed pairs such as emoji are accepted as before):

| Where | Rule | Result |
|---|---|---|
| primary key value (`id` argument and the pk column of the data) | a string must not contain a lone surrogate or NUL (empty strings and the other invalid kinds are unchanged) | `insert`/`insertBulk`: the whole batch is rejected, nothing is written, one `error` event; `save`/`del`: that record is `{ ok: 0, err }`, the other records are processed as usual (`save` used to reject the whole batch); `selectByPk`: `null` |
| strings and keys in the written data, including nested objects and array elements (also `Map`/`Set`, `Error` and `RegExp` text, function source, `Symbol` description and inherited enumerable properties, as walked by `chkOrmData`) | no lone surrogate (a NUL inside a value is not part of this check; PostgreSQL itself refuses it) | `insert`/`insertBulk`: whole batch rejected; `save`: that record `{ ok: 0, err }` |
| `opt.url`, `opt.db`, `opt.cl` | no lone surrogate and no NUL | `WOrmPostgresql(opt)` throws `Error('invalid opt.<name>: <reason>')` |

- The messages use fixed words and never repeat the value: `invalid id: string contains lone surrogate at [data[<k>].<pk>]` (`string contains NUL` for NUL), `invalid data: string contains lone surrogate at [data[<k>].<path>]` (a key that is not well-formed is shown as `<invalid key>`), `invalid opt.cl: string contains lone surrogate`; `<k>` is the index of the record in the call (`0` for a single object). The other invalid primary keys use the same shape with the reasons `primary key is missing`, `string is empty` and `unsupported primary key value` (the old messages `invalid data[k].time[<value>]` and `invalid time[<value>]` repeated the value).
- For a batch, the smallest index among the problems that reject the whole batch decides its message (a missing primary key, a data key that is not a plain column name with `autoInsert: false`, and for `insert`/`insertBulk` every problem); the per-record failures of `save`/`del` do not take part in that decision. Within one record the primary key is checked before the data, and key names before values.
- The package has no `autoGenPk` option (a primary key is never generated), so the check does not depend on any setting. Every call first takes a `cloneDeep` copy of its argument (own getters are read once there, and later changes to the caller's objects do not matter). The data of each record is then walked by `chkOrmData` on a **second, separate copy** of that record, because the walk calls getters (also inherited enumerable ones) whose side effects must not reach the copy that is written; `error`/`change` listeners of `save` receive an independent snapshot of the record as written, never the record that is still waiting to be written, and the primary-key values of `save`/`del` are snapshotted when they are checked (a `Date` is rebuilt), so a listener cannot change what a later record writes or deletes. This costs one more `cloneDeep` of the data (about 9 µs per 20-column record on the development machine).
- `save` and `del` need no connection when every record of the call has already failed the check: the per-record results and the `error` events are returned even if the database is unreachable. A batch with at least one record to process still rejects as a whole when the connection fails.
- Over-strict by design: the walk of `chkOrmData` (one rule for the whole series) also visits inherited enumerable properties of a record, which this package never writes (it writes only own enumerable keys), so such a property that holds a lone surrogate rejects the record although nothing of it would be stored.
- The column-name grammar error of `find`, `order` and `save(…, { autoInsert: false })` (`unsupported column name [<name>]`) still shows the offending name, cleaned and shortened as before; a name that contains a lone surrogate is not shown at all for `save` (it is reported as `<invalid key>` above). A failed record of `save` has `n: 1` (the shape of every failed record of `save`), a failed record of `del` has `n: 0`.
- Not covered: the text produced by `toJSON` or a custom serializer is not checked; a `String` wrapper object is not unwrapped (as a non-empty name option it is refused as `not a string`; an empty wrapper counts as "not given" and the default is used).
- **Existing data is not migrated.** Rows written before this rule with a lone surrogate were already stored with `U+FFFD` instead (the original text cannot be recovered), so there is nothing ill-formed in the table; the rows to look at are those that now contain `U+FFFD`; for top-level text columns: `(await wo.select()).filter(r => Object.values(r).some(v => typeof v === 'string' && v.includes('\ufffd')))` (text inside a JSONB column needs a recursive walk of the parsed value). A row whose primary key contains `U+FFFD` can be addressed with that (well-formed) key: `await wo.del({ id: '\ufffd' })`; when you cannot tell which row it was, clear it by another column (`delAll({ name: 'x' })`) or the whole table (`delAll()`). To find tables that earlier versions addressed by mistake, look for table names containing `U+FFFD` (`select relname from pg_class where relname like '%' || chr(65533) || '%'`).

**Breaking changes of the well-formed strings rule** (each item also says what the previous version did):
1. A lone surrogate in a written string value or key (also nested, also in array elements): the whole `insert`/`insertBulk` is rejected, `save` fails that record. Before: stored as `U+FFFD` (TEXT) or a database error (JSONB).
2. `opt.url`, `opt.db`, `opt.cl` with a lone surrogate or NUL: the constructor throws. Before: constructed, and `cl` could address another table.
3. `save` with a primary key string that contains a lone surrogate (or NUL): that record is `{ ok: 0, err }`, the rest are saved. Before: the whole batch was rejected.
4. The messages of invalid primary keys are fixed words and do not repeat the value: `invalid id: <reason> at [data[k].<pk>]`. Before: `invalid data[k].<pk>[<value>]` (insert, insertBulk, save) and `invalid <pk>[<value>]` (del).
5. A data key that contains NUL, a failing `createTable` argument and a batch of `save`/`del` in which every record already failed are now decided before any connection is made (`save`/`del` return their per-record results even when the database cannot be reached).
6. `save` listeners (`error`, `change` with mode `insert`) receive an independent snapshot of the record. Requires wsemi 1.9.24 or later (`chkOrmStr`, `chkOrmData`).

## Breaking changes (series condition whitelist)
This version applies the w-orm series condition whitelist to `select(find)` and `delAll(find)`. The "Before" column is what the previous version (1.0.31) really did, checked by running it against PostgreSQL 17 (not taken from its documentation); "Now" is this version. Except for boolean `$ne` (still accepted, but its result set changed, see the row), every input in the table is rejected by the check described above, with `invalid find: <reason> at [<path>]`, before a connection is made or anything is sent to PostgreSQL.

| `find` | Before | Now | Instead |
|---|---|---|---|
| `{ name: { $like: 'a%' } }`, `$ilike` | matched with `LIKE`/`ILIKE` | rejected (`unsupported operator`) | `select()` then filter in memory |
| `{ tag: { $null: true } }`, `$null: false`, `$notNull: true`, `$notNull: false` | `is null` / `is not null` | rejected | `{ tag: null }`, `{ tag: { $ne: null } }` |
| `{ name: { $equals: 'aa' } }` | `=` | rejected | `{ name: { $eq: 'aa' } }` or `{ name: 'aa' }` |
| `{ name: { $not: 'aa' } }`, `{ value: { $not: { $gt: 5 } } }` | negation (rows with `NULL` not matched) | rejected | `$ne`, `$nin` or the opposite comparison (`$lte`) |
| `null` elements in `$in`/`$nin`: `{ tag: { $in: ['x', null] } }`, `$in: [null]`, `$nin: [null]` | `in (...) or is null`, `is null`, `is not null` | rejected (`null is not allowed here`) | `{ $or: [{ tag: 'x' }, { tag: null }] }`, `{ tag: null }`, `{ tag: { $ne: null } }` |
| `{ time: 3n }`, `{ time: { $in: [3n] } }` (bigint) | matched | rejected (`unsupported value type`) | `{ time: 3 }`, or a numeric string such as `{ time: '9007199254740993' }` (PostgreSQL converts it by the column type) |
| `{ bin: Buffer.from('ab') }` (bytea column) | matched | rejected | filter on another column, or in memory |
| JSON path keys `{ 'js->>k': '1' }`, `js->k`, `js->a->>b`, `js->>0` | matched jsonb content (`js->>0` indexed a jsonb array, and matched nothing for a jsonb object; `js#>>k` and `js#>k` always failed in PostgreSQL with `malformed array literal`) | rejected (`unsupported column name`) | `select()` then filter in memory, or a view / generated column |
| cast keys `{ 'value::text': '5' }`, `{ 'ts::date': { $gte: '2020-02-01' } }` | matched | rejected | compare with a value of the column type (PostgreSQL converts bound strings), or filter in memory |
| `{ $and: [{ name: 'aa' }, {}] }` | the `{}` element was ignored | rejected (`empty condition`) | remove the `{}` |
| `{ ok: { $ne: true } }`, `{ ok: { $ne: false } }` (boolean `$ne`) | `IS NOT TRUE` / `IS NOT FALSE`: **also matched rows with `NULL`** | SQL three-valued like every other type: rows with `NULL` are **not** matched | to keep the `NULL` rows: `{ $or: [{ ok: null }, { ok: false }] }` |
| `$and`/`$or` with more than 1000 items, `$in`/`$nin` with more than 10000 items (up to 65535 were accepted) | accepted | rejected (`array is too large`) | split the query |
| a `Map`/`Set` whose prototype was set to `null`/`Object.prototype`: at the top level, or as an `$or`/`$and` element or operator object when it carries own condition keys (e.g. `Object.assign(Object.setPrototypeOf(new Map(), null), { name: 'aa' })`); a top-level `new Proxy({}, {})` | treated as a condition, or (at the top level without own keys, and the empty Proxy) as "all rows": `delAll` deleted every row. An empty such object inside `$or`/`$and` was already rejected | rejected | pass `{}` or a plain object |

Added: `$eq`, and strings that start and end with `$` are now accepted as literals for equality, `$eq` and `$ne` (as elements of `$in`/`$nin` they already were). The text of the reasons in the error messages now comes from `cvOrmFind`; the prefix `invalid find: ` and the suffix ` at [<path>]` are unchanged, and `select` still rejects with an `Error` while `delAll` still rejects with the database message string for database errors.

## Breaking changes (knex SQL builder, column-name resolution)
[mongo-sql](https://github.com/goodybag/mongo-sql) (last release 2023) is replaced by [knex](https://knexjs.org) as the SQL builder (knex is a dependency; mongo-sql is not). Connections, transactions, `queryMode: 'extended'` and the error objects/messages of PostgreSQL are unchanged. The table lists every behaviour change found by running the same input table (13491 cells: column types x operators x values, function names, system columns, primary keys, table names, order keys, write paths, time zones) against the previous version (1.0.33) and this one on PostgreSQL 17; there was no other difference in the result sets (`select` hits and `delAll` deletions) of inputs accepted by both versions.

| Input | Before (1.0.33) | Now |
|---|---|---|
| a misspelled column that is a function name: `{ concat: { $ne: 'x' } }`, `to_json`, `to_jsonb`, `row_to_json`, `pg_typeof`, `quote_literal`, `num_nulls` ... | the function was applied to the whole row and the condition could match **every row** (`delAll` deleted all rows) | PostgreSQL reports the missing column (`42703`; `select` rejects with the `pg` error, `delAll` with its message string), nothing is deleted |
| the system column names `ctid`, `tableoid`, `xmin`, `xmax`, `cmin`, `cmax` in `find`, `order`, `opt.pk`, `save(data, { autoInsert: false })` keys and `createTable` | resolved by PostgreSQL (the condition could match every row, or a type error) | rejected: `invalid find` / `invalid order` / `invalid data[k]` / `invalid createTable` / `invalid opt.pk`; a view output column with such a name is rejected too |
| `$..$` strings (start and end with `$`) with `$gt` `$gte` `$lt` `$lte` | rejected | an ordinary literal |
| `$..$` strings as **primary-key values** (`selectByPk`, `del`, `save`, `insert`, `insertBulk`) | invalid primary key (`null` / `ok: 0` / the batch was rejected) | an ordinary literal: it acts on the row whose key is that text. On a non-text key column it is a type error like any other mismatched string (`selectByPk` returns `null`, `del` reports `ok: 0`, `insert`/`insertBulk`/`save` reject with the PostgreSQL error; note that `save` writes record by record, so records before the failing one are already stored, as with any other mismatched key) |
| `$nin` / `$ne '$x$'` when the table name contains `$`, `+`, `(` ... | rejected | works |
| column name `Infinity` (in `find`, `order`, `opt.pk`, `createTable`; the data keys of `insert`/`save` were never rejected) | rejected | a valid name (PostgreSQL decides whether the column exists) |
| `order` keys with JSON paths (`js->k`, `js->>k`, `js#>k`, `js#>>k`) or casts (`v::text`) | `->`, `->>` and `::` worked, `#>` and `#>>` failed in PostgreSQL | rejected (`invalid order`): `order` keys are identifiers, the same as `find` columns |
| `opt.cl` fully double-quoted (`'"Po_Q"'`) | `select`, `selectByPk`, `save`, `del`, `delAll` failed with a syntax error | works |
| text of the PostgreSQL error for an unknown column | `column t.c does not exist` | `column "c" does not exist` (same `42703`) |

Other changes:
- **Fail-closed statement check.** Before a statement is sent, its token sequence and bound values are compared with the ones derived from the condition. If the built text is not exactly what the condition describes, `select`/`delAll` reject with `invalid find: internal statement check failed (statement check): ... at [find]` (`invalid order` when the difference is in the order clause) before a connection is made. This also covers knex reading inherited properties: when `Object.prototype` has been polluted with a name that knex reads (for example `limit`, `offset`, `join`, `having`, `order`, `where`, `distinct`, `union`, `returning`), the call is rejected instead of running a changed statement; the package never modifies global prototypes. The guarantee covers data-type pollution (properties that JSON can create, such as `{"__proto__": {"limit": 5}}` merged unsafely). Accessors, functions or `Symbol` keys installed by running code need code execution and are outside it, although the table name and the bound values are additionally kept independent of them (the table name is split without `String.prototype.split`; a `Date` value is handed to knex as a private copy, so a rewrite of that copy while knex reads it is detected as a value mismatch and rejected, and the verified values are copied again before they are sent). The check compares the statement with the condition as lowered; it is not a proof of the lowering itself, which is covered by the test suite.
- The primary-key functions (`selectByPk`, `del`) build their `where` the same way (unqualified column, fixed table alias); the hand-written `UPDATE` of `save(..., { autoInsert: false })` has no alias but its `where` uses the unqualified, quoted primary-key column as well.
- Known limits: PostgreSQL 12 or later, UTF8 server encoding, views whose output columns are named like system columns are rejected; booleans are written as literals (`"b" IS TRUE`) for equality, `$ne` and the comparison operators but bound as parameters inside `$in`/`$nin` (so `{ s: { $in: [true] } }` on a text column can match `'true'` while `{ s: true }` is a type error), as before.

## Diagnostic output (`logDetail`, `funLog`) and error values
The diagnostic output and the masking of credentials are implemented once, in `wsemi` (`getDiag`, `getDiagSecrets`, `maskDiagText`, `maskDiagCopy`, `maskDiagErr`, `getDiagBriefErr`; see their JSDoc for the exact rules). This package only declares what is secret (the connection string, the user name and the password), which error codes and class names are allowed in the summary, and where it calls them. The package writes to the console in one situation only: a listener of the `change` or `error` event threw (the exception is swallowed, it never changes the result of the operation). All of its output goes through `getDiag` (nothing else in `src` writes to the console, `process.stdout`/`process.stderr` or `process.emitWarning`). **By default only a fixed label and a summary without personal data are printed** (no data values, ids, user identities, text of the exception, backend error text or connection credentials). The options have the same names and meaning as in `w-serv-orm`, `w-orm-reladb` and `w-serv-webdata`:

| Option | Type | Effect |
|---|---|---|
| `opt.logDetail` | Boolean, default `false` | `true` prints `console.log(label, detail)` (standard output): `detail` is the value thrown by the listener as a **masked copy**. Connection credentials are masked. |
| `opt.funLog` | Function, default none | `funLog(label, safe, detail)` receives the output **instead of** the console (`logDetail` has no effect then). `label`: fixed label; `safe`: the summary printed by default; `detail`: the full detail (the value thrown by the listener, as the same masked copy). Connection credentials are masked. Exceptions thrown by `funLog`, and a rejected native promise returned by it, are swallowed (a thenable that is not a native promise is not called). |

A value of another type is ignored and the default is used (no exception), like the other options (`useCache`, ...). The options are read once, when `WOrmPostgresql(opt)` is called.

What is printed by default:

| When | Printed | `safe` |
|---|---|---|
| a `change` listener threw | `change handler threw { mode: 'insert', errType: 'Error' }` | `mode`: the operation (`insert`, `insertBulk`, `save`, `del`, `delAll`). `errType`: `string`, `number`, `null`, `object`, ... for values that are not an `Error`; for an `Error` the name of its class only if it is a built-in error class (`Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`, `AggregateError`) or `DatabaseError`, otherwise `Error` (class names of your own may carry identifiers; an error that sets its own `name`, such as the `DatabaseError` of `pg` whose `name` is `'error'`, is also listed as `Error`). `errCode`: present only when the own property `code` is on a fixed list (Node system error names such as `ECONNREFUSED`, a few Node/TLS codes such as `ERR_INVALID_URL`, and PostgreSQL SQLSTATE codes such as `23505`); numbers and any other text are left out. |
| an `error` listener threw | `error handler threw { mode: 'select', errType: 'Error' }` | the same, `mode` is any operation that can fail (`createTable`, `select`, `selectByPk`, `insert`, `insertBulk`, `save`, `del`, `delAll`) |

The summary is built only from these fixed words, so it is printed as is (it is not searched for credentials: blanking a fixed word would let the gap reveal a short password).

Credentials: the connection string (`opt.url`, and the connection string `opt.url/opt.db` the package builds), the user name and the password are declared to `getDiagSecrets` and replaced by `***` in `logDetail` and in the `detail` given to `funLog`. They are taken from the URL as written, as parsed by the same rules `pg` uses, and from the `user` and `password` query parameters (`?user=…&password=…`), each in its written, percent-decoded, percent-encoded, quote-doubled (SQL literal), JSON-escaped and other forms that `getDiagSecrets` lists. The masking of the copy (property values and keys, `Symbol` values, wrapper objects such as `new String(...)`, `Map`/`Set`, `message`, `stack`, `cause`, values under key names such as `password`, `token`, `authorization`, numbers equal to a numeric password) follows `wsemi` `maskDiagCopy`. Limits: a user name shorter than 3 characters is not masked on its own in the detail (it would blank unrelated text; `user:password` and the URL are still masked); with the default `opt.url` (`postgresql://user:password@127.0.0.1:5432`) the words `user` and `password` are masked in the detail. If the password contains `@`, `/`, `?` or `#`, percent-encode it (`%40`, `%2F`, `%3F`, `%23`): written raw, `pg` takes parts of it for the host name or the database name and the backend message echoes those parts; they are masked as well (see the next section), but the URL is then not a valid one for `pg` itself.

The detail is a copy: the objects of the caller are never changed, getters and methods of the caller's objects are not called, and the copy does not keep the prototype of the caller's classes. How each kind of value is shown (errors, `Map`/`Set`, binary data, functions, getters, circular references, depth and size limits) is defined by `wsemi` `maskDiagCopy`. The `stack` of an error is read only when that cannot run code of yours.

### Error values that leave the package
A reject value, the message argument of the `error` event and the `err` of a failed row of `save` and `del` come from the backend or the driver (or, for the arguments of `insert` and the like, from getters of your own objects). Such a value that contains a connection credential (the whole URL, the password, `user:password`, the part of a malformed URL that the driver echoes, and so on) is replaced by a masked copy: an object of the same class, with `code`, `severity` and the other non-secret fields kept and the credential in `message` (and in other string fields) replaced by `***`. A value without a credential is the original object (identity unchanged). The user name alone and your data values are not masked there (only credentials are). A password of fewer than 4 characters is not masked in these values.

Messages that this package composes itself from fixed words (`invalid find: ...`, `invalid id: ...`, `invalid createTable: ...`, `can not select by ...`) are never masked: blanking a fixed word would let the gap reveal a short password.

**Breaking changes (diagnostic output and error values)**:
1. When a `change` or `error` listener throws, the console used to get `console.log(error)`: the whole exception with its message and stack, which may contain data values, ids and credentials. **Now** the console gets the label and summary above. To get the details add `logDetail: true`, or take the full detail from `funLog`:
```javascript
// before: WOrmPostgresql({ url, db, cl })      -> the thrown error is printed
// now (masked copy, with the label):
let wo = WOrmPostgresql({ url, db, cl, logDetail: true })
// or route it yourself:
let wo2 = WOrmPostgresql({ url, db, cl, funLog: (label, safe, detail) => myLogger.warn(label, safe) })
```
2. **Reject values, the `error` event and the per-row `err` no longer contain credentials.** For example a malformed URL such as `postgresql://alice_u:p@w0rdfrag/tail@127.0.0.1:1` used to reject with `getaddrinfo ENOTFOUND w0rdfrag` (the password fragment `w0rdfrag` was echoed by the driver) and now rejects with `getaddrinfo ENOTFOUND ***`; a backend message that echoes a value equal to the password (`invalid input syntax for type integer: "<the password>"`) now shows `***`. The class, `code` and the other fields are kept; a message without a credential is unchanged.
3. `logDetail: true` prints `console.log(label, detail)`; it used to print the detail alone (without the label).
4. The masked copy follows `wsemi` `maskDiagCopy`: `Map` and `Set` are copied (with masked content) instead of `'[Object]'`, `RegExp` and `Promise` are shown as `'[RegExp]'` and `'[Promise]'`; values under key names such as `password`, `token`, `authorization` are `***` as a whole; circular references are `'[Circular]'`; the limits are depth 8 and 5000 nodes (were 6 and 2000); a copy no longer throws an internal exception per node (which made the old copy of a large object much slower). A `funLog` that returns a thenable that is not a native promise is no longer called through `then`.
5. Requires `wsemi` 1.9.31 or later.
6. **The return contract is otherwise unchanged**: what every operation resolves or rejects with, the payload of the `change` and `error` events and their timing are the same as before (checked against values recorded from the previous version, with and without the options and with throwing listeners), except for the credentials in the values of item 2.
7. Not covered (the caller decides): echoes of the caller's own input inside this package's messages (`createTable` with a sample that is not an object says `obj[<the value>] is not an effective object`; `can not select by find[...]|pk[...]`; a column name that is not allowed is quoted in `invalid find`/`invalid order`; the message of an exception thrown by a getter or `Proxy` trap of your own `find`), the `data` argument of the `error` event (your input), a user name that is on its own in a message, and a password of fewer than 4 characters. `pg` already replaces the input of its own `Invalid URL` error by `*****REDACTED*****`; that error comes from the connection step of the operation, so it rejects without an `error` event, as before. Output of the libraries themselves is not routed through the package: `pg-connection-string` raises one `process.emitWarning` (fixed text) when the URL asks for `sslmode=prefer|require|verify-ca`, knex has fixed-text warnings that the whitelisted inputs cannot reach, and the `DEBUG` environment variable (`DEBUG=knex:*`) makes knex print SQL with its bound values to stderr; do not set it in production.

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

let rsr = [
    { //已存在, 為前次insertBulk所插入
        time: '2025-01-01T00:20:00Z',
        name: 'bulk-1',
        value: 201,
    },
    { //不存在須新增
        time: '2025-01-01T00:22:00Z',
        name: 'ret-new',
        value: 203,
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

    //insert by returnList, 改回傳與輸入等長且保序之逐筆結果, 令呼叫端得知是哪幾筆為新數據
    await wo.insert(rsr, { returnList: true })
        .then(function(msg) {
            console.log('insert by returnList then', msg)
        })
        .catch(function(msg) {
            console.log('insert by returnList catch', `${msg}`)
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

    //select by $eq, $ne (series whitelist: $eq $ne $gt $gte $lt $lte $in $nin, $and, $or)
    let spd = await wo.select({ name: { '$eq': 'rosemary' }, value: { '$ne': 123 } })
    console.log('select by $eq, $ne', spd)

    // //select by regex is outside the series whitelist and is rejected as invalid find ($regex, $like, $not, JSON path keys, ...): filter the rows in memory after select
    // let sr = await wo.select({ name: { $regex: 'PeT', $options: 'i' } })
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
// change insert
// insert by returnList then [ { n: 1, nInserted: 0, ok: 1 }, { n: 1, nInserted: 1, ok: 1 } ]
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
//   { time: 2025-01-01T00:22:00.000Z, name: 'ret-new', value: 203 },
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
//   { time: 2025-01-01T00:22:00.000Z, name: 'ret-new', value: 203 },
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
// select by $eq, $ne [
//   { time: 2025-01-01T00:01:00.000Z, name: 'rosemary', value: 123.456 },
//   { time: 2025-01-01T00:04:00.000Z, name: 'rosemary', value: 123.1236 },
//   { time: 2025-01-01T00:07:00.000Z, name: 'rosemary', value: 124.76 }
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
//   { time: 2025-01-01T00:22:00.000Z, name: 'ret-new', value: 203 },
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
