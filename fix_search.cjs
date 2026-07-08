const fs = require('fs');

const layoutCode = `import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation, Outlet, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { Home, BookOpen, FileQuestion, Brain, Calendar, BarChart3, Settings, Menu, X, Search, ClipboardList, StickyNote, Upload, LogOut, ChevronLeft, ChevronRight, ShieldCheck, Zap, Bookmark, WifiOff, RefreshCw, Download, CheckCircle, Loader2, Clock } from 'lucide-react';

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
  
  // NEW SEARCH STATES
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const searchRef = useRef<HTMLDivElement>(null);

  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'done'>('idle');
  const [appVersion, setAppVersion] = useState('1.1.63');

  useEffect(() => { getVersion().then(v => setAppVersion(v)).catch(console.error); }, []);
  
  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline); window.addEventListener('offline', handleOffline);
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); };
  }, []);

  // Handle clicking outside the search box to close it cleanly
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setIsSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Get most recent slides
  const recentSlides = [...state.slides].sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5);

  // DEEP NEURAL SEARCH ENGINE
  useEffect(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length > 2) {
      let results: any[] = [];
      
      const getSnippet = (text: string) => {
        if (!text) return '';
        const lowerText = text.toLowerCase();
        const index = lowerText.indexOf(query);
        if (index === -1) return '';
        const start = Math.max(0, index - 40);
        const end = Math.min(text.length, index + query.length + 40);
        return (start > 0 ? '...' : '') + text.substring(start, end).replace(/\\n/g, ' ') + (end < text.length ? '...' : '');
      };

      // 1. Navigation
      const navs = [{ n: 'Settings', l: '/settings', i: '⚙️' }, { n: 'Analytics', l: '/analytics', i: '📊' }, { n: 'Study Planner', l: '/planner', i: '📅' }, { n: 'Quiz Mode', l: '/quiz', i: '🧠' }, { n: 'Question Bank', l: '/questions', i: '❓' }, { n: 'Study Materials', l: '/materials', i: '📚' }];
      navs.forEach(n => { if (n.n.toLowerCase().includes(query)) results.push({ id: n.n, title: n.n, subtitle: 'App Navigation', icon: n.i, link: n.l }); });

      // 2. Courses & Topics
      state.courses.forEach(c => { if (c.courseName.toLowerCase().includes(query) || c.courseCode.toLowerCase().includes(query)) results.push({ id: \`c-\${c.id}\`, title: \`\${c.courseCode}: \${c.courseName}\`, subtitle: 'Course', icon: '📘', link: \`/course/\${c.id}\` }); });
      state.topics.forEach(t => { if (t.topicName.toLowerCase().includes(query)) results.push({ id: \`t-\${t.id}\`, title: t.topicName, subtitle: 'Topic', icon: '📑', link: \`/read/\${t.id}\` }); });

      // 3. Slides & PDFs (DEEP CONTENT SEARCH)
      state.slides.forEach(s => {
        const inTitle = s.title.toLowerCase().includes(query);
        const inContent = s.contentText?.toLowerCase().includes(query);
        if (inTitle || inContent) {
          results.push({ id: \`s-\${s.id}\`, title: s.title, subtitle: 'Study Material (PDF/Doc)', icon: '📄', snippet: inContent ? getSnippet(s.contentText || '') : undefined, link: \`/read/\${s.topicId}?slide=\${s.slideNumber - 1}\` });
        }
      });

      // 4. Notes
      state.notes.forEach(n => { if (n.noteText.toLowerCase().includes(query)) results.push({ id: \`n-\${n.id}\`, title: 'Personal Note', subtitle: 'My Notes', icon: '📝', snippet: getSnippet(n.noteText), link: '/notes' }); });

      // 5. Question Bank (DEEP SEARCH IN QUESTIONS AND ANSWERS)
      state.examQuestions.forEach(q => {
        const inQ = q.questionText.toLowerCase().includes(query);
        const inAns = q.modelAnswer?.toLowerCase().includes(query);
        const inOpts = q.options?.some(o => o.toLowerCase().includes(query));
        if (inQ || inAns || inOpts) {
          results.push({ id: \`q-\${q.id}\`, title: q.questionText, subtitle: 'Question Bank', icon: '💡', snippet: inAns ? getSnippet(q.modelAnswer || '') : (inOpts ? 'Found in multiple choice options' : undefined), link: '/questions' });
        }
      });

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
      const currentVersion = await getVersion();
      const response = await fetch('https://api.github.com/repos/g2code33/pharmaTRACK_PERFECT_new/releases/latest');
      if (!response.ok) throw new Error('Failed to fetch from GitHub');
      const data = await response.json();
      const latestVersion = data.tag_name.replace('v', '');
      
      if (latestVersion !== currentVersion) {
        setUpdateStatus('available');
        if (window.confirm(\`Good news! Version \${latestVersion} is available! (You have \${currentVersion})\\n\\nClick OK to open the download page.\`)) {
          const { open } = await import('@tauri-apps/plugin-shell');
          await open(data.html_url); 
          setUpdateStatus('idle');
        } else { setUpdateStatus('idle'); }
      } else {
        alert('You are already on the latest version (' + currentVersion + ')!');
        setUpdateStatus('idle');
      }
    } catch (error: any) {
      console.error('Update failed:', error);
      alert(\`Update Check Failed: \${error.message || error}\`);
      setUpdateStatus('idle');
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 flex-col">
      {isOffline && <div className="w-full bg-red-600 text-white text-xs font-bold text-center py-1.5 uppercase tracking-widest animate-pulse z-[100] relative shadow-md flex items-center justify-center gap-2"><WifiOff className="w-4 h-4" /> No Internet Connection - Operating in Offline Mode</div>}
      <div className="flex flex-1 overflow-hidden">
        <aside className={\`fixed inset-y-0 left-0 z-50 bg-[#0F172A] text-white flex flex-col transition-all duration-300 ease-in-out lg:relative shadow-2xl \${mobileMenuOpen ? 'translate-x-0 w-72' : '-translate-x-full lg:translate-x-0'} \${sidebarCollapsed ? 'lg:w-20' : 'lg:w-72'}\`}>
          <div className={\`flex items-center p-6 border-b border-white/5 \${sidebarCollapsed ? 'justify-center' : 'gap-3'}\`}>
            <div className="w-10 h-10 flex-shrink-0 overflow-hidden rounded-lg shadow-lg shadow-green-500/20"><img src="/logo.png" alt="Logo" className="w-full h-full object-cover scale-110" onError={(e) => e.currentTarget.style.display = 'none'} /></div>
            {!sidebarCollapsed && (<div className="flex-1 overflow-hidden"><h1 className="font-black text-xl tracking-tighter uppercase italic text-white">Pharma<span className="text-[#4ADE80]">TRACK</span></h1></div>)}
            <button onClick={() => setMobileMenuOpen(false)} className="lg:hidden p-1 hover:bg-white/10 rounded"><X className="w-5 h-5 text-white" /></button>
          </div>
          <nav className="flex-1 p-4 space-y-1 overflow-y-auto hide-scrollbar">
            {navItems.map((item: any) => {
              const isActive = location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path));
              return (
                <Link key={item.path} to={item.path} onClick={() => setMobileMenuOpen(false)} title={sidebarCollapsed ? item.label : ''} className={\`flex items-center rounded-xl transition-all duration-200 \${sidebarCollapsed ? 'justify-center p-3' : 'gap-3 px-4 py-3'} \${isActive ? 'bg-[#2D6A4F] text-white shadow-lg shadow-[#2D6A4F]/20' : item.highlight ? 'bg-purple-600/10 text-purple-400 hover:bg-purple-600/20' : 'text-gray-400 hover:bg-white/5 hover:text-white'}\`}>
                  <item.icon className={\`w-5 h-5 flex-shrink-0 \${isActive ? 'text-[#FFB703]' : ''}\`} />
                  {!sidebarCollapsed && <span className="text-sm font-bold tracking-tight">{item.label}</span>}
                </Link>
              );
            })}
          </nav>
          <div className="p-4 bg-[#0F172A] border-t border-white/5">
            <div className={\`flex items-center \${sidebarCollapsed ? 'justify-center' : 'justify-between'}\`}>
              <button onClick={handleLogout} className={\`text-gray-400 hover:text-red-400 p-2.5 rounded-xl hover:bg-red-500/10 transition-all \${sidebarCollapsed ? '' : 'flex items-center gap-2 text-xs font-black uppercase tracking-widest text-white/50'}\`}><LogOut className="w-5 h-5" />{!sidebarCollapsed && <span>End Session</span>}</button>
              <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="hidden lg:flex p-2.5 bg-white/5 text-gray-400 hover:text-[#FFB703] hover:bg-white/10 rounded-xl transition-all">{sidebarCollapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}</button>
            </div>
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="bg-white/80 backdrop-blur-md border-b border-gray-200 px-6 py-4 flex-shrink-0 z-20">
            <div className="flex items-center gap-4 lg:gap-6">
              <button className="lg:hidden p-2 hover:bg-gray-100 rounded-xl" onClick={() => setMobileMenuOpen(true)}><Menu className="w-5 h-5 text-gray-600" /></button>
              
              <Link to="/" className="hidden sm:flex items-center justify-center p-3 bg-[#2D6A4F]/10 hover:bg-[#2D6A4F]/20 text-[#2D6A4F] rounded-xl transition-all shadow-sm" title="Go Home"><Home className="w-5 h-5" /></Link>
              <Link to="/" className="sm:hidden flex items-center justify-center p-2 bg-[#2D6A4F]/10 hover:bg-[#2D6A4F]/20 text-[#2D6A4F] rounded-xl transition-all shadow-sm" title="Go Home"><Home className="w-5 h-5" /></Link>

              <div className="flex-1 max-w-3xl relative" ref={searchRef}>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none"><Search className="w-4 h-4 text-gray-400" /></div>
                  <input type="text" placeholder="Global Deep Search: PDFs, Questions, Notes, Settings..." value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setIsSearchOpen(true); }} onClick={() => setIsSearchOpen(true)} className="w-full pl-11 pr-12 py-3 bg-gray-100 border-none rounded-2xl text-sm font-medium focus:bg-white focus:ring-4 focus:ring-[#2D6A4F]/10 outline-none transition-all shadow-inner" />
                  {searchQuery && <button onClick={() => { setSearchQuery(''); setIsSearchOpen(false); }} className="absolute inset-y-0 right-10 flex items-center p-2 text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>}
                  <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none"><Zap className="w-3 h-3 text-purple-500 animate-pulse" /></div>
                </div>
                
                {isSearchOpen && (
                  <div className="absolute top-full left-0 w-full mt-3 bg-white rounded-2xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.3)] border border-gray-100 overflow-hidden z-[100] max-h-[70vh] flex flex-col animate-in slide-in-from-top-2 duration-200">
                    <div className="overflow-y-auto flex-1 p-2 scrollbar-thin">
                      {searchQuery.length < 3 ? (
                        <div className="p-2">
                          <div className="px-3 py-2 text-[10px] font-black text-gray-400 uppercase tracking-widest flex items-center gap-2 mb-2"><Clock className="w-4 h-4"/> Recently Viewed Materials</div>
                          {recentSlides.length > 0 ? recentSlides.map(s => (
                            <Link key={s.id} to={\`/read/\${s.topicId}?slide=\${s.slideNumber - 1}\`} onClick={() => setIsSearchOpen(false)} className="flex items-center gap-4 p-3 hover:bg-gray-50 rounded-xl transition-all group">
                              <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-lg flex items-center justify-center group-hover:scale-110 transition-transform"><BookOpen className="w-5 h-5"/></div>
                              <div className="flex-1 min-w-0">
                                <p className="font-bold text-gray-800 truncate">{s.title}</p>
                                <p className="text-[9px] font-black uppercase tracking-widest text-gray-400 mt-1">Study Material</p>
                              </div>
                            </Link>
                          )) : <div className="p-8 text-center text-gray-400 font-medium">No recent materials found.</div>}
                        </div>
                      ) : searchResults.length > 0 ? (
                        <div className="p-2 space-y-1">
                          <div className="px-3 py-2 text-[10px] font-black text-[#2D6A4F] uppercase tracking-widest border-b border-gray-100 mb-2">Search Results ({searchResults.length})</div>
                          {searchResults.map((res, i) => (
                            <Link key={i} to={res.link} onClick={() => { setIsSearchOpen(false); setSearchQuery(''); }} className="flex items-start gap-4 p-3 hover:bg-gray-50 rounded-xl transition-all group">
                              <div className="text-2xl pt-1 opacity-70 group-hover:opacity-100 group-hover:scale-110 transition-transform">{res.icon}</div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="font-bold text-[#2D6A4F] text-sm truncate">{res.title}</p>
                                  <span className="text-[9px] font-black uppercase tracking-widest bg-gray-100 px-2 py-1 rounded-md text-gray-500 whitespace-nowrap">{res.subtitle}</span>
                                </div>
                                {res.snippet && (
                                  <p className="text-xs text-gray-600 mt-1.5 italic bg-yellow-50/50 p-2 rounded-lg border border-yellow-100/50 line-clamp-2">
                                    "...<span dangerouslySetInnerHTML={{ __html: res.snippet.replace(new RegExp(searchQuery, 'gi'), match => \`<mark class="bg-yellow-200 text-yellow-900 font-bold px-1 rounded">\${match}</mark>\`) }} />..."
                                  </p>
                                )}
                              </div>
                            </Link>
                          ))}
                        </div>
                      ) : (
                        <div className="p-12 text-center">
                          <Search className="w-12 h-12 text-gray-200 mx-auto mb-3" />
                          <p className="text-gray-500 font-bold">No results found for "{searchQuery}"</p>
                          <p className="text-sm text-gray-400 mt-1">Try searching for keywords inside a PDF or a specific question.</p>
                        </div>
                      )}
                    </div>
                    {searchQuery.length >= 3 && (
                      <div className="bg-gray-50 p-3 text-center border-t border-gray-100">
                        <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest">Deep Neural Search Active</p>
                      </div>
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
