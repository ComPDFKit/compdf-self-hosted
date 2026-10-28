export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function fileValidationKey(file: File, accept: string): string | null {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!accept.toLowerCase().split(',').map((value) => value.trim()).includes(extension)) return 'batchTools.unsupportedFormat';
  if (!file.size) return 'batchTools.emptyFile';
  if (file.size > MAX_UPLOAD_BYTES) return 'batchTools.tooLarge';
  return null;
}

export interface PickedFile { file: File; path: string }

/** DirectoryReader can return only 100 entries per call. Drain every chunk. */
async function readEntry(entry: FileSystemEntry): Promise<PickedFile[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    return [{ file, path: entry.fullPath.replace(/^\//, '') }];
  }
  if (!entry.isDirectory) return [];
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const files: PickedFile[] = [];
  while (true) {
    const chunk = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!chunk.length) break;
    for (const child of chunk) files.push(...await readEntry(child));
  }
  return files;
}

export async function droppedFiles(data: DataTransfer): Promise<PickedFile[]> {
  // Capture entries before the drop event's protected data store closes.
  const items = Array.from(data.items ?? []).filter((item) => item.kind === 'file');
  const entries = items.map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  const fallback = Array.from(data.files);
  const files: PickedFile[] = [];
  if (!entries.length) return fallback.map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  for (const { entry, file } of entries) {
    if (entry) files.push(...await readEntry(entry));
    else if (file) files.push({ file, path: file.name });
  }
  return files;
}

export function parsePages(value: string, pageCount?: number): number[] | null {
  const normalized = value.trim().replace(/[、，]/g, ',');
  if (!normalized || normalized === 'all') return pageCount ? Array.from({ length: pageCount }, (_, i) => i + 1) : [];
  const selected = new Set<number>();
  for (const part of normalized.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2] ?? start);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > (pageCount ?? 100000)) return null;
    for (let page = start; page <= end; page++) selected.add(page);
  }
  return [...selected].sort((a, b) => a - b);
}

export type SplitMode = 'custom' | 'every' | 'equal';
/** Split syntax only; the server validates actual document page bounds. */
export function splitCustomRanges(value: string): string[] | null {
  const normalized = value.trim().toLowerCase().replace(/；/g, ';').replace(/[、，]/g, ',');
  const groups = normalized.split(normalized.includes(';') ? ';' : ',').map((group) => group.trim());
  return groups.length && groups.every((group) => group && parsePages(group) !== null)
    ? groups : null;
}
