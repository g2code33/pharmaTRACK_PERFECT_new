const fs = require('fs');

let code = fs.readFileSync('src/pages/Quiz.tsx', 'utf8');

const badBlock1 = `{isReviewMode && (
                    {isReviewMode && (
          <div className="mt-6 pt-4 border-t">
            <button
              onClick={() => setShowAnswer(!showAnswer)}
              className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
            >
              {showAnswer ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              {showAnswer ? 'Hide Answer' : 'Show Model Answer'}
            </button>
            {showAnswer && (
              <div className="mt-3 p-4 bg-blue-50 rounded-lg">
                <p className="text-gray-700">{currentQuestion.modelAnswer}</p>
              </div>
            )}
          </div>
          )}
          )}`;

const goodBlock1 = `          {isReviewMode && (
          <div className="mt-6 pt-4 border-t">
            <button
              onClick={() => setShowAnswer(!showAnswer)}
              className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
            >
              {showAnswer ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              {showAnswer ? 'Hide Answer' : 'Show Model Answer'}
            </button>
            {showAnswer && (
              <div className="mt-3 p-4 bg-blue-50 rounded-lg">
                <p className="text-gray-700">{currentQuestion.modelAnswer}</p>
              </div>
            )}
          </div>
          )}`;

if (code.includes(badBlock1)) code = code.replace(badBlock1, goodBlock1);

// Fix duplicated readOnly attribute
code = code.replace(/readOnly=\{isReviewMode\} readOnly=\{isReviewMode\}/g, "readOnly={isReviewMode}");

// Fix the nested string syntax that crashed Vite
code = code.replace(
  `{isReviewMode ? "Exit Review" : "{isReviewMode ? "Exit Review" : "Finish Quiz"}"}`,
  `{isReviewMode ? "Exit Review" : "Finish Quiz"}`
);

fs.writeFileSync('src/pages/Quiz.tsx', code);

// Bump to v1.1.68
let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.68';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.68';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(/v1\.1\.\d+/g, 'v1.1.68');
fs.writeFileSync('src/components/Layout.tsx', layout);

