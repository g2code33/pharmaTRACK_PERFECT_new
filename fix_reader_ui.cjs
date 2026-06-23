const fs = require('fs');

let code = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');

// The iframe render logic
const iframeRender = `
  const renderUniversalContent = () => {
    if (isLoadingContent || !fileUrl) {
      return (
        <div className="py-40 text-center flex flex-col items-center justify-center h-full w-full">
          <Loader2 className="w-12 h-12 text-[#FFB703] mx-auto mb-4 animate-spin" />
          <p className="text-xl font-black text-gray-400 uppercase tracking-widest">Loading Material...</p>
        </div>
      );
    }

    if (currentMaterial?.fileType === 'pdf') {
      return (
        <div className="w-full flex-1 flex flex-col relative" style={{ minHeight: "85vh", height: "100%" }}>
          <iframe src={\`\${fileUrl}#toolbar=0\`} className="w-full flex-1 border-none absolute inset-0" style={{ height: "100%", width: "100%" }} />
        </div>
      );
    }

    if (['docx', 'pptx', 'text'].includes(currentMaterial?.fileType || '')) {
      const segments = currentMaterial?.contentText?.split(/--- Page \\d+ ---|### PAGE \\d+|--- Slide \\d+ ---/).filter(s => s.trim().length > 0) || [];
      return (
        <div className="w-full flex flex-col items-center p-4">
          {segments.map((seg, idx) => (
            <div key={idx} ref={el => { pageRefs.current[idx + 1] = el; }} className="w-full max-w-4xl bg-white p-12 rounded-[2.5rem] shadow-2xl border border-gray-100 min-h-[50vh] my-8 relative overflow-hidden group/page">
               <div className="absolute top-4 left-6 text-[10px] font-black text-gray-300 uppercase tracking-widest">Segment {idx + 1}</div>
               <h2 className="text-2xl font-black text-gray-800 mb-8 border-l-8 border-[#FFB703] pl-6 uppercase tracking-tight italic">{currentMaterial?.title}</h2>
               <pre className="whitespace-pre-wrap font-sans text-xl leading-relaxed text-slate-700 select-text selection:bg-[#FFB703]">{seg.trim()}</pre>
            </div>
          ))}
          {segments.length === 0 && (
             <div className="py-40 text-center text-gray-500 font-bold">No text content could be extracted from this document.</div>
          )}
        </div>
      );
    }

    if (currentMaterial?.fileType === 'jpg' || currentMaterial?.fileType === 'png') {
       return (
         <div className="w-full flex items-center justify-center p-4 bg-gray-900 h-full min-h-[85vh]">
           <img src={fileUrl} className="max-w-full shadow-2xl rounded-lg" alt="visual material" />
         </div>
       );
    }

    return null;
  };
`;

code = code.replace(/const renderUniversalContent = \(\) => \{[\s\S]*?return null;\n  \};/, iframeRender);

// Ensure fileUrl is imported and loaded
const fileUrlState = `
  const [fileUrl, setFileUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!currentMaterial) return;
    setIsLoadingContent(true);
    let isMounted = true;

    loadFile(currentMaterial.id).then(async (fileData: any) => {
      if (!isMounted) return;
      if (!fileData) {
        setIsLoadingContent(false);
        return;
      }
      
      let data;
      if (fileData instanceof Blob) {
          data = new Uint8Array(await fileData.arrayBuffer());
      } else if (fileData instanceof Uint8Array) {
          data = fileData;
      } else if (typeof fileData === 'string') {
          const base64Data = fileData.split(',')[1] || fileData;
          const binaryString = window.atob(base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
          data = bytes;
      } else {
          data = new Uint8Array(fileData);
      }
      
      const blob = new Blob([data], { type: currentMaterial.fileType === 'pdf' ? 'application/pdf' : 'application/octet-stream' });
      setFileUrl(URL.createObjectURL(blob));
      setIsLoadingContent(false);
    }).catch(err => {
      console.error(err);
      if (isMounted) setIsLoadingContent(false);
    });

    return () => { isMounted = false; };
  }, [currentMaterial]);
`;

if (!code.includes('setFileUrl')) {
  code = code.replace(
    "const [pdfTotalPages, setPdfTotalPages] = useState(0);", 
    "const [pdfTotalPages, setPdfTotalPages] = useState(0);\n" + fileUrlState
  );
}

fs.writeFileSync('src/pages/SlideReader.tsx', code);
console.log("Restored fast Iframe PDF viewer!");
