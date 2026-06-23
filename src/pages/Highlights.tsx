import React from 'react';
import { useApp } from '../context/AppContext';
import { Bookmark, Search } from 'lucide-react';

const Highlights: React.FC = () => {
  const { state } = useApp();

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-[#FFB703] to-[#FFA500] rounded-2xl p-6 text-white">
        <h1 className="text-2xl font-bold mb-2">⭐ Study Bank</h1>
        <p className="text-white/90">Your saved highlights and notes</p>
      </div>

      <div className="bg-white rounded-xl p-6 border border-gray-100 shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          <Search className="w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search highlights..."
            className="flex-1 outline-none text-sm"
          />
        </div>

        {state.highlights.length === 0 ? (
          <div className="text-center py-12">
            <Bookmark className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-gray-700 mb-2">No Highlights Yet</h2>
            <p className="text-gray-500">Highlight text in Study Materials to save them here</p>
          </div>
        ) : (
          <div className="space-y-4">
            {state.highlights.map((highlight) => (
              <div key={highlight.id} className="p-4 bg-gray-50 rounded-lg border border-gray-100">
                <p className="text-sm text-gray-800">{highlight.text}</p>
                <p className="text-xs text-gray-400 mt-2">
                  Saved from slide {highlight.slideIndex + 1}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Highlights;