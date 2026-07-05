import React, { useState, useEffect } from 'react';
import { Link, useLocation, Outlet, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { Home, BookOpen, FileQuestion, Brain, Calendar, BarChart3, Settings, Moon, Sun, Menu, X, Search, ClipboardList, StickyNote, Upload, LogOut, ChevronLeft, ChevronRight, ShieldCheck, Zap, Bookmark, WifiOff, RefreshCw, Download, CheckCircle, Loader2, Clock } from 'lucide-react';

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
  const { state, dispatch } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'done'>('idle');
  const [appVersion, setAppVersion] = useState('1.1.11');
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
    const query = searchQuery.trim().toLowerCase();
    if (query.length > 2) {
      let results: any[] = [];
      state.courses.forEach(c => { if (c.courseName.toLowerCase().includes(query) || c.courseCode.toLowerCase().includes(query)) results.push({ id: `c-${c.id}`, title: `${c.courseCode}: ${c.courseName}`, subtitle: 'Course', link: `/course/${c.id}` }); });
      state.topics.forEach(t => { if (t.topicName.toLowerCase().includes(query)) results.push({ id: `t-${t.id}`, title: t.topicName, subtitle: 'Topic', link: `/read/${t.id}` }); });
      state.slides.forEach(s => { if (s.title.toLowerCase().includes(query) || s.contentText?.toLowerCase().includes(query)) results.push({ id: `s-${s.id}`, title: s.title, subtitle: 'Study Material', link: `/read/${s.topicId}?slide=${s.slideNumber - 1}` }); });
      state.notes.forEach(n => { if (n.noteText.toLowerCase().includes(query)) results.push({ id: `n-${n.id}`, title: n.noteText.substring(0, 30) + "...", subtitle: 'My Note', link: '/notes' }); });
      state.examQuestions.forEach(q => { if (q.questionText.toLowerCase().includes(query)) results.push({ id: `q-${q.id}`, title: q.questionText, subtitle: 'Question Bank', link: '/questions' }); });
      setSearchResults(results.slice(0, 15));
    } else { setSearchResults([]); }
  }, [searchQuery, state]);

  const handleLogout = async () => {
    if (window.confirm('Terminate PharmTrack Secure Session?')) {
      dispatch({ type: 'SET_LOGGED_IN', payload: false });
    }
  };

    const checkForUpdates = async () => {
    try {
      setUpdateStatus('checking');
      const update = await check();
      if (update) {
        setUpdateStatus('available');
        if (window.confirm(`Version ${update.version} is available! Do you want to install it now?`)) {
          setUpdateStatus('downloading');
          await update.downloadAndInstall();
          setUpdateStatus('done');
          alert('Update complete! The app will now restart.');
          await relaunch();
        } else {
          setUpdateStatus('idle');
        }
      } else {
        alert('You are already on the latest version!');
        setUpdateStatus('idle');
      }
    } catch (error: any) {
      console.error('Update failed:', error);
      alert(`Update Check Failed: ${error.message || error}`);
      setUpdateStatus('idle');
    }
  };

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
              <button onClick={handleLogout} className={`text-gray-400 hover:text-red-400 p-2.5 rounded-xl hover:bg-red-500/10 transition-all ${sidebarCollapsed ? '' : 'flex items-center gap-2 text-xs font-black uppercase tracking-widest text-white/50'}`}><LogOut className="w-5 h-5" />{!sidebarCollapsed && <span>End Session</span>}</button>
              <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="hidden lg:flex p-2.5 bg-white/5 text-gray-400 hover:text-[#FFB703] hover:bg-white/10 rounded-xl transition-all">{sidebarCollapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}</button>
            </div>
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="bg-white/80 backdrop-blur-md border-b border-gray-200 px-6 py-4 flex-shrink-0 z-20">
            <div className="flex items-center gap-6">
              <button className="lg:hidden p-2 hover:bg-gray-100 rounded-xl" onClick={() => setMobileMenuOpen(true)}><Menu className="w-5 h-5 text-gray-600" /></button>
              
              <div className="flex-1 max-w-3xl relative">
                <div className="relative group">
                  <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none"><Search className="w-4 h-4 text-gray-400" /></div>
                  <input type="text" placeholder="Global Search: Courses, Topics, Slides, Notes, Questions..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onFocus={() => setIsSearchFocused(true)} onBlur={() => setTimeout(() => setIsSearchFocused(false), 200)} className="w-full pl-11 pr-12 py-3 bg-gray-100 border-none rounded-2xl text-sm font-medium focus:bg-white focus:ring-4 focus:ring-[#2D6A4F]/10 outline-none transition-all shadow-inner" />
                  <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none"><Zap className="w-3 h-3 text-purple-500 animate-pulse" /></div>
                </div>
                {(isSearchFocused || searchResults.length > 0) && (
                  <div className="absolute top-full left-0 w-full mt-2 bg-white rounded-xl shadow-2xl border border-gray-100 overflow-hidden z-50 max-h-64 overflow-y-auto">
                    {searchQuery.length === 0 ? (
                       recentSlides.length > 0 ? (
                         <>
                           <div className="px-4 py-2 bg-slate-50 border-b text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><Clock size={12}/> Recent Materials</div>
                           {recentSlides.map(s => (
                              <Link key={s.id} to={`/read/${s.topicId}?slide=${s.slideNumber - 1}`} onMouseDown={() => setSearchQuery('')} className="block px-4 py-3 hover:bg-gray-50 border-b last:border-0 transition-colors">
                                <div className="flex justify-between items-center">
                                  <p className="font-bold text-[#2D6A4F] truncate pr-4">{s.title}</p>
                                  <span className="text-[9px] font-black uppercase tracking-widest bg-blue-100 px-2 py-1 rounded-md text-blue-600 flex-shrink-0">PDF / Doc</span>
                                </div>
                              </Link>
                           ))}
                         </>
                       ) : <div className="p-4 text-sm text-gray-500 text-center font-bold">No recent materials yet.</div>
                    ) : (
                      searchResults.map(res => (
                        <Link key={res.id} to={res.link} onMouseDown={() => setSearchQuery('')} className="block px-4 py-3 hover:bg-gray-50 border-b last:border-0 transition-colors">
                          <div className="flex justify-between items-center">
                            <p className="font-bold text-[#2D6A4F] truncate pr-4">{res.title}</p>
                            <span className="text-[9px] font-black uppercase tracking-widest bg-gray-100 px-2 py-1 rounded-md text-gray-500 flex-shrink-0">{res.subtitle}</span>
                          </div>
                        </Link>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="hidden sm:flex items-center gap-4">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-green-50 rounded-full border border-green-100"><div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" /><span className="text-[10px] font-black text-green-700 uppercase tracking-widest">Cloud Ready</span></div>
                
                <div className="flex items-center gap-2 bg-blue-600 text-white pl-4 pr-1 py-1 rounded-full shadow-md">
                  <span className="text-[10px] font-black uppercase tracking-widest border-r border-blue-400 pr-3 mr-1 opacity-90">v{appVersion}</span>
                  <button onClick={checkForUpdates} disabled={updateStatus === 'checking' || updateStatus === 'downloading'} title="Check for Updates" className="flex items-center gap-2 px-3 py-1.5 hover:bg-blue-700 rounded-full font-bold text-xs transition-all disabled:opacity-50">
                    {updateStatus === 'checking' ? <Loader2 className="w-4 h-4 animate-spin" /> : updateStatus === 'downloading' ? <Download className="w-4 h-4 animate-bounce" /> : updateStatus === 'done' ? <CheckCircle className="w-4 h-4" /> : <RefreshCw className="w-4 h-4" />}
                    <span className="hidden lg:inline">{updateStatus === 'checking' ? 'Checking...' : updateStatus === 'downloading' ? 'Updating...' : updateStatus === 'done' ? 'Restarting...' : 'Update App'}</span>
                  </button>
                </div>

                <button onClick={() => setDarkMode(!darkMode)} className="w-10 h-10 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-[#2D6A4F] rounded-full transition-all border border-gray-100 shadow-sm">{darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}</button>
                <Link to="/settings" className="w-10 h-10 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-[#2D6A4F] rounded-full transition-all border border-gray-100 shadow-sm"><Settings className="w-5 h-5" /></Link>
              </div>
            </div>
          </header>
          <main className="flex-1 overflow-y-auto bg-[#F8FAFC] p-6 relative"><Outlet /></main>
        </div>
      </div>
    </div>
  );
};
export default Layout;
