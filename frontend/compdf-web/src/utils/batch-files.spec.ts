// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { droppedFiles, fileValidationKey, MAX_UPLOAD_BYTES, parsePages, splitCustomRanges } from './batch-files';

function fileEntry(path: string): FileSystemFileEntry {
  const file = new File(['pdf'], path.split('/').pop()!, { type: 'application/pdf' });
  return {
    isFile: true, isDirectory: false, fullPath: path,
    file: (resolve: FileCallback) => queueMicrotask(() => resolve(file)),
  } as FileSystemFileEntry;
}

function directoryEntry(path: string, chunks: FileSystemEntry[][]) {
  let index = 0;
  const readEntries = vi.fn((resolve: FileSystemEntriesCallback) => {
    const chunk = chunks[index++] ?? [];
    queueMicrotask(() => resolve(chunk));
  });
  const createReader = vi.fn(() => ({ readEntries }));
  const entry = { isFile: false, isDirectory: true, fullPath: path, createReader } as unknown as FileSystemDirectoryEntry;
  return { entry, createReader, readEntries };
}

function transfer(items: Partial<DataTransferItem>[], files: File[] = []): DataTransfer {
  return { items, files } as unknown as DataTransfer;
}

function entryItem(entry: FileSystemEntry): Partial<DataTransferItem> {
  return { kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null };
}

describe('droppedFiles directory traversal', () => {
  it('drains every 100-entry chunk at each directory level and preserves distinct full paths', async () => {
    const rootFiles = Array.from({ length: 205 }, (_, i) => fileEntry(`/root/file-${i}.pdf`));
    const nestedFiles = Array.from({ length: 103 }, (_, i) => fileEntry(`/root/nested/file-${i}.pdf`));
    const nested = directoryEntry('/root/nested', [nestedFiles.slice(0, 100), nestedFiles.slice(100)]);
    const empty = directoryEntry('/root/empty', []);
    const root = directoryEntry('/root', [rootFiles.slice(0, 100), rootFiles.slice(100, 200), [...rootFiles.slice(200), nested.entry, empty.entry]]);

    const picked = await droppedFiles(transfer([entryItem(root.entry)]));

    expect(picked).toHaveLength(308);
    expect(picked.map(({ path }) => path)).toEqual([...rootFiles, ...nestedFiles].map((entry) => entry.fullPath.slice(1)));
    expect(picked.filter(({ file }) => file.name === 'file-0.pdf').map(({ path }) => path)).toEqual([
      'root/file-0.pdf', 'root/nested/file-0.pdf',
    ]);
    expect(root.createReader).toHaveBeenCalledTimes(1);
    expect(root.readEntries).toHaveBeenCalledTimes(4);
    expect(nested.createReader).toHaveBeenCalledTimes(1);
    expect(nested.readEntries).toHaveBeenCalledTimes(3);
    expect(empty.readEntries).toHaveBeenCalledTimes(1);
  });

  it('captures every entry and fallback file before the drag data store closes', async () => {
    let open = true;
    const guard = () => { if (!open) throw new Error('protected drag data store'); };
    const root = directoryEntry('/root', [[fileEntry('/root/a.pdf')]]);
    const loose = new File(['x'], 'loose.pdf');
    const data = transfer([
      { kind: 'file', webkitGetAsEntry: () => { guard(); return root.entry; }, getAsFile: () => { guard(); return null; } },
      { kind: 'file', webkitGetAsEntry: () => { guard(); return null; }, getAsFile: () => { guard(); return loose; } },
    ]);
    const pending = droppedFiles(data);
    open = false;
    expect((await pending).map(({ path }) => path)).toEqual(['root/a.pdf', 'loose.pdf']);
  });

  it('uses the FileList with relative paths when entry APIs are unavailable', async () => {
    const file = new File(['x'], 'a.pdf');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'folder/a.pdf' });
    expect(await droppedFiles(transfer([], [file]))).toEqual([{ file, path: 'folder/a.pdf' }]);
  });

  it('ignores text items and supports file items without webkitGetAsEntry', async () => {
    const file = new File(['x'], 'a.pdf');
    const textFile = vi.fn(() => null);
    expect(await droppedFiles(transfer([
      { kind: 'string', getAsFile: textFile },
      { kind: 'file', getAsFile: () => file },
    ]))).toEqual([{ file, path: 'a.pdf' }]);
    expect(textFile).not.toHaveBeenCalled();
  });

  it('returns an empty list for an empty directory', async () => {
    const { entry } = directoryEntry('/empty', []);
    expect(await droppedFiles(transfer([entryItem(entry)]))).toEqual([]);
  });

  it('rejects if a later directory chunk fails instead of returning a partial folder', async () => {
    const error = new DOMException('Permission denied', 'NotReadableError');
    const root = directoryEntry('/root', [[fileEntry('/root/a.pdf')]]);
    root.readEntries.mockImplementationOnce((resolve) => resolve([fileEntry('/root/a.pdf')]));
    root.readEntries.mockImplementationOnce((_resolve, ...args: unknown[]) => {
      (args[0] as ErrorCallback)(error);
    });
    await expect(droppedFiles(transfer([entryItem(root.entry)]))).rejects.toBe(error);
  });

  it('propagates a nested file-read error', async () => {
    const error = new DOMException('File disappeared', 'NotFoundError');
    const broken = {
      isFile: true, isDirectory: false, fullPath: '/root/missing.pdf',
      file: (_resolve: FileCallback, reject: ErrorCallback) => reject(error),
    } as FileSystemFileEntry;
    const root = directoryEntry('/root', [[broken]]);
    await expect(droppedFiles(transfer([entryItem(root.entry)]))).rejects.toBe(error);
  });
});

