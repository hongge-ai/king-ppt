const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'king-ppt-generation-route-test-'));
process.env.KING_PPT_HOME = home;
const history = require('../src/history');
const llmprovider = require('../src/llmprovider');
const genDeck = require('../src/generate-deck');
const { TEMPLATES_DIR } = require('../src/paths');
const { app, relay } = require('../src/server');

let server;
let base;
test.before(async () => {
  const themeDir = path.join(TEMPLATES_DIR, 'test-theme');
  fs.mkdirSync(themeDir, { recursive: true });
  fs.writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify({
    name: 'Test theme',
    canvas: { vbWidth: 1280, vbHeight: 720 },
    tokens: {
      color: { bg: '#FFFFFF', primary: '#123456', accent: '#E2703A', text: '#222222' },
      scale: { display: 64, pageTitle: 40, body: 24, caption: 18 },
      font: { title: 'Arial', body: 'Arial' },
    },
  }));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 450));
  fs.rmSync(home, { recursive: true, force: true });
});

test('deck generation returns immediately, reports progress, survives disconnect, and preserves task state on failure', async () => {
  const slide = { title: 'Existing', role: 'cover', svg: '<svg viewBox="0 0 1280 720"><text>Existing</text></svg>' };
  relay.setDeck({ title: 'Existing deck', projectTitle: 'Existing project', templateId: null, canvas: { width: 10, height: 5.625 }, slides: [slide] });
  relay.setDoc({ title: 'New deck', markdown: '# New deck\n\n## New deck\n' });

  const originalCreateTask = history.createTask;
  const originalListActive = llmprovider.listActive;
  const originalGenerateSlideSvg = genDeck.generateSlideSvg;
  llmprovider.listActive = () => ({ chat: { model: 'test' } });
  try {
    history.createTask = () => { throw new Error('history storage unavailable'); };
    const failedStart = await fetch(`${base}/api/generate/deck`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeId: 'test-theme' }),
    });
    assert.equal(failedStart.status, 500);
    assert.equal(relay.getState().title, 'Existing deck');
    assert.equal(relay.getState().slides.length, 1);

    history.createTask = originalCreateTask;
    const initialTask = history.createTask({ title: 'Existing project', prompt: 'Existing project', deck: relay.getState(), doc: relay.getDoc() });
    relay.setTaskId(initialTask.id);
    relay.setProjectTitle('Existing project');
    const taskId = initialTask.id;
    let finishPage;
    genDeck.generateSlideSvg = () => new Promise((resolve) => {
      finishPage = () => resolve('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><text x="20" y="40">Generated</text></svg>');
    });
    const startedAt = Date.now();
    const response = await fetch(`${base}/api/generate/deck`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeId: 'test-theme' }),
    });
    assert.equal(response.status, 202);
    assert.ok(Date.now() - startedAt < 1000, 'task creation should not wait for slide generation');
    const { job: startedJob } = await response.json();
    assert.equal(startedJob.status, 'queued');

    for (let i = 0; i < 50 && !finishPage; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(typeof finishPage, 'function', 'background worker should continue after the HTTP request ends');
    let status = await fetch(`${base}/api/generate/deck/status`).then((r) => r.json());
    assert.equal(status.job.status, 'running');
    const stream = await fetch(`${base}/api/stream`);
    const streamReader = stream.body.getReader();
    const replay = new TextDecoder().decode((await streamReader.read()).value);
    assert.match(replay, /event: generation/);
    assert.match(replay, /\"status\":\"running\"/);
    await streamReader.cancel();

    const resetWhileBusy = await fetch(`${base}/api/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(resetWhileBusy.status, 409);
    assert.equal(relay.getState().title, 'New deck');

    finishPage();
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await fetch(`${base}/api/generate/deck/status`).then((r) => r.json());
      if (status.job.status === 'completed') break;
    }
    assert.equal(status.job.status, 'completed');
    assert.equal(status.job.completed, 1);
    assert.equal(relay.getState().slides.length, 1);
    assert.equal(relay.getState().projectTitle, 'Existing project');
    assert.equal(relay.getState().taskId, taskId);
    assert.equal(history.list().length, 1);

    relay.setDoc({ title: 'Partial deck', markdown: '# Partial deck\n\n## Cover\n\n> Short cover\n\n## Body\n\n- First point\n- Second point' });
    let calls = 0;
    genDeck.generateSlideSvg = async () => {
      calls += 1;
      if (calls === 2) throw new Error('second slide failed');
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><text x="20" y="40">Partial</text></svg>';
    };
    const failedResponse = await fetch(`${base}/api/generate/deck`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeId: 'test-theme' }),
    });
    const failedPayload = await failedResponse.json();
    assert.equal(failedResponse.status, 202, JSON.stringify(failedPayload));
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await fetch(`${base}/api/generate/deck/status`).then((r) => r.json());
      if (status.job.status === 'failed') break;
    }
    assert.equal(status.job.status, 'failed');
    assert.equal(status.job.completed, 1);
    assert.equal(status.job.error, 'second slide failed');
    assert.equal(relay.getState().slides.length, 1);
    assert.equal(relay.getState().taskId, taskId);
    assert.equal(history.list().length, 1);
  } finally {
    history.createTask = originalCreateTask;
    llmprovider.listActive = originalListActive;
    genDeck.generateSlideSvg = originalGenerateSlideSvg;
  }
});
