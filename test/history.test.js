const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'king-ppt-history-test-'));
process.env.KING_PPT_HOME = home;
const history = require('../src/history');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('one conversation task keeps its prompt, deck title, project label, and later updates', () => {
  const deck = {
    title: 'Slide title',
    projectTitle: 'Project label',
    templateId: null,
    canvas: { width: 10, height: 5.625 },
    slides: [{ title: 'Cover', role: 'cover', svg: '<svg viewBox="0 0 1280 720"></svg>' }],
  };
  const created = history.createTask({ title: 'Project label', prompt: 'First prompt', deck, doc: { markdown: '# Slide title' } });
  const original = history.load(created.id);

  assert.equal(original.meta.title, 'Project label');
  assert.equal(original.deck.title, 'Slide title');
  assert.equal(original.deck.taskId, created.id);
  assert.equal(original.messages.length, 1);
  assert.equal(original.messages[0].content, 'First prompt');
  assert.equal(history.findByFingerprint(deck).id, created.id);

  history.appendMessage(created.id, { role: 'user', content: 'Add a conclusion' });
  const renamed = history.rename(created.id, 'Renamed project');
  assert.equal(renamed.title, 'Renamed project');

  const changedDeck = history.load(created.id).deck;
  changedDeck.slides[0].svg = '<svg viewBox="0 0 1280 720"><text>Edited</text></svg>';
  history.updateTask(created.id, { deck: changedDeck, doc: { markdown: '# Slide title' } });
  const updated = history.load(created.id);
  assert.equal(updated.meta.title, 'Renamed project');
  assert.equal(updated.deck.title, 'Slide title');
  assert.equal(updated.deck.projectTitle, 'Renamed project');
  assert.equal(updated.messages.length, 2);
  assert.equal(updated.deck.slides.length, 1);
});

test('task list sorts by last modification, not by open/read access', async () => {
  const first = history.createTask({ title: 'First', prompt: 'First' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = history.createTask({ title: 'Second', prompt: 'Second' });
  const openedAt = history.load(first.id).meta.updatedAt;
  assert.equal(history.list()[0].id, second.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  history.updateTask(first.id, { deck: { title: 'First deck', slides: [{ svg: '<svg>edit</svg>' }] }, doc: null });
  assert.equal(history.load(first.id).meta.updatedAt > openedAt, true);
  assert.equal(history.list()[0].id, first.id);
});

test('legacy identical snapshots are hidden from the task list without deleting their files', () => {
  const created = history.createTask({
    title: 'Chat task', prompt: 'Initial prompt',
    deck: { title: 'Slides', slides: [{ svg: '<svg>same</svg>' }] },
  });
  const legacyId = '20200101-000000-abcd';
  const legacyDir = path.join(history.HISTORY_DIR, legacyId);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'meta.json'), JSON.stringify({
    id: legacyId, title: 'Old snapshot', createdAt: '2020-01-01T00:00:00.000Z',
    pages: 1, fingerprint: created.fingerprint,
  }));

  assert.equal(history.list().filter((item) => item.fingerprint === created.fingerprint).length, 1);
  assert.equal(fs.existsSync(path.join(legacyDir, 'meta.json')), true);
});

test('history rejects blank or oversized conversation labels', () => {
  const created = history.createTask({ title: 'Task', prompt: 'Prompt' });
  assert.throws(() => history.rename(created.id, '  '), /标题不能为空/);
  assert.throws(() => history.rename(created.id, 'x'.repeat(81)), /不能超过 80/);
});
