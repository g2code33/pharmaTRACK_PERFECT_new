const fs = require('fs');

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');

if (!layout.includes("const [darkMode, setDarkMode]")) {
    layout = layout.replace(
        "const [appVersion, setAppVersion] = useState('1.1.10');",
        "const [appVersion, setAppVersion] = useState('1.1.11');\n  const [darkMode, setDarkMode] = useState(false);\n  useEffect(() => { document.documentElement.classList.toggle('dark', darkMode); }, [darkMode]);"
    );
}

fs.writeFileSync('src/components/Layout.tsx', layout);
console.log('Fixed Dark Mode state');

// Bump version
let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.11';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.11';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

