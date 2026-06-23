const fs = require('fs');

function fixReader() {
    let code = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');
    
    // Fix pdfjs blob handling
    const badLoad = `loadFile(currentMaterial.id).then(async (fileData: any) => {
        if (!fileData) throw new Error("File not found.");
        const data = fileData instanceof Uint8Array ? fileData : fileData;
        return pdfjs.getDocument({ data }).promise;
      })`;
      
    const goodLoad = `loadFile(currentMaterial.id).then(async (fileData: any) => {
        if (!fileData) throw new Error("File not found.");
        let data;
        if (fileData instanceof Blob) {
            data = new Uint8Array(await fileData.arrayBuffer());
        } else {
            data = fileData;
        }
        return pdfjs.getDocument({ data }).promise;
      })`;

    code = code.replace(badLoad, goodLoad);
    fs.writeFileSync('src/pages/SlideReader.tsx', code);
}

function fixMaterials() {
    let code = fs.readFileSync('src/pages/StudyMaterials.tsx', 'utf8');
    
    const badLoad = `// rawData is Uint8Array from our storage system
      const data = rawData;

      const loadingTask = pdfjs.getDocument({ data: data as Uint8Array });`;
      
    const goodLoad = `let data;
      if (rawData instanceof Blob) {
          data = new Uint8Array(await rawData.arrayBuffer());
      } else {
          data = rawData as Uint8Array;
      }
      const loadingTask = pdfjs.getDocument({ data });`;

    code = code.replace(badLoad, goodLoad);
    fs.writeFileSync('src/pages/StudyMaterials.tsx', code);
}

fixReader();
fixMaterials();
console.log('Fixed PDF Blob conversions!');
