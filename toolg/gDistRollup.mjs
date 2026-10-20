import rollupFiles from 'w-package-tools/src/rollupFiles.mjs'
import getFiles from 'w-package-tools/src/getFiles.mjs'


let fdSrc = './src'
let fdTar = './dist'


rollupFiles({
    fns: 'WOrmPostgresql.mjs',
    fdSrc,
    fdTar,
    nameDistType: 'kebabCase',
    globals: {
        'events': 'events',
        'pg': 'pg',
        'knex': 'knex',
    },
    external: [
        'events',
        'pg',
        'knex',
    ],
})

