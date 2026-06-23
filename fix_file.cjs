const fs = require('fs');

let code = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');

// Replace the PDF loader block to properly use Uint8Array which fixes Invalid PDF structure
const oldLoad = `      loadFile(currentMaterial.id).then(async (fileData: any) => {
        if (!fileData) throw new Error("File not found.");
        let data;
        if (fileData instanceof Blob) {
            data = new Uint8Array(await fileData.arrayBuffer());
        } else {
            data = fileData;
        }
        return pdfjs.getDocument({ data }).promise;
      })`;

const newLoad = `      loadFile(currentMaterial.id).then(async (fileData: any) => {
        if (!fileData) throw new Error("File not found.");
        let data;
        if (fileData instanceof Blob) {
            data = new Uint8Array(await fileData.arrayBuffer());
        } else if (fileData instanceof Uint8Array) {
            data = fileData;
        } else if (typeof fileData === 'string') {
            // Handle base64 string or data URL
            const base64Data = fileData.split(',')[1] || fileData;
            const binaryString = window.atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            data = bytes;
        } else {
            data = new Uint8Array(fileData);
        }
        return pdfjs.getDocument({ data }).promise;
      })`;

code = code.replace(oldLoad, newLoad);

// Fix StudyMaterials pdf loader too
let matCode = fs.readFileSync('src/pages/StudyMaterials.tsx', 'utf8');
const oldMatLoad = `      let data;
      if (rawData instanceof Blob) {
          data = new Uint8Array(await rawData.arrayBuffer());
      } else {
          data = rawData as Uint8Array;
      }
      const loadingTask = pdfjs.getDocument({ data });`;

const newMatLoad = `      let data;
      if (rawData instanceof Blob) {
          data = new Uint8Array(await rawData.arrayBuffer());
      } else if (typeof rawData === 'string') {
          const base64Data = rawData.split(',')[1] || rawData;
          const binaryString = window.atob(base64Data);
          data = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) data[i] = binaryString.charCodeAt(i);
      } else {
          data = rawData as Uint8Array;
      }
      const loadingTask = pdfjs.getDocument({ data });`;

matCode = matCode.replace(oldMatLoad, newMatLoad);

fs.writeFileSync('src/pages/SlideReader.tsx', code);
fs.writeFileSync('src/pages/StudyMaterials.tsx', matCode);

console.log('Fixed PDF Data parsing');
