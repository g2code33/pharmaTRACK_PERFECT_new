const fs = require('fs');
let code = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');

// Replace WebviewWindow with native OS shell
code = code.replace(
  "import { WebviewWindow } from '@tauri-apps/api/webviewWindow';",
  "import { open } from '@tauri-apps/plugin-shell';"
);

const oldOpenWeb = `const openExternalWeb = () => {
    try {
      new WebviewWindow('ext-web', { url: 'https://www.google.com/search?igu=1', title: 'PharmaTRACK Browser', width: 450, height: 700, x: window.innerWidth - 470, y: 100, alwaysOnTop: true });
    } catch(e) {
      window.open('https://www.google.com/search?igu=1', '_blank', 'width=450,height=700');
    }
  };`;

const newOpenWeb = `const openExternalWeb = async () => {
    try {
      await open('https://chatgpt.com');
    } catch(e) {
      window.open('https://chatgpt.com', '_blank');
    }
  };`;

code = code.replace(oldOpenWeb, newOpenWeb);

// Fix AI 404 issue by trimming the API Key
const oldAI = `const apiResponse = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=\${state.openAIKey}\`, {`;
const newAI = `const apiKey = state.openAIKey.trim();
        const apiResponse = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=\${apiKey}\`, {`;

code = code.replace(oldAI, newAI);

fs.writeFileSync('src/pages/SlideReader.tsx', code);
