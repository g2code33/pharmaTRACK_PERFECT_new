/** Browser file-picker hints. The input filter is not security validation; every
 * selected package/material is still inspected by the relevant parser. */
export const BROWSER_MATERIAL_ACCEPT = [
  '.pdf', 'application/pdf',
  '.doc', '.docx', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt', '.pptx', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt', '.md', '.csv', 'text/plain', 'text/markdown', 'text/csv',
  'image/*',
].join(',');

export const BROWSER_PHARMAEXAM_ACCEPT = '.pharmaexam,.zip,application/zip';

export function hasPharmaExamExtension(name: string): boolean {
  return name.trim().toLowerCase().endsWith('.pharmaexam');
}

/**
 * Browser file associations are intentionally not assumed. This helper is
 * only for UI messaging and tests; package authenticity is decided by the
 * signed-package validator after bytes are read.
 */
export function isBrowserPharmaExamSelection(file: Pick<File, 'name'> | { name: string }): boolean {
  return hasPharmaExamExtension(file.name);
}
