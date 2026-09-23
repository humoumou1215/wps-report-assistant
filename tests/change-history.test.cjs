const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function fixture(records) {
  const elements = new Map(), requests = [], detailBox = { innerHTML: '' };
  const detailButton = { dataset: { renderDetail: 'r1' }, onclick: null };
  const recoveryButton = { dataset: { renderRecover: 'interrupted' }, onclick: null };
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, disabled: false, textContent: '', innerHTML: '', className: '', classList: { toggle() {} } });
    return elements.get(id);
  };
  const buttons = selector => selector === '[data-render-detail]'
    ? [detailButton]
    : selector === '[data-render-recover]'
      ? [recoveryButton]
      : [];
  const context = {
    console,
    confirm: () => true,
    document: {
      querySelector: selector => selector.startsWith('[data-render-detail-box=') ? detailBox : element(selector),
      querySelectorAll: buttons,
    },
  };
  context.window = context;
  context.RAChangeState = { content: value => value && value.kind === 'text' ? value.text.text : '' };
  context.RA = {
    $: element,
    $$: buttons,
    esc: value => String(value == null ? '' : value).replace(/</g, '&lt;'),
    toast() {},
    api: async (url, options) => {
      requests.push({ url, options });
      if (!options) return url.endsWith('/r1')
        ? { record: { beforeSnapshot: { kind: 'text', text: { text: 'before' } }, actualAfterSnapshot: { kind: 'text', text: { text: 'after' } }, programVerification: { ok: true }, agentVerification: { ok: true } } }
        : { records };
      if (url.endsWith('/undo')) return { record: { id: 'undo', status: 'verified' } };
      if (url.endsWith('/recover')) return { record: { id: 'recovery', status: 'verified' } };
      throw new Error('Unexpected write route ' + url);
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../addins/wpp/change-history.js'), 'utf8'), context);
  const manager = context.createChangeHistory({
    context: () => ({ projectId: 'p1', documentId: 'd1', documentKey: 'doc.xlsx' }),
    refresh: async () => {},
    showHistory() {},
  });
  return { manager, requests, detailBox, elements, detailButton, recoveryButton };
}

test('timeline only queries records and undo delegates to the server Gateway', async () => {
  const record = { id: 'r1', projectId: 'p1', documentId: 'd1', status: 'verified', createdAt: new Date().toISOString(), target: { label: 'Table 1' }, forwardPlan: { kind: 'text', text: 'updated' }, variableIds: ['v1'] };
  const f = fixture([record]);
  await f.manager.load();
  await f.manager.undoLatest();
  assert.ok(f.requests.some(request => request.url.endsWith('/render-records?documentId=d1')));
  assert.ok(f.requests.some(request => request.url.endsWith('/r1/undo') && request.options.method === 'POST'));
  assert.equal(f.requests.some(request => request.url.endsWith('/render-records') && request.options), false);
});

test('timeline detail displays stored Before and actual After evidence', async () => {
  const record = { id: 'r1', projectId: 'p1', documentId: 'd1', status: 'verified', createdAt: new Date().toISOString(), target: { label: 'Table 1' }, forwardPlan: { kind: 'text', text: 'updated' }, variableIds: ['v1'] };
  const f = fixture([record]);
  await f.manager.load();
  await f.detailButton.onclick();
  assert.match(f.detailBox.innerHTML, /before/);
  assert.match(f.detailBox.innerHTML, /after/);
});

test('recovery requires explicit confirmation and calls the recovery endpoint', async () => {
  const f = fixture([]);
  await f.manager.load();
  await f.recoveryButton.onclick();
  assert.ok(f.requests.some(request => request.url.endsWith('/interrupted/recover') && request.options.body.confirm === true));
});
