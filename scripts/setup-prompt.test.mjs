import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  askConfirm,
  askLine,
  askSecret,
  askSelect,
  askText,
  WizardAbort,
} from './setup-prompt.mjs'

class FakeTTY extends EventEmitter {
  isTTY = true
  rawModeChanges = []
  written = []
  setRawMode(value) { this.rawModeChanges.push(value) }
  resume() {}
  pause() {}
  write(chunk) { this.written.push(chunk) }
  type(text) {
    // Defer emission so a chained prompt can attach its listener first.
    return new Promise((resolve) => {
      setImmediate(() => {
        this.emit('data', Buffer.from(text, 'utf8'))
        resolve()
      })
    })
  }
  get outputText() { return this.written.join('') }
}

function fakeIo() {
  const input = new FakeTTY()
  const output = new FakeTTY()
  return { io: { input, output }, input, output }
}

test('askSecret masks every character and never echoes the value (#195)', async () => {
  const { io, input, output } = fakeIo()
  const pending = askSecret('Cloudflare API token', io)
  input.type('abc123')
  input.type('\r')
  const value = await pending
  assert.equal(value, 'abc123')
  assert.equal(output.outputText.includes('abc123'), false, 'secret must never be echoed')
  assert.equal(output.outputText.includes('******'), true, 'mask echoed instead')
  assert.deepEqual(input.rawModeChanges, [true, false], 'raw mode restored')
})

test('askLine supports backspace, ctrl-u and ctrl-c abort (#195)', async () => {
  {
    const { io, input } = fakeIo()
    const pending = askLine('Hostname', io)
    input.type('exampX\u007fle\r')
    assert.equal(await pending, 'example')
  }
  {
    const { io, input } = fakeIo()
    const pending = askLine('Hostname', io)
    input.type('wrong\u0015right\r')
    assert.equal(await pending, 'right')
  }
  {
    const { io, input } = fakeIo()
    const pending = askLine('Hostname', io)
    input.type('\u0003')
    await assert.rejects(pending, WizardAbort)
    assert.deepEqual(input.rawModeChanges, [true, false])
  }
})

test('EOF and non-TTY abort instead of hanging (#195)', async () => {
  {
    const { io, input } = fakeIo()
    const pending = askLine('Hostname', io)
    input.emit('close')
    await assert.rejects(pending, /EOF/)
  }
  {
    const input = { isTTY: false }
    const output = { write() {} }
    await assert.rejects(askLine('Token', { input, output }), /not a TTY/)
  }
})

test('askSelect auto-picks a single option and validates numbering (#195)', async () => {
  const { io, input } = fakeIo()
  assert.equal(await askSelect('Account', [{ title: 'Only', value: 'acct-1' }], io), 'acct-1')
  const pending = askSelect('Account', [
    { title: 'A', value: 'a' },
    { title: 'B', value: 'b' },
  ], io)
  input.type('9\r')
  input.type('2\r')
  assert.equal(await pending, 'b')
})

test('askConfirm defaults and rejects invalid answers without looping forever (#195)', async () => {
  {
    const { io, input } = fakeIo()
    const pending = askConfirm('Apply?', io)
    input.type('\r')
    assert.equal(await pending, false)
  }
  {
    const { io, input } = fakeIo()
    const pending = askConfirm('Apply?', io, { defaultYes: true })
    input.type('n\r')
    assert.equal(await pending, false)
  }
  {
    const { io, input } = fakeIo()
    const pending = askConfirm('Apply?', io)
    input.type('maybe\r')
    input.type('y\r')
    assert.equal(await pending, true)
  }
})

test('askText validates and stops after bounded attempts (#195)', async () => {
  const { io, input } = fakeIo()
  const pending = askText('Hostname', io, { validate: (v) => (v.includes('.') ? null : 'must contain a dot') })
  input.type('nodot\r')
  input.type('anime.example.com\r')
  assert.equal(await pending, 'anime.example.com')
  const { io: io2, input: input2 } = fakeIo()
  const failing = askText('Hostname', io2, { validate: () => 'always invalid' })
  input2.type('a\r'); input2.type('b\r'); input2.type('c\r')
  await assert.rejects(failing, /too many invalid/)
})
