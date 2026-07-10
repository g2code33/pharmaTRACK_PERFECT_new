const fs = require('fs');
let code = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');

// A. Inject Tauri Event Listener for Tab interception
const eventImport = `import { listen } from '@tauri-apps/api/event';`;
if (!code.includes(eventImport)) code = code.replace("import { WebviewWindow }", `import { WebviewWindow } from '@tauri-apps/api/webviewWindow';\n${eventImport}`);

// B. Replace old single URL state with robust Tab State
code = code.replace(
  "const [browserUrl, setBrowserUrl] = useState('https://chatgpt.com');",
  `const [browserTabs, setBrowserTabs] = useState([{ id: 'default', url: 'https://chatgpt.com', title: 'ChatGPT' }]);
  const [activeTabId, setActiveTabId] = useState('default');
  const [urlInput, setUrlInput] = useState('https://chatgpt.com');

  useEffect(() => {
    const tab = browserTabs.find(t => t.id === activeTabId);
    if (tab) setUrlInput(tab.url);
  }, [activeTabId, browserTabs]);`
);

// C. Replace updateWebview Logic and add New Tab Listener
const oldUpdate = /const updateWebview = async \(\) => \{[\s\S]*?catch\(e\) \{\}\n    \}\n  \};/m;
const newUpdate = `useEffect(() => {
    let unlisten;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('new-browser-tab', (event) => {
        const url = event.payload;
        const newId = uuidv4();
        const title = url.replace('https://', '').split('/')[0];
        setBrowserTabs(tabs => [...tabs, { id: newId, url, title }]);
        setActiveTabId(newId);
        setShowBrowserPanel(true);
        setShowAIPanel(false);
      }).then(u => unlisten = u);
    });
    return () => { if (unlisten) unlisten(); }
  }, []);

  const updateWebview = async () => {
    if (showBrowserPanel && browserContainerRef.current) {
      const rect = browserContainerRef.current.getBoundingClientRect();
      const activeTab = browserTabs.find(t => t.id === activeTabId);
      if (!activeTab) return;

      try {
        const { invoke } = await import('@tauri-apps/api/core');
        for (const tab of browserTabs) {
           if (tab.id !== activeTabId) invoke('hide_website', { label: \`browser_tab_\${tab.id}\` }).catch(()=>{});
        }
        await invoke('embed_website', {
          label: \`browser_tab_\${activeTabId}\`, url: activeTab.url, x: rect.left, y: rect.top, width: rect.width, height: rect.height
        });
      } catch(e) {}
    } else {
      try { 
        const { invoke } = await import('@tauri-apps/api/core');
        for (const tab of browserTabs) invoke('hide_website', { label: \`browser_tab_\${tab.id}\` }).catch(()=>{});
      } catch(e) {}
    }
  };`;
code = code.replace(oldUpdate, newUpdate);

// D. Replace single iframe UI with dynamic Tabbed UI
const uiOld = /\{showBrowserPanel && \([\s\S]*?className="flex-1 overflow-hidden bg-\[#1E293B\] relative flex items-center justify-center"[\s\S]*?\}\)/m;
const uiNew = `{showBrowserPanel && (
          <div className="bg-white border-l flex flex-col shadow-2xl z-[110] flex-shrink-0 relative overflow-hidden" style={{ width: \`\${panelWidth}px\` }}>
            
            {/* Native Tab Bar */}
            <div className="flex bg-gray-200 overflow-x-auto border-b border-gray-300 scrollbar-none h-9 flex-shrink-0">
               {browserTabs.map(tab => (
                  <div key={tab.id} 
                    className={\`flex items-center gap-2 px-3 py-1 cursor-pointer border-r border-gray-300 min-w-[100px] max-w-[150px] transition-all \${activeTabId === tab.id ? 'bg-white font-bold' : 'hover:bg-gray-100 text-gray-600'}\`} 
                    onClick={() => setActiveTabId(tab.id)}
                  >
                     <span className="text-xs truncate flex-1">{tab.title}</span>
                     <button onClick={(e) => {
                         e.stopPropagation();
                         if (browserTabs.length === 1) return;
                         const remaining = browserTabs.filter(t => t.id !== tab.id);
                         setBrowserTabs(remaining);
                         import('@tauri-apps/api/core').then(({invoke}) => invoke('destroy_website', { label: \`browser_tab_\${tab.id}\` }));
                         if (activeTabId === tab.id) setActiveTabId(remaining[0].id);
                     }} className="p-0.5 hover:bg-gray-200 rounded-sm"><X className="w-3 h-3 text-gray-500" /></button>
                  </div>
               ))}
               <button onClick={() => {
                   const newId = uuidv4();
                   setBrowserTabs(tabs => [...tabs, { id: newId, url: 'https://google.com', title: 'Google' }]);
                   setActiveTabId(newId);
               }} className="px-3 hover:bg-gray-300 flex items-center justify-center text-gray-600 font-black text-lg">+</button>
            </div>

            <div className="p-2 border-b bg-gray-50 flex items-center gap-2 flex-shrink-0">
              <div className="flex items-center gap-1 flex-1 bg-white border border-gray-200 rounded-lg px-2 py-1.5 shadow-sm">
                <Globe className="w-3.5 h-3.5 text-gray-400" />
                <input 
                  type="text" 
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') return setShowBrowserPanel(false);
                    if (e.key === 'Enter') {
                      let url = urlInput.trim();
                      const isUrl = /^((https?:\/\/)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|((\d{1,3}\.){3}\d{1,3}))(:\d+)?(\/[-a-z0-9%_.~+]*)*(\?[;&a-z0-9%_.~+=-]*)?(#[-a-z0-9_]*)?$/i.test(url);
                      let finalUrl = url;
                      if (isUrl) {
                        if (!url.startsWith('http')) finalUrl = 'https://' + url;
                      } else {
                        finalUrl = \`https://www.google.com/search?q=\${encodeURIComponent(url)}&igu=1\`;
                      }
                      
                      setBrowserTabs(tabs => tabs.map(t => t.id === activeTabId ? { ...t, url: finalUrl, title: finalUrl.replace('https://', '').split('/')[0] } : t));
                      import('@tauri-apps/api/core').then(({ invoke }) => {
                          invoke('update_website', { label: \`browser_tab_\${activeTabId}\`, url: finalUrl }).catch(console.error);
                      });
                    }
                  }}
                  className="flex-1 bg-transparent outline-none text-xs"
                  placeholder="Search Google or type a URL..."
                />
              </div>
              <button onClick={() => setShowBrowserPanel(false)} className="p-1.5 hover:bg-gray-200 rounded-lg"><X className="w-4 h-4 text-gray-500"/></button>
            </div>
            <div ref={browserContainerRef} className="flex-1 overflow-hidden bg-white relative flex flex-col items-center justify-center">
              <Loader2 className="w-8 h-8 text-gray-300 animate-spin mb-4" />
            </div>
          </div>
        )}`;
code = code.replace(uiOld, uiNew);

// E. Fix dependencies
code = code.replace("[showBrowserPanel, panelWidth, browserUrl, isFullscreen]", "[showBrowserPanel, panelWidth, activeTabId, isFullscreen]");
fs.writeFileSync('src/pages/SlideReader.tsx', code);
