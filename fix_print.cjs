const fs = require('fs');
let code = fs.readFileSync('src/pages/Analytics.tsx', 'utf8');

if (!code.includes('Printer')) {
    code = code.replace('Award,', 'Award,\n  Printer,');
}

const headerInjection = `      {/* Print-only Header */}
      <div className="hidden print:block mb-8 text-center border-b-2 border-gray-800 pb-4">
        <h1 className="text-3xl font-black text-gray-900 mb-2">PharmaTRACK Progress Report</h1>
        <div className="grid grid-cols-2 gap-4 text-left text-sm mt-6 mb-2 mx-auto max-w-2xl bg-gray-50 p-4 rounded-lg border border-gray-200">
           <div><span className="font-bold text-gray-500">Student Name:</span> <span className="font-semibold text-gray-800">{state.student?.name || 'N/A'}</span></div>
           <div><span className="font-bold text-gray-500">University:</span> <span className="font-semibold text-gray-800">{state.student?.university || 'N/A'}</span></div>
           <div><span className="font-bold text-gray-500">Program:</span> <span className="font-semibold text-gray-800">{state.student?.program || 'N/A'}</span></div>
           <div><span className="font-bold text-gray-500">Level/Semester:</span> <span className="font-semibold text-gray-800">{state.student?.level || 'N/A'} / {state.student?.semester || 'N/A'}</span></div>
        </div>
        <p className="text-xs font-bold text-gray-400 mt-4 text-right">Generated on: {new Date().toLocaleDateString()}</p>
      </div>

      {/* Screen Header */}`;

if (!code.includes('PharmaTRACK Progress Report')) {
    code = code.replace('{/* Header */}', headerInjection);
}

const printButton = `        <div className="flex gap-2 print:hidden">
          <button 
            onClick={() => {
              const originalTitle = document.title;
              document.title = \`PharmaTRACK_Progress_\${state.student?.name?.replace(/\\s+/g, '_') || 'Report'}_\${new Date().toISOString().split('T')[0]}\`;
              window.print();
              document.title = originalTitle;
            }} 
            className="flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg text-sm font-bold shadow-md hover:bg-[#1B4332] transition-colors"
          >
            <Printer className="w-4 h-4" /> Print Report
          </button>
          {(['7d', '30d', 'all'] as const).map((range) => (`;

if (!code.includes('window.print()')) {
    code = code.replace(/<div className="flex gap-2">\s*\{\(\['7d', '30d', 'all'\] as const\)\.map\(\(range\) => \(/, printButton);
}

fs.writeFileSync('src/pages/Analytics.tsx', code);

let css = fs.readFileSync('src/index.css', 'utf8');
const printStyles = `
@media print {
  body {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    background-color: white !important;
  }
  aside {
    display: none !important;
  }
  header {
    display: none !important;
  }
  main {
    margin: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
    height: auto !important;
    background-color: white !important;
  }
  .print\\:block {
    display: block !important;
  }
  .print\\:hidden {
    display: none !important;
  }
}
`;
if (!css.includes('@media print')) {
  fs.appendFileSync('src/index.css', printStyles);
}
