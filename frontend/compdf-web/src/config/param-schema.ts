/**
 * Parameter schema + request builder (pure logic, no Vue, no network).
 *
 * Maps the shared upload `parameter` + `password` state onto the middleware's
 * two request shapes:
 *
 *   - PDF routes (`/api/v1/pdf/{op}`): `extractRequest` parses `body.request`
 *     (JSON string) and forwards ONLY that object upstream; a sibling
 *     `password` field is DROPPED when `request` is present. So the password
 *     is injected INTO the request object → `passwordField: 'inline'`,
 *     `field: 'request'`.
 *   - Conversion routes (`/api/v1/conversion/convert` + `/convert-to-pdf`):
 *     the controller reads `options` (JSON string) AND `password` (separate
 *     field) → `passwordField: 'separate'`, `field: 'options'`.
 *
 * `buildRequest()` returns the payload + field name + password rule; the
 * caller (UploadPanel.upload()) does the actual FormData.append.
 */

export interface ConversionFeatures {
  flowLayout?: boolean; includeImages?: boolean; includeAnnotations?: boolean;
  formulaToImage?: boolean; allowOcr?: boolean;
  ocrSettings?: boolean;
  pageOneOutput?: boolean; retainBgImg?: boolean; imageFormat?: boolean; excelOptions?: boolean;
  imgDpi?: boolean; pageRange?: boolean; mergeCsv?: boolean; htmlOption?: boolean;
  jsonContent?: boolean; password?: boolean; transparentText?: boolean; rotateAngle?: boolean;
  insertOptions?: boolean; watermarkOptions?: boolean; removeWatermarkOptions?: boolean; encryptOptions?: boolean;
}

export const CONVERSION_FEATURES: Record<string, ConversionFeatures> = {
  'pdf/docx': { flowLayout: true, includeImages: true, includeAnnotations: true, formulaToImage: true, allowOcr: true, ocrSettings: true, retainBgImg: true, pageRange: true, password: true },
  'pdf/ofd': { password: true, allowOcr: true, ocrSettings: true, includeImages: true, includeAnnotations: true, pageRange: true, pageOneOutput: true },
  'pdf/xlsx': { includeImages: true, includeAnnotations: true, formulaToImage: true, allowOcr: true, ocrSettings: true, pageOneOutput: true, excelOptions: true, pageRange: true, password: true },
  'pdf/pptx': { includeImages: true, includeAnnotations: true, formulaToImage: true, allowOcr: true, ocrSettings: true, pageOneOutput: true, retainBgImg: true, pageRange: true, password: true },
  'pdf/html': { htmlOption: true, includeImages: true, includeAnnotations: true, formulaToImage: true, allowOcr: true, ocrSettings: true, pageOneOutput: true, pageRange: true, password: true },
  'pdf/txt': { allowOcr: true, ocrSettings: true, pageOneOutput: true, pageRange: true, password: true },
  'pdf/csv': { includeImages: true, includeAnnotations: true, formulaToImage: true, allowOcr: true, ocrSettings: true, pageOneOutput: true, mergeCsv: true, pageRange: true, password: true },
  'pdf/rtf': { includeImages: true, includeAnnotations: true, allowOcr: true, ocrSettings: true, pageOneOutput: true, retainBgImg: true, pageRange: true, password: true },
  'pdf/json': { jsonContent: true, includeImages: true, includeAnnotations: true, allowOcr: true, ocrSettings: true, pageOneOutput: true, pageRange: true, password: true },
  'pdf/png': { imageFormat: true, pageRange: true, password: true },
  'pdf/jpg': { imageFormat: true, imgDpi: true, pageRange: true, password: true },
  'pdf/img': { imageFormat: true, imgDpi: true, pageRange: true, password: true },
  'pdf/searchablePdf': { includeImages: true, transparentText: true, formulaToImage: true, ocrSettings: true, pageOneOutput: true, retainBgImg: true, pageRange: true, password: true },
  'pdf/merge': {},
  'pdf/split': { pageRange: true, password: true },
  'pdf/insert': { password: true, insertOptions: true },
  'pdf/delete': { pageRange: true, password: true },
  'pdf/rotate': { pageRange: true, password: true, rotateAngle: true },
  'pdf/compress': { password: true },
  'pdf/addWatermark': { pageRange: true, password: true, watermarkOptions: true },
  'pdf/removeWatermark': { pageRange: true, password: true, removeWatermarkOptions: true },
  'pdf/encrypt': { encryptOptions: true },
  'pdf/decrypt': { password: true },
  'docx/pdf': {}, 'xlsx/pdf': {}, 'pptx/pdf': {}, 'html/pdf': {}, 'png/pdf': {}, 'txt/pdf': {}, 'csv/pdf': {}, 'rtf/pdf': {},
  'img/docx': { allowOcr: true, ocrSettings: true }, 'img/xlsx': { allowOcr: true, ocrSettings: true }, 'img/pptx': { allowOcr: true, ocrSettings: true },
  'img/pdf': { allowOcr: true, ocrSettings: true }, 'img/txt': { allowOcr: true, ocrSettings: true }, 'img/json': { allowOcr: true, ocrSettings: true },
  'img/html': { allowOcr: true, ocrSettings: true }, 'img/rtf': { allowOcr: true, ocrSettings: true }, 'img/csv': { allowOcr: true, ocrSettings: true },
};

