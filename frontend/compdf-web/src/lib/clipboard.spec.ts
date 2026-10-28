// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('clipboard compatibility', () => {
  it('uses the Clipboard API when it succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyText('test text');
    expect(writeText).toHaveBeenCalledWith('test text');
  });

  it('copies through the HTTP fallback when navigator.clipboard is absent', async () => {
    vi.stubGlobal('navigator', {});
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    await copyText('http test text');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when the Clipboard API denies access', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    await copyText('permission test text');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('rejects failed fallback copying instead of reporting success', async () => {
    vi.stubGlobal('navigator', {});
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) });
    await expect(copyText('test text')).rejects.toThrow('Clipboard unavailable');
    expect(document.querySelector('textarea')).toBeNull();
  });
});
