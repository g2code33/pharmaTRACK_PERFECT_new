import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Highlighter, Copy, Sparkles, Check, X } from 'lucide-react';
import type { HighlightColor } from '../types';

/**
 * Floating toolbar shown over a text selection.
 *
 * Rendered inline (not in a portal) so it inherits the viewer's stacking
 * context, and positioned from the selection's client rect clamped to the
 * viewport so it never opens off-screen near a page edge.
 */

export const HIGHLIGHT_COLORS: { key: HighlightColor; label: string; swatch: string; overlay: string }[] = [
  { key: 'yellow', label: 'Yellow', swatch: 'bg-yellow-300', overlay: 'rgba(253, 224, 71, 0.42)' },
  { key: 'green', label: 'Green', swatch: 'bg-green-300', overlay: 'rgba(134, 239, 172, 0.42)' },
  { key: 'blue', label: 'Blue', swatch: 'bg-sky-300', overlay: 'rgba(125, 211, 252, 0.42)' },
  { key: 'pink', label: 'Pink', swatch: 'bg-pink-300', overlay: 'rgba(249, 168, 212, 0.45)' },
];

export const overlayFor = (color: string): string =>
  HIGHLIGHT_COLORS.find((c) => c.key === color)?.overlay ?? HIGHLIGHT_COLORS[0].overlay;

interface SelectionPopupProps {
  /** Anchor point in client coordinates (top-centre of the selection). */
  anchor: { x: number; y: number } | null;
  onHighlight: (color: HighlightColor) => void;
  onCopy: () => void;
  onAskAi?: () => void;
  onDismiss: () => void;
}

const SelectionPopup: React.FC<SelectionPopupProps> = ({ anchor, onHighlight, onCopy, onAskAi, onDismiss }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) { setPos(null); return; }
    const box = ref.current.getBoundingClientRect();
    const margin = 8;
    // Clamp horizontally so the toolbar stays fully on screen, and flip below
    // the selection when there isn't room above it.
    const left = Math.min(
      Math.max(margin, anchor.x - box.width / 2),
      window.innerWidth - box.width - margin,
    );
    const above = anchor.y - box.height - 10;
    const top = above < margin ? anchor.y + 24 : above;
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => { setCopied(false); }, [anchor]);

  if (!anchor) return null;

  return (
    <div
      ref={ref}
      // mousedown must not clear the selection we are about to act on.
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
        zIndex: 200,
      }}
      className="flex items-center gap-1 bg-slate-900 text-white rounded-xl shadow-2xl px-1.5 py-1.5 animate-in fade-in duration-100"
    >
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c.key}
          onClick={() => onHighlight(c.key)}
          title={`Highlight ${c.label.toLowerCase()}`}
          className={`w-6 h-6 rounded-md ${c.swatch} hover:scale-110 active:scale-95 transition-transform ring-1 ring-white/20`}
        />
      ))}

      <span className="w-px h-5 bg-white/20 mx-1" />

      <button
        onClick={() => { onCopy(); setCopied(true); }}
        title="Copy text"
        className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
      >
        {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
      </button>

      {onAskAi && (
        <button
          onClick={onAskAi}
          title="Ask the AI about this"
          className="p-1.5 rounded-lg hover:bg-white/10 transition-colors text-[#FFB703]"
        >
          <Sparkles className="w-4 h-4" />
        </button>
      )}

      <button onClick={onDismiss} title="Dismiss" className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

export default SelectionPopup;
export { Highlighter };