const PDF_EDIT_TO_TYPES = ['merge','split','insert','delete','rotate','compress','addWatermark','removeWatermark','encrypt','decrypt'];

const ENCRYPT_PERMISSION_KEYS = ['allowPrint','allowCopy','allowDocumentChanges','allowDocumentAssembly','allowCommenting','allowFormFieldEntry'];

/** The `parameter` ref shape (subset referenced by the builder). */
export interface UploadParameter {
  pageRanges: string;
  outputFileName: string;
  imgDpi: number;
  rotateAngle: string;
  insertActionType: 'BLANK' | 'FROM_PDF';
  insertIndex: string; insertCount: string; insertWidth: string; insertHeight: string; insertTargetPassword: string; sourcePages: string;
  compressQuality: 'low' | 'medium' | 'high' | 'custom';
  compressCustomFlags: string[]; compressImageQuality: string;
  watermarkType: 'text' | 'image'; watermarkFullScreen: boolean;
  watermarkText: string; watermarkFontSize: string; watermarkFontColor: string;
  watermarkOpacity: string; watermarkRotation: string;
  watermarkHorizalign: string; watermarkVertalign: string;
  watermarkHorizOffset: string; watermarkVertOffset: string;
  watermarkHorizontalSpacing: string; watermarkVerticalSpacing: string;
  encryptUserPassword: string; encryptOwnerPassword: string;
  allowPrint: string; allowCopy: string; allowDocumentChanges: string;
  allowDocumentAssembly: string; allowCommenting: string; allowFormFieldEntry: string;
  imageFormat: string;
  excelWorksheetOption: string;
  // Conversion flags gate UI switches/radios in ParamForm and ride through to
  // the options payload as '1'/'0' string toggles.
  enableAiLayout: string;
  isContainImg: string;
  pageLayoutMode: string;
  isContainAnnot: string;
  formulaToImage: string;
  enableOcr: string;
  excelAllContent: string;
  type: string;                 // JSON content scope: '0' text / '1' table / '2' all
  htmlOption: string;
  isOutputDocumentPerPage: string;
  containPageBackgroundImage: string;
  ocrRecognitionLang: string;
  ocrOption: string;
  imageScaling: number;
  transparentText: string;
  sourceType: string;
  // Per-file arrays used during merge (initialized on file selection).
  mergeFilePageRanges?: string[];
  mergePasswords?: string[];
  // ...other conversion flags carried through opaquely.
  [key: string]: unknown;
}

export function defaultParameter(): UploadParameter {
  return {
    pageRanges: '', outputFileName: '', imgDpi: 144, rotateAngle: '90',
    insertActionType: 'BLANK', insertIndex: '1', insertCount: '1', insertWidth: '595', insertHeight: '842', insertTargetPassword: '', sourcePages: '',
    compressQuality: 'medium', compressCustomFlags: [], compressImageQuality: '80',
    watermarkType: 'text', watermarkFullScreen: false,
    watermarkText: '', watermarkFontSize: '', watermarkFontColor: '',
    watermarkOpacity: '1', watermarkRotation: '0',
    watermarkHorizalign: 'center', watermarkVertalign: 'center',
    watermarkHorizOffset: '0', watermarkVertOffset: '0',
    watermarkHorizontalSpacing: '', watermarkVerticalSpacing: '',
    encryptUserPassword: '', encryptOwnerPassword: '',
    allowPrint: '', allowCopy: '', allowDocumentChanges: '', allowDocumentAssembly: '', allowCommenting: '', allowFormFieldEntry: '',
    imageFormat: 'png', excelWorksheetOption: 'e_ForTable',
    // enableOcr defaults to '0'; ParamForm lifts it to '1' for image sources
    // and searchable PDF tools.
    enableAiLayout: '1', isContainImg: '1', pageLayoutMode: 'e_Flow', isContainAnnot: '1',
    formulaToImage: '0', enableOcr: '0', excelAllContent: '0', type: '0',
    htmlOption: 'e_SinglePageWithBookmark',
    isOutputDocumentPerPage: '0', containPageBackgroundImage: '0',
    ocrRecognitionLang: 'AUTO', ocrOption: 'ALL',
    imageScaling: 0, transparentText: '1', sourceType: '1',
    mergeFilePageRanges: [], mergePasswords: [],
  };
}

