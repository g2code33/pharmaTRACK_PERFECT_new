/**
 * Download-progress maths for the in-app update sheet.
 *
 * Kept out of the component so the sheet file exports nothing but the sheet
 * (anything else breaks fast refresh) and so the arithmetic can be tested on
 * its own — a wrong percentage here is the difference between a progress bar
 * and a bar that sits at 0% for the whole download.
 */

/** `null` when the server never sent a content length (indeterminate bar). */
export function updateDownloadPercent(received: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(received) || received <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
}

export function formatDownloadSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
