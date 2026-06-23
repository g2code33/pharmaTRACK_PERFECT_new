/**
 * PharmTrack - Ultra-Reliable Word Document Processor
 * Uses mammoth.js for clean, reliable .docx parsing
 */

import * as mammoth from 'mammoth';

export interface WordDocumentResult {
  text: string;
  html: string;
  messages: Array<{ type: string; message: string }>;
  pages: Array<{
    pageNumber: number;
    content: string;
    html: string;
  }>;
}

// Parse Word document to text and HTML
export const parseWordDocument = async (file: File): Promise<WordDocumentResult> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = async (loadEvent) => {
      try {
        const arrayBuffer = loadEvent.target?.result as ArrayBuffer;
        
        // Parse with mammoth
        const result = await mammoth.extractRawText({ arrayBuffer });
        const htmlResult = await mammoth.convertToHtml({ arrayBuffer });
        
        // Split into pages (approximate by paragraphs)
        const paragraphs = result.value.split(/\n\s*\n/).filter(p => p.trim().length > 0);
        const pageSize = 15; // Approximate paragraphs per page
        const pages: WordDocumentResult['pages'] = [];
        
        for (let i = 0; i < paragraphs.length; i += pageSize) {
          const pageParagraphs = paragraphs.slice(i, i + pageSize);
          pages.push({
            pageNumber: Math.floor(i / pageSize) + 1,
            content: pageParagraphs.join('\n\n'),
            html: pageParagraphs.map(p => `<p>${p}</p>`).join(''),
          });
        }
        
        // If no pages detected, create one
        if (pages.length === 0) {
          pages.push({
            pageNumber: 1,
            content: result.value,
            html: htmlResult.value,
          });
        }
        
        resolve({
          text: result.value,
          html: htmlResult.value,
          messages: result.messages.concat(htmlResult.messages),
          pages,
        });
      } catch (err) {
        reject(err);
      }
    };
    
    reader.onerror = () => {
      reject(new Error('Failed to read Word document'));
    };
    
    reader.readAsArrayBuffer(file);
  });
};

// Validate Word document
export const validateWordDocument = async (file: File): Promise<boolean> => {
  try {
    // Check file extension
    const ext = file.name.toLowerCase().split('.').pop();
    if (ext !== 'docx') {
      return false;
    }
    
    // Check file size (minimum 1KB for valid .docx)
    if (file.size < 1024) {
      return false;
    }
    
    // Try to parse first few bytes (DOCX files are ZIP files)
    const startBytes = file.slice(0, 4);
    const buffer = await startBytes.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    
    // ZIP files (including .docx) start with PK (0x50 0x4B 0x03 0x04)
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) {
      return false;
    }
    
    // Try to parse with mammoth
    const result = await parseWordDocument(file);
    return result.text.length > 0;
  } catch {
    return false;
  }
};

// Extract plain text from Word document
export const extractWordText = async (file: File): Promise<string> => {
  const result = await parseWordDocument(file);
  return result.text;
};

// Convert Word document to clean HTML for display
export const wordToCleanHTML = async (file: File): Promise<string> => {
  const result = await parseWordDocument(file);
  
  // Clean up the HTML for better display
  let html = result.html
    .replace(/<p>\s*<\/p>/g, '') // Remove empty paragraphs
    .replace(/<br\s*\/?>/g, '<br />') // Normalize line breaks
    .replace(/<div/g, '<p') // Convert divs to paragraphs
    .replace(/<\/div>/g, '</p>');
  
  return html;
};

// Split Word document into sections (for slide-like viewing)
export const splitWordIntoSections = async (file: File): Promise<Array<{
  title: string;
  content: string;
  pageNumber: number;
}>> => {
  const result = await parseWordDocument(file);
  const sections: Array<{ title: string; content: string; pageNumber: number }> = [];
  
  // Split by headings or large paragraphs
  const lines = result.text.split('\n');
  let currentSection = { title: '', content: '', pageNumber: 1 };
  let lineCount = 0;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // Check if this looks like a heading (short line, possibly all caps or title case)
    const isHeading = trimmed.length < 100 && (
      trimmed === trimmed.toUpperCase() || 
      /^[A-Z][a-z]+(\s+[A-Z][a-z]+)*$/.test(trimmed) ||
      trimmed.endsWith(':')
    );
    
    if (isHeading && currentSection.content.length > 0) {
      // Save current section and start new one
      sections.push({ ...currentSection });
      currentSection = {
        title: trimmed,
        content: '',
        pageNumber: Math.floor(lineCount / 20) + 1,
      };
    } else {
      currentSection.content += trimmed + '\n';
    }
    
    lineCount++;
    
    // Create new section every ~500 characters for better readability
    if (currentSection.content.length > 500) {
      sections.push({ ...currentSection });
      currentSection = {
        title: `Continued...`,
        content: '',
        pageNumber: Math.floor(lineCount / 20) + 1,
      };
    }
  }
  
  // Add final section
  if (currentSection.content.length > 0 || currentSection.title) {
    sections.push(currentSection);
  }
  
  // If no sections created, make one big section
  if (sections.length === 0) {
    sections.push({
      title: file.name.replace('.docx', ''),
      content: result.text,
      pageNumber: 1,
    });
  }
  
  return sections;
};
