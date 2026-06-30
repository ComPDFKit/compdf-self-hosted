/**
 * Locale list + catalog slug→i18n-key mapping. Language labels are native names.
 */
export interface Language { code: string; label: string; }

export const LANGUAGES: Language[] = [
  { code: 'en',    label: 'English' },
  { code: 'zh-cn', label: '中文(简体)' },
  { code: 'zh-tw', label: '中文(繁體)' },
  { code: 'ja',    label: '日本語' },
  { code: 'ko',    label: '한국어' },
  { code: 'th',    label: 'ภาษาไทย' },
  { code: 'es',    label: 'Español' },
];

export const DEFAULT_LOCALE = 'en';
const STORAGE_KEY = 'compdf-lang';

export function getStoredLocale(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_LOCALE;
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_LOCALE;
}
export function storeLocale(code: string): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, code);
}

/**
 * Catalog slug → pdfTools.tools.* key.
 */
const SLUG_TO_TOOL_KEY: Record<string, string> = {
  'pdf-to-word': 'pdfToWord',
  'pdf-to-json': 'pdfToJson',
  'pdf-to-html': 'pdfToHtml',
  'pdf-to-csv': 'pdfToCsv',
  'pdf-to-excel': 'pdfToExcel',
  'pdf-to-txt': 'pdfToTxt',
  'pdf-to-powerpoint': 'pdfToPowerPoint',
  'pdf-to-image': 'pdfToImage',
  'pdf-to-rtf': 'pdfToRtf',
  'pdf-to-editable': 'pdfToSearchablePdf',
  'pdf-to-ofd': 'pdfToOfd',
  'word-to-pdf': 'wordToPdf',
  'png-to-pdf': 'pngToPdf',
  'rtf-to-pdf': 'rtfToPdf',
  'excel-to-pdf': 'excelToPdf',
  'txt-to-pdf': 'txtToPdf',
  'csv-to-pdf': 'csvToPdf',
  'powerpoint-to-pdf': 'powerPointToPdf',
  'html-to-pdf': 'htmlToPdf',
  'image-to-word': 'imageToWord',
  'image-to-pdf': 'imageToPdf',
  'image-to-html': 'imageToHtml',
  'image-to-excel': 'imageToExcel',
  'image-to-txt': 'imageToTxt',
  'image-to-rtf': 'imageToRtf',
  'image-to-powerpoint': 'imageToSlide',
  'image-to-json': 'imageToJson',
  'image-to-csv': 'imageToCsv',
  'merge': 'merge',
  'split': 'split',
  'insert': 'insert',
  'delete': 'delete',
  'rotate': 'rotate',
  'compress': 'compress',
  'add-watermark': 'addWatermark',
  'remove-watermark': 'removeWatermark',
  'encrypt': 'encrypt',
  'decrypt': 'decrypt',
};

export function toolI18nKey(slug: string): string {
  const key = SLUG_TO_TOOL_KEY[slug];
  if (!key) throw new Error(`no i18n key for slug: ${slug}`);
  return `pdfTools.tools.${key}`;
}

/** Catalog section index (0..4) → pdfTools.sections.* key. */
export const SECTION_KEYS: Record<number, string> = {
  0: 'pdfTools.sections.pdfToOthers',
  1: 'pdfTools.sections.othersToPdf',
  2: 'pdfTools.sections.imageToOthers',
  3: 'pdfTools.sections.pageEditor',
  4: 'pdfTools.sections.pdfSecurity',
};
