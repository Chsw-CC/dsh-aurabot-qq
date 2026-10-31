import assert from 'node:assert/strict'
import { test, after, mock } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'aurabot-diary-media-'))
process.env.AURABOT_DATA_DIR = root
after(() => rmSync(root, { recursive: true, force: true }))

const { normalize } = await import('../src/core/config.js')
const { createQzone } = await import('../src/features/qzone.js')
const { collectSources, localPictures } = await import('../src/modules/diary/sources.js')
const { createDiaryAssets, downloadImage } = await import('../src/modules/diary/assets.js')
const { createDiaryMedia, parseDraft } = await import('../src/modules/diary/media.js')
const { readJson, writeJson, dataDir } = await import('../src/core/store.js')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64')
const log = { info() {}, warn() {} }

function fixture({ rich = {}, config = {}, reply, modules = {} } = {}) {
  let cfg = normalize({ enabled: true, dryRun: false, diary: { visibility: 'self', rich: { enabled: true, ...rich } }, ...config })
  const calls = []
  const memories = []
  const prompts = []
  const hub = {
    chatLogOf: () => [{ t: Date.now(), chatId: 'private:10001', who: '主人', text: '私聊秘密不要公开' }],
    async runSystemTurn(...args) {
      prompts.push(args)
      return typeof reply === 'function' ? reply(args) : reply || JSON.stringify({ text: '今天安静地收好了一点开心。', imageIds: [] })
    },
  }
  const api = {
    config: () => cfg,
    dataDir: (...parts) => join(root, 'cache', ...parts),
    use: (id) => modules[id], core: { hub },
  }
  const media = createDiaryMedia(api)
  const qzone = createQzone({
    getConfig: () => cfg, log, hub,
    composeDiary: media.compose,
    onebot: { async call(action, params) { calls.push({ action, params }); return { tid: 't1' } } },
    onDiary: (text) => memories.push(text),
  })
  return { api, media, qzone, calls, memories, prompts, config: () => cfg, setConfig: (next) => { cfg = next } }
}

test('新配图默认关闭，目录为空；异常配置不会自动启用或推断路径', () => {
  const cfg = normalize({})
  assert.deepEqual(cfg.diary.rich, { enabled: false, stickers: true, browsing: false, local: false, folder: '', maxImages: 2 })
  assert.equal(normalize({ diary: { rich: null } }).diary.rich.enabled, false)
  assert.equal(normalize({ diary: { rich: { enabled: 'true', folder: '../private', maxImages: 99 } } }).diary.rich.enabled, false)
  assert.equal(normalize({ diary: { rich: { folder: '../private' } } }).diary.rich.folder, '')
  assert.equal(cfg.diary.attachImage, true, '原有配图默认值不变')
})

test('关闭图文功能时完全走原有写作与配图流程', async () => {
  writeJson(dataDir('diary.json'), { history: [], plan: { day: '', times: [], done: [] } })
  const cfg = normalize({ enabled: true, dryRun: false })
  let picked = 0
  const calls = []
  const qzone = createQzone({
    getConfig: () => cfg, log,
    hub: { chatLogOf: () => [], runSystemTurn: async () => '今天想好好吃一碗白米饭。' },
    composeDiary: () => { throw new Error('不应调用新流程') },
    pickImage: () => { picked++; return 'base64://' + PNG.toString('base64') },
    onebot: { call: async (action, params) => { calls.push({ action, params }); return 'old' } },
  })
  const result = await qzone.writeDiary()
  assert.equal(result.ok, true)
  assert.equal(picked, 1)
  assert.equal(calls[0].params.content, '今天想好好吃一碗白米饭。')
  assert.equal(calls[0].params.images.length, 1)
})

test('指定本地图库后才读取；没有指定目录、不启用来源时均为空', () => {
  const folder = join(root, 'allowed')
  mkdirSync(folder)
  writeFileSync(join(folder, '开心.png'), PNG)
  const api = { use: () => undefined }
  assert.deepEqual(localPictures(''), [])
  assert.equal(collectSources(api, { local: true }).pictures.length, 0)
  assert.equal(collectSources(api, { folder, local: false }).pictures.length, 0)
  assert.equal(collectSources(api, { folder, local: true }).pictures.length, 1)
  assert.throws(() => localPictures('../'), /完整路径/)
})

