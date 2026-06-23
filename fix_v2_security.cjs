const fs = require('fs');

// 1. Fix Tauri V2 Permissions (Capabilities)
const capPath = 'src-tauri/capabilities/migrated.json';
if (fs.existsSync(capPath)) {
    let cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));
    cap.permissions = cap.permissions || [];
    const requiredPermissions = [
        "updater:default",
        "updater:allow-check",
        "updater:allow-download-and-install",
        "core:window:default",
        "core:window:allow-create",
        "core:webview:allow-create-webview",
        "core:window:allow-set-always-on-top"
    ];
    requiredPermissions.forEach(p => {
        if (!cap.permissions.includes(p)) cap.permissions.push(p);
    });
    fs.writeFileSync(capPath, JSON.stringify(cap, null, 2));
}

// 2. Refine the Pop-out window in SlideReader
const readerPath = 'src/pages/SlideReader.tsx';
if (fs.existsSync(readerPath)) {
    let code = fs.readFileSync(readerPath, 'utf8');
    const newOpen = `const openExternalWeb = async () => {\n    try {\n      const win = new WebviewWindow('browser-' + Date.now(), {\n        url: 'https://chatgpt.com',\n        title: 'PharmaTRACK Browser',\n        width: 800,\n        height: 600,\n        alwaysOnTop: true\n      });\n    } catch(e) {\n      window.open('https://chatgpt.com', '_blank', 'width=800,height=600');\n    }\n  };\n`;
    code = code.replace(/const openExternalWeb = \(\) => \{[\s\S]*? \};\n/g, newOpen);
    fs.writeFileSync(readerPath, code);
}
console.log('Fixed permissions and WebviewWindow!');
