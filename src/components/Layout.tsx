import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation, Outlet, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { searchAll, type SearchResult } from '../utils/search';
import ErrorBoundary from './ErrorBoundary';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { Home, BookOpen, FileQuestion, Brain, Calendar, BarChart3, Settings, Moon, Sun, Menu, X, Search, ClipboardList, StickyNote, Upload, LogOut, ChevronLeft, ChevronRight, ShieldCheck, Zap, Bookmark, WifiOff, RefreshCw, Download, CheckCircle, Loader2, Clock, UserCircle, Cloud } from 'lucide-react';

const navItems = [
  { path: '/', icon: Home, label: 'Dashboard' },
  { path: '/materials', icon: Upload, label: '📚 Study Materials', highlight: true },
  { path: '/highlights', icon: Bookmark, label: '⭐ Study Bank' },
  { path: '/courses', icon: BookOpen, label: 'My Courses' },
  { path: '/objectives', icon: ClipboardList, label: 'Learning Objectives' },
  { path: '/questions', icon: FileQuestion, label: 'Question Bank' },
  { path: '/quiz', icon: Brain, label: 'Quiz Mode' },
  { path: '/planner', icon: Calendar, label: 'Study Planner' },
  { path: '/notes', icon: StickyNote, label: 'My Notes' },
  { path: '/analytics', icon: BarChart3, label: 'Analytics' },
  { path: '/timetable', icon: Calendar, label: 'Offline Timetable' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

const Layout: React.FC = () => {
  const { state, logout } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'done'>('idle');
  const [appVersion, setAppVersion] = useState('1.1.82');
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => { document.documentElement.classList.toggle('dark', darkMode); }, [darkMode]);
  useEffect(() => { getVersion().then(v => setAppVersion(v)).catch(console.error); }, []);
  
  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline); window.addEventListener('offline', handleOffline);
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); };
  }, []);

  const recentSlides = [...state.slides].sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5);

  useEffect(() => {
    setSearchResults(searchAll(state, searchQuery));
    setActiveIndex(0);
  }, [searchQuery, state]);

  // Close the dropdown on outside click. Replaces the old onBlur+setTimeout,
  // which raced with the click it was trying to allow.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setIsSearchFocused(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  // Ctrl/Cmd+K focuses search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const closeSearch = () => {
    setSearchQuery('');
    setIsSearchFocused(false);
    searchInputRef.current?.blur();
  };

  const goToResult = (link: string) => {
    navigate(link);
    closeSearch();
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const list = searchQuery ? searchResults : recentSlides.map(s => ({ link: `/read/${s.topicId}?slide=${Math.max(0, s.slideNumber - 1)}` }));
    if (e.key === 'Escape') { closeSearch(); return; }
    if (!list.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % list.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + list.length) % list.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = list[activeIndex] ?? list[0];
      if (chosen) goToResult(chosen.link);
    }
  };

  const handleLogout = async () => {
    if (window.confirm('Terminate PharmTrack Secure Session?')) {
      // Must go through logout(): dispatching SET_LOGGED_IN alone left the
      // Supabase session on disk, and the session check immediately signed the
      // user straight back in.
      await logout();
      navigate('/', { replace: true });
    }
  };

  // `silent` is used by the automatic check on launch: it still offers a real
  // update, but stays quiet when already up to date or when the check fails
  // (e.g. offline), so starting the app never throws up a pointless popup.
  const checkForUpdates = async (silent = false) => {
    try {
      setUpdateStatus('checking');
      const update = await check();

      if (update) {
        setUpdateStatus('available');
        let downloaded = 0;
        let contentLength = 0;

        if (window.confirm(`Version ${update.version} is available! Do you want to download and install it now?`)) {
          setUpdateStatus('downloading');
          
          // Natively download and install in the background
          await update.downloadAndInstall((event) => {
            if (event.event === 'Started') contentLength = event.data.contentLength || 0;
            if (event.event === 'Progress') downloaded += event.data.chunkLength;
            console.log(`Downloaded ${downloaded} of ${contentLength}`);
          });
          
          setUpdateStatus('done');
          alert('Update installed successfully! The app will now restart.');
          await relaunch(); // Auto-restarts the app!
        } else {
          setUpdateStatus('idle');
        }
      } else {
        if (!silent) {
          const currentVersion = await getVersion();
          alert('You are already on the latest version (' + currentVersion + ')!');
        }
        setUpdateStatus('idle');
      }
    } catch (error: any) {
      console.error('Update failed:', error);
      if (!silent) alert(`Update Check Failed: ${error.message || error}`);
      setUpdateStatus('idle');
    }
  };

  // Check for updates shortly after launch so users get fixes without having to
  // know the button exists. Runs once, only when online, and stays silent
  // unless there is genuinely an update to offer. The delay keeps the network
  // call away from the initial render.
  const hasAutoCheckedRef = useRef(false);
  useEffect(() => {
    if (hasAutoCheckedRef.current) return;
    hasAutoCheckedRef.current = true;
    if (!navigator.onLine) return;

    const timer = setTimeout(() => { void checkForUpdates(true); }, 3000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className={`flex h-screen overflow-hidden flex-col ${darkMode ? "bg-slate-900" : "bg-slate-50"}`}>
      {isOffline && <div className="w-full bg-red-600 text-white text-xs font-bold text-center py-1.5 uppercase tracking-widest animate-pulse z-[100] relative shadow-md flex items-center justify-center gap-2"><WifiOff className="w-4 h-4" /> No Internet Connection - Operating in Offline Mode</div>}
      <div className="flex flex-1 overflow-hidden">
        <aside className={`fixed inset-y-0 left-0 z-50 bg-[#0F172A] text-white flex flex-col transition-all duration-300 ease-in-out lg:relative shadow-2xl ${mobileMenuOpen ? 'translate-x-0 w-72' : '-translate-x-full lg:translate-x-0'} ${sidebarCollapsed ? 'lg:w-20' : 'lg:w-72'}`}>
          <div className={`flex items-center p-6 border-b border-white/5 ${sidebarCollapsed ? 'justify-center' : 'gap-3'}`}>
            <div className="w-10 h-10 flex-shrink-0 overflow-hidden rounded-lg shadow-lg shadow-green-500/20"><img src="/logo.png" alt="Logo" className="w-full h-full object-cover scale-110" onError={(e) => e.currentTarget.style.display = 'none'} /></div>
            {!sidebarCollapsed && (<div className="flex-1 overflow-hidden"><h1 className="font-black text-xl tracking-tighter uppercase italic text-white">Pharma<span className="text-[#4ADE80]">TRACK</span></h1></div>)}
            <button onClick={() => setMobileMenuOpen(false)} className="lg:hidden p-1 hover:bg-white/10 rounded"><X className="w-5 h-5 text-white" /></button>
          </div>
          <nav className="flex-1 p-4 space-y-1 overflow-y-auto hide-scrollbar">
            {navItems.map((item: any) => {
              const isActive = location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path));
              return (
                <Link key={item.path} to={item.path} onClick={() => setMobileMenuOpen(false)} title={sidebarCollapsed ? item.label : ''} className={`flex items-center rounded-xl transition-all duration-200 ${sidebarCollapsed ? 'justify-center p-3' : 'gap-3 px-4 py-3'} ${isActive ? 'bg-[#2D6A4F] text-white shadow-lg shadow-[#2D6A4F]/20' : item.highlight ? 'bg-purple-600/10 text-purple-400 hover:bg-purple-600/20' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}>
                  <item.icon className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-[#FFB703]' : ''}`} />
                  {!sidebarCollapsed && <span className="text-sm font-bold tracking-tight">{item.label}</span>}
                </Link>
              );
            })}
          </nav>
          <div className="p-4 bg-[#0F172A] border-t border-white/5">
            <div className={`flex items-center ${sidebarCollapsed ? 'justify-center' : 'justify-between'}`}>
              {state.isLoggedIn ? (
                <button onClick={handleLogout} title="End Session" className={`text-gray-400 hover:text-red-400 p-2.5 rounded-xl hover:bg-red-500/10 transition-all ${sidebarCollapsed ? '' : 'flex items-center gap-2 text-xs font-black uppercase tracking-widest text-white/50'}`}><LogOut className="w-5 h-5" />{!sidebarCollapsed && <span>End Session</span>}</button>
              ) : (
                // Red: signed out means the user's work exists in exactly one
                // place, with no backup. Worth flagging, not whispering.
                <Link to="/login" title="Not backed up — sign in to sync" className={`text-red-300 hover:text-white bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 p-2.5 rounded-xl transition-all ${sidebarCollapsed ? '' : 'flex items-center gap-2 text-xs font-black uppercase tracking-widest'}`}><Cloud className="w-5 h-5" />{!sidebarCollapsed && <span>Sign in to sync</span>}</Link>
              )}
              <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="hidden lg:flex p-2.5 bg-white/5 text-gray-400 hover:text-[#FFB703] hover:bg-white/10 rounded-xl transition-all">{sidebarCollapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}</button>
            </div>
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* z-[120] beats the reader's side panels (z-[110]); backdrop-blur makes
              this element a stacking context, so the search dropdown inside it
              can never escape — the header itself has to sit above them. */}
          <header className="bg-white/80 backdrop-blur-md border-b border-gray-200 px-6 py-4 flex-shrink-0 relative z-[120]">
            <div className="flex items-center gap-4 lg:gap-6">
              <button className="lg:hidden p-2 hover:bg-gray-100 rounded-xl" onClick={() => setMobileMenuOpen(true)}><Menu className="w-5 h-5 text-gray-600" /></button>
              
              {/* Universal Home Button */}
              <Link to="/" className="hidden sm:flex items-center justify-center p-3 bg-[#2D6A4F]/10 hover:bg-[#2D6A4F]/20 text-[#2D6A4F] rounded-xl transition-all shadow-sm" title="Go Home">
                 <Home className="w-5 h-5" />
              </Link>
              <Link to="/" className="sm:hidden flex items-center justify-center p-2 bg-[#2D6A4F]/10 hover:bg-[#2D6A4F]/20 text-[#2D6A4F] rounded-xl transition-all shadow-sm" title="Go Home">
                 <Home className="w-5 h-5" />
              </Link>

              <div className="flex-1 max-w-3xl relative" ref={searchBoxRef}>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none"><Search className="w-4 h-4 text-gray-400" /></div>
                  <input
                    ref={searchInputRef}
                    type="text"
                    placeholder="Search courses, topics, slides, notes, questions…  (Ctrl+K)"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onFocus={() => setIsSearchFocused(true)}
                    onKeyDown={onSearchKeyDown}
                    className="w-full pl-11 pr-12 py-3 bg-gray-100 border-none rounded-2xl text-sm font-medium focus:bg-white focus:ring-4 focus:ring-[#2D6A4F]/10 outline-none transition-all shadow-inner"
                  />
                  {searchQuery ? (
                    <button onClick={closeSearch} title="Clear" className="absolute inset-y-0 right-3 flex items-center text-gray-400 hover:text-gray-700"><X className="w-4 h-4" /></button>
                  ) : (
                    <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none"><Zap className="w-3 h-3 text-purple-500 animate-pulse" /></div>
                  )}
                </div>

                {isSearchFocused && (
                  <div className="absolute top-full left-0 w-full mt-2 bg-white rounded-xl shadow-2xl border border-gray-100 overflow-hidden z-50 max-h-[26rem] overflow-y-auto">
                    {searchQuery.length === 0 ? (
                      recentSlides.length > 0 ? (
                        <>
                          <div className="px-4 py-2 bg-slate-50 border-b text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><Clock size={12} /> Recent Materials</div>
                          {recentSlides.map((s, i) => (
                            // onMouseDown (not onClick) so navigation happens before
                            // the input's blur can tear the list down.
                            <div
                              key={s.id}
                              role="button"
                              tabIndex={-1}
                              onMouseDown={(e) => { e.preventDefault(); goToResult(`/read/${s.topicId}?slide=${Math.max(0, s.slideNumber - 1)}`); }}
                              onMouseEnter={() => setActiveIndex(i)}
                              className={`block px-4 py-3 border-b last:border-0 cursor-pointer transition-colors ${activeIndex === i ? 'bg-[#2D6A4F]/10' : 'hover:bg-gray-50'}`}
                            >
                              <div className="flex justify-between items-center">
                                <p className="font-bold text-[#2D6A4F] truncate pr-4">{s.title}</p>
                                <span className="text-[9px] font-black uppercase tracking-widest bg-blue-100 px-2 py-1 rounded-md text-blue-600 flex-shrink-0">PDF / Doc</span>
                              </div>
                            </div>
                          ))}
                        </>
                      ) : <div className="p-4 text-sm text-gray-500 text-center font-bold">No recent materials yet.</div>
                    ) : searchResults.length === 0 ? (
                      <div className="p-6 text-center">
                        <p className="text-sm font-bold text-gray-600">No matches for “{searchQuery}”</p>
                        <p className="text-xs text-gray-400 mt-1">Try fewer words, or check Study Materials.</p>
                      </div>
                    ) : (
                      <>
                        <div className="px-4 py-2 bg-slate-50 border-b text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center justify-between">
                          <span>{searchResults.length} result{searchResults.length === 1 ? '' : 's'}</span>
                          <span className="normal-case tracking-normal font-bold text-slate-400">↑↓ to move · ↵ to open · esc to close</span>
                        </div>
                        {searchResults.map((res, i) => (
                          <div
                            key={res.id}
                            role="button"
                            tabIndex={-1}
                            onMouseDown={(e) => { e.preventDefault(); goToResult(res.link); }}
                            onMouseEnter={() => setActiveIndex(i)}
                            className={`block px-4 py-3 border-b last:border-0 cursor-pointer transition-colors ${activeIndex === i ? 'bg-[#2D6A4F]/10' : 'hover:bg-gray-50'}`}
                          >
                            <div className="flex justify-between items-start gap-3">
                              <div className="min-w-0 flex-1">
                                <p className="font-bold text-[#2D6A4F] truncate">{res.title}</p>
                                {res.snippet && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{res.snippet}</p>}
                              </div>
                              <span className="text-[9px] font-black uppercase tracking-widest bg-gray-100 px-2 py-1 rounded-md text-gray-500 flex-shrink-0">{res.category}</span>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="hidden sm:flex items-center gap-4">
                {/* Honest sync status. The old badge was hardcoded to a green
                    "Cloud Ready" even while offline with no account, which
                    contradicted the red offline banner right above it. */}
                {(() => {
                  const status = isOffline
                    ? { label: 'Offline', dot: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200' }
                    : !state.isLoggedIn
                    ? { label: 'Local only', dot: 'bg-slate-400', text: 'text-slate-600', bg: 'bg-slate-50', border: 'border-slate-200' }
                    : { label: 'Synced', dot: 'bg-green-500', text: 'text-green-700', bg: 'bg-green-50', border: 'border-green-100' };
                  return (
                    <div title={
                      isOffline
                        ? 'No internet. Everything is saved on this device.'
                        : !state.isLoggedIn
                        ? 'Saved on this device only. Sign in to add a cloud backup.'
                        : 'Signed in — cloud backup available.'
                    } className={`flex items-center gap-2 px-3 py-1.5 rounded-full border ${status.bg} ${status.border}`}>
                      <span className="relative flex w-2 h-2">
                        {/* Silent "beep": a soft expanding ping, not a static dot. */}
                        <span className={`absolute inline-flex w-full h-full rounded-full opacity-75 animate-ping ${status.dot}`} />
                        <span className={`relative inline-flex w-2 h-2 rounded-full ${status.dot}`} />
                      </span>
                      <span className={`text-[10px] font-black uppercase tracking-widest ${status.text}`}>{status.label}</span>
                    </div>
                  );
                })()}
                
                <div className="flex items-center gap-2 bg-blue-600 text-white pl-4 pr-1 py-1 rounded-full shadow-md">
                  <span className="text-[10px] font-black uppercase tracking-widest border-r border-blue-400 pr-3 mr-1 opacity-90">v{appVersion}</span>
                  <button onClick={() => void checkForUpdates(false)} disabled={updateStatus === 'checking' || updateStatus === 'downloading'} title="Check for Updates" className="flex items-center gap-2 px-3 py-1.5 hover:bg-blue-700 rounded-full font-bold text-xs transition-all disabled:opacity-50">
                    {updateStatus === 'checking' ? <Loader2 className="w-4 h-4 animate-spin" /> : updateStatus === 'downloading' ? <Download className="w-4 h-4 animate-bounce" /> : updateStatus === 'done' ? <CheckCircle className="w-4 h-4" /> : <RefreshCw className="w-4 h-4" />}
                    <span className="hidden lg:inline">{updateStatus === 'checking' ? 'Checking...' : updateStatus === 'downloading' ? 'Updating...' : updateStatus === 'done' ? 'Restarting...' : 'Update App'}</span>
                  </button>
                </div>

                <button onClick={() => setDarkMode(!darkMode)} className="w-10 h-10 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-[#2D6A4F] rounded-full transition-all border border-gray-100 shadow-sm">{darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}</button>
                <Link to="/settings" className="w-10 h-10 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-[#2D6A4F] rounded-full transition-all border border-gray-100 shadow-sm" title="Settings"><Settings className="w-5 h-5" /></Link>
                <Link to="/profile" className="w-10 h-10 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-[#2D6A4F] rounded-full transition-all border border-gray-100 shadow-sm" title={state.student?.name ? `Profile — ${state.student.name}` : 'Profile'}><UserCircle className="w-5 h-5" /></Link>
              </div>
            </div>
          </header>
          <main className="flex-1 overflow-y-auto bg-[#F8FAFC] p-6 relative">
            {/* Scoped to the page area so a crashing route leaves the sidebar,
                search and navigation usable. resetKey clears the error when the
                user navigates away. */}
            <ErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </div>
  );
};
export default Layout;
