import React, { Suspense, useEffect, useState } from 'react';
import { lazyRoute, prefetchLikelyRoutes } from './utils/routeLoader';
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from './context/AppContext';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import StorageNoticeBanner from './components/StorageNoticeBanner';
// First paint: these three are what a student sees before anything else, so
// they stay in the main chunk.
import Dashboard from './pages/Dashboard';
import Onboarding from './pages/Onboarding';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';

/**
 * Everything else loads on demand. Startup was paying to parse the PDF reader,
 * the presentation renderer, the archive viewer and the charts on every visit,
 * even for a student who only opened the dashboard.
 *
 * Each import is written out in full rather than built from a template string:
 * a computed `import(`./pages/${name}`)` silently resolves to nothing at build
 * time and the pages never reach the bundle.
 */
const StudyMaterials = lazyRoute('/materials', () => import('./pages/StudyMaterials'));
const Highlights = lazyRoute('/highlights', () => import('./pages/Highlights'));
const Courses = lazyRoute('/courses', () => import('./pages/Courses'));
const LearningObjectives = lazyRoute('/objectives', () => import('./pages/LearningObjectives'));
const QuestionBank = lazyRoute('/questions', () => import('./pages/QuestionBank'));
const Quiz = lazyRoute('/quiz', () => import('./pages/Quiz'));
const QuickQuiz = lazyRoute('/quick-quiz', () => import('./pages/QuickQuiz'));
const Planner = lazyRoute('/planner', () => import('./pages/Planner'));
const Notes = lazyRoute('/notes', () => import('./pages/Notes'));
const Analytics = lazyRoute('/analytics', () => import('./pages/Analytics'));
const Settings = lazyRoute('/settings', () => import('./pages/Settings'));
const CourseDetail = lazyRoute('/course', () => import('./pages/CourseDetail'));
const SlideReader = lazyRoute('/read', () => import('./pages/SlideReader'));
const Timetable = lazyRoute('/timetable', () => import('./pages/Timetable'));
const Profile = lazyRoute('/profile', () => import('./pages/Profile'));
const AcademicArchive = lazyRoute('/archive', () => import('./pages/AcademicArchive'));
const ArchiveViewer = lazyRoute('/archive-viewer', () => import('./pages/ArchiveViewer'));
const StorageManager = lazyRoute('/storage', () => import('./pages/StorageManager'));
const MaterialLibrary = lazyRoute('/library', () => import('./pages/MaterialLibrary'));
const AcademicSearch = lazyRoute('/search', () => import('./pages/Search'));
const Today = lazyRoute('/learn', () => import('./pages/Today'));
const Clinical = lazyRoute('/clinical', () => import('./pages/Clinical'));
const AiAssistant = lazyRoute('/ai', () => import('./pages/AiAssistant'));
const ExaminationBuilder = lazyRoute('/examinations/builder', () => import('./pages/ExaminationBuilder'));
const KioskEntry = lazyRoute('/examinations/kiosk', () => import('./pages/KioskEntry'));
const SecureExamination = lazyRoute('/examination/secure', () => import('./pages/SecureExamination'));
const ExaminationAdmin = lazyRoute('/examinations/admin', () => import('./pages/ExaminationAdmin'));

import { readWorkspaceRaw } from './utils/storage';
import {
  consumePendingQuickQuiz,
  registerQuickQuizProtocolHandler,
  routeFromPharmaTrackDeepLink,
} from './utils/appLinks';
import {
  detectRuntimeCapabilities,
  isPWAStandalone,
  listenNative,
  nativeInvoke,
} from './platform/runtime';
import { AIProvider } from './ai/state';
import {
  getSecureKioskState,
  recordBlockedKioskNavigation,
  subscribeSecureKiosk,
} from './examination/kioskState';
import { consumeAndroidPharmaExamLaunch } from './examination/androidAdapter';
import { consumePharmaExamLaunches } from './examination/nativeKiosk';
import { queuePharmaExamLaunch } from './examination/packageLaunch';

const workspaceIsBlocked = (): boolean => {
  const status = readWorkspaceRaw().status;
  return status === 'malformed' || status === 'unavailable';
};

/** Central application gate: hiding links is not security. */
const SecureExamRouteGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const [kiosk, setKiosk] = useState(getSecureKioskState());
  useEffect(() => subscribeSecureKiosk(setKiosk), []);
  const activeSecurePath = kiosk.attemptId ? `/examination/secure/${kiosk.attemptId}` : '';
  const selectedRouteBlocked = kiosk.blockedRoutes.some(
    (prefix) => location.pathname === prefix || location.pathname.startsWith(`${prefix}/`),
  );
  if (
    kiosk.active &&
    (kiosk.fullLockdown || selectedRouteBlocked) &&
    location.pathname !== activeSecurePath
  ) {
    recordBlockedKioskNavigation(location.pathname);
    return <Navigate to={activeSecurePath || '/examinations/kiosk'} replace />;
  }
  return <>{children}</>;
};

