import { describe, expect, it } from 'vitest'
import {
  buildHttpCall,
  buildSmtpPlan,
  ChannelBuildError,
  dispatchChannels,
  sendToChannel,
  type FetchLike,
} from '../src/channel-send.ts'
import type { ChannelConfig, ChannelType, PushMessage } from '../src/channels.ts'

/** A configured channel for the tests. */
function ch(type: ChannelType, fields: Record<string, string>, extra: Partial<ChannelConfig> = {}): ChannelConfig {
  return { id: 'ch_abcdef123456', type, enabled: true, label: '', fields, ...extra }
}

/** One message. */
const message: PushMessage = {
  title: 'T',
  body: 'B',
  level: 'info',
  scenario: 'completed',
  source: 'proj',
  timestamp: 1_700_000_000_000,
}

/** A fetch stub returning a fixed status/text, optionally recording calls. */
function stubFetch(status: number, body: string, sink?: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => void): FetchLike {
  return async (url, init) => {
    sink?.(url, init)
    return { status, text: async () => body }
  }
}

describe('channel dispatch — request shapes', () => {
  it('builds a generic webhook POST with a JSON envelope', () => {
    const call = buildHttpCall(ch('webhook', { url: 'https://example.com/hook' }), message, 0)
    expect(call.url).toBe('https://example.com/hook')
    expect(call.method).toBe('POST')
    const body = JSON.parse(call.body as string)
    expect(body.title).toBe('T')
    expect(body.message).toBe('B')
    expect(body.level).toBe('info')
  })

  it('merges custom webhook headers from JSON', () => {
    const call = buildHttpCall(ch('webhook', { url: 'https://x', headers: '{"Authorization":"Bearer k"}' }), message, 0)
    expect(call.headers['Authorization']).toBe('Bearer k')
  })

  it('refuses a channel missing a required field', () => {
    expect(() => buildHttpCall(ch('webhook', {}), message, 0)).toThrow(ChannelBuildError)
  })

  it('builds bark from the device key and default server', () => {
    expect(buildHttpCall(ch('bark', { deviceKey: 'KEY' }), message, 0).url).toBe('https://api.day.app/KEY')
    expect(buildHttpCall(ch('bark', { deviceKey: 'KEY', server: 'https://bark.local/' }), message, 0).url).toBe('https://bark.local/KEY')
  })

  it('builds serverchan Turbo with a form body', () => {
    const call = buildHttpCall(ch('serverchan', { sendKey: 'SCT123' }), message, 0)
    expect(call.url).toBe('https://sctapi.ftqq.com/SCT123.send')
    expect(call.body).toContain('title=T')
    expect(call.body).toContain('desp=')
  })

  it('builds pushplus and wecom payloads', () => {
    expect(buildHttpCall(ch('pushplus', { token: 'tk' }), message, 0).url).toBe('https://www.pushplus.plus/send')
    const wecom = buildHttpCall(ch('wecom', { key: 'k' }), message, 0)
    expect(wecom.url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k')
    expect(JSON.parse(wecom.body as string).msgtype).toBe('text')
  })

  it('signs dingtalk when a secret is present', () => {
    const call = buildHttpCall(ch('dingtalk', { url: 'https://oapi.dingtalk.com/robot/send?access_token=x', secret: 'SEC' }), message, 1_000_000)
    expect(call.url).toContain('timestamp=1000000')
    expect(call.url).toContain('&sign=')
  })

  it('signs feishu when a secret is present', () => {
    const payload = JSON.parse(buildHttpCall(ch('feishu', { url: 'https://open.feishu.cn/hook/x', secret: 'SEC' }), message, 1_000_000).body as string)
    expect(payload.msg_type).toBe('text')
    expect(typeof payload.sign).toBe('string')
    expect(payload.timestamp).toBe('1000')
  })

  it('builds telegram, ntfy, gotify, slack, discord', () => {
    expect(buildHttpCall(ch('telegram', { botToken: 'BOT', chatId: '42' }), message, 0).url).toBe('https://api.telegram.org/botBOT/sendMessage')
    const ntfy = buildHttpCall(ch('ntfy', { topic: 'topic' }), message, 0)
    expect(ntfy.url).toBe('https://ntfy.sh/topic')
    expect(ntfy.headers['Title']).toBe('T')
    const gotify = buildHttpCall(ch('gotify', { server: 'https://gotify.x', token: 'tk' }), message, 0)
    expect(gotify.url).toBe('https://gotify.x/message?token=tk')
    expect(JSON.parse(gotify.body as string).priority).toBe(3)
    expect(buildHttpCall(ch('slack', { url: 'https://hooks.slack/x' }), message, 0).url).toBe('https://hooks.slack/x')
    expect(JSON.parse(buildHttpCall(ch('discord', { url: 'https://discord/x' }), message, 0).body as string).content).toContain('T')
  })

  it('builds wxpusher and pushdeer', () => {
    const wx = buildHttpCall(ch('wxpusher', { appToken: 'AT_x', uid: 'UID_1' }), message, 0)
    expect(JSON.parse(wx.body as string).uids).toEqual(['UID_1'])
    const pd = buildHttpCall(ch('pushdeer', { pushKey: 'PK' }), message, 0)
    expect(pd.url).toBe('https://api2.pushdeer.com/message/push')
    expect(pd.body).toContain('pushkey=PK')
  })

  it('builds an SMTP plan with a base64 message', () => {
    const plan = buildSmtpPlan(ch('smtp', { host: 'smtp.x', port: '465', secure: 'ssl', from: 'a@x', to: 'b@x, c@x' }), message)
    expect(plan.port).toBe(465)
    expect(plan.secure).toBe('ssl')
    expect(plan.to).toEqual(['b@x', 'c@x'])
    expect(plan.data).toContain('Subject: =?UTF-8?B?')
    expect(plan.data).toContain('Content-Transfer-Encoding: base64')
  })
})

describe('channel dispatch — delivery and business codes', () => {
  it('treats wecom errcode 0 as success and non-zero as failure', async () => {
    const ok = await sendToChannel(ch('wecom', { key: 'k' }), message, { fetchImpl: stubFetch(200, '{"errcode":0}') })
    expect(ok.ok).toBe(true)
    const bad = await sendToChannel(ch('wecom', { key: 'k' }), message, { fetchImpl: stubFetch(200, '{"errcode":40000,"errmsg":"bad"}') })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('errcode')
  })

  it('treats telegram ok:false as failure', async () => {
    const r = await sendToChannel(ch('telegram', { botToken: 'B', chatId: '1' }), message, { fetchImpl: stubFetch(200, '{"ok":false,"description":"chat not found"}') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('chat not found')
  })

  it('skips disabled channels and isolates one failing channel', async () => {
    const channels = [
      ch('wecom', { key: 'k' }, { id: 'ch_aaaaaaaaaaaa' }),
      ch('slack', { url: 'https://hooks.slack/x' }, { id: 'ch_bbbbbbbbbbbb' }),
      ch('discord', { url: 'https://discord/x' }, { id: 'ch_cccccccccccc', enabled: false }),
    ]
    const fetchImpl: FetchLike = async url => {
      if (url.includes('qyapi')) return { status: 200, text: async () => '{"errcode":0}' }
      return { status: 500, text: async () => 'boom' }
    }
    const receipts = await dispatchChannels(channels, message, { fetchImpl })
    expect(receipts).toHaveLength(2)
    expect(receipts.find(r => r.id === 'ch_aaaaaaaaaaaa')?.ok).toBe(true)
    expect(receipts.find(r => r.id === 'ch_bbbbbbbbbbbb')?.ok).toBe(false)
  })

  it('times out a hung request', async () => {
    const slow: FetchLike = () => new Promise(resolve => setTimeout(() => resolve({ status: 200, text: async () => '{}' }), 300))
    const r = await sendToChannel(ch('slack', { url: 'https://x' }), message, { fetchImpl: slow, timeoutMs: 20 })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('timeout')
  })

  it('delivers SMTP through the injected seam', async () => {
    let called = 0
    const ok = await sendToChannel(ch('smtp', { host: 'smtp.x', port: '465', secure: 'ssl', from: 'a@x', to: 'b@x' }), message, {
      smtpDeliver: async () => { called += 1 },
    })
    expect(ok.ok).toBe(true)
    expect(called).toBe(1)
    const bad = await sendToChannel(ch('smtp', { host: 'smtp.x', port: '465', secure: 'ssl', from: 'a@x', to: 'b@x' }), message, {
      smtpDeliver: async () => { throw new Error('auth failed') },
    })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('auth failed')
  })
})
