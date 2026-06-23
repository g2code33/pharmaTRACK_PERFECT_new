const fs = require('fs');

const fixFile = (filePath) => {
    let code = fs.readFileSync(filePath, 'utf8');
    
    // Replace the CDN worker link with a reliable local import
    code = code.replace(
        "pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;",
        "// Offline-first worker initialization\\n" +
        "import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';\\n" +
        "pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;"
    );

    fs.writeFileSync(filePath, code);
    console.log('Fixed', filePath);
};

fixFile('src/pages/SlideReader.tsx');
fixFile('src/pages/StudyMaterials.tsx');
