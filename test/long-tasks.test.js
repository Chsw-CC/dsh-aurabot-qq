import { test } from 'node:test'
import assert from 'node:assert/strict'
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
