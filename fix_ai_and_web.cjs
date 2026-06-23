const fs = require('fs');

let code = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');

// 1. Restore the WebviewWindow import
code = code.replace(
  "import { open } from '@tauri-apps/plugin-shell';",
  "import { WebviewWindow } from '@tauri-apps/api/webviewWindow';"
);

// 2. Change the Pop-out function to launch a dedicated small native window
const oldOpenWeb = `const openExternalWeb = async () => {
    try {
      await open('https://chatgpt.com');
    } catch(e) {
      window.open('https://chatgpt.com', '_blank');
    }
  };`;

const newOpenWeb = `const openExternalWeb = () => {
    try {
      new WebviewWindow('ext-web', {
        url: 'https://chatgpt.com',
        title: 'PharmaTRACK Browser',
        width: 800,
        height: 600,
        alwaysOnTop: true,
      });
    } catch(e) {
      window.open('https://chatgpt.com', '_blank', 'width=800,height=600');
    }
  };`;

code = code.replace(oldOpenWeb, newOpenWeb);

// 3. Upgrade AI to Gemini 2.5 Flash
code = code.replace(/gemini-1\.5-flash/g, 'gemini-2.5-flash');

fs.writeFileSync('src/pages/SlideReader.tsx', code);
console.log('Fixed Pop-out Web and Upgraded AI to Gemini 2.5');
