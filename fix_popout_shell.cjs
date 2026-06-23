const fs = require('fs');

let code = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');

const oldOpen = `const openExternalWeb = async () => {\n    try {\n      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');\n      const win = new WebviewWindow('browser-' + Date.now(), {\n        url: 'https://chatgpt.com',\n        title: 'PharmaTRACK AI Browser',\n        width: 800,\n        height: 600,\n        alwaysOnTop: true\n      });\n      win.once('tauri://error', (e) => {\n        console.error('Webview Error:', e);\n        window.open('https://chatgpt.com', '_blank');\n      });\n    } catch(e) {\n      console.error('Catch Error:', e);\n      window.open('https://chatgpt.com', '_blank');\n    }\n  };`;

const newOpen = `const openExternalWeb = async () => {\n    try {\n      const { open } = await import('@tauri-apps/plugin-shell');\n      await open('https://chatgpt.com');\n    } catch(e) {\n      console.error('Shell Open Error:', e);\n      window.open('https://chatgpt.com', '_blank');\n    }\n  };`;

code = code.replace(oldOpen, newOpen);
fs.writeFileSync('src/pages/SlideReader.tsx', code);
