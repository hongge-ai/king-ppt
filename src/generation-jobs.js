const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createGenerationJobs({ file, onChange = () => {}, schedule = setImmediate }) {
  let current = null;

  function persist() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(current, null, 2), 'utf8');
      try { fs.renameSync(temp, file); }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EEXIST'].includes(error.code)) throw error;
        fs.copyFileSync(temp, file);
        fs.unlinkSync(temp);
      }
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best-effort temp cleanup */ }
    }
  }

  function publish({ required = false } = {}) {
    if (!current) return;
    current.revision = (current.revision || 0) + 1;
    current.persistenceError = null;
    try { persist(); }
    catch (error) {
      current.persistenceError = `任务状态无法保存：${error.message}`;
      if (required) throw error;
    }
    onChange({ ...current });
  }

  if (file) {
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { current = null; }
    if (current && ['queued', 'running'].includes(current.status)) {
      current.status = 'interrupted';
      current.error = '服务重启时任务尚未完成。已保留已生成页面，请重试。';
      current.updatedAt = new Date().toISOString();
      publish();
    }
  }

  function get() {
    return current ? { ...current } : null;
  }

  function isActive() {
    return Boolean(current && ['queued', 'running'].includes(current.status));
  }

  function start({ title, templateId, total }, runner) {
    if (isActive()) {
      const error = new Error('已有整册生成任务正在运行');
      error.code = 'BUSY';
      throw error;
    }

    const now = new Date().toISOString();
    current = {
      id: crypto.randomUUID(),
      title: title || '',
      templateId: templateId || null,
      status: 'queued',
      total: Math.max(0, Number(total) || 0),
      completed: 0,
      message: '等待开始',
      recovered: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const id = current.id;
    try { publish({ required: true }); }
    catch (error) { current = null; throw error; }

    schedule(async () => {
      if (!current || current.id !== id) return;
      try {
        current.status = 'running';
        current.message = '正在准备页面';
        current.updatedAt = new Date().toISOString();
        publish();
        const result = await runner((completed, recovered, message) => {
          if (!current || current.id !== id) return;
          current.completed = Math.max(current.completed, Math.min(current.total, Number(completed) || 0));
          if (Array.isArray(recovered)) current.recovered = recovered.slice();
          if (message) current.message = String(message);
          current.updatedAt = new Date().toISOString();
          publish();
        });
        if (!current || current.id !== id) return;
        current.status = 'completed';
        current.completed = current.total;
        current.recovered = Array.isArray(result && result.recovered) ? result.recovered : current.recovered;
        current.result = result || null;
        current.error = null;
      } catch (error) {
        if (!current || current.id !== id) return;
        current.status = 'failed';
        current.error = error && error.message ? error.message : String(error || '生成失败');
      } finally {
        if (current && current.id === id) {
          current.updatedAt = new Date().toISOString();
          publish();
        }
      }
    });
    return get();
  }

  return { get, isActive, start };
}

module.exports = { createGenerationJobs };
