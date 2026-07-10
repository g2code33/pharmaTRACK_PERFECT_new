const fs = require('fs');

// 1. Rewrite Rust Backend to support Native Child Webviews
const mainRs = `#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use tauri::{Manager, WebviewBuilder, WebviewUrl};

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[tauri::command]
fn embed_website(app: tauri::AppHandle, label: String, url: String, x: f64, y: f64, width: f64, height: f64) {
    let main_window = app.get_webview_window("main").unwrap();

    if let Some(existing_webview) = app.get_webview(&label) {
        let _ = existing_webview.close();
    }

    let _webview = main_window
        .add_child(
            WebviewBuilder::new(&label, WebviewUrl::External(url.parse().unwrap()))
                .auto_resize()
                .position(x, y)
                .size(width, height)
                // Spoof identity to bypass AI bot blockers!
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
        )
        .unwrap();
}

#[tauri::command]
fn destroy_website(app: tauri::AppHandle, label: String) {
    if let Some(existing_webview) = app.get_webview(&label) {
        let _ = existing_webview.close();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![open_devtools, embed_website, destroy_website])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}`;
fs.writeFileSync('src-tauri/src/main.rs', mainRs);

// 2. Overhaul SlideReader.tsx to map coordinates to the Native Window
let slideReader = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');

const oldState = `const [browserUrl, setBrowserUrl] = useState('');`;
const newState = `const [browserUrl, setBrowserUrl] = useState('https://chatgpt.com');
  const browserContainerRef = useRef<HTMLDivElement>(null);

  const updateWebview = async () => {
    if (showBrowserPanel && browserContainerRef.current) {
      const rect = browserContainerRef.current.getBoundingClientRect();
      let url = browserUrl.trim();
      if (!url) url = 'https://chatgpt.com';
      else if (!/^https?:\\/\\//i.test(url)) url = 'https://' + url;

      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('embed_website', {
          label: 'slide_browser',
          url: url,
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        });
      } catch(e) { console.error(e); }
    } else {
      try { 
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('destroy_website', { label: 'slide_browser' }); 
      } catch(e) {}
    }
  };

  useEffect(() => {
    updateWebview();
    const handleResize = () => updateWebview();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      import('@tauri-apps/api/core').then(({invoke}) => invoke('destroy_website', { label: 'slide_browser' })).catch(()=>{});
    };
  }, [showBrowserPanel, panelWidth, browserUrl, isFullscreen]);`;

if (!slideReader.includes('updateWebview')) {
    slideReader = slideReader.replace(oldState, newState);
}

// 3. Fix Input enter mapping
const oldInputHandling = /onKeyDown=\{\(e\) => \{[\s\S]*?if \(iframe\) iframe\.src = finalUrl; \} \}\}/;
const newInputHandling = `onKeyDown={(e) => { if (e.key === 'Escape') { setShowBrowserPanel(false); return; } if (e.key === 'Enter') { let url = browserUrl.trim(); const isUrl = /^((https?:\\/\\/)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}|((\\d{1,3}\\.){3}\\d{1,3}))(:\\d+)?(\\/[-a-z0-9%_.~+]*)*(\\?[;&a-z0-9%_.~+=-]*)?(#[-a-z0-9_]*)?$/i.test(url); let finalUrl = url; if (isUrl) { if (!url.startsWith('http')) finalUrl = 'https://' + url; } else { finalUrl = \`https://www.google.com/search?q=\${encodeURIComponent(url)}\`; } setBrowserUrl(finalUrl); } }}`;
slideReader = slideReader.replace(oldInputHandling, newInputHandling);

// 4. Replace iframe with native OS bounds placeholder
const oldIframeDiv = /<div className="flex-1 overflow-hidden bg-white relative">[\s\S]*?<\/div>/;
const newIframeDiv = `<div ref={browserContainerRef} className="flex-1 overflow-hidden bg-[#1E293B] relative flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-gray-500 animate-spin" />
            </div>`;
slideReader = slideReader.replace(oldIframeDiv, newIframeDiv);

fs.writeFileSync('src/pages/SlideReader.tsx', slideReader);

// 5. Bump versions to 1.1.72
let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.72';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.72';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(/v1\.1\.\d+/g, 'v1.1.72');
fs.writeFileSync('src/components/Layout.tsx', layout);

console.log("Native OS Webview successfully injected!");
