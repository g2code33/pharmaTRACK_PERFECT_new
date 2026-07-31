import React from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useApp } from './context/AppContext';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import StudyMaterials from './pages/StudyMaterials';
import Highlights from './pages/Highlights';
import Login from './pages/Login';
import Courses from './pages/Courses';
import LearningObjectives from './pages/LearningObjectives';
import QuestionBank from './pages/QuestionBank';
import Quiz from './pages/Quiz';
import Planner from './pages/Planner';
import Notes from './pages/Notes';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';
import CourseDetail from './pages/CourseDetail';
import SlideReader from './pages/SlideReader';
import Timetable from './pages/Timetable';
import Profile from './pages/Profile';
import Onboarding from './pages/Onboarding';

const App = () => {
  const { state } = useApp();

  // Offline-first: the app is fully usable with no account and no internet.
  // The only thing that gates the UI is whether we know who the student is —
  // collected once by Onboarding and stored locally. Signing in is optional
  // and only unlocks cloud sync (see utils/requireAuth).
  const needsOnboarding = state.student === null;

  return (
    <HashRouter>
      <Routes>
        {needsOnboarding ? (
          // First run. No login wall: just ask their name/level so the app is
          // personalised, then let them straight in.
          <Route path="*" element={<Onboarding />} />
        ) : (
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/materials" element={<StudyMaterials />} />
            <Route path="/highlights" element={<Highlights />} />
            <Route path="/courses" element={<Courses />} />
            <Route path="/course/:courseId" element={<CourseDetail />} />
            {/* FIXED THIS ROUTE TO /read/:topicId to match your buttons! */}
            <Route path="/read/:topicId" element={<SlideReader />} />
            <Route path="/objectives" element={<LearningObjectives />} />
            <Route path="/questions" element={<QuestionBank />} />
            <Route path="/quiz" element={<Quiz />} />
            <Route path="/planner" element={<Planner />} />
            <Route path="/notes" element={<Notes />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/profile" element={<Profile />} />
            {/* Reachable on demand (e.g. from "Sign in to sync"), never forced. */}
            <Route path="/login" element={<Login />} />
            <Route path="/timetable" element={<Timetable />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Route>
        )}
      </Routes>
    </HashRouter>
  );
};

export default App;
