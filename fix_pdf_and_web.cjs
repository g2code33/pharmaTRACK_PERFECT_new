const fs = require('fs');
let code = fs.readFileSync('/home/user/pharmatrack_perfect/src/pages/SlideReader.tsx', 'utf8');

// Fix 1: Make the PDF iframe properly expand in flex containers
const oldIframe = `<div className="w-full h-full relative">
          <iframe src={\`\${fileUrl}#toolbar=0\`} className="w-full h-full border-none" />
        </div>`;
const newIframe = `<div className="w-full flex-1 flex flex-col" style={{ minHeight: "85vh" }}>
          <iframe src={\`\${fileUrl}#toolbar=0\`} className="w-full flex-1 border-none" />
        </div>`;
code = code.replace(oldIframe, newIframe);

// Fix 2: Add fallback for Pop-out Web so it works in Chrome too
const oldWeb = `new WebviewWindow('ext-web', {
      url: 'https://www.google.com/search?igu=1',
      title: 'PharmaTRACK Browser',
      width: 450,
      height: 700,
      x: window.innerWidth - 470,
      y: 100,
      alwaysOnTop: true,
    });`;
const newWeb = `try {
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
    }`;
code = code.replace(oldWeb, newWeb);

fs.writeFileSync('/home/user/pharmatrack_perfect/src/pages/SlideReader.tsx', code);
console.log('Fixed PDF and Web button!');
