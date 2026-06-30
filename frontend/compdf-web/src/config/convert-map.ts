/**
 * The 38-tool catalog + slug→endpoint mapping. Authoritative for both the
 * catalog page (TOOL_SECTIONS) and the detail page (resolveTool).
 *
 * Three middleware route families:
 *   pdf            → POST /api/v1/pdf/{op}, multipart `request` JSON part + file(s)
 *   convert-target → POST /api/v1/conversion/convert, flat field `target`
 *   convert-type   → POST /api/v1/conversion/convert, flat field `type` (img/*, pdf/pdf, pdf/ofd, img/json)
 *   convert-to-pdf → POST /api/v1/conversion/convert-to-pdf, flat field `type` (optional)
 *
 * Tool/section titles are i18n-driven (see i18n-keys.ts: toolI18nKey(slug),
 * SECTION_KEYS[idx]) — no `title` field is stored here.
 *
 * Icon filenames match the SVGs in src/assets/icons.
 */

export type PdfOp =
  | 'merge' | 'split' | 'insert-from-pdf' | 'insert-blank'
  | 'delete' | 'rotate' | 'compress'
  | 'watermark/add' | 'watermark/remove' | 'encrypt' | 'decrypt';

export type Endpoint =
  | { kind: 'pdf'; op: PdfOp }
  | { kind: 'convert-target'; target: string }
  | { kind: 'convert-type'; type: string }
  | { kind: 'convert-to-pdf'; type?: string };

export interface ToolDef {
  slug: string;
  icon: string;
  accept: string;
  multiple?: boolean;
  endpoint: Endpoint;
}

export interface ToolSection {
  tools: ToolDef[];
}

const IMG = '.jpg,.png,.jpeg,.bmp';

const ALL: ToolDef[] = [
  // PDF to other formats.
  { slug: 'pdf-to-word', icon: 'pdf_to_word', accept: '.pdf', endpoint: { kind: 'convert-target', target: 'docx' } },
  { slug: 'pdf-to-json', icon: 'pdf_to_json', accept: '.pdf', endpoint: { kind: 'convert-target', target: 'json' } },
  { slug: 'pdf-to-html', icon: 'pdf_to_html', accept: '.pdf', endpoint: { kind: 'convert-target', target: 'html' } },
  { slug: 'pdf-to-csv', icon: 'pdf_to_csv', accept: '.pdf', endpoint: { kind: 'convert-target', target: 'csv' } },
  { slug: 'pdf-to-excel', icon: 'pdf_to_excel', accept: '.pdf', endpoint: { kind: 'convert-target', target: 'xlsx' } },
  { slug: 'pdf-to-txt', icon: 'pdf_to_txt', accept: '.pdf', endpoint: { kind: 'convert-target', target: 'txt' } },
  { slug: 'pdf-to-powerpoint', icon: 'pdf_to_ppt', accept: '.pdf', endpoint: { kind: 'convert-target', target: 'pptx' } },
  { slug: 'pdf-to-image', icon: 'pdf_to_png', accept: '.pdf', endpoint: { kind: 'convert-target', target: 'png' } },
  { slug: 'pdf-to-rtf', icon: 'pdf_to_rtf', accept: '.pdf', endpoint: { kind: 'convert-target', target: 'rtf' } },
  { slug: 'pdf-to-editable', icon: 'pdf_to_editable', accept: '.pdf', endpoint: { kind: 'convert-type', type: 'pdf/pdf' } },
  { slug: 'pdf-to-ofd', icon: 'pdf_to_ofd', accept: '.pdf', endpoint: { kind: 'convert-type', type: 'pdf/ofd' } },

  // Other formats to PDF.
  { slug: 'word-to-pdf', icon: 'word_to_pdf', accept: '.doc,.docx', endpoint: { kind: 'convert-to-pdf', type: 'docx/pdf' } },
  { slug: 'png-to-pdf', icon: 'png_to_pdf', accept: '.png', endpoint: { kind: 'convert-to-pdf', type: 'png/pdf' } },
  { slug: 'rtf-to-pdf', icon: 'rtf_to_pdf', accept: '.rtf', endpoint: { kind: 'convert-to-pdf', type: 'rtf/pdf' } },
  { slug: 'excel-to-pdf', icon: 'excel_to_pdf', accept: '.xls,.xlsx', endpoint: { kind: 'convert-to-pdf', type: 'xlsx/pdf' } },
  { slug: 'txt-to-pdf', icon: 'txt_to_pdf', accept: '.txt', endpoint: { kind: 'convert-to-pdf', type: 'txt/pdf' } },
  { slug: 'csv-to-pdf', icon: 'csv_to_pdf', accept: '.csv', endpoint: { kind: 'convert-to-pdf', type: 'csv/pdf' } },
  { slug: 'powerpoint-to-pdf', icon: 'ppt_to_pdf', accept: '.ppt,.pptx', endpoint: { kind: 'convert-to-pdf', type: 'pptx/pdf' } },
  { slug: 'html-to-pdf', icon: 'html_to_pdf', accept: '.html,.htm', endpoint: { kind: 'convert-to-pdf', type: 'html/pdf' } },

  // Images to other formats.
  { slug: 'image-to-word', icon: 'image_to_word', accept: IMG, endpoint: { kind: 'convert-type', type: 'img/docx' } },
  { slug: 'image-to-pdf', icon: 'image_to_pdf', accept: IMG, endpoint: { kind: 'convert-to-pdf', type: 'png/pdf' } },
  { slug: 'image-to-html', icon: 'image_to_html', accept: IMG, endpoint: { kind: 'convert-type', type: 'img/html' } },
  { slug: 'image-to-excel', icon: 'image_to_excel', accept: IMG, endpoint: { kind: 'convert-type', type: 'img/xlsx' } },
  { slug: 'image-to-txt', icon: 'image_to_txt', accept: IMG, endpoint: { kind: 'convert-type', type: 'img/txt' } },
  { slug: 'image-to-rtf', icon: 'image_to_rtl', accept: IMG, endpoint: { kind: 'convert-type', type: 'img/rtf' } },
  { slug: 'image-to-powerpoint', icon: 'image_to_ppt', accept: IMG, endpoint: { kind: 'convert-type', type: 'img/pptx' } },
  { slug: 'image-to-json', icon: 'image_to_json', accept: IMG, endpoint: { kind: 'convert-type', type: 'img/json' } },
  { slug: 'image-to-csv', icon: 'image_to_csv', accept: IMG, endpoint: { kind: 'convert-type', type: 'img/csv' } },

  // Page editing.
  { slug: 'merge', icon: 'merge_files', accept: '.pdf', multiple: true, endpoint: { kind: 'pdf', op: 'merge' } },
  { slug: 'split', icon: 'split_files', accept: '.pdf', endpoint: { kind: 'pdf', op: 'split' } },
  { slug: 'insert', icon: 'insert_page', accept: '.pdf', endpoint: { kind: 'pdf', op: 'insert-from-pdf' } },
  { slug: 'delete', icon: 'delete_files', accept: '.pdf', endpoint: { kind: 'pdf', op: 'delete' } },
  { slug: 'rotate', icon: 'rotate_page', accept: '.pdf', endpoint: { kind: 'pdf', op: 'rotate' } },
  { slug: 'compress', icon: 'compress', accept: '.pdf', endpoint: { kind: 'pdf', op: 'compress' } },

  // PDF security.
  { slug: 'add-watermark', icon: 'add_watermark', accept: '.pdf', endpoint: { kind: 'pdf', op: 'watermark/add' } },
  { slug: 'remove-watermark', icon: 'remove_watermark', accept: '.pdf', endpoint: { kind: 'pdf', op: 'watermark/remove' } },
  { slug: 'encrypt', icon: 'encryption', accept: '.pdf', endpoint: { kind: 'pdf', op: 'encrypt' } },
  { slug: 'decrypt', icon: 'decryption', accept: '.pdf', endpoint: { kind: 'pdf', op: 'decrypt' } },
];

