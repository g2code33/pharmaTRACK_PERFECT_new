/**
 * PharmTrack - Universal File Processor
 * Handles PDF, DOCX, PPTX, and Images with high reliability.
 */

import * as pdfjs from 'pdfjs-dist';
import * as mammoth from 'mammoth';
import JSZip from 'jszip';

// Set PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;

export interface FilePage {
  pageNumber: number;
  text: string;
  title: string;
}

export interface ProcessedFile {
  text: string;
  type: 'pdf' | 'docx' | 'pptx' | 'image' | 'text';
  originalFile: File;
  previewUrl: string;
  pages: FilePage[];
}

export const processAnyFile = async (file: File): Promise<ProcessedFile> => {
  const extension = file.name.toLowerCase().split('.').pop();
  
  if (extension === 'pdf') {
    return handlePDF(file);
  } else if (extension === 'docx') {
    return handleDOCX(file);
  } else if (extension === 'pptx') {
    return handlePPTX(file);
  } else if (['jpg', 'jpeg', 'png', 'webp'].includes(extension || '')) {
    return handleImage(file);
  } else {
    return handleText(file);
  }
};

const handlePDF = async (file: File): Promise<ProcessedFile> => {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  let fullText = '';
  const pages: FilePage[] = [];
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map((item: any) => item.str);
    const pageText = strings.join(' ');
    fullText += `--- Page ${i} ---\n${pageText}\n\n`;
    pages.push({
      pageNumber: i,
      text: pageText,
      title: `PDF Page ${i}`
    });
  }
  
  return {
    text: fullText,
    type: 'pdf',
    originalFile: file,
    previewUrl: URL.createObjectURL(file),
    pages
  };
};

const handleDOCX = async (file: File): Promise<ProcessedFile> => {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  const fullText = result.value;
  
  // Smart split for Word docs (every ~1500 chars or double newlines)
  const segments = fullText.split(/\n\s*\n/).filter(s => s.trim().length > 0);
  const pages: FilePage[] = [];
  
  segments.forEach((seg, idx) => {
    pages.push({
      pageNumber: idx + 1,
      text: seg,
      title: `Document Section ${idx + 1}`
    });
  });
  
  return {
    text: fullText,
    type: 'docx',
    originalFile: file,
    previewUrl: URL.createObjectURL(file),
    pages: pages.length > 0 ? pages : [{ pageNumber: 1, text: fullText, title: 'Main Document' }]
  };
};

const handlePPTX = async (file: File): Promise<ProcessedFile> => {
  const zip = await JSZip.loadAsync(file);
  let fullText = '';
  const pages: FilePage[] = [];
  
  const slideFiles = Object.keys(zip.files).filter(name => name.startsWith('ppt/slides/slide') && name.endsWith('.xml'));
  slideFiles.sort((a, b) => {
    const aNum = parseInt(a.match(/\d+/)![0]);
    const bNum = parseInt(b.match(/\d+/)![0]);
    return aNum - bNum;
  });

  for (let i = 0; i < slideFiles.length; i++) {
    const slidePath = slideFiles[i];
    const content = await zip.file(slidePath)?.async('text');
    if (content) {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(content, "text/xml");
      const texts = Array.from(xmlDoc.getElementsByTagName("a:t")).map(t => t.textContent).join(' ');
      
      if (texts.trim()) {
        const slideText = texts.trim();
        const slideIdx = i + 1;
        fullText += `--- Slide ${slideIdx} ---\n${slideText}\n\n`;
        pages.push({
          pageNumber: slideIdx,
          text: slideText,
          title: `Slide ${slideIdx}`
        });
      }
    }
  }
  
  return {
    text: fullText || "No readable text found.",
    type: 'pptx',
    originalFile: file,
    previewUrl: URL.createObjectURL(file),
    pages: pages.length > 0 ? pages : [{ pageNumber: 1, text: 'No text content', title: 'Empty Slide' }]
  };
};

const handleImage = async (file: File): Promise<ProcessedFile> => {
  return {
    text: `[Visual Material: ${file.name}]`,
    type: 'image',
    originalFile: file,
    previewUrl: URL.createObjectURL(file),
    pages: [{ pageNumber: 1, text: `Visual content: ${file.name}`, title: 'Image' }]
  };
};

const handleText = async (file: File): Promise<ProcessedFile> => {
  const text = await file.text();
  return {
    text,
    type: 'text',
    originalFile: file,
    previewUrl: URL.createObjectURL(file),
    pages: [{ pageNumber: 1, text, title: 'Text Note' }]
  };
};
