const fs = require('fs');

let code = fs.readFileSync('src/pages/Quiz.tsx', 'utf8');

if (!code.includes('const [isReviewMode, setIsReviewMode]')) {
    code = code.replace(
      'const [quizStarted, setQuizStarted] = useState(false);',
      'const [quizStarted, setQuizStarted] = useState(false);\n  const [isReviewMode, setIsReviewMode] = useState(false);'
    );
    fs.writeFileSync('src/pages/Quiz.tsx', code);
}

// Bump version
let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.70';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.70';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(/v1\.1\.\d+/g, 'v1.1.70');
fs.writeFileSync('src/components/Layout.tsx', layout);