export const TOOL_SECTIONS: ToolSection[] = [
  // image-to-pdf ends with '-to-pdf' but belongs in the image conversion group,
  // so the X-to-PDF section must exclude image-*.
  { tools: ALL.filter((t) => t.slug.startsWith('pdf-to-')) },
  { tools: ALL.filter((t) => t.slug.endsWith('-to-pdf') && !t.slug.startsWith('image-')) },
  { tools: ALL.filter((t) => t.slug.startsWith('image-to-')) },
  { tools: ALL.filter((t) => ['merge','split','insert','delete','rotate','compress'].includes(t.slug)) },
  { tools: ALL.filter((t) => ['add-watermark','remove-watermark','encrypt','decrypt'].includes(t.slug)) },
];

const BY_SLUG = new Map(ALL.map((t) => [t.slug, t]));

export function resolveTool(slug: string): ToolDef | null {
  return BY_SLUG.get(slug) ?? null;
}

/**
 * Map a tool's Endpoint onto the {fromType, toType} pair consumed by
 * ParamForm's feature flags (CONVERSION_FEATURES[`${fromType}/${toType}`])
 * and buildRequest's branching. `toType` is ALWAYS the catalog toType (e.g.
 * 'rotate', 'addWatermark', 'searchablePdf') — NEVER the raw pdf op name.
 *
 * Deterministic from endpoint + slug; no hardcoded per-slug table.
 */
const PDF_OP_TO_TYPE: Record<string, string> = {
  'insert-from-pdf': 'insert',
  'watermark/add': 'addWatermark',
  'watermark/remove': 'removeWatermark',
};

export function resolveConversionTypes(tool: ToolDef): { fromType: string; toType: string } {
  const ep = tool.endpoint;
  switch (ep.kind) {
    case 'pdf':
      return { fromType: 'pdf', toType: PDF_OP_TO_TYPE[ep.op] ?? ep.op };
    case 'convert-target':
      // pdf→X: target IS the toType (pdf-to-image target=png → toType='png').
      return { fromType: 'pdf', toType: ep.target };
    case 'convert-type': {
      const [src, dst] = ep.type.split('/');
      if (src === 'pdf') {
        // pdf/pdf → searchablePdf (OCR layer); pdf/ofd → ofd.
        return { fromType: 'pdf', toType: dst === 'pdf' ? 'searchablePdf' : dst };
      }
      // img/* → fromType='img', toType = part after 'img/'.
      return { fromType: src, toType: dst };
    }
    case 'convert-to-pdf': {
      // image-to-pdf + png-to-pdf share type 'png/pdf' but are image sources;
      // they must hit 'img/pdf' (allowOcr), not the empty 'png/pdf' entry.
      if (tool.slug.startsWith('image-') || tool.slug.startsWith('png-')) {
        return { fromType: 'img', toType: 'pdf' };
      }
      // word/excel/.../html → fromType = segment before '/pdf'.
      const src = ep.type ? ep.type.split('/')[0] : '';
      return { fromType: src, toType: 'pdf' };
    }
  }
}
