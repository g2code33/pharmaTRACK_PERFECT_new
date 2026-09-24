import React, { Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useApp } from './context/AppContext';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import StorageNoticeBanner from './components/StorageNoticeBanner';
// First paint: these three are what a student sees before anything else, so
// they stay in the main chunk.
import Dashboard from './pages/Dashboard';
import Onboarding from './pages/Onboarding';
import Login from './pages/Login';

/**
 * Everything else loads on demand. Startup was paying to parse the PDF reader,
 * the presentation renderer, the archive viewer and the charts on every visit,
 * even for a student who only opened the dashboard.
 *
 * Each import is written out in full rather than built from a template string:
 * a computed `import(`./pages/${name}`)` silently resolves to nothing at build
 * time and the pages never reach the bundle.
 */
const StudyMaterials = React.lazy(() => import('./pages/StudyMaterials'));
const Highlights = React.lazy(() => import('./pages/Highlights'));
const Courses = React.lazy(() => import('./pages/Courses'));
const LearningObjectives = React.lazy(() => import('./pages/LearningObjectives'));
const QuestionBank = React.lazy(() => import('./pages/QuestionBank'));
const Quiz = React.lazy(() => import('./pages/Quiz'));
const Planner = React.lazy(() => import('./pages/Planner'));
const Notes = React.lazy(() => import('./pages/Notes'));
const Analytics = React.lazy(() => import('./pages/Analytics'));
const Settings = React.lazy(() => import('./pages/Settings'));
const CourseDetail = React.lazy(() => import('./pages/CourseDetail'));
const SlideReader = React.lazy(() => import('./pages/SlideReader'));
const Timetable = React.lazy(() => import('./pages/Timetable'));
const Profile = React.lazy(() => import('./pages/Profile'));
const AcademicArchive = React.lazy(() => import('./pages/AcademicArchive'));
const ArchiveViewer = React.lazy(() => import('./pages/ArchiveViewer'));
const StorageManager = React.lazy(() => import('./pages/StorageManager'));
const MaterialLibrary = React.lazy(() => import('./pages/MaterialLibrary'));
const AcademicSearch = React.lazy(() => import('./pages/Search'));
const Today = React.lazy(() => import('./pages/Today'));
const Clinical = React.lazy(() => import('./pages/Clinical'));
const AiAssistant = React.lazy(() => import('./pages/AiAssistant'));
const ExaminationBuilder = React.lazy(() => import('./pages/ExaminationBuilder'));
const KioskEntry = React.lazy(() => import('./pages/KioskEntry'));
const SecureExamination = React.lazy(() => import('./pages/SecureExamination'));
const ExaminationAdmin = React.lazy(() => import('./pages/ExaminationAdmin'));

import { readWorkspaceRaw } from './utils/storage';
import { AIProvider } from './ai/state';

/** Shown only for the few hundred milliseconds a page chunk takes to arrive. */
const PageLoading: React.FC = () => (
  <div className="flex items-center justify-center py-16" data-testid="page-loading">
    <div className="w-6 h-6 border-2 border-[#2D6A4F]/20 border-t-[#2D6A4F] rounded-full animate-spin" />
  </div>
);

const App = () => {
  const { state } = useApp();

  // Offline-first: the app is fully usable with no account and no internet.
  // The only thing that gates the UI is whether we know who the student is —
  // collected once by Onboarding and stored locally. Signing in is optional
  // and only unlocks cloud sync (see utils/requireAuth).
  const needsOnboarding = state.student === null;
  // An unreadable semester file must not look like a brand-new student.
  // Onboarding would invite them to start over, and the next save would be
  // refused anyway. Show Storage until the file is readable again.
  const storageBlocked = (() => {
    const status = readWorkspaceRaw().status;
    return status === 'malformed' || status === 'unavailable';
  })();

  // AIProvider owns AI configuration + credentials for the whole app. It sits
  // inside the error boundary and outside the router, and is independent of the
  // academic state — which is why AI keys never travel with a semester backup
  // (see src/ai/credentials.ts).
  if (storageBlocked) {
    return (
      <ErrorBoundary>
        <HashRouter>
          <div className="min-h-screen bg-slate-50">
            <StorageNoticeBanner />
            <main className="p-4 sm:p-8">
              <StorageManager />
            </main>
          </div>
        </HashRouter>
      </ErrorBoundary>
    );
  }

  return (
    // Outer boundary catches anything outside the Layout (Login, Onboarding)
    // and any crash in the router itself.
    <ErrorBoundary>
      <AIProvider>
        <HashRouter>
          <Suspense fallback={<PageLoading />}>
            <Routes>
              {needsOnboarding ? (
                // First run. No login wall: just ask their name/level so the app is
                // personalised, then let them straight in.
                <Route path="*" element={<Onboarding />} />
              ) : (
                <>
                  <Route path="/examination/secure/:attemptId" element={<SecureExamination />} />
                  <Route element={<Layout />}>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/materials" element={<StudyMaterials />} />
                    <Route path="/search" element={<AcademicSearch />} />
                    <Route path="/library" element={<MaterialLibrary />} />
                    <Route path="/highlights" element={<Highlights />} />
                    <Route path="/courses" element={<Courses />} />
                    <Route path="/course/:courseId" element={<CourseDetail />} />
                    {/* FIXED THIS ROUTE TO /read/:topicId to match your buttons! */}
                    <Route path="/read/:topicId" element={<SlideReader />} />
                    <Route path="/objectives" element={<LearningObjectives />} />
                    <Route path="/questions" element={<QuestionBank />} />
                    <Route path="/quiz" element={<Quiz />} />
                    <Route path="/examinations/builder" element={<ExaminationBuilder />} />
                    <Route path="/examinations/kiosk" element={<KioskEntry />} />
                    <Route path="/examinations/admin" element={<ExaminationAdmin />} />
                    <Route path="/planner" element={<Planner />} />
                    <Route path="/learn" element={<Today />} />
                    <Route path="/clinical" element={<Clinical />} />
                    <Route path="/notes" element={<Notes />} />
                    <Route path="/analytics" element={<Analytics />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/profile" element={<Profile />} />
                    {/* Reachable on demand (e.g. from "Sign in to sync"), never forced. */}
                    <Route path="/login" element={<Login />} />
                    <Route path="/timetable" element={<Timetable />} />
                    <Route path="/ai" element={<AiAssistant />} />
                    <Route path="/archive" element={<AcademicArchive />} />
                    <Route path="/archive/:id" element={<ArchiveViewer />} />
                    <Route path="/storage" element={<StorageManager />} />
                    <Route path="*" element={<Navigate to="/" />} />
                  </Route>
                </>
              )}
            </Routes>
          </Suspense>
        </HashRouter>
      </AIProvider>
    </ErrorBoundary>
  );
};

export default App;
