#!/usr/bin/env node
// Encode a music track for the game — AAC-LC in an ADTS stream (.aac), which
// every browser plays — with the AAC encoder built into Chrome (WebCodecs), so
// no ffmpeg is needed:
//   node tools/encode-music.mjs <in.flac> <out.aac> [--kbps 96]
//
// Chrome (headless) decodes the input — FLAC, WAV, MP3, OGG, anything it plays —
// AudioEncoder encodes it, and every AAC frame gets its 7-byte ADTS header.
// Set CHROME=/path/to/chrome if it is not found. With ffmpeg the same is:
//   ffmpeg -i in.flac -c:a aac -b:a 96k out.aac
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const k = args.indexOf('--kbps');
const kbps = k >= 0 ? +args.splice(k, 2)[1] : 96;
const [input, output] = args;
if (!input || !output || !(kbps >= 32 && kbps <= 320)) {
  console.error('usage: node tools/encode-music.mjs <in.flac> <out.aac> [--kbps 96]');
  process.exit(1);
}
const CHROME = [process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => p && fs.existsSync(p));
if (!CHROME) { console.error('Chrome not found — set CHROME=/path/to/chrome'); process.exit(1); }

// Runs in the page: decode, encode, ADTS-frame, POST the result back (absolute
// URLs: the page may still be about:blank when it runs)
const pageJs = base => `(async () => {
  const audio = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(await (await fetch('${base}/in')).arrayBuffer());
  const sr = audio.sampleRate, ch = Math.min(2, audio.numberOfChannels), frames = [];
  const enc = new AudioEncoder({ output: c => { const b = new Uint8Array(c.byteLength); c.copyTo(b); frames.push(b); }, error: e => { throw e; } });
  enc.configure({ codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, bitrate: ${kbps * 1000} });
  for (let i = 0, N = 4096; i < audio.length; i += N) {
    const n = Math.min(N, audio.length - i), data = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) data.set(audio.getChannelData(c).subarray(i, i + n), c * n);
    enc.encode(new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(i / sr * 1e6), data }));
    if (enc.encodeQueueSize > 32) await new Promise(r => setTimeout(r, 0));
  }
  await enc.flush();
  const sfi = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350].indexOf(sr);
  const adts = p => {                       // AAC-LC, no CRC, one raw data block
    if (p[0] === 0xFF && (p[1] & 0xF6) === 0xF0) return [p];   // already ADTS
    const len = p.length + 7;
    return [new Uint8Array([0xFF, 0xF1, (1 << 6) | (sfi << 2) | (ch >> 2), ((ch & 3) << 6) | (len >> 11), (len >> 3) & 0xFF, ((len & 7) << 5) | 0x1F, 0xFC]), p];
  };
  await fetch('${base}/out', { method: 'POST', body: new Blob(frames.flatMap(adts)) });
  return { seconds: audio.duration, sampleRate: sr, channels: ch, frames: frames.length };
})()`;

let result = null;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/in') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); fs.createReadStream(input).pipe(res); return; }
  if (req.url === '/out' && req.method === 'POST') {
    const parts = []; req.on('data', d => parts.push(d)); req.on('end', () => { result = Buffer.concat(parts); res.end('ok'); }); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>encode</title>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
// throwaway profile next to the output (the system temp folder may be small)
const profile = path.join(path.dirname(path.resolve(output)), `.encode-chrome-${process.pid}`);
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--mute-audio', `http://127.0.0.1:${port}/`], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} server.close(); setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500); };
try {
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await new Promise(r => setTimeout(r, 150));
    try {
      const [devPort] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
      const page = (await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json()).find(t => t.type === 'page' && t.url.includes(`:${port}/`));
      wsUrl = page?.webSocketDebuggerUrl;
    } catch {}
  }
  if (!wsUrl) throw new Error('could not connect to Chrome');
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const evaluate = expression => new Promise(r => {
    const my = ++id;
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === my) r(m); };
    ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  // the target can exist before its page has loaded: wait for our origin
  for (let i = 0; i < 100; i++) {
    const r = await evaluate(`location.origin + ' ' + document.readyState`);
    if (r.result?.result?.value === `http://127.0.0.1:${port} complete`) break;
    await new Promise(res => setTimeout(res, 100));
  }
  const reply = await evaluate(pageJs(`http://127.0.0.1:${port}`));
  ws.close();
  if (reply.result?.exceptionDetails || !result) throw new Error(reply.result?.exceptionDetails?.exception?.description || 'no output');
  const info = reply.result.result.value;
  fs.writeFileSync(output, result);
  console.log(`${output}: ${Math.floor(info.seconds / 60)}:${String(Math.round(info.seconds % 60)).padStart(2, '0')}, ${info.sampleRate} Hz ${info.channels} ch, AAC ${kbps} kbps, ${(result.length / 1048576).toFixed(2)} MiB`);
} catch (e) { console.error(`${input}: ${e.message}`); process.exitCode = 1; }
finally { cleanup(); }
