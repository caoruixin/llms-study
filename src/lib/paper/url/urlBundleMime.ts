/**
 * URL 导入产出的「净化 HTML 合集」MIME 类型——零依赖叶子文件。
 *
 * 为什么单独拆出来：validate.ts 的 MIME_BY_FORMAT 需要这个常量，而 urlBundle.ts
 * 本身依赖 ingest.ts（取 IngestError）、ingest.ts 又依赖 validate.ts（取
 * MAX_TEXT_CHARS/validateFile）——如果 validate.ts 直接从 urlBundle.ts 取常量，
 * 会形成 validate → urlBundle → ingest → validate 的循环 import。拆一个不依赖
 * 任何模块的叶子文件，两边都从这里取值，从根上避免成环。
 */
export const URL_BUNDLE_MIME = 'application/x-paper-url-bundle+json'
