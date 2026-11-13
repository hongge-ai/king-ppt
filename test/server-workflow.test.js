const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'king-ppt-server-test-'));
process.env.KING_PPT_HOME = home;
const history = require('../src/history');
const llmprovider = require('../src/llmprovider');
const genOutline = require('../src/generate-outline');
const { app, relay } = require('../src/server');

let server;
let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 450));
  fs.rmSync(home, { recursive: true, force: true });
});

test('new starts an empty conversation; first prompt creates one reusable history task', async () => {
  const fresh = await fetch(`${base}/api/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(fresh.status, 200);
  assert.equal((await fresh.json()).history.length, 0);
  assert.equal(relay.getState().taskId, null);
  const removedManualArchive = await fetch(`${base}/api/history/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(removedManualArchive.status, 404);

  const originalListActive = llmprovider.listActive;
  const originalGenerateOutline = genOutline.generateOutline;
  llmprovider.listActive = () => ({ chat: { model: 'test-model' } });
  genOutline.generateOutline = async ({ topic }) => `# Slide title\n\n## Cover\n\n> ${topic}`;
  try {
    const first = await fetch(`${base}/api/generate/outline`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Project label' }),
    });
    assert.equal(first.status, 200);
    const firstHistory = await fetch(`${base}/api/history`).then((r) => r.json());
    assert.equal(firstHistory.items.length, 1);
    const task = firstHistory.items[0];
    assert.equal(task.title, 'Project label');
    assert.equal(task.prompt, 'Project label');
    assert.equal(task.messageCount, 1);
    assert.equal(relay.getState().taskId, task.id);

    const second = await fetch(`${base}/api/generate/outline`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Add a conclusion' }),
    });
    assert.equal(second.status, 200);
    const secondHistory = await fetch(`${base}/api/history`).then((r) => r.json());
    assert.equal(secondHistory.items.length, 1);
    assert.equal(secondHistory.items[0].id, task.id);
    assert.equal(secondHistory.items[0].messageCount, 2);

    relay.setDeck({
      title: 'Slide title', projectTitle: 'Project label', taskId: task.id, templateId: null,
      canvas: { width: 10, height: 5.625 },
      slides: [{ title: 'Cover', role: 'cover', svg: '<svg viewBox="0 0 1280 720"><text x="20" y="40">Cover</text></svg>' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const renamedResponse = await fetch(`${base}/api/history/${task.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Renamed project' }),
    });
    assert.equal(renamedResponse.status, 200);
    assert.equal(relay.getState().projectTitle, 'Renamed project');

    const beforeOpen = history.load(task.id).meta.updatedAt;
    const opened = await fetch(`${base}/api/history/${task.id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const openedBody = await opened.json();
    assert.equal(opened.status, 200);
    assert.equal(history.load(task.id).meta.updatedAt, beforeOpen);
    assert.equal(openedBody.deckTitle, 'Slide title');
    assert.equal(openedBody.messages.length, 2);
    assert.equal(relay.getState().taskId, task.id);
    assert.equal(relay.getState().projectTitle, 'Renamed project');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const selectedSlide = relay.getState().slides[0];
    relay.setSlide(0, { ...selectedSlide, svg: selectedSlide.svg.replace('Cover', 'Edited cover') });
    assert.ok(Date.parse(history.load(task.id).meta.updatedAt) > Date.parse(beforeOpen));

    const exportResponse = await fetch(`${base}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slides: relay.getState().slides, title: relay.getState().title, themeId: relay.getState().templateId, canvas: relay.getState().canvas }),
    });
    const exportedBytes = await exportResponse.arrayBuffer();
    assert.equal(exportResponse.status, 200, new TextDecoder().decode(exportedBytes));
    const zip = await JSZip.loadAsync(exportedBytes);
    assert.ok(zip.file('ppt/slides/slide1.xml'));

    const newConversation = await fetch(`${base}/api/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(newConversation.status, 200);
    assert.equal((await newConversation.json()).history.length, 1);
    assert.equal(relay.getState().taskId, null);
    assert.equal(relay.getState().slides.length, 0);
    assert.equal(history.load(task.id).messages.length, 2);
  } finally {
    llmprovider.listActive = originalListActive;
    genOutline.generateOutline = originalGenerateOutline;
  }
});

test('generation status endpoint returns the current persisted job snapshot', async () => {
  const response = await fetch(`${base}/api/generate/deck/status`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).job, null);
});