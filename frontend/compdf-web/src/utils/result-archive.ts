import { unzip, zip } from 'fflate';

export function zipFiles(files: Record<string, Uint8Array>): Promise<Blob> {
  return new Promise((resolve, reject) => zip(files, { level: 0 }, (error, data) => {
    if (error) reject(error);
    else resolve(new Blob([new Uint8Array(data)], { type: 'application/zip' }));
  }));
}

/** Split's SDK returns a ZIP; apply the chosen naming separator to its PDFs. */
export async function nameSplitOutputs(blob: Blob, sourceName: string, separator: string): Promise<Blob> {
  const input = new Uint8Array(await blob.arrayBuffer());
  const entryNames: string[] = [];
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(input, {
    // Capture ZIP directory order before parallel decompression can reorder results.
    filter: (entry) => { entryNames.push(entry.name); return true; },
  }, (error, files) => error ? reject(error) : resolve(files)));
  const base = sourceName.replace(/\.pdf$/i, '').replace(/[\\/]/g, '_');
  const renamed: Record<string, Uint8Array> = Object.create(null);
  let count = 0;
  for (const name of entryNames) {
    if (name.endsWith('/')) continue;
    renamed[name.toLowerCase().endsWith('.pdf') ? `${base}${separator}${++count}.pdf` : name.split('/').pop()!] = entries[name]!;
  }
  return zipFiles(renamed);
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}
