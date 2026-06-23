const fs = require('fs');
let code = fs.readFileSync('src/pages/StudyMaterials.tsx', 'utf8');

// Enable .pptx and .docx uploads correctly in both regular and bulk uploads
code = code.replace(/accept="\.pdf,image\/\*"/g, 'accept=".pdf,.docx,.pptx,image/*"');
code = code.replace(/accept=\{\(slideForm.fileType as any\) === 'text' \? '\.docx' : 'image\/\*'\}/g, 'accept=".pdf,.docx,.pptx,image/*"');

fs.writeFileSync('src/pages/StudyMaterials.tsx', code);
console.log('Fixed upload restrictions');
