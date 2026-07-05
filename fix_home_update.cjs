const fs = require('fs');

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');

// Inject the Home button to the header next to the mobile menu button
const newHeader = `<header className="bg-white/80 backdrop-blur-md border-b border-gray-200 px-6 py-4 flex-shrink-0 z-20">
            <div className="flex items-center gap-4 lg:gap-6">
              <button className="lg:hidden p-2 hover:bg-gray-100 rounded-xl" onClick={() => setMobileMenuOpen(true)}><Menu className="w-5 h-5 text-gray-600" /></button>
              
              {/* Universal Home Button */}
              <Link to="/" className="hidden sm:flex items-center justify-center p-3 bg-[#2D6A4F]/10 hover:bg-[#2D6A4F]/20 text-[#2D6A4F] rounded-xl transition-all shadow-sm" title="Go Home">
                 <Home className="w-5 h-5" />
              </Link>
              <Link to="/" className="sm:hidden flex items-center justify-center p-2 bg-[#2D6A4F]/10 hover:bg-[#2D6A4F]/20 text-[#2D6A4F] rounded-xl transition-all shadow-sm" title="Go Home">
                 <Home className="w-5 h-5" />
              </Link>

              <div className="flex-1 max-w-3xl relative">`;

// Only inject if it's not already there
if (!layout.includes('title="Go Home"')) {
    layout = layout.replace(/<header className="bg-white\/80 backdrop-blur-md border-b border-gray-200 px-6 py-4 flex-shrink-0 z-20">\n\s*<div className="flex items-center gap-6">\n\s*<button className="lg:hidden p-2 hover:bg-gray-100 rounded-xl" onClick=\{\(\) => setMobileMenuOpen\(true\)\}.*\n\s*<div className="flex-1 max-w-3xl relative">/, newHeader);
}

// Bump versions to v1.1.18
layout = layout.replace(/v1\.1\.\d+/g, 'v1.1.18');
fs.writeFileSync('src/components/Layout.tsx', layout);

let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.18';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.18';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

console.log("Injected Universal Home Button and bumped to v1.1.18!");
