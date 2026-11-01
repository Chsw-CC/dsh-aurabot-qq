import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalize } from '../src/core/config.js'
import { presetFor } from '../src/chat/access.js'
import { rulesText } from '../src/persona/personas.js'

test('新安装默认打开长任务模式，老用户存过的不变', () => {
  assert.equal(normalize({}).longTasks, true)
  assert.equal(normalize({ longTasks: false }).longTasks, false)
  assert.equal(presetFor('full', normalize({})), 'aurabot-private-long')
  assert.equal(presetFor('social', normalize({})), 'aurabot-social')
})

test('规则跟着开关走，只进主人私聊', () => {
  assert.match(rulesText('private', normalize({ ownerName: '主人' })), /放到后台/)
  assert.doesNotMatch(rulesText('private', normalize({ longTasks: false })), /放到后台/)
  assert.doesNotMatch(rulesText('social', normalize({})), /放到后台/)
})

test('智能体团队只挂在主人私聊的长任务预设，社交预设碰不到', () => {
  const yml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const start = (id) => yml.indexOf(`id: preset-aurabot-${id}`)
  const at = yml.indexOf('dsh-experimental-tool-agent-team')
  assert.ok(at > start('private-long'), '要在长任务预设里')
  assert.ok(at < start('social'), '不能进社交预设')
  assert.equal(yml.split('dsh-experimental-tool-agent-team').length, 2, '只挂一处')
  assert.doesNotMatch(yml, /dsh-experimental-agent-team'/, '服务由 DSH 的开关提供，这里不重复注册')
  assert.match(rulesText('private', normalize({})), /spawn_teammate/)
  assert.doesNotMatch(rulesText('social', normalize({})), /spawn_teammate/)
})

