const fs = require('fs');
let code = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');

const oldOpenWeb = `const openExternalWeb = async () => {
    try {
      await open('https://chatgpt.com');
    } catch(e) {
      window.open('https://chatgpt.com', '_blank');
    }
  };`;

const oldOpenWeb2 = `const openExternalWeb = () => {
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

const correctWeb = `const openExternalWeb = () => {
    try {
      new WebviewWindow('ext-web', {
        url: 'https://www.google.com/search?igu=1',
        title: 'PharmaTRACK Browser',
        width: 450,
        height: 700,
        x: window.innerWidth - 470,
        y: 100,
        alwaysOnTop: true,
      });
    } catch(e) {
      window.open('https://www.google.com/search?igu=1', '_blank', 'width=450,height=700');
    }
  };`;

if (code.includes(oldOpenWeb)) code = code.replace(oldOpenWeb, correctWeb);
if (code.includes(oldOpenWeb2)) code = code.replace(oldOpenWeb2, correctWeb);

fs.writeFileSync('src/pages/SlideReader.tsx', code);
console.log('Pop-out Web Forcefully Corrected!');
