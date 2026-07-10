const fs = require('fs');

// Fix 1: Debounce saveState in AppContext.tsx to stop UI freezing on large states
let appCtx = fs.readFileSync('src/context/AppContext.tsx', 'utf8');

const oldSaveState = `  useEffect(() => {
    if (state.student !== null || state.courses.length > 0) {
      saveState(state);
    }
  }, [state]);`;

const newSaveState = `  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (state.student !== null || state.courses.length > 0) {
        saveState(state);
      }
    }, 1000); // Debounce saves by 1 second to prevent UI freezing
    return () => clearTimeout(timeoutId);
  }, [state]);`;

appCtx = appCtx.replace(oldSaveState, newSaveState);
fs.writeFileSync('src/context/AppContext.tsx', appCtx);

// Fix 2: Prevent memory leaks from Blob URLs in SlideReader
let slideReader = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');

const oldBlobLoader = `      const blob = new Blob([data], { type: currentMaterial.fileType === 'pdf' ? 'application/pdf' : 'application/octet-stream' });
      setFileUrl(URL.createObjectURL(blob));
      setIsLoadingContent(false);
    }).catch(err => {
      console.error(err);
      if (isMounted) setIsLoadingContent(false);
    });

    return () => { isMounted = false; };
  }, [currentMaterial]);`;

const newBlobLoader = `      const blob = new Blob([data], { type: currentMaterial.fileType === 'pdf' ? 'application/pdf' : 'application/octet-stream' });
      const newUrl = URL.createObjectURL(blob);
      setFileUrl(newUrl);
      setIsLoadingContent(false);
    }).catch(err => {
      console.error(err);
      if (isMounted) setIsLoadingContent(false);
    });

    return () => { 
      isMounted = false; 
      setFileUrl(prevUrl => {
         if (prevUrl) URL.revokeObjectURL(prevUrl);
         return null;
      });
    };
  }, [currentMaterial]);`;

slideReader = slideReader.replace(/const blob = new Blob[\s\S]*?return \(\) => \{ isMounted = false; \};\n  \}, \[currentMaterial\]\);/, newBlobLoader);
fs.writeFileSync('src/pages/SlideReader.tsx', slideReader);

// Fix 3: Fix Quiz interval dependency loop which causes CPU spikes
let quiz = fs.readFileSync('src/pages/Quiz.tsx', 'utf8');
const oldInterval = `  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    if (quizStarted && settings.timed && timeRemaining > 0 && !quizFinished) {
      timer = setInterval(() => {
        setTimeRemaining((prev) => {
          if (prev <= 1) { finishQuiz(); return 0; }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [quizStarted, settings.timed, timeRemaining, quizFinished]);`;

const newInterval = `  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    if (quizStarted && settings.timed && !quizFinished) {
      timer = setInterval(() => {
        setTimeRemaining((prev) => {
          if (prev <= 1) { 
             clearInterval(timer);
             setTimeout(() => finishQuiz(), 0);
             return 0; 
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [quizStarted, settings.timed, quizFinished]);`;

if (quiz.includes('timer = setInterval(() => {') && quiz.includes('[quizStarted, settings.timed, timeRemaining, quizFinished]')) {
    quiz = quiz.replace(oldInterval, newInterval);
    fs.writeFileSync('src/pages/Quiz.tsx', quiz);
}

// BUMP VERSION
let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.71';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.71';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(/v1\.1\.\d+/g, 'v1.1.71');
fs.writeFileSync('src/components/Layout.tsx', layout);
