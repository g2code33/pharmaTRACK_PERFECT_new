const fs = require('fs');
let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');

const oldUpdateBtn = `<button onClick={checkForUpdates} disabled={updateStatus === 'checking' || updateStatus === 'downloading'} title="Check for Updates" className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-full font-bold text-xs transition-all shadow-md disabled:opacity-50">`;
const newUpdateBtn = `<div className="flex items-center gap-2 bg-blue-600 text-white pl-4 pr-1 py-1 rounded-full shadow-md">
                  <span className="text-[10px] font-black uppercase tracking-widest border-r border-blue-400 pr-3 mr-1 opacity-90">v1.0.6</span>
                  <button onClick={checkForUpdates} disabled={updateStatus === 'checking' || updateStatus === 'downloading'} title="Check for Updates" className="flex items-center gap-2 px-3 py-1.5 hover:bg-blue-700 rounded-full font-bold text-xs transition-all disabled:opacity-50">`;

if (!layout.includes('v1.0.6')) {
    layout = layout.replace(oldUpdateBtn, newUpdateBtn);
    layout = layout.replace(/<\/span>\n                <\/button>/, `</span>\n                </button>\n                </div>`);
    fs.writeFileSync('src/components/Layout.tsx', layout);
}