/** App-level routing is needed because a file association can launch the app on Dashboard. */
const ExamLaunchRouter: React.FC = () => {
  const navigate = useNavigate();
  useEffect(() => {
    let disposed = false;
    let cleanupNative: () => void = () => undefined;
    const route = () => navigate('/examinations/kiosk');
    void consumePharmaExamLaunches((path) => {
      if (!disposed) {
        queuePharmaExamLaunch({ path });
        route();
      }
    }).then((cleanup) => {
      cleanupNative = cleanup;
    });
    void consumeAndroidPharmaExamLaunch((bytes) => {
      if (!disposed) {
        queuePharmaExamLaunch({ bytes });
        route();
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      cleanupNative();
    };
  }, [navigate]);
  return null;
};

/** Routes custom app links (pharmatrack://q/...) into the already-open desktop app. */
const NativeAppLinkRouter: React.FC = () => {
  const navigate = useNavigate();
  useEffect(() => {
    let disposed = false;
    let cleanupNative: (() => void) | undefined;
    const route = (value: string) => {
      const path = routeFromPharmaTrackDeepLink(value);
      if (!disposed && path) navigate(path);
    };

    void nativeInvoke<string[]>('get_pending_pharmatrack_links')
      .then((links) => links?.forEach(route))
      .catch(() => undefined);
    void listenNative<string[]>('pharmatrack-deep-link-opened', (event) => {
      event.payload.forEach(route);
    }).then((cleanup) => {
      cleanupNative = cleanup;
    });

    return () => {
      disposed = true;
      cleanupNative?.();
    };
  }, [navigate]);
  return null;
};

const AppLinkRedirect: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const raw = new URLSearchParams(location.search).get('url') || '';
    const route = routeFromPharmaTrackDeepLink(raw) || '/';
    navigate(route, { replace: true });
  }, [location.search, navigate]);
  return <PageLoading />;
};

/**
 * A quick quiz opened in the browser can be continued inside the installed
 * app. Installed PWAs and desktop apps share storage with the browser profile
 * that handed the quiz over, so the first launch after "Open in app" lands
 * straight on the quiz instead of the dashboard.
 */
const PendingQuickQuizLauncher: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const runtime = detectRuntimeCapabilities();
    // Only the installed experiences claim a pending quiz; a plain browser tab
    // already has the link it was opened with.
    if (!runtime.isPWA && !runtime.nativeHost) return;
    const alreadyOnQuiz =
      location.pathname.startsWith('/quick-quiz') || location.pathname.startsWith('/q/');
    if (alreadyOnQuiz) return;
    const pending = consumePendingQuickQuiz();
    if (pending) navigate(pending, { replace: true });
    // Only the first render of a launch should claim a pending quiz.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isPWAStandalone()) return;
    try {
      if (window.localStorage.getItem('pharmatrack:protocol-handler') === 'registered') return;
      if (registerQuickQuizProtocolHandler()) {
        window.localStorage.setItem('pharmatrack:protocol-handler', 'registered');
      }
    } catch {
      // Registration is an enhancement; failures must not break startup.
    }
  }, []);

  return null;
};

/**
 * Some Android/PWA/desktop WebViews can resume from sleep with a stale GPU
 * surface: the app is still running, but the compositor shows a black frame.
 * On every real resume/focus we force a tiny root repaint and tell heavy
 * viewers (PDF canvases, slide renderers) to repaint their visible content.
 */
