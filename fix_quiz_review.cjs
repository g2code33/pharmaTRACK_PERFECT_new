const fs = require('fs');

let quiz = fs.readFileSync('src/pages/Quiz.tsx', 'utf8');

// 1. Add review state
if (!quiz.includes('isReviewMode')) {
    quiz = quiz.replace(
      'const [quizStarted, setQuizStarted] = useState(false);',
      'const [quizStarted, setQuizStarted] = useState(false);\n  const [isReviewMode, setIsReviewMode] = useState(false);'
    );
}

// 2. Modify startQuiz to clear review mode
quiz = quiz.replace(
    'setQuizStarted(true);\n    setQuizFinished(false);\n    setResults(null);',
    'setQuizStarted(true);\n    setQuizFinished(false);\n    setResults(null);\n    setIsReviewMode(false);'
);

// 3. Add reviewQuiz function
const reviewQuizFunc = `
  const reviewQuiz = (history) => {
    const qs = state.examQuestions.filter(q => history.questionsUsed.includes(q.id));
    setQuizQuestions(qs);
    const prevAnswers = new Map();
    history.answersGiven.forEach(a => { prevAnswers.set(a.questionId, { answer: a.answer, flagged: false }); });
    setAnswers(prevAnswers);
    setCurrentIndex(0);
    setIsReviewMode(true);
    setQuizStarted(true);
    setQuizFinished(false);
  };
`;
if (!quiz.includes('reviewQuiz')) {
    quiz = quiz.replace('const startQuiz = () => {', reviewQuizFunc + '\n  const startQuiz = () => {');
}

// 4. Add Review button to Recent Quizzes UI
const oldRecentUI = `                  <div
                    key={quiz.id}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                  >
                    <div>
                      <p className="font-medium text-gray-800">
                        {course?.courseCode || 'Mixed'} - {quiz.questionsUsed.length} questions
                      </p>
                      <p className="text-sm text-gray-500">
                        {new Date(quiz.completedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div
                      className={\`text-lg font-bold \${
                        quiz.scorePercentage >= 70
                          ? 'text-green-600'
                          : quiz.scorePercentage >= 50
                          ? 'text-yellow-600'
                          : 'text-red-600'
                      }\`}
                    >
                      {quiz.scorePercentage}%
                    </div>
                  </div>`;

const newRecentUI = `                  <div
                    key={quiz.id}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                  >
                    <div>
                      <p className="font-medium text-gray-800">
                        {course?.courseCode || 'Mixed'} - {quiz.questionsUsed.length} questions
                      </p>
                      <p className="text-sm text-gray-500">
                        {new Date(quiz.completedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div
                        className={\`text-lg font-bold \${
                          quiz.scorePercentage >= 70
                            ? 'text-green-600'
                            : quiz.scorePercentage >= 50
                            ? 'text-yellow-600'
                            : 'text-red-600'
                        }\`}
                      >
                        {quiz.scorePercentage}%
                      </div>
                      <button onClick={() => reviewQuiz(quiz)} className="text-sm font-bold text-[#2D6A4F] bg-[#2D6A4F]/10 px-3 py-1.5 rounded-lg hover:bg-[#2D6A4F]/20 transition-colors">Review</button>
                    </div>
                  </div>`;

if (quiz.includes(oldRecentUI)) {
    quiz = quiz.replace(oldRecentUI, newRecentUI);
}

// 5. Hide Model Answer button if not in review mode
const oldModelAnswer = `<div className="mt-6 pt-4 border-t">
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
          </div>`;

const newModelAnswer = `{isReviewMode && (
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
if (quiz.includes(oldModelAnswer)) quiz = quiz.replace(oldModelAnswer, newModelAnswer);

// Adjust navigation for review mode
quiz = quiz.replace('onClick={finishQuiz}', 'onClick={isReviewMode ? () => setQuizStarted(false) : finishQuiz}');
quiz = quiz.replace('Finish Quiz', '{isReviewMode ? "Exit Review" : "Finish Quiz"}');
quiz = quiz.replace(/onClick=\{\(\) => saveAnswer\(currentQuestion\.id, String\(idx\)\)\}/g, 'onClick={() => { if(!isReviewMode) saveAnswer(currentQuestion.id, String(idx)) }}');
quiz = quiz.replace(/onChange=\{\(e\) => saveAnswer\(currentQuestion\.id, e\.target\.value\)\}/g, 'onChange={(e) => { if(!isReviewMode) saveAnswer(currentQuestion.id, e.target.value) }}');
quiz = quiz.replace('placeholder="Type your answer here..."', 'placeholder="Type your answer here..." readOnly={isReviewMode}');

fs.writeFileSync('src/pages/Quiz.tsx', quiz);
console.log('Quiz and UX Fixed!');

// BUMP VERSION
let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.66';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.66';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(/v1\.\d+\.\d+/g, 'v1.1.66');
fs.writeFileSync('src/components/Layout.tsx', layout);