test('本地目录扫描不穿过链接或 junction', () => {
  const folder = join(root, 'links')
  const outside = join(root, 'private')
  mkdirSync(folder)
  mkdirSync(outside)
  writeFileSync(join(outside, '私人.png'), PNG)
  symlinkSync(outside, join(folder, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(localPictures(folder).length, 0)
  assert.throws(() => localPictures(join(folder, 'shortcut')), /链接/)
})

test('公开浏览只读取成功的公开作品，不取私信、搜索结果、失败或过期记录', () => {
  const item = { id: '123456789', title: '云朵插画', author: '画师', cover: 'https://example.com/image.png' }
  const now = Date.now()
  const history = [
    { kind: 'read', at: now, item, text: '私信中主人的秘密' },
    { kind: 'dm', at: now, item: { ...item, id: '987654321', title: '私信' } },
    { kind: 'search', at: now, item }, { kind: 'read', at: now, item, ok: false },
    { kind: 'read', at: now - 72 * 3600_000, item }, { kind: 'read', at: now, item, dryRun: true },
  ]
  const api = { use: (id) => id === 'huashi6' ? { state: () => ({ history }) } : undefined }
  const pool = collectSources(api, { browsing: true }, [], now)
  assert.equal(pool.events.length, 1)
  assert.equal(pool.pictures.length, 1)
  assert.equal(pool.pictures[0].url, 'https://www.huashi6.com/draw/123456789')
  assert.doesNotMatch(JSON.stringify(pool), /主人的秘密|私信中/)
})

test('模型只能从授权候选编号选图，不能注入路径或任意 URL', () => {
  for (const id of ['C:\\private.png', 'https://example.com/secret.png', '../../private']) {
    assert.throws(() => parseDraft(JSON.stringify({ text: '今天真好。', imageIds: [id] }), [], 140), /未授权/)
  }
  assert.throws(() => parseDraft('{"text":', [], 140), /不完整/)
  assert.throws(() => parseDraft(JSON.stringify({ text: '密码是123456789', imageIds: [] }), [], 140), /敏感/)
})

test('图片缓存只接受摘要编号和有效图片，不开放任意本地路径', async () => {
  const assets = createDiaryAssets(join(root, 'asset-test'), { download: async () => PNG })
  const image = await assets.materialize({ id: 'test', kind: 'browsing', src: 'https://example.com/image.png' })
  assert.deepEqual(assets.read(image.id), PNG)
  assert.throws(() => assets.read('../../config.json'), /不存在/)
  assert.throws(() => assets.store(Buffer.from('not an image')), /有效图片/)
})

test('外部配图重定向到内网时在第二次请求前拦截', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }))
  try {
    await assert.rejects(() => downloadImage('https://8.8.8.8/image.png'), /内网|本机/)
    assert.equal(fetch.mock.callCount(), 1)
    await assert.rejects(() => downloadImage('https://user:password@8.8.8.8/image.png'), /登录信息/)
    assert.equal(fetch.mock.callCount(), 1)
  } finally { fetch.mock.restore() }
})

test('下载同时限制声明长度和实际流长度', async () => {
  for (const response of [new Response(PNG, { headers: { 'content-length': String(9 * 1024 * 1024) } }), new Response(Buffer.alloc(8 * 1024 * 1024 + 1))]) {
    const fetch = mock.method(globalThis, 'fetch', async () => response)
    try { await assert.rejects(() => downloadImage('https://8.8.8.8/image.png'), /8MB/) }
    finally { fetch.mock.restore() }
  }
})

test('预览不调用 OneBot、不改历史和计划、不写记忆，且不向模型提供聊天或路径', async () => {
  const initial = { history: [{ text: '原有记录' }], plan: { day: '2026-10-31', times: [600], done: [] } }
  writeJson(dataDir('diary.json'), initial)
  const f = fixture()
  const result = await f.qzone.writeDiary({ preview: true })
  assert.equal(result.ok, true)
  assert.equal(result.preview, true)
  assert.equal(f.calls.length, 0)
  assert.equal(f.memories.length, 0)
  assert.deepEqual(readJson(dataDir('diary.json')), initial)
  assert.doesNotMatch(f.prompts[0][2], /私聊秘密|private:10001|C:\\Users/)
  assert.deepEqual(f.prompts[0][3], { noTools: true, key: 'media' })
})