const ResumePaintRecovery: React.FC = () => {
  useEffect(() => {
    let settleTimer: number | undefined;
    let guardTimer: number | undefined;
    let firstFrame: number | undefined;
    let secondFrame: number | undefined;

    const cancelFrames = () => {
      if (firstFrame !== undefined) window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
      firstFrame = undefined;
      secondFrame = undefined;
    };

    const repaint = () => {
      if (typeof document === 'undefined' || typeof window === 'undefined') return;
      const root = document.getElementById('root');
      if (!root) return;
      window.clearTimeout(settleTimer);
      window.clearTimeout(guardTimer);
      cancelFrames();

      // Dropping the compositing layer and immediately re-creating it forces
      // the webview to rasterise this content into a NEW texture. Re-applying
      // the same translateZ(0) on its own is a no-op the compositor is free to
      // skip, which is why a lost/blank surface could survive the old version
      // of this recovery (the Linux desktop build's black screen on resume).
      document.documentElement.classList.add('pharmatrack-resume-paint');
      root.style.transform = 'none';
      root.getBoundingClientRect();
      root.style.transform = 'translateZ(0)';
      // Opacity marks the layer's contents dirty without affecting layout, and
      // unlike a filter it does not become a containing block for the app's
      // fixed headers, so nothing shifts while it is applied.
      root.style.opacity = '0.999';
      root.getBoundingClientRect();
      window.dispatchEvent(new CustomEvent('pharmatrack:resume'));

      const restore = () => {
        root.style.transform = '';
        root.style.opacity = '';
        document.documentElement.classList.remove('pharmatrack-resume-paint');
        window.clearTimeout(settleTimer);
        cancelFrames();
      };

      // Release on the frame after the repaint actually lands rather than after
      // a fixed delay, so the window is back to normal as soon as it is drawn.
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(restore);
      });
      // Frames are not delivered to a window that is still unmapped; the timer
      // guarantees the styles never get stuck on.
      settleTimer = window.setTimeout(restore, 600);

      guardTimer = window.setTimeout(() => {
        const style = window.getComputedStyle(root);
        if (!root.childElementCount || style.display === 'none' || style.visibility === 'hidden') {
          window.location.reload();
        }
      }, 1200);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') repaint(); };
    window.addEventListener('pageshow', repaint);
    window.addEventListener('focus', repaint);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(settleTimer);
      window.clearTimeout(guardTimer);
      cancelFrames();
      window.removeEventListener('pageshow', repaint);
      window.removeEventListener('focus', repaint);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return null;
};

/** Shown only for the few hundred milliseconds a page chunk takes to arrive. */
const PageLoading: React.FC = () => (
  <div className="flex items-center justify-center py-16" data-testid="page-loading">
    <div className="w-6 h-6 border-2 border-[#2D6A4F]/20 border-t-[#2D6A4F] rounded-full animate-spin" />
  </div>
);

const App = () => {
  const { state } = useApp();

  // Once the first screen is up, quietly warm the handful of pages a student is
  // most likely to open next, so their first click feels instant. Heavy, rarely
  // used pages are deliberately left out (see utils/routeLoader).
  useEffect(() => {
    prefetchLikelyRoutes();
  }, []);

  // Offline-first: the app is fully usable with no account and no internet.
  // The only thing that gates the UI is whether we know who the student is —
  // collected once by Onboarding and stored locally. Signing in is optional
  // and only unlocks cloud sync (see utils/requireAuth).
  const needsOnboarding = state.student === null;
  // An unreadable semester file must not look like a brand-new student.
  // Onboarding would invite them to start over, and the next save would be
  // refused anyway. Check this once and on real storage events only. Parsing
  // the whole local workspace during every React render made ordinary taps,
  // typing and quiz answers feel delayed on large semester files.
  const [storageBlocked, setStorageBlocked] = useState(() => workspaceIsBlocked());
  useEffect(() => {
    const refreshStorageStatus = () => setStorageBlocked(workspaceIsBlocked());
    window.addEventListener('storage', refreshStorageStatus);
    return () => window.removeEventListener('storage', refreshStorageStatus);
  }, []);

  // AIProvider owns AI configuration + credentials for the whole app. It sits
  // inside the error boundary and outside the router, and is independent of the
  // academic state — which is why AI keys never travel with a semester backup
  // (see src/ai/credentials.ts).
  if (storageBlocked) {
    return (
      <ErrorBoundary>
        <HashRouter>
          <ResumePaintRecovery />
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
          <ResumePaintRecovery />
          <Suspense fallback={<PageLoading />}>
            <ExamLaunchRouter />
            <NativeAppLinkRouter />
            <PendingQuickQuizLauncher />
            <Routes>
              {needsOnboarding ? (
                // First run remains offline-first, but an existing account can
                // sign in from a fresh device before completing onboarding.
                <>
                  <Route path="/quick-quiz" element={<QuickQuiz />} />
                  <Route path="/q/:code" element={<QuickQuiz />} />
                  <Route path="/app-link" element={<AppLinkRedirect />} />
                  <Route path="/login" element={<Login />} />
                  <Route path="/reset-password" element={<ResetPassword />} />
                  <Route path="*" element={<Onboarding />} />
                </>
              ) : (
                <>
                  <Route path="/quick-quiz" element={<QuickQuiz />} />
                  <Route path="/q/:code" element={<QuickQuiz />} />
                  <Route path="/app-link" element={<AppLinkRedirect />} />
                  <Route path="/examination/secure/:attemptId" element={<SecureExamination />} />
                  <Route
                    element={
                      <SecureExamRouteGate>
                        <Layout />
                      </SecureExamRouteGate>
                    }
                  >
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
                    <Route path="/reset-password" element={<ResetPassword />} />
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
