const fs = require('fs');

// 1. Add the Logo to Analytics.tsx
let code = fs.readFileSync('src/pages/Analytics.tsx', 'utf8');
const oldHeader = `{/* Print-only Header */}\n      <div className="hidden print:block mb-8 text-center border-b-2 border-gray-800 pb-4">\n        <h1 className="text-3xl font-black text-gray-900 mb-2">PharmaTRACK Progress Report</h1>`;
const newHeader = `{/* Print-only Header */}\n      <div className="hidden print:block mb-8 text-center border-b-2 border-gray-800 pb-4">\n        <img src="/logo.png" className="h-16 mx-auto mb-4" alt="PharmaTRACK Logo" />\n        <h1 className="text-3xl font-black text-gray-900 mb-2">PharmaTRACK Progress Report</h1>`;
if (code.includes(oldHeader)) {
    code = code.replace(oldHeader, newHeader);
    fs.writeFileSync('src/pages/Analytics.tsx', code);
}

// 2. Fix the Print Layout CSS
let css = fs.readFileSync('src/index.css', 'utf8');
css = css.replace(/@media print \{[\s\S]*?\}/g, '');
const betterPrintStyles = `\n@media print {
  @page { margin: 20mm; }
  body {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    background-color: white !important;
    color: black !important;
  }
  aside, nav, header, button {
    display: none !important;
  }
  main {
    margin: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
    height: auto !important;
    background-color: white !important;
    width: 100% !important;
    position: absolute;
    top: 0;
    left: 0;
  }
  .print\\:block { display: block !important; }
  .print\\:hidden { display: none !important; }
}\n`;
fs.appendFileSync('src/index.css', betterPrintStyles);
