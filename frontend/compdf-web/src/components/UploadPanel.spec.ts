// @vitest-environment happy-dom

import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchApi, type BatchInfo, type BatchItemInfo } from '@/api/batch';
import { apiClient } from '@/api/client';
import { resolveTool, resolveConversionTypes, type Endpoint } from '@/config/convert-map';
import { defaultStampParameter } from '@/config/stamp-schema';
import type { UploadParameter } from '@/config/param-schema';
import en from '@/i18n/locales/en.json';
import { nameSplitOutputs, saveBlob, zipFiles } from '@/utils/result-archive';
import UploadPanel from './UploadPanel.vue';

// Keep the real request builders, error translation, and filename parsing.
vi.mock('@/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  apiClient: { post: vi.fn() },
}));
vi.mock('@/api/batch', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/batch')>(),
  batchApi: {
    create: vi.fn(), upload: vi.fn(), submit: vi.fn(), status: vi.fn(),
    retry: vi.fn(), downloadItem: vi.fn(), archive: vi.fn(),
  },
}));
vi.mock('@/utils/result-archive', () => ({ saveBlob: vi.fn(), zipFiles: vi.fn(), nameSplitOutputs: vi.fn() }));
// The shell owns orchestration. Child rendering, PDF workers and parameter UI
// are deliberately outside this suite; model events still use their real names.
vi.mock('./ParamForm.vue', () => ({
  default: {
    name: 'ParamForm',
    props: ['parameter', 'password', 'converting', 'files', 'iccProfileFile'],
    emits: ['update:parameter', 'update:password', 'update:iccProfileFile'],
    template: '<div />',
  },
}));

const wrappers: VueWrapper[] = [];
const batchId = 'batch-1';

function pdf(name: string) {
  return new File(['%PDF-1.7\nmock PDF bytes'], name, { type: 'application/pdf', lastModified: 1 });
}

function item(name: string, status: BatchItemInfo['status'], extra: Partial<BatchItemInfo> = {}): BatchItemInfo {
  return {
    itemId: `item-${name}`, sourceName: name, sourceSize: 24,
    sequenceNo: 1, status, attemptCount: 1, ...extra,
  };
}

function batch(status: BatchInfo['status'], items: BatchItemInfo[] = []): BatchInfo {
  return {
    batchId, kind: 'pdf', op: 'rotate', status, items, totalCount: items.length,
    queuedCount: items.filter((entry) => entry.status === 'queued').length,
    processingCount: items.filter((entry) => entry.status === 'processing').length,
    successCount: items.filter((entry) => entry.status === 'success').length,
    failedCount: items.filter((entry) => entry.status === 'failed').length,
    canceledCount: items.filter((entry) => entry.status === 'canceled').length,
  };
}

