const fs = require('fs');

let code = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');

const newRender = `  const renderUniversalContent = () => {
    if (isLoadingContent || !fileUrl) {
      return (
        <div className="py-40 text-center flex flex-col items-center justify-center h-full w-full">
          <Loader2 className="w-12 h-12 text-[#FFB703] mx-auto mb-4 animate-spin" />
          <p className="text-xl font-black text-gray-400 uppercase tracking-widest">Loading Material...</p>
        </div>
      );
    }

    // Use fast native iframe for PDFs and plain text
    if (['pdf', 'text'].includes(currentMaterial?.fileType || '')) {
      return (
        <div className="w-full flex-1 flex flex-col relative" style={{ minHeight: "85vh", height: "100%" }}>
          <iframe src={currentMaterial?.fileType === 'pdf' ? \`\${fileUrl}#toolbar=0\` : fileUrl} className="w-full flex-1 border-none absolute inset-0" style={{ height: "100%", width: "100%" }} />
        </div>
      );
    }

    // Use native image tag for visual files
    if (['jpg', 'png'].includes(currentMaterial?.fileType || '')) {
       return (
         <div className="w-full flex items-center justify-center p-4 bg-gray-900 h-full min-h-[85vh]">
           <img src={fileUrl} className="max-w-full shadow-2xl rounded-lg" alt="visual material" />
         </div>
       );
    }

    // Fallback for DOCX and PPTX (Offline Web browsers cannot render these inside iframes)
    return (
       <div className="flex flex-col items-center justify-center h-full w-full bg-gray-50 p-10 min-h-[85vh]">
          <File className="w-24 h-24 text-gray-300 mb-6" />
          <h2 className="text-2xl font-black text-gray-800 mb-2">Native Document Loaded</h2>
          <p className="text-gray-500 mb-8 max-w-sm text-center">Web browsers cannot display Word or PowerPoint files directly. Please click below to open it in Microsoft Office.</p>
          <a href={fileUrl} download={currentMaterial.title} className="bg-[#2D6A4F] text-white px-8 py-4 rounded-2xl font-bold text-lg shadow-xl hover:bg-[#1B4332] flex items-center gap-3">
            <Download className="w-6 h-6" /> Open Document
          </a>
       </div>
    );
  };`;

code = code.replace(/const renderUniversalContent = \(\) => \{[\s\S]*?return null;\n  \};/, newRender);

fs.writeFileSync('src/pages/SlideReader.tsx', code);
console.log("Replaced with simple iframe viewer.");