test('图文日记按保存的可见范围发布，记录与记忆只在实际成功后更新', async () => {
  const f = fixture()
  const result = await f.qzone.writeDiary({ visibility: 'all' })
  assert.equal(result.ok, true)
  assert.equal(f.calls[0].params.ugc_right, 64)
  assert.equal(result.visibility, 'self')
  assert.equal(f.memories.length, 1)
  assert.equal(f.qzone.history()[0].tid, 't1')
})

test('部分好友名单为空时不生成草稿，也不退回公开', async () => {
  const f = fixture({ config: { diary: { visibility: 'selected', audienceQQs: '', rich: { enabled: true } } } })
  const result = await f.qzone.writeDiary()
  assert.equal(result.ok, false)
  assert.match(result.message, /名单为空/)
  assert.equal(f.prompts.length, 0)
  assert.equal(f.calls.length, 0)
})

test('试运行只生成结果，不能发布或写成功记忆', async () => {
  const f = fixture({ config: { dryRun: true } })
  const result = await f.qzone.writeDiary()
  assert.equal(result.dryRun, true)
  assert.equal(f.calls.length, 0)
  assert.equal(f.memories.length, 0)
})

test('生成过程中主人关闭图文开关或撤销目录权限，本次停止发布', async () => {
  for (const change of [{ enabled: false }, { local: false, folder: '' }]) {
    let f
    f = fixture({ rich: { local: true, folder: root }, reply: () => {
      f.setConfig({ ...f.config(), diary: { ...f.config().diary, rich: { ...f.config().diary.rich, ...change } } })
      return JSON.stringify({ text: '今天很开心。', imageIds: [] })
    } })
    const result = await f.qzone.writeDiary()
    assert.equal(result.ok, false)
    assert.equal(f.calls.length, 0)
    assert.equal(f.memories.length, 0)
  }
})

test('原生发布前仍用最新范围，保留部分好友名单和排除名单', async () => {
  for (const [visibility, right] of [['selected', 16], ['excluded', 128]]) {
    let f
    f = fixture({ reply: () => {
      f.setConfig({ ...f.config(), diary: { ...f.config().diary, visibility, audienceQQs: '10001' } })
      return JSON.stringify({ text: '今天的心情像一朵云。', imageIds: [] })
    } })
    const result = await f.qzone.writeDiary({ visibility: 'all' })
    assert.equal(result.ok, true)
    assert.equal(f.calls[0].params.ugc_right, right)
    assert.deepEqual(f.calls[0].params.target_uins, [10001])
  }
})

test('草稿生成后撤销配图授权，原生 post 最后一道检查也会阻止发布', async () => {
  const f = fixture()
  const draft = await f.media.compose()
  f.setConfig({ ...f.config(), diary: { ...f.config().diary, rich: { ...f.config().diary.rich, enabled: false } } })
  const result = await f.qzone.post(draft.text, { images: draft.images, beforeSend: draft.beforeSend })
  assert.equal(result.ok, false)
  assert.equal(f.calls.length, 0)
})

test('原生日记的预览接口拒绝 GET 和表单请求，JSON POST 不发布', async () => {
  const definition = (await import('../src/modules/diary/index.js')).default
  const f = fixture()
  const routes = new Map()
  const disposers = []
  definition.setup({
    ...f.api, log, lazy: () => ({}), onDispose: (fn) => disposers.push(fn), every() {}, tool() {}, rule() {},
    route: (path, run) => routes.set(path, run),
    core: { ...f.api.core, onebot: { call: () => { throw new Error('预览不得调用网关') } }, http: { body: async () => ({}) } },
  })
  try {
    assert.equal((await routes.get('/diary/preview')({ method: 'GET' })).ok, false)
    assert.equal((await routes.get('/diary/preview')({ method: 'POST', headers: { 'content-type': 'text/plain' } })).ok, false)
    assert.equal(f.prompts.length, 0)
    const result = await routes.get('/diary/preview')({ method: 'POST', headers: { 'content-type': 'application/json' } })
    assert.equal(result.ok, true)
    assert.equal(result.preview, true)
  } finally { disposers.forEach((dispose) => dispose()) }
})
