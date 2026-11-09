import type { Endpoint } from '@/config/convert-map';

/** Use the source (or requested) name; server names only help identify the output format. */
export function defaultResultFilename(
  endpoint: Endpoint,
  sourceName: string,
  contentType: string,
  request?: Record<string, unknown>,
  resultName?: string,
): string {
  const split = endpoint.kind === 'pdf' && endpoint.op === 'split';
  const requested = request?.[split ? 'zipFileName' : 'outputFileName'];
  const preferredName = typeof requested === 'string' && requested.trim()
    ? requested.trim() : endpoint.kind === 'pdf' && endpoint.op === 'merge' ? 'merged.pdf' : sourceName;

  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  const imageExtensions: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/tiff': 'tiff',
    'image/bmp': 'bmp', 'image/webp': 'webp', 'image/gif': 'gif',
  };
  let extension = endpoint.kind === 'convert-target' ? endpoint.target
    : endpoint.kind === 'convert-type' ? endpoint.type.split('/').pop()!
    : split ? 'zip' : 'pdf';
  // Generic binary responses may still advertise the actual format in their name.
  const reportedExtension = resultName?.split('.').pop()?.toLowerCase();
  const knownExtensions = ['pdf', 'zip', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'html', 'htm', 'txt', 'rtf', 'csv', 'json', 'xml', 'ofd', 'md', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'gif'];
  if (reportedExtension && knownExtensions.includes(reportedExtension)) extension = reportedExtension;
  if (mime === 'application/pdf') extension = 'pdf';
  else if (mime === 'application/zip' || mime === 'application/x-zip-compressed') extension = 'zip';
  else if (imageExtensions[mime]) extension = imageExtensions[mime]!;
  if (extension === 'markdown') extension = 'md';
  const dot = preferredName.lastIndexOf('.');
  const base = dot > 0 ? preferredName.slice(0, dot) : preferredName;
  return `${base}.${extension}`;
}

/** Keep source folders and allocate a free name without overwriting any entry. */
export function availableArchivePath(
  sourcePath: string,
  outputName: string,
  files: Record<string, Uint8Array>,
): string {
  const safeParts = (path: string) => path.split(/[\\/]/).filter((part) => part && part !== '.' && part !== '..');
  const directory = safeParts(sourcePath).slice(0, -1);
  const filename = safeParts(outputName).pop() || 'result';
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  let candidate = [...directory, filename].join('/');
  let count = 1;
  while (Object.hasOwn(files, candidate)) {
    candidate = [...directory, `${base} (${++count})${extension}`].join('/');
  }
  return candidate;
}
