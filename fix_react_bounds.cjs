const fs = require('fs');
let code = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');

const oldUpdate = `  const updateWebview = async () => {
    if (showBrowserPanel && browserContainerRef.current) {
      const rect = browserContainerRef.current.getBoundingClientRect();
      const activeTab = browserTabs.find((t) => t.id === activeTabId);
      if (!activeTab) return;

      try {
        const { invoke } = await import('@tauri-apps/api/core');
        for (const tab of browserTabs) {
          if (tab.id !== activeTabId) {
            invoke('hide_website', { label: \`browser_tab_\${tab.id}\` }).catch(() => {});
          }
        }
        await invoke('embed_website', {
          label: \`browser_tab_\${activeTabId}\`,
          url: activeTab.url,
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        });
      } catch (e) {
        console.error(e);
      }
    } else {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        for (const tab of browserTabs) {
          invoke('hide_website', { label: \`browser_tab_\${tab.id}\` }).catch(() => {});
        }
      } catch (e) {}
    }
  };`;

const newUpdate = `  const updateWebview = async () => {
    if (showBrowserPanel && browserContainerRef.current) {
      setTimeout(async () => {
          if (!browserContainerRef.current) return;
          const rect = browserContainerRef.current.getBoundingClientRect();
          const activeTab = browserTabs.find((t) => t.id === activeTabId);
          if (!activeTab) return;

          // Guard against firing before the panel has actually laid out
          if (rect.width === 0 || rect.height === 0) return;

          try {
            const { invoke } = await import('@tauri-apps/api/core');
            for (const tab of browserTabs) {
              if (tab.id !== activeTabId) {
                invoke('hide_website', { label: \`browser_tab_\${tab.id}\` }).catch(() => {});
              }
            }
            
            await invoke('embed_website', {
              label: \`browser_tab_\${activeTabId}\`,
              url: activeTab.url,
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
            });
          } catch (e) {
            console.error(e);
          }
      }, 50);
    } else {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        for (const tab of browserTabs) {
          invoke('hide_website', { label: \`browser_tab_\${tab.id}\` }).catch(() => {});
        }
      } catch (e) {}
    }
  };`;

if (code.includes('const rect = browserContainerRef.current.getBoundingClientRect();') && !code.includes('setTimeout(async () => {') && !code.includes('rect.width === 0')) {
    code = code.replace(oldUpdate, newUpdate);
    fs.writeFileSync('src/pages/SlideReader.tsx', code);
}
