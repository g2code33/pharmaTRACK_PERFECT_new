const fs = require('fs');

let code = fs.readFileSync('src/pages/QuestionBank.tsx', 'utf8');

// Add states for selected course and topic
const stateInjection = `  const [selectedCourseId, setSelectedCourseId] = useState('');
  const [selectedTopicId, setSelectedTopicId] = useState('');

  const filteredTopics = state.topics.filter(t => t.courseId === selectedCourseId);
`;
code = code.replace("const [error, setError] = useState('');", "const [error, setError] = useState('');\n" + stateInjection);

// Update handleImport to use these states and validate them
const handleImportOld = `  const handleImport = () => {
    try {
      const parsed = JSON.parse(jsonInput);
      if (!Array.isArray(parsed)) throw new Error('JSON must be an array of objects.');
      
      const newQuestions: ExamQuestion[] = parsed.map((q: any) => {
        if (!q.question_text || !q.choices || q.correct_answer === undefined) {
          throw new Error('Missing required fields in one or more questions.');
        }
        return {
          id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
          courseId: 'imported',
          topicId: 'imported',`;

const handleImportNew = `  const handleImport = () => {
    if (!selectedCourseId || !selectedTopicId) {
      setError('Please select a specific Course and Topic before importing.');
      return;
    }

    try {
      const parsed = JSON.parse(jsonInput);
      if (!Array.isArray(parsed)) throw new Error('JSON must be an array of objects.');
      
      const newQuestions: ExamQuestion[] = parsed.map((q: any) => {
        if (!q.question_text || !q.choices || q.correct_answer === undefined) {
          throw new Error('Missing required fields in one or more questions.');
        }
        return {
          id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
          courseId: selectedCourseId,
          topicId: selectedTopicId,`;

code = code.replace(handleImportOld, handleImportNew);

// Insert dropdowns into the UI above the textarea
const uiInjection = `
            {error && <div className="mb-4 p-3 bg-red-50 text-red-600 border border-red-200 rounded-xl text-sm font-semibold">{error}</div>}

            <div className="flex gap-4 mb-4">
              <div className="flex-1">
                <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Select Course</label>
                <select 
                  value={selectedCourseId} 
                  onChange={(e) => { setSelectedCourseId(e.target.value); setSelectedTopicId(''); }}
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm focus:ring-4 focus:ring-purple-500/10 outline-none bg-slate-50"
                >
                  <option value="">-- Choose Course --</option>
                  {state.courses.map(c => (
                    <option key={c.id} value={c.id}>{c.courseCode} - {c.courseName}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Select Topic</label>
                <select 
                  value={selectedTopicId} 
                  onChange={(e) => setSelectedTopicId(e.target.value)}
                  disabled={!selectedCourseId}
                  className="w-full border border-slate-200 rounded-xl p-3 text-sm focus:ring-4 focus:ring-purple-500/10 outline-none bg-slate-50 disabled:opacity-50"
                >
                  <option value="">-- Choose Topic --</option>
                  {filteredTopics.map(t => (
                    <option key={t.id} value={t.id}>{t.topicName}</option>
                  ))}
                </select>
              </div>
            </div>
`;

code = code.replace("{error && <div className=\"mb-4 p-3 bg-red-50 text-red-600 border border-red-200 rounded-xl text-sm font-semibold\">{error}</div>}", uiInjection);

fs.writeFileSync('src/pages/QuestionBank.tsx', code);
console.log('Question Bank Updated!');
