// Local dev helpers (no dependencies):
//   http://localhost:8788/practice-quiz.html   the demo page
//   http://localhost:8787/v1/systemone         a MOCK Jev endpoint (answers from the demo answer key) so you can
//                                               try Blair Vision without an API key. It is NOT Jev.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { runInNewContext } from 'node:vm';

const DEMO = join(process.cwd(), 'demo');
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const sandbox = { window: {} };
runInNewContext(readFileSync(join(DEMO, 'questions.js'), 'utf8'), sandbox);
const bank = sandbox.window.QUESTIONS;
const answers = new Map(bank.map((q) => [norm(q.q), norm(q.choices[q.answer])]));

export function startServers({ demoPort = 8788, mockPort = 8787, latency = [150, 350], quiet = false } = {}) {
  const counters = { calls: 0, questions: [] };
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };

  const mock = createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.url === '/stats') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(counters)); }
    if (req.url === '/reset') { counters.calls = 0; counters.questions = []; res.writeHead(200, cors); return res.end('ok'); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!/^Bearer .+/.test(req.headers.authorization || '')) { res.writeHead(401, { ...cors, 'Content-Type': 'application/json' }); return res.end('{"error":"missing bearer key"}'); }
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400, cors); return res.end('{"error":"bad json"}'); }
      const spec = j.questions?.answer;
      const ids = Object.keys(spec?.criteria ?? {});
      counters.calls++; counters.questions.push(j.state?.question);
      const want = answers.get(norm(j.state?.question));
      let pick = ids.find((id) => norm(spec.criteria[id]) === want);
      const known = !!pick;
      if (!pick) pick = ids[0];
      const top = known ? 0.9 : 0.4, rest = (1 - top) / (ids.length - 1 || 1);
      const probabilities = Object.fromEntries(ids.map((id) => [id, id === pick ? top : rest]));
      const delay = latency[0] + Math.random() * (latency[1] - latency[0]);
      if (!quiet) console.log(`[mock-jev] #${counters.calls} "${j.state?.question}" -> ${pick} (${known ? 'known' : 'unknown, low confidence'})`);
      setTimeout(() => {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answers: { answer: { choice: pick, confidence: top, probabilities } }, usage: { cost: 0.00002 }, model: 'mock/jev' }));
      }, delay);
    });
  });

  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const demo = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(DEMO, path === '/' ? 'practice-quiz.html' : path);
    if (!file.startsWith(DEMO) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'text/plain' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    let n = 0;
    const done = () => { if (++n === 2) resolve({ counters, close: () => { mock.close(); demo.close(); } }); };
    mock.listen(mockPort, '127.0.0.1', done);
    demo.listen(demoPort, '127.0.0.1', done);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServers();
  console.log('Demo page:  http://localhost:8788/practice-quiz.html');
  console.log('Mock Jev:   http://localhost:8787/v1/systemone   (any API key works; it is a mock, not Jev)');
}
