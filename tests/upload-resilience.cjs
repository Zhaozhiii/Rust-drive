// Exercise the actual browser upload request code with a deterministic clock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/drive.js'), 'utf8');
const start = source.indexOf('const send = index =>');
const end = source.indexOf('const worker = async () =>', start);
const expression = source.slice(start + 'const send = '.length, end).trim().replace(/;$/, '');

function harness() {
  let now = 0, serial = 0, xhr;
  const timers = new Map(), active = new Set();
  class Request {
    constructor() { xhr = this; this.upload = {}; }
    open() {}
    setRequestHeader() {}
    send() {}
    abort() { this.aborted = true; this.onabort(); }
  }
  const send = vm.runInNewContext(`(${expression})`, {
    XMLHttpRequest: Request, file: { size: 16, slice: () => ({ size: 16 }) },
    session: { chunkSize: 16, id: 'test' }, api: '/api/clouddrive',
    active, inflight: new Map(), sampleBytes: 0, render() {}, update() {},
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    send, active, timers,
    get xhr() { return xhr; },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = target;
    },
  };
}

(async () => {
  let h = harness(), result = h.send(0);
  assert.equal(h.xhr.timeout, 0);
  for (let loaded = 1; loaded <= 4; loaded++) {
    h.advance(240000); h.xhr.upload.onprogress({ loaded });
    assert(!h.xhr.aborted, 'active upload must survive the old five-minute total limit');
  }
  h.xhr.upload.onload(); h.advance(240000);
  h.xhr.status = 200; h.xhr.onload(); await result;
  assert.equal(h.timers.size, 0); assert.equal(h.active.size, 0);

  h = harness(); result = h.send(0);
  const stalled = assert.rejects(result, /长时间无进展/);
  h.advance(300000); await stalled;
  assert(h.xhr.aborted); assert.equal(h.active.size, 0);

  for (const status of [400, 404, 409, 413, 507, 408, 429, 500, 503]) {
    h = harness(); result = h.send(0);
    h.xhr.status = status; h.xhr.responseText = '{"message":"fixture"}'; h.xhr.onload();
    await assert.rejects(result, error => {
      assert.equal(error.message, 'fixture');
      assert.equal(error.retryable, status === 408 || status === 429 || (status >= 500 && status !== 507));
      return true;
    });
    assert.equal(h.timers.size, 0); assert.equal(h.active.size, 0);
  }
  h = harness(); result = h.send(0);
  const paused = assert.rejects(result, /上传已中断/);
  h.xhr.abort(); await paused;
  assert.equal(h.timers.size, 0);
  console.log('PASS slow upload progress, idle timeout, response retry policy, pause and timer cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