function response(data: Blob, filename: string): AxiosResponse<Blob> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders({ 'content-disposition': `attachment; filename="${filename}"` }),
    config: { headers: new AxiosHeaders() },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mountPanel(props: Partial<InstanceType<typeof UploadPanel>['$props']> = {}) {
  const wrapper = shallowMount(UploadPanel, {
    props: {
      fromType: 'pdf', toType: 'rotate', mode: 'multiple', accept: '.pdf',
      toolSlug: 'rotate', endpoint: { kind: 'pdf', op: 'rotate' }, ...props,
    },
    global: {
      renderStubDefaultSlot: true,
      stubs: {
        TooltipProvider: { inheritAttrs: false, template: '<slot />' },
        Tooltip: { inheritAttrs: false, template: '<slot />' },
        TooltipTrigger: { inheritAttrs: false, template: '<slot />' },
        TooltipContent: { template: '<span hidden><slot /></span>' },
      },
      // flatJson expands messages in place, so never hand it the imported fixture.
      plugins: [createI18n({ legacy: false, locale: 'en', flatJson: true, messages: { en: { ...en } } })],
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

async function pickFiles(wrapper: VueWrapper, files: File[], selector = 'input[name="files"]') {
  const input = wrapper.get(selector);
  Object.defineProperty(input.element, 'files', { configurable: true, value: files });
  await input.trigger('change');
  await flushPromises();
}

function rowFor(wrapper: VueWrapper, name: string) {
  const row = wrapper.findAll('tbody tr').find((entry) => entry.get('.file-name').text() === name);
  expect(row, `Expected a visible row for ${name}`).toBeDefined();
  return row!;
}

function hasRow(wrapper: VueWrapper, name: string): boolean {
  return wrapper.findAll('tbody tr').some((entry) => entry.get('.file-name').text() === name);
}

async function setPassword(wrapper: VueWrapper, name: string, password: string) {
  await rowFor(wrapper, name).get('input[type="password"]').setValue(password);
  await flushPromises();
}

async function setParameters(wrapper: VueWrapper, patch: Partial<UploadParameter>) {
  const form = wrapper.getComponent({ name: 'ParamForm' });
  form.vm.$emit('update:parameter', { ...form.props('parameter'), ...patch });
  await flushPromises();
}

async function start(wrapper: VueWrapper) {
  const button = wrapper.get('.start-button');
  expect(button.attributes('disabled')).toBeUndefined();
  await button.trigger('click');
  await flushPromises();
}

function buttonWithText(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('button').find((entry) => entry.text() === text);
  expect(button, `Expected button: ${text}`).toBeDefined();
  return button!;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(batchApi.create).mockResolvedValue(batch('draft'));
  vi.mocked(batchApi.upload).mockImplementation(async (_id, file) => item(file.name, 'uploaded'));
  vi.mocked(batchApi.submit).mockResolvedValue(batch('queued'));
  vi.mocked(batchApi.status).mockResolvedValue(batch('success'));
  vi.mocked(batchApi.retry).mockResolvedValue(batch('queued'));
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('UploadPanel batch requests and results', () => {
  const cases: { name: string; toType: string; endpoint: Endpoint; field: 'request' | 'options' }[] = [
    { name: 'PDF edits', toType: 'rotate', endpoint: { kind: 'pdf', op: 'rotate' }, field: 'request' },
    { name: 'conversions', toType: 'docx', endpoint: { kind: 'convert-target', target: 'docx' }, field: 'options' },
  ];

  it.each(cases)('adds files and starts $name on HTTP without crypto.randomUUID', async ({ toType, endpoint }) => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const wrapper = mountPanel({ toType, endpoint, toolSlug: toType === 'docx' ? 'pdf-to-word' : 'rotate' });
    const file = pdf('http-upload.pdf');
    vi.mocked(batchApi.status).mockResolvedValue(batch('success', [
      item(file.name, 'success', { outputName: `http-upload.${toType === 'docx' ? 'docx' : 'pdf'}` }),
    ]));

    await pickFiles(wrapper, [file]);
    expect(rowFor(wrapper, file.name).get('.file-name').text()).toBe(file.name);

    await start(wrapper);

    expect(batchApi.create).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    }));
    expect(batchApi.upload).toHaveBeenCalledWith(batchId, file, '');
    expect(rowFor(wrapper, file.name).text()).toContain(en['batchTools.processed']);
  });

  it.each(cases)('uploads individual passwords and excludes credentials/generated filenames from shared $name', async ({ toType, endpoint, field }) => {
    const wrapper = mountPanel({ toType, endpoint, toolSlug: toType === 'docx' ? 'pdf-to-word' : 'rotate' });
    const first = pdf('first.pdf');
    const second = pdf('second.pdf');
    await pickFiles(wrapper, [first, second]);
    await setParameters(wrapper, { pageRanges: '1-2', rotateAngle: '180' });
    wrapper.getComponent({ name: 'ParamForm' }).vm.$emit('update:password', 'legacy-global-password');
    await setPassword(wrapper, first.name, 'first-password');
    await setPassword(wrapper, second.name, 'second-password');
    vi.mocked(batchApi.status).mockResolvedValue(batch('success', [
      item(first.name, 'success', { outputName: 'first-result.pdf' }),
      item(second.name, 'success', { outputName: 'second-result.pdf' }),
    ]));

    await start(wrapper);

    expect(batchApi.create).toHaveBeenCalledTimes(1);
    const create = vi.mocked(batchApi.create).mock.calls[0]![0];
    expect(create).toMatchObject({
      kind: endpoint.kind === 'pdf' ? 'pdf' : 'conversion',
      op: endpoint.kind === 'pdf' ? 'rotate' : 'convert',
      idempotencyKey: expect.any(String),
      [field]: { pageRanges: '1-2', ...(field === 'request' ? { angle: 180 } : {}) },
    });
    expect(create[field]).not.toHaveProperty('password');
    expect(create[field]).not.toHaveProperty('passwords');
    expect(create[field]).not.toHaveProperty('outputFileName');
    expect(create[field]).not.toHaveProperty('zipFileName');
    expect(JSON.stringify(create)).not.toContain('first-password');
    expect(JSON.stringify(create)).not.toContain('second-password');
    expect(JSON.stringify(create)).not.toContain('legacy-global-password');
    expect(batchApi.upload).toHaveBeenCalledTimes(2);
    expect(batchApi.upload).toHaveBeenNthCalledWith(1, batchId, first, 'first-password');
    expect(batchApi.upload).toHaveBeenNthCalledWith(2, batchId, second, 'second-password');
    expect(batchApi.submit).toHaveBeenCalledTimes(1);
    expect(batchApi.submit).toHaveBeenCalledWith(batchId);
    expect(batchApi.status).toHaveBeenCalledTimes(1);
    expect(batchApi.status).toHaveBeenCalledWith(batchId);
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(rowFor(wrapper, first.name).text()).toContain(en['batchTools.processed']);
    expect(rowFor(wrapper, second.name).text()).toContain(en['batchTools.processed']);
  });

  it('preserves successful downloads while retrying only the failed item with its original settings and password', async () => {
    const wrapper = mountPanel();
    const first = pdf('success.pdf');
    const second = pdf('failure.pdf');
    const output = new Blob(['successful PDF output'], { type: 'application/pdf' });
    const success = item(first.name, 'success', { outputName: 'success-rotated.pdf' });
    const failed = item(second.name, 'failed', { failureReason: 'SDK processing failed' });
    vi.mocked(batchApi.status).mockResolvedValueOnce(batch('partial_success', [success, failed]));
    vi.mocked(batchApi.downloadItem).mockResolvedValue(response(output, success.outputName!));
    await pickFiles(wrapper, [first, second]);
    await setParameters(wrapper, { rotateAngle: '180', pageRanges: '1-2' });
    await setPassword(wrapper, first.name, 'successful-password');
    await setPassword(wrapper, second.name, 'failed-password');
    await start(wrapper);
    const originalRequest = structuredClone(vi.mocked(batchApi.create).mock.calls[0]![0]);

    expect(rowFor(wrapper, second.name).text()).toContain('SDK processing failed');
    expect(wrapper.getComponent({ name: 'ParamForm' }).props('converting')).toBe(true);
    expect(rowFor(wrapper, first.name).get('input[type="password"]').attributes('disabled')).toBeDefined();
    await rowFor(wrapper, first.name).get(`button[aria-label="${en['batchTools.download']}"]`).trigger('click');
    await flushPromises();
    expect(saveBlob).toHaveBeenLastCalledWith(output, 'success-rotated.pdf');

    const retry = deferred<BatchInfo>();
    vi.mocked(batchApi.retry).mockReturnValueOnce(retry.promise);
    vi.mocked(batchApi.status).mockResolvedValueOnce(batch('success', [
      success, item(second.name, 'success', { outputName: 'failure-rotated.pdf', attemptCount: 2 }),
    ]));
    await wrapper.get('.start-button').trigger('click');
    await flushPromises();
    expect(batchApi.retry).toHaveBeenCalledTimes(1);
    expect(batchApi.retry).toHaveBeenCalledWith(failed.itemId, { password: 'failed-password' });
    expect(rowFor(wrapper, first.name).text()).toContain(en['batchTools.processed']);
    expect(rowFor(wrapper, first.name).find(`button[aria-label="${en['batchTools.download']}"]`).exists()).toBe(true);

    retry.resolve(batch('queued'));
    await flushPromises();
    expect(batchApi.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(batchApi.create).mock.calls[0]![0]).toEqual(originalRequest);
    expect(originalRequest.request).toMatchObject({ angle: 180, pageRanges: '1-2' });
    expect(batchApi.upload).toHaveBeenCalledTimes(2);
    expect(batchApi.submit).toHaveBeenCalledTimes(1);
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(rowFor(wrapper, first.name).text()).toContain(en['batchTools.processed']);
    expect(rowFor(wrapper, second.name).text()).toContain(en['batchTools.processed']);
    await rowFor(wrapper, first.name).get(`button[aria-label="${en['batchTools.download']}"]`).trigger('click');
    await flushPromises();
    expect(saveBlob).toHaveBeenLastCalledWith(output, 'success-rotated.pdf');
    expect(vi.mocked(batchApi.downloadItem).mock.calls).toEqual([[success.itemId], [success.itemId]]);
  });

  it('allows correcting only the failed file password before an item retry', async () => {
    const wrapper = mountPanel();
    const first = pdf('unlocked.pdf');
    const second = pdf('locked.pdf');
    const success = item(first.name, 'success', { outputName: 'unlocked-result.pdf' });
    const failed = item(second.name, 'failed', { failureCode: 'INVALID_PASSWORD', failureReason: 'Wrong password' });
    vi.mocked(batchApi.status).mockResolvedValueOnce(batch('partial_success', [success, failed]));
    await pickFiles(wrapper, [first, second]);
    await setPassword(wrapper, second.name, 'wrong-password');
    await start(wrapper);
    await setPassword(wrapper, second.name, 'correct-password');
    vi.mocked(batchApi.status).mockResolvedValueOnce(batch('success', [success, item(second.name, 'success')]));

    await rowFor(wrapper, second.name).get(`button[aria-label="${en['batchTools.retry']}"]`).trigger('click');
    await flushPromises();

    expect(batchApi.retry).toHaveBeenCalledTimes(1);
    expect(batchApi.retry).toHaveBeenCalledWith(failed.itemId, { password: 'correct-password' });
    expect(batchApi.create).toHaveBeenCalledTimes(1);
    expect(batchApi.upload).toHaveBeenCalledTimes(2);
    expect(rowFor(wrapper, first.name).text()).toContain(en['batchTools.processed']);
  });
});

describe('UploadPanel retry regressions', () => {
  it('reconciles an accepted remote retry after its response is lost, without submitting another retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const wrapper = mountPanel();
    const first = pdf('already-successful.pdf');
    const second = pdf('retry-response-lost.pdf');
    const success = item(first.name, 'success', { outputName: 'preserved.pdf' });
    vi.mocked(batchApi.status)
      .mockResolvedValueOnce(batch('partial_success', [success, item(second.name, 'failed', { failureReason: 'Initial failure' })]))
      .mockResolvedValueOnce(batch('processing', [success, item(second.name, 'processing', { attemptCount: 2 })]))
      .mockResolvedValueOnce(batch('success', [success, item(second.name, 'success', { attemptCount: 2, outputName: 'recovered.pdf' })]));
    await pickFiles(wrapper, [first, second]);
    await setPassword(wrapper, second.name, 'retry-password');
    await start(wrapper);
    vi.mocked(batchApi.retry).mockRejectedValueOnce(new Error('Network Error: response lost'));

    await wrapper.get('.start-button').trigger('click');
    await flushPromises();

    expect(batchApi.retry).toHaveBeenCalledTimes(1);
    expect(batchApi.retry).toHaveBeenCalledWith(`item-${second.name}`, { password: 'retry-password' });
    expect(batchApi.status).toHaveBeenCalledTimes(2);
    expect(rowFor(wrapper, second.name).get('.status-badge').classes()).toContain('processing');
    expect(rowFor(wrapper, first.name).text()).toContain(en['batchTools.processed']);
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(batchApi.status).toHaveBeenCalledTimes(3);
    expect(vi.mocked(batchApi.status).mock.calls).toEqual([[batchId], [batchId], [batchId]]);
    expect(batchApi.retry).toHaveBeenCalledTimes(1);
    expect(batchApi.create).toHaveBeenCalledTimes(1);
    expect(batchApi.upload).toHaveBeenCalledTimes(2);
    expect(batchApi.submit).toHaveBeenCalledTimes(1);
    expect(rowFor(wrapper, second.name).text()).toContain(en['batchTools.processed']);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('retries merge using the original valid inputs and stored request when the first row is invalid', async () => {
    const wrapper = mountPanel({ toType: 'merge', toolSlug: 'merge', endpoint: { kind: 'pdf', op: 'merge' } });
    const invalid = new File(['unsupported'], 'invalid-first.txt');
    const first = pdf('first-valid.pdf');
    const second = pdf('second-valid.pdf');
    await pickFiles(wrapper, [invalid, first, second]);
    await rowFor(wrapper, first.name).get('.file-page-range').setValue('1');
    await rowFor(wrapper, second.name).get('.file-page-range').setValue('2-3');
    await setPassword(wrapper, first.name, 'first-merge-password');
    await setPassword(wrapper, second.name, 'second-merge-password');
    vi.mocked(apiClient.post)
      .mockRejectedValueOnce(new Error('Temporary merge failure'))
      .mockResolvedValueOnce(response(new Blob(['merged output']), 'merged-case.pdf'));
    await start(wrapper);

    expect(hasRow(wrapper, invalid.name)).toBe(false);
    expect(rowFor(wrapper, first.name).text()).toContain(en['batchTools.processingFailed']);
    await wrapper.get('.start-button').trigger('click');
    await flushPromises();

    expect(apiClient.post).toHaveBeenCalledTimes(2);
    for (const [url, data] of vi.mocked(apiClient.post).mock.calls) {
      expect(url).toBe('/process/pdf/merge');
      const form = data as FormData;
      expect(form.getAll('files').map((file) => (file as File).name)).toEqual([first.name, second.name]);
      expect(JSON.parse(form.get('request') as string)).toEqual({
        pageRanges: ['1', '2-3'], outputFileName: 'first-valid.pdf',
        passwords: ['first-merge-password', 'second-merge-password'],
      });
    }
    expect(rowFor(wrapper, first.name).text()).toContain(en['batchTools.processed']);
    expect(rowFor(wrapper, second.name).text()).toContain(en['batchTools.processed']);
    expect(hasRow(wrapper, invalid.name)).toBe(false);
    expect(batchApi.create).not.toHaveBeenCalled();
    expect(batchApi.retry).not.toHaveBeenCalled();
  });
});

describe('PDF decoration backend integration', () => {
  const cases = [
    ['add-headers-footers', 'headers-footers/add'],
    ['remove-headers-footers', 'headers-footers/remove'],
    ['add-bates', 'bates/add'],
    ['remove-bates', 'bates/remove'],
  ] as const;

  it.each(cases)('%s uses its catalog endpoint through upload, retry and download', async (slug, op) => {
    const tool = resolveTool(slug)!;
    const wrapper = mountPanel({ ...resolveConversionTypes(tool), toolSlug: slug, endpoint: tool.endpoint, accept: tool.accept });
    const first = pdf('first.pdf');
    const second = pdf('second.pdf');
    Object.defineProperty(first, 'webkitRelativePath', { value: 'case/nested/first.pdf' });
    await pickFiles(wrapper, [first, second], 'input[name="folder"]');
    if (op.endsWith('/add')) {
      const form = wrapper.getComponent({ name: 'StampSettings' });
      const value = defaultStampParameter(op.startsWith('bates') ? 'bates' : 'headers-footers');
      Object.assign(value, { pageRange: 'custom', customPages: '1、3', pageOffset: 5, prefix: 'CASE-', suffix: '-A' });
      value.regions.bottomCenter = 'Page <<1>>';
      form.vm.$emit('update:modelValue', value);
      await flushPromises();
    }
    await setPassword(wrapper, first.name, 'first-password');
    await setPassword(wrapper, second.name, 'incorrect-password');
    vi.mocked(batchApi.status).mockResolvedValueOnce(batch('partial_success', [
      item(first.name, 'success', { outputName: 'first-result.pdf' }),
      item(second.name, 'failed', { failureCode: '120002', failureReason: 'Incorrect password' }),
    ]));
    await start(wrapper);

    const create = vi.mocked(batchApi.create).mock.calls[0]![0];
    expect(create).toMatchObject({ kind: 'pdf', op, idempotencyKey: expect.any(String) });
    expect(create.request).not.toHaveProperty('password');
    if (op.endsWith('/remove')) {
      expect(create.request).toEqual({});
      expect(wrapper.findComponent({ name: 'ParamForm' }).exists()).toBe(false);
    } else {
      expect(create.request).toMatchObject({ pages: '1,3', fontName: 'Helvetica', fontSize: 12, textColor: '#000000' });
      expect((create.request!.margin as { top: number }).top).toBeCloseTo(30 * 72 / 25.4);
      if (op === 'headers-footers/add') expect(create.request).toMatchObject({ regions: { bottomCenter: 'Page <<1>>' }, pageOffset: 5, rules: 2 });
      else {
        expect(create.request).toMatchObject({ position: 'bottomRight', startNumber: 1, digits: 6, prefix: 'CASE-', suffix: '-A', pageOffset: 0 });
        expect(create.options).toEqual({ numberingMode: 'per-file' });
      }
    }
    expect(batchApi.upload).toHaveBeenNthCalledWith(1, batchId, first, 'first-password', 'case/nested/first.pdf');
    expect(batchApi.upload).toHaveBeenNthCalledWith(2, batchId, second, 'incorrect-password');
    expect(batchApi.submit).toHaveBeenCalledWith(batchId);
    expect(rowFor(wrapper, second.name).text()).toContain(en['pdfToolDetail.upload.errors.apiCodes.invalidPassword']);

    await setPassword(wrapper, second.name, 'correct-password');
    vi.mocked(batchApi.status).mockResolvedValueOnce(batch('success', [
      item(first.name, 'success'), item(second.name, 'success', { outputName: 'second-result.pdf' }),
    ]));
    await rowFor(wrapper, second.name).get(`button[aria-label="${en['batchTools.retry']}"]`).trigger('click');
    await flushPromises();
    expect(batchApi.retry).toHaveBeenCalledWith(`item-${second.name}`, { password: 'correct-password' });
    expect(batchApi.create).toHaveBeenCalledTimes(1);
    expect(batchApi.upload).toHaveBeenCalledTimes(2);
    const output = new Blob(['%PDF result'], { type: 'application/pdf' });
    vi.mocked(batchApi.downloadItem).mockResolvedValueOnce(response(output, 'second-result.pdf'));
    await rowFor(wrapper, second.name).get(`button[aria-label="${en['batchTools.download']}"]`).trigger('click');
    await flushPromises();
    expect(saveBlob).toHaveBeenCalledWith(output, 'second-result.pdf');
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

describe('per-file page ranges', () => {
  it('keeps merge ranges attached to files when reordered and snapshots them for retry', async () => {
    const wrapper = mountPanel({ toType: 'merge', toolSlug: 'merge', endpoint: { kind: 'pdf', op: 'merge' } });
    const first = pdf('first.pdf');
    const second = pdf('second.pdf');
    await pickFiles(wrapper, [first, second]);
    expect(wrapper.find('.settings').exists()).toBe(false);
    expect(wrapper.get('.workspace-grid').classes()).toContain('without-settings');
    await rowFor(wrapper, first.name).get('.file-page-range').setValue('1、3-5');
    await rowFor(wrapper, second.name).get('.drag-handle').trigger('keydown', { key: 'ArrowUp' });
    expect(wrapper.findAll('.file-name').map((row) => row.text())).toEqual([second.name, first.name]);
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('Temporary error')).mockResolvedValueOnce(response(new Blob(['%PDF output']), 'merged.pdf'));
    await start(wrapper);
    const form = vi.mocked(apiClient.post).mock.calls[0]![1] as FormData;
    expect(form.getAll('files').map((file) => (file as File).name)).toEqual([second.name, first.name]);
    expect(JSON.parse(form.get('request') as string).pageRanges).toEqual(['all', '1,3-5']);
    expect(rowFor(wrapper, first.name).get('.file-page-range').attributes('disabled')).toBeDefined();
    await rowFor(wrapper, first.name).get(`button[aria-label="${en['batchTools.retry']}"]`).trigger('click');
    await flushPromises();
    const retry = vi.mocked(apiClient.post).mock.calls[1]![1] as FormData;
    expect(JSON.parse(retry.get('request') as string).pageRanges).toEqual(['all', '1,3-5']);
  });

  it('hides per-file downloads and saves the merged result as a PDF', async () => {
    const wrapper = mountPanel({ toType: 'merge', toolSlug: 'merge', endpoint: { kind: 'pdf', op: 'merge' } });
    const first = pdf('first.pdf');
    const second = pdf('second.pdf');
    const output = new Blob(['%PDF merged output'], { type: 'application/pdf' });
    vi.mocked(apiClient.post).mockResolvedValueOnce(response(output, 'merged.pdf'));

    await pickFiles(wrapper, [first, second]);
    await start(wrapper);

    expect(rowFor(wrapper, first.name).find(`button[aria-label="${en['batchTools.download']}"]`).exists()).toBe(false);
    expect(rowFor(wrapper, second.name).find(`button[aria-label="${en['batchTools.download']}"]`).exists()).toBe(false);
    expect(rowFor(wrapper, first.name).find(`button[aria-label="${en['batchTools.delete']}"]`).exists()).toBe(false);
    expect(rowFor(wrapper, second.name).find(`button[aria-label="${en['batchTools.delete']}"]`).exists()).toBe(false);

    await buttonWithText(wrapper, en['batchTools.downloadAll']).trigger('click');
    await flushPromises();

    expect(saveBlob).toHaveBeenCalledWith(output, 'merged.pdf');
    expect(zipFiles).not.toHaveBeenCalled();
  });

  it('rejects malformed merge ranges before sending files', async () => {
    const wrapper = mountPanel({ toType: 'merge', toolSlug: 'merge', endpoint: { kind: 'pdf', op: 'merge' } });
    await pickFiles(wrapper, [pdf('first.pdf'), pdf('second.pdf')]);
    await rowFor(wrapper, 'first.pdf').get('.file-page-range').setValue('5-1');
    expect(wrapper.get('.start-button').attributes('disabled')).toBeDefined();
    await wrapper.get('.start-button').trigger('click');
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it.each(['remove-headers-footers', 'remove-bates'])('hides the page range and defaults to whole-document removal in %s', async (slug) => {
    const tool = resolveTool(slug)!;
    const wrapper = mountPanel({ ...resolveConversionTypes(tool), toolSlug: slug, endpoint: tool.endpoint });
    await pickFiles(wrapper, [pdf('remove.pdf')]);
    expect(wrapper.find('.settings').exists()).toBe(false);
    expect(wrapper.get('.workspace-grid').classes()).toContain('without-settings');
    expect(wrapper.find('.page-range-cell').exists()).toBe(false);
    expect(wrapper.find('.file-page-range').exists()).toBe(false);
    await start(wrapper);
    expect(batchApi.create).toHaveBeenCalledWith(expect.objectContaining({ op: tool.endpoint.kind === 'pdf' ? tool.endpoint.op : '', request: {} }));
  });
});

describe('Split settings request integration', () => {
  it('sends encrypted files directly and retries backend password failures without reprocessing successes', async () => {
    const wrapper = mountPanel({ toolSlug: 'split', toType: 'split', endpoint: { kind: 'pdf', op: 'split' } });
    const good = pdf('open.pdf');
    const locked = pdf('locked.pdf');
    await pickFiles(wrapper, [good, locked]);
    expect(apiClient.post).not.toHaveBeenCalled();
    const settings = wrapper.getComponent({ name: 'SplitSettings' });
    settings.vm.$emit('update:mode', 'every');
    settings.vm.$emit('update:count', 2);
    await flushPromises();
    const passwordError = (code: number) => ({ response: { data: { type: 'pdf', code, errorCode: code === 120001 ? 'PASSWORD_REQUIRED' : 'INVALID_PASSWORD', message: 'PDF password error', traceId: 'test' } } });
    const goodResult = new Blob(['good ZIP']);
    vi.mocked(apiClient.post).mockResolvedValueOnce(response(goodResult, 'open.zip')).mockRejectedValueOnce(passwordError(120001));
    vi.mocked(nameSplitOutputs).mockResolvedValueOnce(goodResult);
    await start(wrapper);
    expect(apiClient.post).toHaveBeenCalledTimes(2);
    expect(rowFor(wrapper, good.name).text()).toContain(en['batchTools.processed']);
    expect(rowFor(wrapper, locked.name).get('.status-badge').attributes('aria-label')).toBe(en['pdfToolDetail.upload.errors.apiCodes.passwordRequired']);
    await setPassword(wrapper, locked.name, 'incorrect-password');
    expect(apiClient.post).toHaveBeenCalledTimes(2);
    vi.mocked(apiClient.post).mockRejectedValueOnce(passwordError(120002));
    await wrapper.get('.start-button').trigger('click');
    await flushPromises();
    expect(apiClient.post).toHaveBeenCalledTimes(3);
    expect(rowFor(wrapper, locked.name).get('.status-badge').attributes('aria-label')).toBe(en['pdfToolDetail.upload.errors.apiCodes.invalidPassword']);
    const input = rowFor(wrapper, locked.name).get('input[type="password"]');
    (input.element as HTMLInputElement).value = 'correct-password';
    await input.trigger('input');
    const lockedResult = new Blob(['locked ZIP']);
    vi.mocked(apiClient.post).mockResolvedValueOnce(response(lockedResult, 'locked.zip'));
    vi.mocked(nameSplitOutputs).mockResolvedValueOnce(lockedResult);
    await wrapper.get('.start-button').trigger('click');
    await flushPromises();
    expect(apiClient.post).toHaveBeenCalledTimes(4);
    const [url, body] = vi.mocked(apiClient.post).mock.calls[3]!;
    expect(url).toBe('/process/pdf/split');
    const form = body as FormData;
    expect((form.get('file') as File).name).toBe(locked.name);
    expect(JSON.parse(form.get('request') as string)).toMatchObject({ splitMode: 'every', splitCount: 2, password: 'correct-password' });
    expect(rowFor(wrapper, locked.name).text()).toContain(en['batchTools.processed']);
    expect(batchApi.create).not.toHaveBeenCalled();
    await rowFor(wrapper, good.name).get('button[aria-label="Download"]').trigger('click');
    await flushPromises();
    expect(saveBlob).toHaveBeenCalledWith(goodResult, 'open.zip');
  });

  it('puts the selected file password into the split request sent to the operation endpoint', async () => {
    const wrapper = mountPanel({ toolSlug: 'split', toType: 'split', endpoint: { kind: 'pdf', op: 'split' } });
    const file = pdf('locked-split.pdf');
    await pickFiles(wrapper, [file]);
    const password = rowFor(wrapper, file.name).get('input[type="password"]');
    await password.setValue('correct-password');
    await password.trigger('blur');
    const settings = wrapper.getComponent({ name: 'SplitSettings' });
    settings.vm.$emit('update:mode', 'custom');
    settings.vm.$emit('update:ranges', '1-2');
    await flushPromises();
    vi.mocked(apiClient.post).mockResolvedValueOnce(response(new Blob(['split-output']), 'locked-split.zip'));
    await start(wrapper);
    const [url, form] = vi.mocked(apiClient.post).mock.calls[0]!;
    expect(url).toBe('/process/pdf/split');
    expect(JSON.parse((form as FormData).get('request') as string)).toMatchObject({ password: 'correct-password' });
    expect((form as FormData).get('file')).toMatchObject({ name: file.name });
  });

  it.each([
    ['custom', '1,2-3', 1, ['1', '2-3']],
    ['every', '', 2, ['1-2', '3']],
    ['equal', '', 2, ['1-2', '3']],
  ] as const)('submits %s without requiring frontend PDF metadata', async (mode, ranges, count, expected) => {
    const wrapper = mountPanel({ toolSlug: 'split', toType: 'split', endpoint: { kind: 'pdf', op: 'split' } });
    const file = pdf('case.pdf');
    await pickFiles(wrapper, [file]);
    expect(wrapper.get('.start-button').attributes('disabled')).toBeDefined();
    const settings = wrapper.getComponent({ name: 'SplitSettings' });
    expect(settings.props()).not.toHaveProperty('pageCount');
    settings.vm.$emit('update:mode', mode);
    settings.vm.$emit('update:ranges', ranges);
    settings.vm.$emit('update:count', count);
    settings.vm.$emit('update:separator', ' ');
    await flushPromises();
    const archive = new Blob(['archive']);
    vi.mocked(apiClient.post).mockResolvedValueOnce(response(archive, 'case.zip'));
    vi.mocked(nameSplitOutputs).mockResolvedValueOnce(archive);
    await start(wrapper);
    const [url, form] = vi.mocked(apiClient.post).mock.calls[0]!;
    expect(url).toBe('/process/pdf/split');
    const payload = JSON.parse((form as FormData).get('request') as string);
    if (mode === 'custom') expect(payload.ranges).toEqual(expected);
    else { expect(payload).toMatchObject({ splitMode: mode, splitCount: count }); expect(payload).not.toHaveProperty('ranges'); }
    expect(nameSplitOutputs).toHaveBeenCalledWith(archive, file.name, ' ');
    expect(batchApi.create).not.toHaveBeenCalled();
    expect(settings.props('disabled')).toBe(true);
  });
});

describe('processing and completed layouts', () => {
  it('shows progress and a locked primary action until results replace it with summary cards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const wrapper = mountPanel();
    const good = pdf('good.pdf');
    const bad = pdf('bad.pdf');
    const pending = deferred<BatchInfo>();
    vi.mocked(batchApi.status)
      .mockResolvedValueOnce(batch('processing', [item(good.name, 'processing'), item(bad.name, 'queued')]))
      .mockReturnValueOnce(pending.promise);
    await pickFiles(wrapper, [good, bad]);
    await start(wrapper);
    expect(wrapper.find('.progress-panel').exists()).toBe(true);
    expect(wrapper.find('.result-summary').exists()).toBe(false);
    expect(wrapper.find('.result-actions').exists()).toBe(false);
    expect(wrapper.get('.start-button').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.add-menu summary').attributes('aria-disabled')).toBe('true');
    expect(wrapper.get('.settings').classes()).toContain('settings-locked');
    await vi.advanceTimersByTimeAsync(1000);
    pending.resolve(batch('partial_success', [item(good.name, 'success'), item(bad.name, 'failed', { failureReason: 'Invalid password' })]));
    await flushPromises();
    expect(wrapper.find('.progress-panel').exists()).toBe(false);
    expect(wrapper.findAll('.summary-card strong').map((node) => node.text())).toEqual(['2', '1', '1']);
    expect(wrapper.get('.result-actions').text()).toContain(en['batchTools.downloadAll']);
    expect(wrapper.get('.result-actions').text()).toContain(en['batchTools.resetParameters']);
    expect(wrapper.findAll('.main-actions button')).toHaveLength(1);
    expect(wrapper.get('.start-button').attributes('disabled')).toBeUndefined();
    expect(rowFor(wrapper, bad.name).find('.name-cell .error').exists()).toBe(false);
    expect(rowFor(wrapper, bad.name).get('.status-badge').attributes('aria-label')).toBe('Invalid password');
    expect(wrapper.get('.add-menu summary').attributes('aria-disabled')).toBe('false');
  });
});

describe('UploadPanel download races', () => {
  it('locks destructive actions and archives the original success snapshot while retry polling updates rows', async () => {
    const wrapper = mountPanel();
    const first = pdf('first.pdf');
    const second = pdf('second.pdf');
    const failed = pdf('failed.pdf');
    const firstOutput = new Blob(['first output']);
    const secondOutput = new Blob(['second output']);
    const archive = new Blob(['mock ZIP'], { type: 'application/zip' });
    vi.mocked(batchApi.status).mockResolvedValueOnce(batch('partial_success', [
      item(first.name, 'success', { outputName: 'first-original.pdf' }),
      item(second.name, 'success', { outputName: 'second-original.pdf' }),
      item(failed.name, 'failed', { failureReason: 'Temporary failure' }),
    ]));
    await pickFiles(wrapper, [first, second, failed]);
    await start(wrapper);
    const firstDownload = deferred<AxiosResponse<Blob>>();
    vi.mocked(batchApi.downloadItem)
      .mockReturnValueOnce(firstDownload.promise)
      .mockResolvedValueOnce(response(secondOutput, 'second-original.pdf'));
    vi.mocked(zipFiles).mockResolvedValueOnce(archive);

    await buttonWithText(wrapper, en['batchTools.downloadAll']).trigger('click');
    await flushPromises();
    expect(batchApi.downloadItem).toHaveBeenCalledTimes(1);
    const blocked = [
      buttonWithText(wrapper, en['batchTools.resetParameters']),
      buttonWithText(wrapper, en['batchTools.clearList']),
      rowFor(wrapper, first.name).get(`button[aria-label="${en['batchTools.delete']}"]`),
    ];
    for (const button of blocked) {
      expect(button.attributes('disabled')).toBeDefined();
      await button.trigger('click');
    }
    expect(wrapper.findAll('tbody tr')).toHaveLength(3);
    expect(wrapper.get('.start-button').attributes('disabled')).toBeDefined();

    // Retrying a failed item can legitimately refresh all rows while a download
    // awaits bytes. A new success and changed output names must not alter this ZIP.
    vi.mocked(batchApi.status).mockResolvedValueOnce(batch('success', [
      item(first.name, 'success', { outputName: 'first-refreshed.pdf' }),
      item(second.name, 'success', { outputName: 'second-refreshed.pdf' }),
      item(failed.name, 'success', { outputName: 'new-success.pdf', attemptCount: 2 }),
    ]));
    await rowFor(wrapper, failed.name).get(`button[aria-label="${en['batchTools.retry']}"]`).trigger('click');
    await flushPromises();
    expect(rowFor(wrapper, failed.name).text()).toContain(en['batchTools.processed']);
    firstDownload.resolve(response(firstOutput, 'first-original.pdf'));
    await flushPromises();

    expect(vi.mocked(batchApi.downloadItem).mock.calls).toEqual([[`item-${first.name}`], [`item-${second.name}`]]);
    expect(zipFiles).toHaveBeenCalledTimes(1);
    expect(vi.mocked(zipFiles).mock.calls[0]![0]).toEqual({
      'first-original.pdf': new Uint8Array(await firstOutput.arrayBuffer()),
      'second-original.pdf': new Uint8Array(await secondOutput.arrayBuffer()),
    });
    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(saveBlob).toHaveBeenCalledWith(archive, 'rotate-results.zip');
    expect(buttonWithText(wrapper, en['batchTools.resetParameters']).attributes('disabled')).toBeUndefined();
    expect(buttonWithText(wrapper, en['batchTools.clearList']).attributes('disabled')).toBeUndefined();
  });

  it.each(['single', 'archive-files', 'archive-zip'] as const)('does not save %s downloads that finish after unmount', async (stage) => {
    const wrapper = mountPanel();
    const first = pdf('unmount-first.pdf');
    const second = pdf('unmount-second.pdf');
    vi.mocked(batchApi.status).mockResolvedValueOnce(batch('success', [
      item(first.name, 'success', { outputName: 'first-output.pdf' }),
      item(second.name, 'success', { outputName: 'second-output.pdf' }),
    ]));
    await pickFiles(wrapper, [first, second]);
    await start(wrapper);
    const download = deferred<AxiosResponse<Blob>>();
    const zip = deferred<Blob>();
    const output = new Blob(['output bytes']);
    vi.mocked(zipFiles).mockReturnValueOnce(zip.promise);
    if (stage === 'archive-zip') vi.mocked(batchApi.downloadItem).mockResolvedValue(response(output, 'output.pdf'));
    else vi.mocked(batchApi.downloadItem).mockReturnValueOnce(download.promise);

    if (stage === 'single') {
      await rowFor(wrapper, first.name).get(`button[aria-label="${en['batchTools.download']}"]`).trigger('click');
    } else {
      await buttonWithText(wrapper, en['batchTools.downloadAll']).trigger('click');
    }
    await flushPromises();
    expect(batchApi.downloadItem).toHaveBeenCalledTimes(stage === 'archive-zip' ? 2 : 1);
    expect(zipFiles).toHaveBeenCalledTimes(stage === 'archive-zip' ? 1 : 0);
    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    download.resolve(response(output, 'output.pdf'));
    zip.resolve(new Blob(['archive bytes']));
    await flushPromises();

    expect(saveBlob).not.toHaveBeenCalled();
    expect(batchApi.downloadItem).toHaveBeenCalledTimes(stage === 'archive-zip' ? 2 : 1);
    expect(zipFiles).toHaveBeenCalledTimes(stage === 'archive-zip' ? 1 : 0);
  });
});

describe('UploadPanel polling lifecycle', () => {
  it('clears scheduled polling when a route unmounts the panel', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const wrapper = mountPanel();
    const file = pdf('polling.pdf');
    vi.mocked(batchApi.status).mockResolvedValue(batch('processing', [item(file.name, 'processing')]));
    await pickFiles(wrapper, [file]);
    await start(wrapper);
    expect(batchApi.status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(batchApi.status).toHaveBeenCalledTimes(2);

    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    await vi.advanceTimersByTimeAsync(10000);
    await flushPromises();

    expect(batchApi.status).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(batchApi.create).toHaveBeenCalledTimes(1);
  });

  it('does not schedule another poll when an in-flight status request resolves after unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred<BatchInfo>();
    vi.mocked(batchApi.status).mockReturnValueOnce(pending.promise);
    const wrapper = mountPanel();
    const file = pdf('in-flight.pdf');
    await pickFiles(wrapper, [file]);
    await start(wrapper);
    expect(batchApi.status).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    pending.resolve(batch('processing', [item(file.name, 'processing')]));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10000);

    expect(batchApi.status).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('settings validation timing', () => {
  it('hides required encryption errors on upload but keeps invalid submission disabled', async () => {
    const wrapper = mountPanel({ toType: 'encrypt', toolSlug: 'encrypt', endpoint: { kind: 'pdf', op: 'encrypt' } });
    await pickFiles(wrapper, [pdf('source.pdf')]);
    expect(wrapper.find('.settings > .error').exists()).toBe(false);
    expect(wrapper.get('.start-button').attributes('disabled')).toBeDefined();
    await wrapper.get('.start-button').trigger('click');
    expect(apiClient.post).not.toHaveBeenCalled();
    await setParameters(wrapper, { encryptUserPassword: 'secret' });
    await wrapper.get('.settings > fieldset').trigger('input');
    expect(wrapper.get('.start-button').attributes('disabled')).toBeUndefined();
    await setParameters(wrapper, { encryptUserPassword: '' });
    await wrapper.get('.settings > fieldset').trigger('input');
    expect(wrapper.get('.settings > .error').text()).toBe(en['pdfToolDetail.upload.errors.encryptPasswordRequired']);
    expect(wrapper.get('.start-button').attributes('disabled')).toBeDefined();
    await buttonWithText(wrapper, en['batchTools.clearList']).trigger('click');
    await pickFiles(wrapper, [pdf('another.pdf')]);
    expect(wrapper.find('.settings > .error').exists()).toBe(false);
  });
});

describe('UploadPanel synchronous PDF/A and local file validation', () => {
  it('requires an ICC profile and sends PDF/A files individually through the synchronous endpoint', async () => {
    const wrapper = mountPanel({ toType: 'pdfa', toolSlug: 'pdf-to-pdfa', endpoint: { kind: 'pdf', op: 'pdfa' } });
    const first = pdf('first-archive.pdf');
    const second = pdf('second-archive.pdf');
    const icc = new File(['mock ICC bytes'], 'sRGB.icc', { type: 'application/vnd.iccprofile' });
    await pickFiles(wrapper, [first, second]);
    expect(wrapper.get('.start-button').attributes('disabled')).toBeDefined();
    await wrapper.get('.start-button').trigger('click');
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(batchApi.create).not.toHaveBeenCalled();
    await pickFiles(wrapper, [icc], 'input[accept=".icc,.icm"]');
    await setParameters(wrapper, { pdfStandard: 'pdfa2b', outputTitle: 'Archive', outputLanguage: 'en_US' });
    await setPassword(wrapper, first.name, 'archive-one');
    await setPassword(wrapper, second.name, 'archive-two');
    const firstOutput = new Blob(['first PDF/A'], { type: 'application/pdf' });
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce(response(firstOutput, 'first-pdfa.pdf'))
      .mockResolvedValueOnce(response(new Blob(['second PDF/A']), 'second-pdfa.pdf'));

    await start(wrapper);

    expect(batchApi.create).not.toHaveBeenCalled();
    expect(batchApi.upload).not.toHaveBeenCalled();
    expect(batchApi.status).not.toHaveBeenCalled();
    expect(apiClient.post).toHaveBeenCalledTimes(2);
    for (const [index, file] of [first, second].entries()) {
      const [url, form, config] = vi.mocked(apiClient.post).mock.calls[index]!;
      expect(url).toBe('/process/pdf/pdfa');
      expect(form).toBeInstanceOf(FormData);
      const data = form as FormData;
      expect((data.get('file') as File).name).toBe(file.name);
      expect(await (data.get('file') as File).text()).toBe(await file.text());
      expect((data.get('iccFile') as File).name).toBe('sRGB.icc');
      expect(await (data.get('iccFile') as File).text()).toBe(await icc.text());
      expect(data.has('password')).toBe(false);
      expect(JSON.parse(data.get('request') as string)).toMatchObject({
        standard: 'pdfa2b', password: index === 0 ? 'archive-one' : 'archive-two',
        uaConfig: { title: 'Archive', language: 'en_US' },
      });
      expect(config?.responseType).toBe('blob');
      expect(config?.signal?.aborted).toBe(false);
    }
    await rowFor(wrapper, first.name).get(`button[aria-label="${en['batchTools.download']}"]`).trigger('click');
    await flushPromises();
    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(saveBlob).toHaveBeenCalledWith(firstOutput, 'first-pdfa.pdf');
    expect(batchApi.downloadItem).not.toHaveBeenCalled();
  });

  it('leaves PDF validity checks to the backend while excluding unsupported and empty files', async () => {
    const wrapper = mountPanel({ toType: 'addBates', toolSlug: 'add-bates', endpoint: { kind: 'pdf', op: 'bates/add' } });
    const malformed = pdf('malformed.pdf');
    const unsupported = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const empty = new File([], 'empty.pdf', { type: 'application/pdf' });
    const valid = pdf('valid.pdf');
    await pickFiles(wrapper, [malformed, unsupported, empty, valid]);

    expect(rowFor(wrapper, malformed.name).find('.error').exists()).toBe(false);
    expect(hasRow(wrapper, unsupported.name)).toBe(false);
    expect(rowFor(wrapper, empty.name).text()).toContain(en['batchTools.emptyFile']);
    vi.mocked(batchApi.status).mockResolvedValue(batch('partial_success', [item(malformed.name, 'failed', { failureCode: 'PDF_FORMAT_ERROR', failureReason: 'Invalid PDF' }), item(valid.name, 'success', { outputName: 'valid-bates.pdf' })]));

    await start(wrapper);

    expect(batchApi.upload).toHaveBeenCalledTimes(2);
    expect(batchApi.upload).toHaveBeenCalledWith(batchId, malformed, '');
    expect(batchApi.upload).toHaveBeenCalledWith(batchId, valid, '');
    expect(batchApi.create).toHaveBeenCalledTimes(1);
    expect(batchApi.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pdf', op: 'bates/add', options: { numberingMode: 'per-file' },
      request: expect.objectContaining({ position: 'bottomRight', startNumber: 1, digits: 6 }),
    }));
    expect(rowFor(wrapper, valid.name).text()).toContain(en['batchTools.processed']);
    for (const file of [malformed, empty]) {
      expect(rowFor(wrapper, file.name).find(`button[aria-label="${en['batchTools.download']}"]`).exists()).toBe(false);
    }
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('keeps submission disabled when every selected file fails local validation', async () => {
    const wrapper = mountPanel({ toType: 'addBates', toolSlug: 'add-bates', endpoint: { kind: 'pdf', op: 'bates/add' } });
    await pickFiles(wrapper, [new File([], 'empty.pdf'), new File(['text'], 'wrong.txt')]);

    expect(wrapper.get('.start-button').attributes('disabled')).toBeDefined();
    expect(hasRow(wrapper, 'wrong.txt')).toBe(false);
    expect(wrapper.find('[role="alert"]').text()).toContain(en['batchTools.unsupportedFormat']);
    await wrapper.get('.start-button').trigger('click');
    await flushPromises();
    expect(batchApi.create).not.toHaveBeenCalled();
    expect(batchApi.upload).not.toHaveBeenCalled();
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