describe('fileValidationKey exact extensions and byte limits', () => {
  it.each([
    ['report.PDF', '.pdf', null],
    ['archive.final.DocX', ' .doc , .DOCX ', null],
    ['photo.jpeg', '.jpg,.jpeg,.png', null],
    ['report.pdf.exe', '.pdf', 'batchTools.unsupportedFormat'],
    ['report.pdfx', '.pdf', 'batchTools.unsupportedFormat'],
    ['report.doc', '.docx', 'batchTools.unsupportedFormat'],
    ['photo.jpg', '.jpeg', 'batchTools.unsupportedFormat'],
    ['pdf', '.pdf', 'batchTools.unsupportedFormat'],
    ['report.', '.pdf', 'batchTools.unsupportedFormat'],
    ['report.pdf ', '.pdf', 'batchTools.unsupportedFormat'],
  ])('validates %s against %s', (name, accept, expected) => {
    expect(fileValidationKey(new File(['x'], name, { type: 'application/pdf' }), accept)).toBe(expected);
  });

  it('rejects an empty file even when the extension is valid', () => {
    expect(fileValidationKey(new File([], 'empty.pdf'), '.pdf')).toBe('batchTools.emptyFile');
  });

  it.each([
    [1, null],
    [100 * 1024 * 1024, null],
    [100 * 1024 * 1024 + 1, 'batchTools.tooLarge'],
  ])('enforces the inclusive 100 MiB boundary at %s bytes', (size, expected) => {
    const file = new File(['x'], 'large.pdf');
    // Exercise the boundary without allocating a 100 MiB buffer in the test runner.
    Object.defineProperty(file, 'size', { value: size });
    expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(fileValidationKey(file, '.pdf')).toBe(expected);
  });
});

describe('parsePages', () => {
  it('normalizes punctuation, sorts and deduplicates overlapping ranges', () => {
    expect(parsePages(' 5， 1 - 3、2, 3-4 ', 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('expands all pages only when the count is available', () => {
    expect(parsePages('all', 3)).toEqual([1, 2, 3]);
    expect(parsePages(' ', 3)).toEqual([1, 2, 3]);
    expect(parsePages('all')).toEqual([]);
  });

  it.each(['0', '-1', '3-1', '1.5', '1e2', '1,,2', '1,', ',1', '1;2', '1-6', '6', '9007199254740992']) (
    'rejects malformed or out-of-range selection %s', (value) => {
      expect(parsePages(value, 5)).toBeNull();
    },
  );

  it('bounds expansion when metadata is unavailable', () => {
    expect(parsePages('100000')).toEqual([100000]);
    expect(parsePages('100001')).toBeNull();
  });
});

describe('splitCustomRanges', () => {
  it('parses comma groups and preserves semicolon-grouped non-contiguous pages', () => {
    expect(splitCustomRanges('1-3,4-6,7-12')).toEqual(['1-3','4-6','7-12']);
    expect(splitCustomRanges('1，3-5、8')).toEqual(['1','3-5','8']);
    expect(splitCustomRanges(' 1-3；4，6; 8、10 ')).toEqual(['1-3','4,6','8,10']);
    expect(splitCustomRanges('all')).toEqual(['all']);
  });
  it.each(['', ';', '1;', ';1', '1;;2', '3-1', '0', '1,'])('rejects invalid syntax %s without reading PDF bytes', (value) => {
    expect(splitCustomRanges(value)).toBeNull();
  });
});
