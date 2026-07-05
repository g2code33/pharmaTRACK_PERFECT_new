const fs = require('fs');

// 1. Force inject the Home button into Layout.tsx
let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');

const targetStr = `<button className="lg:hidden p-2 hover:bg-gray-100 rounded-xl" onClick={() => setMobileMenuOpen(true)}><Menu className="w-5 h-5 text-gray-600" /></button>`;
const homeButtonHtml = `<button className="lg:hidden p-2 hover:bg-gray-100 rounded-xl" onClick={() => setMobileMenuOpen(true)}><Menu className="w-5 h-5 text-gray-600" /></button>
              
              {/* Universal Home Button */}
              <Link to="/" className="flex items-center justify-center p-2.5 bg-[#2D6A4F]/10 hover:bg-[#2D6A4F]/20 text-[#2D6A4F] rounded-xl transition-all shadow-sm" title="Go Home">
                 <Home className="w-5 h-5" />
              </Link>`;

if (!layout.includes('title="Go Home"')) {
    layout = layout.replace(targetStr, homeButtonHtml);
    layout = layout.replace('<div className="flex items-center gap-6">', '<div className="flex items-center gap-4 lg:gap-6">');
}

// Ensure 'Home' is imported from lucide-react if it somehow got removed
if (!layout.includes('Home,')) {
    layout = layout.replace('import {', 'import { Home,');
}

// 2. Bump versions to v1.1.20
layout = layout.replace(/v1\.1\.\d+/g, 'v1.1.20');
fs.writeFileSync('src/components/Layout.tsx', layout);

let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.20';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.20';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

console.log("Injected Home button and bumped version to 1.1.20!");
