const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGenerationJobs } = require('../src/generation-jobs');

function tempFile() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'king-ppt-generation-test-'));
  return { home, file: path.join(home, 'deck-generation.json') };
}

test('background jobs publish durable progress and completion', async (t) => {
  const { home, file } = tempFile();
  const jobs = createGenerationJobs({ file });
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const started = jobs.start({ title: 'Deck', templateId: 'theme', total: 2 }, async (progress) => {
    progress(1, [], '正在生成第 2 / 2 页');
    return { recovered: [0], pages: 2 };
  });
  assert.equal(started.status, 'queued');
  assert.equal(jobs.isActive(), true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const completed = jobs.get();
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completed, 2);
  assert.deepEqual(completed.recovered, [0]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'completed');
  assert.equal(jobs.isActive(), false);
});

test('failed jobs keep progress and restart marks unfinished work interrupted', async (t) => {
  const { home, file } = tempFile();
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const jobs = createGenerationJobs({ file });
  jobs.start({ title: 'Partial', total: 4 }, async (progress) => {
    progress(2, [1], '正在生成第 3 / 4 页');
    throw new Error('upstream timed out');
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(jobs.get().status, 'failed');
  assert.equal(jobs.get().completed, 2);
  assert.equal(jobs.get().error, 'upstream timed out');

  const interruptedFile = path.join(home, 'interrupted.json');
  fs.writeFileSync(interruptedFile, JSON.stringify({ id: 'old', status: 'running', title: 'Old', completed: 1, total: 3 }));
  const recovered = createGenerationJobs({ file: interruptedFile });
  assert.equal(recovered.get().status, 'interrupted');
  assert.match(recovered.get().error, /已保留已生成页面/);
});

test('only one background job can run at a time', async (t) => {
  const { home, file } = tempFile();
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let release;
  const jobs = createGenerationJobs({ file });
  jobs.start({ title: 'One', total: 1 }, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.throws(() => jobs.start({ title: 'Two', total: 1 }, async () => ({})), { code: 'BUSY' });
  release({ pages: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(jobs.get().status, 'completed');
});
