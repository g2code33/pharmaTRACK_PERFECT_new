const fs = require('fs');
let code = fs.readFileSync('src/pages/StudyMaterials.tsx', 'utf8');

const regex = /import \{[\s\S]*?\} from 'lucide-react';/;
const oldImports = code.match(regex)[0];
if (!oldImports.includes('Cloud')) {
    const newImports = oldImports.replace('Loader2,', 'Loader2,\n  Cloud,');
    code = code.replace(oldImports, newImports);
}

fs.writeFileSync('src/pages/StudyMaterials.tsx', code);
console.log('Fixed imports in StudyMaterials');
