const fs = require('fs');
let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
if (!layout.includes("import { getVersion }")) {
    layout = layout.replace(
        "import { relaunch } from '@tauri-apps/plugin-process';",
        "import { relaunch } from '@tauri-apps/plugin-process';\nimport { getVersion } from '@tauri-apps/api/app';"
    );
}
if (!layout.includes("const [appVersion, setAppVersion]")) {
    layout = layout.replace(
        "const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'done'>('idle');",
        "const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'done'>('idle');\n  const [appVersion, setAppVersion] = useState('1.0.0');\n\n  useEffect(() => {\n    getVersion().then(v => setAppVersion(v)).catch(console.error);\n  }, []);"
    );
}
layout = layout.replace(
    /<span className="text-\[10px\] font-black uppercase tracking-widest border-r border-blue-400 pr-3 mr-1 opacity-90">v.*?<\/span>/g,
    `<span className="text-[10px] font-black uppercase tracking-widest border-r border-blue-400 pr-3 mr-1 opacity-90">v{appVersion}</span>`
);
fs.writeFileSync('src/components/Layout.tsx', layout);
