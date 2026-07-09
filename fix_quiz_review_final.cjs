const fs = require('fs');

let code = fs.readFileSync('src/pages/Quiz.tsx', 'utf8');

// Ensure reviewQuiz just jumps straight to the results dashboard
const oldReviewFuncRegex = /const reviewQuiz = \(history: QuizHistory\) => \{[\s\S]*?setQuizFinished\(false\);\n  \};/;
const newReviewFunc = `  const reviewQuiz = (history: QuizHistory) => {
    const qs = state.examQuestions.filter(q => history.questionsUsed.includes(q.id));
    setQuizQuestions(qs);
    
    // We recreate the answers map exactly as it was during the quiz so the Results screen can read it
    const prevAnswers = new Map();
    history.answersGiven.forEach(a => { 
       prevAnswers.set(a.questionId, { answer: a.answer, flagged: false }); 
    });
    setAnswers(prevAnswers);
    
    // Bypass the active quiz mode and jump straight to the Results screen
    setResults(history);
    setQuizStarted(true);
    setQuizFinished(true);
  };`;

if (code.match(oldReviewFuncRegex)) {
    code = code.replace(oldReviewFuncRegex, newReviewFunc);
}

// Strip out the broken interactive isReviewMode UI modifications
code = code.replace(/const \[isReviewMode, setIsReviewMode\] = useState\(false\);\n/g, '');
code = code.replace(/setIsReviewMode\(false\);\n/g, '');
code = code.replace(/\{isReviewMode && \(\n          /g, '');
code = code.replace(/          \)\}\n        <\/div>\n      \)\}/g, '        </div>\n      )}');
code = code.replace(/readOnly=\{isReviewMode\} /g, '');
code = code.replace(/\{isReviewMode \? "Exit Review" : "Finish Quiz"\}/g, '"Finish Quiz"');
code = code.replace(/onClick=\{isReviewMode \? \(\) => setQuizStarted\(false\) : finishQuiz\}/g, 'onClick={finishQuiz}');
code = code.replace(/onClick=\{\(\) => \{ if\(!isReviewMode\) saveAnswer\(currentQuestion\.id, String\(idx\)\) \}\}/g, 'onClick={() => saveAnswer(currentQuestion.id, String(idx))}');
code = code.replace(/onChange=\{\(e\) => \{ if\(!isReviewMode\) saveAnswer\(currentQuestion\.id, e\.target\.value\) \}\}/g, 'onChange={(e) => saveAnswer(currentQuestion.id, e.target.value)}');

fs.writeFileSync('src/pages/Quiz.tsx', code);

// Bump version
let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.69';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.69';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(/v1\.1\.\d+/g, 'v1.1.69');
fs.writeFileSync('src/components/Layout.tsx', layout);