export interface BuildRequestInput {
  toType: string;          // catalog toType (e.g. 'rotate', 'docx', 'pdf', 'searchablePdf')
  fromType: string;        // 'pdf' | 'img' | 'docx' | ...
  parameter: UploadParameter;
  password: string;
  files: File[];           // primary file(s); for merge = all merge files
  insertTargetFile?: File;
  watermarkImageFile?: File;
  isCsvMerge?: boolean;
}

export interface BuildRequestResult {
  field: 'request' | 'options';
  payload: Record<string, unknown>;
  extraFiles?: File[];      // appended as additional `file` parts (insert FROM_PDF)
  imageFile?: File;         // appended as `imageFile` part (watermark image)
  passwordField: 'inline' | 'separate';
}

// ---- helpers ---------------------------------------------------------------
function getOutputFileName(parameter: UploadParameter, files: File[], extension = 'pdf'): string {
  if (parameter.outputFileName.trim()) return parameter.outputFileName.trim();
  const name = files[0]?.name ?? 'output';
  const idx = name.lastIndexOf('.');
  const base = idx > -1 ? name.substring(0, idx) : name;
  return `${base}.${extension}`;
}
function setIfFilled(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === '' || value === null || value === undefined) return;
  target[key] = value;
}
function toNumberOrUndefined(value: number | string): number | undefined {
  if (value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
function toBooleanOrUndefined(value: string): boolean | undefined {
  if (value === '') return undefined;
  return value === 'true';
}
function toStringList(value: string): string[] {
  return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}
function splitRangesOrAll(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return ['all'];
  const ranges = toStringList(trimmed);
  return ranges.length ? ranges : ['all'];
}

function buildPdfEditPayload(input: BuildRequestInput): { payload: Record<string, unknown>; extraFiles?: File[]; imageFile?: File } {
  const { toType, parameter, files, password } = input;
  let pages: string | number = parameter.pageRanges || 'all';
  const outputFileName = getOutputFileName(parameter, files, toType === 'split' ? 'zip' : 'pdf');
  if (toType === 'merge') {
    return { payload: {
      pageRanges: files.map((_, i) => (parameter.mergeFilePageRanges as string[] | undefined)?.[i] || 'all'),
      passwords: files.map((_, i) => (parameter.mergePasswords as string[] | undefined)?.[i] || password || null),
      outputFileName,
    } };
  }
  if (toType === 'split') {
    return { payload: {
      ranges: splitRangesOrAll(parameter.pageRanges),
      zipFileName: outputFileName,
    } };
  }
  if (toType === 'insert') {
    const base: Record<string, unknown> = { actionType: parameter.insertActionType, index: Number(parameter.insertIndex) || 1, outputFileName };
    if (parameter.insertActionType === 'FROM_PDF') {
      setIfFilled(base, 'targetPassword', password);
      setIfFilled(base, 'insertPassword', parameter.insertTargetPassword);
      const sourceRanges = toStringList(parameter.sourcePages);
      if (sourceRanges.length) base.sourcePageRanges = sourceRanges;
      return { payload: base, extraFiles: input.insertTargetFile ? [input.insertTargetFile] : undefined };
    }
    return { payload: { ...base, count: Number(parameter.insertCount) || 1, width: Number(parameter.insertWidth) || 595, height: Number(parameter.insertHeight) || 842 } };
  }
  if (toType === 'delete') { pages = parameter.pageRanges || 1; return { payload: { pages, outputFileName } }; }
  if (toType === 'rotate') { return { payload: { pages, angle: Number(parameter.rotateAngle) || 90, outputFileName } }; }
  if (toType === 'compress') {
    const result: Record<string, unknown> = { outputFileName };
    const q = parameter.compressQuality;
    if (q === 'low' || q === 'medium') { result.profile = 'aggressive'; result.imageQuality = q === 'low' ? 30 : 60; }
    else if (q === 'high') { result.imageQuality = 80; }
    else if (q === 'custom') {
      if (parameter.compressCustomFlags.length) result.optimizeFlags = parameter.compressCustomFlags;
      setIfFilled(result, 'imageQuality', toNumberOrUndefined(parameter.compressImageQuality));
    }
    return { payload: result };
  }
  if (toType === 'addWatermark') {
    const result: Record<string, unknown> = {
      type: parameter.watermarkType, opacity: toNumberOrUndefined(parameter.watermarkOpacity),
      rotation: Number(parameter.watermarkRotation) || 0,
      horizalign: parameter.watermarkHorizalign, vertalign: parameter.watermarkVertalign,
      horizOffset: Number(parameter.watermarkHorizOffset) || 0, vertOffset: Number(parameter.watermarkVertOffset) || 0,
      pages, fullScreen: parameter.watermarkFullScreen, outputFileName,
    };
    if (parameter.watermarkType === 'text') {
      result.text = parameter.watermarkText;
      setIfFilled(result, 'fontSize', toNumberOrUndefined(parameter.watermarkFontSize));
      setIfFilled(result, 'fontColor', parameter.watermarkFontColor);
    }
    setIfFilled(result, 'horizontalSpacing', toNumberOrUndefined(parameter.watermarkHorizontalSpacing));
    setIfFilled(result, 'verticalSpacing', toNumberOrUndefined(parameter.watermarkVerticalSpacing));
    return { payload: result, imageFile: parameter.watermarkType === 'image' ? input.watermarkImageFile : undefined };
  }
  if (toType === 'removeWatermark') { return { payload: { outputFileName, pages, mode: 'tagged' } }; }
  if (toType === 'encrypt') {
    const result: Record<string, unknown> = { outputFileName };
    setIfFilled(result, 'userPassword', parameter.encryptUserPassword);
    setIfFilled(result, 'ownerPassword', parameter.encryptOwnerPassword);
    for (const k of ENCRYPT_PERMISSION_KEYS) setIfFilled(result, k, toBooleanOrUndefined(parameter[k] as string));
    return { payload: result };
  }
  if (toType === 'decrypt') { const result: Record<string, unknown> = { outputFileName }; setIfFilled(result, 'password', password); return { payload: result }; }
  return { payload: { pages, outputFileName } };
}

function conversionFeatureKey(input: BuildRequestInput): string {
  if (input.toType === 'searchablePdf') return 'pdf/searchablePdf';
  if (input.fromType === 'img') return `img/${input.toType}`;
  return `${input.fromType}/${input.toType}`;
}

function buildConversionPayload(input: BuildRequestInput): Record<string, unknown> {
  const parameter = input.parameter;
  const features = CONVERSION_FEATURES[conversionFeatureKey(input)] || {};
  const payload: Record<string, unknown> = {};
  const set = (key: keyof UploadParameter, include: boolean, skipEmpty = false) => {
    const value = parameter[key];
    if (!include) return;
    if (skipEmpty && (value === '' || value === undefined || value === null)) return;
    payload[key] = value;
  };

  set('enableAiLayout', !!features.flowLayout);
  set('pageLayoutMode', !!features.flowLayout);
  set('isContainImg', !!features.includeImages);
  set('isContainAnnot', !!features.includeAnnotations);
  set('formulaToImage', !!features.formulaToImage);
  set('enableOcr', !!features.allowOcr || input.toType === 'searchablePdf' || input.fromType === 'img');
  set('excelAllContent', !!features.excelOptions);
  set('excelWorksheetOption', !!features.excelOptions);
  set('type', !!features.jsonContent);
  set('htmlOption', !!features.htmlOption);
  set('isOutputDocumentPerPage', !!features.pageOneOutput);
  set('containPageBackgroundImage', !!features.retainBgImg);
  set('transparentText', !!features.transparentText);
  set('imageFormat', !!features.imageFormat);
  set('pageRanges', !!features.pageRange, true);
  const shouldSendOcrSettings = !!features.ocrSettings && (parameter.enableOcr === '1' || input.toType === 'searchablePdf' || input.fromType === 'img');
  set('ocrRecognitionLang', shouldSendOcrSettings, true);
  set('ocrOption', shouldSendOcrSettings, true);

  if (features.imgDpi) {
    payload.imageScaling = Number((parameter.imgDpi / 72).toFixed(2));
  }
  if (input.isCsvMerge) {
    payload.excelWorksheetOption = 'e_ForDocument';
  }
  return payload;
}

export function buildRequest(input: BuildRequestInput): BuildRequestResult {
  const isPdfEdit = PDF_EDIT_TO_TYPES.includes(input.toType);
  // other→pdf (not img): minimal { sourceType: '1' }, no password.
  if (input.toType === 'pdf' && input.fromType !== 'img') {
    return { field: 'options', payload: { sourceType: '1' }, passwordField: 'separate' };
  }
  if (isPdfEdit) {
    const { payload, extraFiles, imageFile } = buildPdfEditPayload(input);
    // PDF routes forward ONLY the `request` JSON; inject password inline.
    if (input.password && !(input.toType === 'insert' && input.parameter.insertActionType === 'FROM_PDF')) {
      (payload as Record<string, unknown>).password = input.password;
    }
    return { field: 'request', payload, extraFiles, imageFile, passwordField: 'inline' };
  }
  const payload = buildConversionPayload(input);
  return { field: 'options', payload, passwordField: 'separate' };
}
