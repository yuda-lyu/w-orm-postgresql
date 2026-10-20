import assert from 'assert'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { startPg, stopPg, volumesOfPg, hasVolume, cnameOf, PORTS } from './tools/pgContainer.mjs'


//測試容器收尾須連同匿名 volume 一併移除(帳本 R15, 第 88 項):
//postgres 映像宣告 VOLUME, docker run 未指定掛載時會建立匿名 volume; 啟動前清殘留與結束時的 docker rm -f 若不帶 -v, 匿名 volume 即遺留為懸置 volume
//(各測試日積月累吃滿磁碟, C: 槽曾因此剩 0 位元組). 本檔以容器實際掛載的 volume 名稱逐一驗證: 收尾後 docker volume inspect 必須失敗.
//另驗證: 埠表固定、表外名稱 throw、埠綁定 127.0.0.1.

let execFileAsync = promisify(execFile)
let ctName = 'worm-test-pg-volume'
let docker = (args) => execFileAsync('docker', args)
let waitGone = async (vname) => {
    for (let i = 0; i < 20; i++) {
        if (!(await hasVolume(vname))) {
            return true
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return false
}


after(async function() {
    this.timeout(120000)
    await stopPg(ctName) //萬一測試中途失敗, 仍收尾
})


describe('container cleanup: anonymous volumes are removed with the container (item 88)', function() {
    it('should remove every anonymous volume of the container when stopPg is called', async function() {
        this.timeout(300000)
        await startPg(ctName)
        let vols = await volumesOfPg(ctName)
        assert.ok(vols.length >= 1, 'the postgres image creates at least one anonymous volume')
        for (let v of vols) {
            assert.strictEqual(await hasVolume(v), true, `volume ${v} must exist while the container runs`)
        }
        await stopPg(ctName)
        for (let v of vols) {
            assert.strictEqual(await waitGone(v), true, `volume ${v} must be removed together with the container`)
        }
    })

    it('should also remove the volumes of a residual container of the same name when startPg cleans up before starting', async function() {
        this.timeout(300000)
        await startPg(ctName)
        let old = await volumesOfPg(ctName)
        assert.ok(old.length >= 1)
        //不先 stopPg, 直接再 startPg: 模擬上一輪測試中途失敗遺留同名容器
        await startPg(ctName)
        let fresh = await volumesOfPg(ctName)
        for (let v of old) {
            assert.ok(!fresh.includes(v), 'the new container must not reuse the old volume')
            assert.strictEqual(await waitGone(v), true, `residual volume ${v} must be removed by the pre-start cleanup`)
        }
        await stopPg(ctName)
        for (let v of fresh) {
            assert.strictEqual(await waitGone(v), true)
        }
    })
})


describe('container ports: fixed table, loopback only, no random ports', function() {
    it('should map the container name to its fixed port 8451-8459 and bind to 127.0.0.1 only', async function() {
        this.timeout(300000)
        let info = await startPg(ctName)
        try {
            //WORM_TEST_PORT_BASE 未設時為 8451(同機多工作區並行時各設不同值, 整段平移)
            let base = process.env.WORM_TEST_PORT_BASE === undefined || process.env.WORM_TEST_PORT_BASE === '' ? 8451 : Number(process.env.WORM_TEST_PORT_BASE)
            let expect = base + PORTS[ctName]
            assert.strictEqual(info.port, expect)
            assert.ok(info.port >= base && info.port <= base + 8)
            assert.ok(info.url.includes(`@127.0.0.1:${expect}`))
            let r = await docker(['port', cnameOf(ctName), '5432/tcp'])
            assert.strictEqual(r.stdout.trim(), `127.0.0.1:${expect}`)
        }
        finally {
            await stopPg(ctName)
        }
    })

    it('should give every registered container name a distinct port inside 8451-8459', function() {
        let seq = Object.values(PORTS)
        assert.strictEqual(new Set(seq).size, seq.length)
        seq.forEach((i) => assert.ok(Number.isInteger(i) && i >= 0 && i <= 8))
        assert.ok(Object.keys(PORTS).includes('worm-test-postgresql'))
    })

    it('should throw for a container name that is not registered (never fall back to a random port) and before touching docker', async function() {
        await assert.rejects(() => startPg('not-registered-name'), /not registered in PORTS/)
        await assert.rejects(() => stopPg('not-registered-name'), /not registered in PORTS/)
        await assert.rejects(() => startPg('__proto__'), /not registered in PORTS/)
        await assert.rejects(() => startPg('constructor'), /not registered in PORTS/)
    })

    it('should shift the whole port range deterministically with WORM_TEST_PORT_BASE and reject out-of-range bases', async function() {
        let old = process.env.WORM_TEST_PORT_BASE
        try {
            for (let bad of ['abc', '7999', '1.5', '49000', '-1']) {
                process.env.WORM_TEST_PORT_BASE = bad
                await assert.rejects(() => startPg(ctName), /WORM_TEST_PORT_BASE must be an integer/, bad)
            }
        }
        finally {
            if (old === undefined) {
                delete process.env.WORM_TEST_PORT_BASE
            }
            else {
                process.env.WORM_TEST_PORT_BASE = old
            }
        }
    })

    it('should list every container name used by the api- test files in PORTS (a new api- test file must register its name)', async function() {
        let fs = await import('fs')
        let dir = new URL('./', import.meta.url)
        let files = fs.readdirSync(dir).filter((f) => /^api-.*\.test\.mjs$/.test(f))
        let used = []
        for (let f of files) {
            let src = fs.readFileSync(new URL(f, dir), 'utf8')
            for (let m of src.matchAll(/^let ctName = '([^']+)'/gm)) {
                used.push(m[1])
            }
        }
        assert.ok(used.length >= 5, `container names found: ${used.join(',')}`)
        used.forEach((n) => assert.ok(Object.prototype.hasOwnProperty.call(PORTS, n), `${n} is not registered in PORTS`))
        assert.strictEqual(new Set(used).size, used.length, 'each api- test file must use its own container name')
    })
})
