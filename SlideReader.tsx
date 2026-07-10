import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import { loadFile } from '../utils/storage';
import {
  ArrowLeft, ChevronLeft, ChevronRight, Sparkles, Send, Loader2,
  Lightbulb, Maximize2, Minimize2, Download, X, Globe, MessageSquare as MessageSquareIcon, File
} from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';

// Offline-first worker initialization
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const SlideReader: React.FC = () => {
  const { topicId } = useParams<{ topicId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { state, dispatch, getSlidesForTopic } = useApp();

  const initialSlide = parseInt(searchParams.get('slide') || '0', 10);
  const [currentSlideIndex, setCurrentSlideIndex] = useState(initialSlide);
  const [showAIPanel, setShowAIPanel] = useState(true);
  const [showBrowserPanel, setShowBrowserPanel] = useState(false);
  const [activePanel, setActivePanel] = useState<'ai' | 'browser'>('ai');
  const [chatInput, setChatInput] = useState('');
  const [isAILoading, setIsAILoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(window.innerWidth > 1024 ? 400 : 320);
  const [isResizing, setIsResizing] = useState(false);
  const [browserTabs, setBrowserTabs] = useState([{ id: 'default', url: 'https://chatgpt.com', title: 'ChatGPT' }]);
  const [activeTabId, setActiveTabId] = useState('default');
  const [urlInput, setUrlInput] = useState('https://chatgpt.com');

  useEffect(() => {
    const tab = browserTabs.find(t => t.id === activeTabId);
    if (tab) setUrlInput(tab.url);
  }, [activeTabId, browserTabs]);
  const browserContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let unlisten: any;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('new-browser-tab', (event: any) => {
        const url = event.payload as string;
        const newId = uuidv4();
        const title = url.replace('https://', '').split('/');
        setBrowserTabs(tabs => [...tabs, { id: newId, url, title }]);
        setActiveTabId(newId);
        setShowBrowserPanel(true);
        setShowAIPanel(false);
      }).then((u: any) => unlisten = u);
    });
    return () => { if (unlisten) unlisten(); }
  }, []);

  const updateWebview = async () => {
    if (showBrowserPanel && browserContainerRef.current) {
      setTimeout(async () => {
          if (!browserContainerRef.current) return;
          const rect = browserContainerRef.current.getBoundingClientRect();
          const activeTab = browserTabs.find(t => t.id === activeTabId);
          if (!activeTab) return;

          try {
            const { invoke } = await import('@tauri-apps/api/core');
            for (const tab of browserTabs) {
               if (tab.id !== activeTabId) invoke('hide_website', { label: `browser_tab_${tab.id}` }).catch(()=>{});
            }
            await invoke('embed_website', {
              label: `browser_tab_${activeTabId}`, url: activeTab.url, x: rect.left, y: rect.top, width: rect.width, height: rect.height
            });
          } catch(e) { console.error(e); }
      }, 50);
    } else {
      try { 
        const { invoke } = await import('@tauri-apps/api/core');
        for (const tab of browserTabs) invoke('hide_website', { label: `browser_tab_${tab.id}` }).catch(()=>{});
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
  }, [showBrowserPanel, panelWidth, activeTabId, isFullscreen]);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const topic = state.topics.find((t) => t.id === topicId);
  const course = topic ? state.courses.find((c) => c.id === topic.courseId) : null;
  const materialList = topicId ? getSlidesForTopic(topicId) : [];
  const currentMaterial = materialList[currentSlideIndex];

  const chatMessages = state.chatHistory
    .filter((m) => m.topicId === topicId)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: new Date(m.timestamp),
    }));

  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(true);

  useEffect(() => {
    if (!currentMaterial) return;
    setIsLoadingContent(true);
    let isMounted = true;

    loadFile(currentMaterial.id).then(async (fileData: any) => {
      if (!isMounted) return;
      if (!fileData) {
        setIsLoadingContent(false);
        return;
      }
      
      let data;
      if (fileData instanceof Blob) {
          data = new Uint8Array(await fileData.arrayBuffer());
      } else if (fileData instanceof Uint8Array) {
          data = fileData;
      } else if (typeof fileData === 'string') {
          const base64Data = fileData.split(',') || fileData;
          const binaryString = window.atob(base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
          data = bytes;
      } else {
          data = new Uint8Array(fileData);
      }
      
      const blob = new Blob([data], { type: currentMaterial.fileType === 'pdf' ? 'application/pdf' : 'application/octet-stream' });
      const newUrl = URL.createObjectURL(blob);
      setFileUrl(newUrl);
      setIsLoadingContent(false);
    });

    return () => { isMounted = false; };
  }, [currentMaterial]);

  return (
    <div className="flex h-screen w-full bg-slate-900 text-white">
      <div className="flex flex-1 flex-col items-center justify-center p-4">
        {isLoadingContent ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            <p className="text-sm text-slate-400">Loading document...</p>
          </div>
        ) : fileUrl ? (
          <iframe src={fileUrl} className="h-full w-full rounded-lg border border-slate-700" title="Slide Viewer" />
        ) : (
          <div className="text-slate-400">No slide content found</div>
        )}
      </div>
    </div>
  );
};

export default SlideReader;
