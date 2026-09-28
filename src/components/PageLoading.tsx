import React from 'react';

/**
 * Loading state for lazily loaded route chunks.
 *
 * Two boundaries render it:
 *
 *  - inside Layout, around the <Outlet /> — while a page chunk downloads the
 *    sidebar, header and search must stay on screen, and only the content area
 *    shows the loader. Before this boundary existed the app-level fallback
 *    replaced the whole shell, so every first visit to a sidebar tab flashed a
 *    near-white screen with a lone spinner.
 *
 *  - at the app root — the brief window a deep link needs before its page
 *    chunk arrives (e.g. a PWA restored straight onto #/materials, or the
 *    secure examination route, which lives outside the Layout).
 *
 * It is styled to read as a page of the app, not a blank screen: it fills the
 * visible content area and carries the brand spinner, matching the styling of
 * ErrorBoundary's fallback.
 */
const PageLoading: React.FC = () => (
  <div
    className="flex min-h-[60vh] w-full items-center justify-center"
    data-testid="page-loading"
    role="status"
    aria-label="Loading page"
  >
    <div className="flex flex-col items-center gap-3">
      <div className="w-8 h-8 border-[3px] border-[#2D6A4F]/20 border-t-[#2D6A4F] rounded-full animate-spin" />
      <span className="text-[10px] font-black uppercase tracking-widest text-[#2D6A4F]/60">
        Loading
      </span>
    </div>
  </div>
);

export default PageLoading;
