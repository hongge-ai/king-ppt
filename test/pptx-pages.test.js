const test = require('node:test');
const assert = require('node:assert/strict');
const { textNodeValue } = require('../src/pptx-pages');

test('PPTX text values preserve text wrapped with XML attributes', () => {
  assert.equal(textNodeValue({ '#text': '公元前 ', '@_space': 'preserve' }), '公元前 ');
  assert.equal(textNodeValue('1164.7'), '1164.7');
  assert.equal(textNodeValue(undefined), '');
  assert.equal(textNodeValue({ '@_space': 'preserve' }), '');
});
