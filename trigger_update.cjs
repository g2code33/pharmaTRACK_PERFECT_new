const fs = require('fs');

// 1. Add Dark Mode State and Icons to Layout.tsx
let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');

// Add Sun and Moon icons to imports
if (!layout.includes('Moon,')) {
    layout = layout.replace('Settings,', 'Settings, Moon, Sun,');
}

// Add state and replace v1.1.10 with v1.1.11
layout = layout.replace(
    /const \[appVersion, setAppVersion\] = useState\('1\.1\.10'\);/,
    `const [appVersion, setAppVersion] = useState('1.1.11');\n  const [darkMode, setDarkMode] = useState(false);\n  useEffect(() => { document.documentElement.classList.toggle('dark', darkMode); }, [darkMode]);`
);

// Inject the Dark Mode Button right next to the Settings Button
const buttonInjection = `<button onClick={() => setDarkMode(!darkMode)} className="w-10 h-10 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-[#2D6A4F] rounded-full transition-all border border-gray-100 shadow-sm">{darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}</button>\n                `;

if (!layout.includes('setDarkMode')) {
    layout = layout.replace(/(<Link to="\/settings".*?<\/Link>)/, buttonInjection + '$1');
}

// Make the background respond to dark mode
layout = layout.replace(
    '<div className="flex h-screen overflow-hidden bg-slate-50 flex-col">',
    '<div className={`flex h-screen overflow-hidden flex-col ${darkMode ? "bg-slate-900" : "bg-slate-50"}`}>'
);

fs.writeFileSync('src/components/Layout.tsx', layout);

// 2. Bump Tauri and NPM versions to 1.1.11
let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.11';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.11';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

console.log('Dark Mode added and version bumped to 1.1.11!');
