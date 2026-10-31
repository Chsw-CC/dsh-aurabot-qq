import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let api
const root = mkdtempSync(join(tmpdir(), 'aurabot-backup-'))
const put = (rel, text) => {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const read = (rel) => readFileSync(join(root, rel), 'utf8')

before(async () => {
  process.env.AURABOT_DATA_DIR = root
  api = await import('../src/core/backup.js')
})

test('备份、暂存、启动时换上：内容一致，旧文件留底，排除项不进备份', async () => {
  put('config.json', JSON.stringify({ ownerQQ: '1', song: { root: join(root, 'songs') } }))
  put('memories.json', '记忆🤔')
  put('personas/鱼.md', '人设')
  put('stickers/a.png', Buffer.alloc(5000, 7))
  put('modules/pet/module.json', '{}')
  put('logs/a.log', 'x')
  put('sessions.json', '{}')
  put('douyin/edge-profile/Cookies', 'x')
  put('douyin/im/db', 'keep')
  put('modules-data/pet/app/node_modules/electron/a', 'x')

  const b = await api.createBackup({ version: '1.2.0-beta.1' })
  assert.equal(b.files, 6)
  assert.deepEqual(b.skipped, [])
  assert.deepEqual(api.listBackups().map((x) => x.name), [b.name])

  // 模拟换了电脑：数据目录里是别的东西
  put('memories.json', '新电脑的')
  put('config.json', '{"ownerQQ":"2"}')
  put('only-here.json', '留着')

  const r = await api.stageRestore(b.file)
  assert.equal(r.ok, true)
  assert.equal(read('memories.json'), '新电脑的', '运行中不替换')
  assert.equal(api.pendingRestore().files, 6)

  // 备份来自别的路径：配置里的旧路径要换成这台电脑的
  const pending = join(root, '.restore-pending.json')
  const oldRoot = 'C:\\old\\aurabot'
  const stageConfig = join(root, '.restore', 'config.json')
  writeFileSync(stageConfig, JSON.stringify({ ownerQQ: '1', dir: oldRoot + '\\songs' }))
  writeFileSync(pending, JSON.stringify({ ...JSON.parse(readFileSync(pending, 'utf8')), dataDir: oldRoot }))

  assert.equal(api.applyPendingRestore(123), 6)
  assert.equal(read('memories.json'), '记忆🤔')
  assert.equal(read('personas/鱼.md'), '人设')
  assert.equal(readFileSync(join(root, 'stickers/a.png')).length, 5000)
  assert.equal(JSON.parse(read('config.json')).dir, join(root, 'songs'))
  assert.equal(read('only-here.json'), '留着')
  assert.equal(read('backups/pre-restore-123/memories.json'), '新电脑的', '旧文件留底')
  assert.equal(api.pendingRestore(), null)
  assert.equal(existsSync(join(root, '.restore')), false)
  assert.equal(api.applyPendingRestore(), 0, '没有待恢复时什么都不做')
})

test('坏文件和别的 zip 都拒绝，且不留待恢复', async () => {
  const bad = join(root, 'bad.zip')
  writeFileSync(bad, 'not a zip at all, sorry about that friend')
  await assert.rejects(api.stageRestore(bad), /不是有效的备份/)
  assert.equal(api.pendingRestore(), null)
})

test('内容被改动过的备份过不了校验', async () => {
  const b = await api.createBackup({ version: 'x', now: new Date(Date.now() + 60000) })
  const buf = readFileSync(b.file)
  const at = buf.indexOf(Buffer.from('data/config.json')) + 16
  buf[at + 2] ^= 0xff
  const broken = join(root, 'broken.zip')
  writeFileSync(broken, buf)
  await assert.rejects(api.stageRestore(broken))
  assert.equal(api.pendingRestore(), null)
})

test('取消恢复清掉暂存', async () => {
  const b = api.listBackups()[0]
  await api.stageRestore(join(root, 'backups', b.name))
  assert.ok(api.pendingRestore())
  api.cancelRestore()
  assert.equal(api.pendingRestore(), null)
  assert.ok(readdirSync(root).every((n) => n !== '.restore'))
})
