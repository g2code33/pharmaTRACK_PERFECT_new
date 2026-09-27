import React, { useState, useEffect, useRef } from 'react';
import { listenNative, nativeInvoke, detectRuntimeCapabilities } from '../platform/runtime';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import { loadFile } from '../utils/storage';
import { sniffMaterialKind, type MaterialKind } from '../utils/materialKind';
import PdfViewer from '../components/PdfViewer';
import PptxViewer from '../components/PptxViewer';
import AIChatPanel from '../components/AIChatPanel';
import { loadSlideText } from '../utils/storage';
import type { AIChatMessage, AppStateLike, ContextSelection } from '../ai';
import {
  ArrowLeft, ChevronLeft, ChevronRight, Loader2,
  Maximize2, Minimize2, X, Globe, MessageSquare as MessageSquareIcon,
  ArrowLeftCircle, ArrowRightCircle, RotateCw, ExternalLink
} from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';

// Offline-first worker initialization
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface BrowserTab {
  id: string;
  url: string;
  title: string;
  history?: string[];
  historyIndex?: number;
}

// Detects whether typed text is a URL or a search query, and normalizes it.
// "paracetamol dosing" -> Search engine. "bnf.org" or "https://..." -> direct nav.
function resolveAddressInput(raw: string, isNative: boolean): string {
  const trimmed = raw.trim();
  const looksLikeUrl = /^((https?:\/\/)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|((\d{1,3}\.){3}\d{1,3}))(:\d+)?(\/[-a-z0-9%_.~+]*)*(\?[;&a-z0-9%_.~+=-]*)?(#[-a-z0-9_]*)?$/i.test(trimmed);

  if (looksLikeUrl) {
    return trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  }
  if (isNative) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url.replace('https://', '').split('/')[0];
  }
}

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
  /** Page/slide currently on screen — the *only* material sent to the AI. */
  const [page, setPage] = useState(1);
  const [pageText, setPageText] = useState('');
  const [pageCount, setPageCount] = useState(0);
  /** Full text of the open material, loaded from IndexedDB on demand. */
  const [fullText, setFullText] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(window.innerWidth > 1024 ? 400 : 320);
  const [isResizing, setIsResizing] = useState(false);

  const [browserTabs, setBrowserTabs] = useState<BrowserTab[]>(() => {
    const isNative = detectRuntimeCapabilities().nativeWebview;
    const initialUrl = isNative ? 'https://www.google.com' : 'https://en.m.wikipedia.org/wiki/Pharmacology';
    return [
      {
        id: 'default',
        url: initialUrl,
        title: isNative ? 'Google' : 'Wikipedia',
        history: [initialUrl],
        historyIndex: 0,
      },
    ];
  });
  const [activeTabId, setActiveTabId] = useState('default');
  const [urlInput, setUrlInput] = useState(() => {
    const isNative = detectRuntimeCapabilities().nativeWebview;
    return isNative ? 'https://www.google.com' : 'https://en.m.wikipedia.org/wiki/Pharmacology';
  });
  const [webviewReady, setWebviewReady] = useState(false);

  const browserContainerRef = useRef<HTMLDivElement>(null);
  const boundsUpdateRafRef = useRef<number | null>(null);

  const getBrowserContainerBounds = () => {
    const el = browserContainerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };

  const scheduleWebviewBoundsUpdate = () => {
    if (boundsUpdateRafRef.current !== null) return;
    boundsUpdateRafRef.current = requestAnimationFrame(() => {
      boundsUpdateRafRef.current = null;
      void updateWebview();
    });
  };

  // Keep the address bar in sync with whichever tab is active
  useEffect(() => {
    const tab = browserTabs.find(t => t.id === activeTabId);
    if (tab) setUrlInput(tab.url);
  }, [activeTabId, browserTabs]);

  // Native webview events and commands are optional. In a browser this whole
  // block becomes a no-op; the surrounding study reader remains usable.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenNative<string>('new-browser-tab', (event) => {
      const url = event.payload;
      const newId = uuidv4();
      setBrowserTabs(tabs => [...tabs, {
        id: newId,
        url,
        title: titleFromUrl(url),
        history: [url],
        historyIndex: 0,
      }]);
      setActiveTabId(newId);
      setShowBrowserPanel(true);
      setShowAIPanel(false);
      setActivePanel('browser');
    }).then((remove) => { unlisten = remove; });
    return () => { unlisten?.(); };
  }, []);

  // Listen for live navigation updates from the embedded webview (title/url
  // changes as the user clicks around inside it).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenNative<{ label: string; url: string; title?: string }>('webview-navigation-update', (event) => {
      const { label, url, title } = event.payload;
      const tabId = label.replace('browser_tab_', '');
      setBrowserTabs(tabs => tabs.map(t =>
        t.id === tabId ? { ...t, url, title: title || titleFromUrl(url) } : t
      ));
      if (tabId === activeTabId) setUrlInput(url);
      setWebviewReady(true);
    }).then((remove) => { unlisten = remove; });
    return () => { unlisten?.(); };
  }, [activeTabId]);

  const updateWebview = async () => {
    if (!detectRuntimeCapabilities().nativeWebview) return;
    if (showBrowserPanel && browserContainerRef.current) {
      const bounds = getBrowserContainerBounds();
      const activeTab = browserTabs.find(t => t.id === activeTabId);
      if (!activeTab || !bounds) {
        if (!bounds) console.warn('embed_website skipped: container not laid out yet');
        return;
      }

      for (const tab of browserTabs) {
        if (tab.id !== activeTabId) {
          void nativeInvoke('hide_website', { label: `browser_tab_${tab.id}` });
        }
      }
      await nativeInvoke('embed_website', {
        label: `browser_tab_${activeTabId}`,
        url: activeTab.url,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    } else {
      for (const tab of browserTabs) {
        void nativeInvoke('hide_website', { label: `browser_tab_${tab.id}` });
      }
    }
  };

  useEffect(() => {
    scheduleWebviewBoundsUpdate();
    let timer: NodeJS.Timeout | null = null;
    if (showBrowserPanel) {
      timer = setTimeout(() => {
        scheduleWebviewBoundsUpdate();
      }, 50);
    }
    const handleResize = () => scheduleWebviewBoundsUpdate();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (timer) clearTimeout(timer);
      if (boundsUpdateRafRef.current !== null) {
        cancelAnimationFrame(boundsUpdateRafRef.current);
        boundsUpdateRafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBrowserPanel, panelWidth, activeTabId, isFullscreen, browserTabs.length, showAIPanel]);

  // Track the browser container's own size changes (panel drag, flex reflow, etc.)
  useEffect(() => {
    const el = browserContainerRef.current;
    if (!el || !showBrowserPanel || !detectRuntimeCapabilities().nativeWebview) return;

    const observer = new ResizeObserver(() => scheduleWebviewBoundsUpdate());
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBrowserPanel, activeTabId, panelWidth]);

  // Destroy every tab's native webview on unmount so nothing leaks across a long session.
  useEffect(() => {
    return () => {
      if (!detectRuntimeCapabilities().nativeWebview) return;
      for (const tab of browserTabs) {
        void nativeInvoke('destroy_website', { label: `browser_tab_${tab.id}` });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigateActiveTab = (finalUrl: string) => {
    setBrowserTabs(tabs => tabs.map(t => {
      if (t.id !== activeTabId) return t;
      const history = t.history || [t.url];
      const currentIndex = t.historyIndex ?? (history.length - 1);
      const newHistory = [...history.slice(0, currentIndex + 1), finalUrl];
      return {
        ...t,
        url: finalUrl,
        title: titleFromUrl(finalUrl),
        history: newHistory,
        historyIndex: newHistory.length - 1,
      };
    }));
    setUrlInput(finalUrl);
    setWebviewReady(false);
    if (detectRuntimeCapabilities().nativeWebview) {
      void nativeInvoke('navigate_website', { label: `browser_tab_${activeTabId}`, url: finalUrl });
    }
  };

  const handleAddressBarSubmit = () => {
    if (!urlInput.trim()) return;
    const isNative = detectRuntimeCapabilities().nativeWebview;
    navigateActiveTab(resolveAddressInput(urlInput, isNative));
  };

  const handleBack = () => {
    if (detectRuntimeCapabilities().nativeWebview) {
      void nativeInvoke('webview_back', { label: `browser_tab_${activeTabId}` });
      return;
    }
    const tab = browserTabs.find(t => t.id === activeTabId);
    if (!tab || !tab.history || (tab.historyIndex ?? 0) <= 0) return;
    const newIndex = (tab.historyIndex ?? 0) - 1;
    const prevUrl = tab.history[newIndex];
    setBrowserTabs(tabs => tabs.map(t =>
      t.id === activeTabId ? { ...t, url: prevUrl, title: titleFromUrl(prevUrl), historyIndex: newIndex } : t
    ));
    setUrlInput(prevUrl);
    setWebviewReady(false);
  };

  const handleForward = () => {
    if (detectRuntimeCapabilities().nativeWebview) {
      void nativeInvoke('webview_forward', { label: `browser_tab_${activeTabId}` });
      return;
    }
    const tab = browserTabs.find(t => t.id === activeTabId);
    if (!tab || !tab.history || (tab.historyIndex ?? 0) >= tab.history.length - 1) return;
    const newIndex = (tab.historyIndex ?? 0) + 1;
    const nextUrl = tab.history[newIndex];
    setBrowserTabs(tabs => tabs.map(t =>
      t.id === activeTabId ? { ...t, url: nextUrl, title: titleFromUrl(nextUrl), historyIndex: newIndex } : t
    ));
    setUrlInput(nextUrl);
    setWebviewReady(false);
  };

  const handleReload = () => {
    setWebviewReady(false);
    if (detectRuntimeCapabilities().nativeWebview) {
      void nativeInvoke('webview_reload', { label: `browser_tab_${activeTabId}` });
      return;
    }
    const tab = browserTabs.find(t => t.id === activeTabId);
    if (tab) {
      const currentUrl = tab.url;
      setBrowserTabs(tabs => tabs.map(t => t.id === activeTabId ? { ...t, url: '' } : t));
      setTimeout(() => {
        setBrowserTabs(tabs => tabs.map(t => t.id === activeTabId ? { ...t, url: currentUrl } : t));
      }, 50);
    }
  };

  const openNewTab = () => {
    const isNative = detectRuntimeCapabilities().nativeWebview;
    const defaultUrl = isNative ? 'https://www.google.com' : 'https://en.m.wikipedia.org/wiki/Pharmacology';
    const newId = uuidv4();
    setBrowserTabs(tabs => [...tabs, {
      id: newId,
      url: defaultUrl,
      title: titleFromUrl(defaultUrl),
      history: [defaultUrl],
      historyIndex: 0,
    }]);
    setActiveTabId(newId);
    setUrlInput(defaultUrl);
    setWebviewReady(false);
  };

  const closeTab = (tabId: string) => {
    if (browserTabs.length === 1) return;
    const remaining = browserTabs.filter(t => t.id !== tabId);
    setBrowserTabs(remaining);
    if (detectRuntimeCapabilities().nativeWebview) {
      void nativeInvoke('destroy_website', { label: `browser_tab_${tabId}` });
    }
    if (activeTabId === tabId) {
      setActiveTabId(remaining[0].id);
      setUrlInput(remaining[0].url);
    }
  };

  const chatEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const topic = state.topics.find((t) => t.id === topicId);
  const course = topic ? state.courses.find((c) => c.id === topic.courseId) : null;
  const materialList = topicId ? getSlidesForTopic(topicId) : [];
  const currentMaterial = materialList[currentSlideIndex];

  // Study Bank links in as /read/:topicId?slide=N&page=M
  const deepLinkPage = parseInt(searchParams.get('page') || '0', 10) || undefined;
  const deepLinkMaterial = searchParams.get('material') || undefined;
  const deepLinkQuery = searchParams.get('q') || undefined;
  const focusHighlightId = searchParams.get('highlight') || undefined;

  // A global-search hit links to a specific material; select it once loaded.
  React.useEffect(() => {
    if (!deepLinkMaterial || !materialList.length) return;
    const idx = materialList.findIndex((m) => m.id === deepLinkMaterial);
    if (idx >= 0 && idx !== currentSlideIndex) setCurrentSlideIndex(idx);
  }, [deepLinkMaterial, materialList.length]);


  /** Highlights belonging to the material currently open. */
  const materialHighlights = React.useMemo(
    () => state.highlights.filter((h) => h.materialId === currentMaterial?.id),
    [state.highlights, currentMaterial?.id],
  );

  const handleCreateHighlight = (h: { page: number; text: string; color: string; rects: any[] }) => {
    if (!topicId || !currentMaterial) return;
    dispatch({
      type: 'ADD_HIGHLIGHT',
      payload: {
        topicId,
        slideIndex: currentSlideIndex,
        materialId: currentMaterial.id,
        page: h.page,
        text: h.text,
        color: h.color,
        rects: h.rects,
      },
    });
  };

  /**
   * Selection → AI. The passage becomes part of the *context*, not a giant
   * prompt string: the engine sends the selection plus the current page/slide.
   */
  const [selection, setSelection] = useState('');
  const handleAskAiAboutSelection = (text: string) => {
    setShowAIPanel(true);
    setShowBrowserPanel(false);
    setActivePanel('ai');
    setSelection(text);
  };

  /** Loads the full extracted text lazily, only once a material is opened. */
  useEffect(() => {
    let cancelled = false;
    if (!currentMaterial?.id) {
      setFullText(null);
      return;
    }
    loadSlideText(currentMaterial.id)
      .then((text) => !cancelled && setFullText(text ?? currentMaterial.contentText ?? ''))
      .catch(() => !cancelled && setFullText(currentMaterial.contentText ?? ''));
    return () => {
      cancelled = true;
    };
  }, [currentMaterial?.id, currentMaterial?.contentText]);

  // Reset page tracking when switching material.
  useEffect(() => {
    setPage(1);
    setPageText('');
    setPageCount(0);
    setSelection('');
  }, [currentMaterial?.id]);

  // Opening the reader is study. Once per day; does not advance the revision interval.
  useEffect(() => {
    if (!topicId) return;
    dispatch({ type: 'MARK_TOPIC_STUDIED', payload: { topicId } });
  }, [topicId, dispatch]);

  // Recently opened. Does not touch the file, so a failed render still counts.
  useEffect(() => {
    const id = currentMaterial?.id;
    if (!id) return;
    dispatch({
      type: 'UPDATE_SLIDE',
      payload: { id, updates: { lastOpenedAt: new Date().toISOString() } },
    });
  }, [currentMaterial?.id, dispatch]);

  // Last page/slide, written after the viewer has actually reported a count
  // so the reset-to-1 above does not overwrite a resumed position.
  useEffect(() => {
    const id = currentMaterial?.id;
    if (!id || pageCount < 1) return;
    const timer = window.setTimeout(() => {
      dispatch({
        type: 'UPDATE_SLIDE',
        payload: {
          id,
          updates: {
            lastOpenedAt: new Date().toISOString(),
            lastPosition: page,
            pageCount,
          },
        },
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [currentMaterial?.id, page, pageCount, dispatch]);

  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [openedKind, setOpenedKind] = useState<MaterialKind | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(true);

  useEffect(() => {
    if (!currentMaterial?.id) return;
    const materialId = currentMaterial.id;
    const fileType = currentMaterial.fileType;
    const knownKind = currentMaterial.materialKind;
    const knownSize = currentMaterial.fileSize;
    setIsLoadingContent(true);
    setOpenedKind(null);
    let isMounted = true;

    loadFile(materialId).then(async (fileData: any) => {
      if (!isMounted) return;
      if (!fileData) {
        setIsLoadingContent(false);
        return;
      }

      let data: Uint8Array;
      if (fileData instanceof Blob) {
        data = new Uint8Array(await fileData.arrayBuffer());
      } else if (fileData instanceof Uint8Array) {
        data = fileData;
      } else if (typeof fileData === 'string') {
        const base64Data = fileData.split(',')[1] || fileData;
        const binaryString = window.atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
        data = bytes;
      } else {
        data = new Uint8Array(fileData);
      }

      const sniffed = sniffMaterialKind(data);
      const mime = fileType === 'pdf' || sniffed === 'pdf'
        ? 'application/pdf'
        : sniffed === 'pptx'
          ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
          : 'application/octet-stream';
      const blob = new Blob([data as unknown as BlobPart], { type: mime });
      const newUrl = URL.createObjectURL(blob);
      setOpenedKind(sniffed);
      setFileUrl(newUrl);
      setIsLoadingContent(false);

      const updates: Partial<import('../types').Slide> = {};
      if ((!knownKind || knownKind === 'unknown') && sniffed !== 'unknown' && sniffed !== 'text') {
        updates.materialKind = sniffed;
      }
      if (knownSize == null) updates.fileSize = data.byteLength;
      if (Object.keys(updates).length) {
        dispatch({ type: 'UPDATE_SLIDE', payload: { id: materialId, updates } });
      }
    }).catch(err => {
      console.error(err);
      if (isMounted) setIsLoadingContent(false);
    });

    return () => {
      isMounted = false;
      setFileUrl(prevUrl => {
        if (prevUrl) URL.revokeObjectURL(prevUrl);
        return null;
      });
    };
    // Metadata updates must not reload the file, or the viewer jumps back to slide 1.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMaterial?.id, currentMaterial?.fileType]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.chatHistory]);

  const handleToggleBrowser = () => {
    if (showBrowserPanel) {
      // If browser is open, clicking it again brings AI back!
      setShowBrowserPanel(false);
      setShowAIPanel(true);
      setActivePanel('ai');
    } else {
      // Open browser in place of AI in the exact same panel position
      setShowAIPanel(false);
      setShowBrowserPanel(true);
      setActivePanel('browser');
    }
  };

  const handleToggleAI = () => {
    if (showAIPanel) {
      // If AI is currently open, toggle off
      setShowAIPanel(false);
      setShowBrowserPanel(false);
    } else {
      // Close browser if open, and bring AI back
      setShowBrowserPanel(false);
      setShowAIPanel(true);
      setActivePanel('ai');
    }
  };

  const handleToggleExpandReader = () => {
    if (showAIPanel || showBrowserPanel) {
      setShowAIPanel(false);
      setShowBrowserPanel(false);
    } else {
      if (activePanel === 'browser') {
        setShowBrowserPanel(true);
        setShowAIPanel(false);
      } else {
        setShowAIPanel(true);
        setShowBrowserPanel(false);
      }
    }
  };

  // Global Escape Key Handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFullscreen(false);
        if (showBrowserPanel) {
          setShowBrowserPanel(false);
          setShowAIPanel(true);
          setActivePanel('ai');
        } else if (showAIPanel) {
          setShowAIPanel(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showBrowserPanel, showAIPanel]);

  const openExternalWeb = async (targetUrl?: string) => {
    const destination = targetUrl || urlInput || 'https://en.wikipedia.org/wiki/Pharmacology';
    try {
      if (!detectRuntimeCapabilities().nativeHost) {
        window.open(destination, '_blank', 'noopener,noreferrer');
        return;
      }
      await nativeInvoke('open_external_url', { url: destination });
    } catch {
      window.open(destination, '_blank', 'noopener,noreferrer');
    }
  };

  const handleNext = () => {
    if (currentSlideIndex < materialList.length - 1) {
      setCurrentSlideIndex(currentSlideIndex + 1);
    }
  };

  const handlePrev = () => {
    if (currentSlideIndex > 0) {
      setCurrentSlideIndex(currentSlideIndex - 1);
    }
  };

  /**
   * Which material the student is reading, and exactly where in it. The engine
   * turns this into "course → topic → page/slide → question" context; the whole
   * document and the rest of the semester are never sent.
   */
  const isPdf = currentMaterial?.fileType === 'pdf' || openedKind === 'pdf';
  const aiScope: ContextSelection = {
    topicId,
    courseId: topic?.courseId,
    materialId: currentMaterial?.id,
    page: isPdf ? page : undefined,
    slide: isPdf ? undefined : page,
    selection: selection || undefined,
    materialText: currentMaterial
      ? {
          label: currentMaterial.title,
          text: fullText ?? currentMaterial.contentText ?? '',
          page: isPdf ? page : undefined,
          slide: isPdf ? undefined : page,
          // Only the page/slide in view goes out, not the whole document.
          focusText: pageText || undefined,
        }
      : undefined,
  };

  /**
   * Mirrors the AI transcript into the topic's chat history. That store is
   * academic data (it is included in semester archives), so it is kept in sync
   * while the engine owns provider metadata.
   */
  const mirrorChatMessage = (message: AIChatMessage) => {
    if (!topicId) return;
    dispatch({
      type: 'ADD_CHAT_MESSAGE',
      payload: { topicId, role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content },
    });
  };

  const renderUniversalContent = () => {
    if (isLoadingContent || !fileUrl) {
      return (
        <div className="py-40 text-center flex flex-col items-center justify-center h-full w-full">
          <Loader2 className="w-12 h-12 text-[#FFB703] mx-auto mb-4 animate-spin" />
          <p className="text-xl font-black text-gray-400 uppercase tracking-widest">Loading Material...</p>
        </div>
      );
    }

    // Canvas-rendered viewer. The old <iframe> clipped the bottom of every
    // document (a `minHeight: 85vh` wrapper around an `absolute inset-0`
    // iframe) and exposed no page count, search or navigation.
    if (currentMaterial?.fileType === 'pdf' || openedKind === 'pdf') {
      return (
        <PdfViewer
          fileUrl={fileUrl}
          title={currentMaterial.title}
          highlights={materialHighlights}
          onCreateHighlight={handleCreateHighlight}
          onDeleteHighlight={(id) => dispatch({ type: 'DELETE_HIGHLIGHT', payload: id })}
          onAskAi={handleAskAiAboutSelection}
          jumpToPage={deepLinkPage}
          initialQuery={deepLinkQuery}
          focusHighlightId={focusHighlightId}
          onPageChange={(current, total, text) => {
            setPage(current);
            setPageCount(total);
            setPageText(text ?? '');
          }}
        />
      );
    }

    const nameHint = (currentMaterial?.title || '').toLowerCase();
    if (currentMaterial?.fileType === 'text' && /\.pptx?$/.test(nameHint)) {
      return (
        <PptxViewer
          fileUrl={fileUrl}
          title={currentMaterial.title}
          extractedText={currentMaterial.contentText}
          uploadDate={currentMaterial.createdAt}
          jumpToPage={deepLinkPage}
          initialQuery={deepLinkQuery}
          onCreateHighlight={(h) => handleCreateHighlight({ ...h, rects: [] })}
          onAskAi={handleAskAiAboutSelection}
          onSlideChange={(current, total, text) => {
            setPage(current);
            setPageCount(total);
            setPageText(text ?? '');
          }}
        />
      );
    }

    if (currentMaterial?.fileType === 'text') {
      return (
        <div className="w-full h-full overflow-auto bg-white p-8">
          <pre className="max-w-4xl mx-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-700">
            {currentMaterial.contentText || 'No text content.'}
          </pre>
        </div>
      );
    }

    if (currentMaterial?.fileType === 'jpg' || currentMaterial?.fileType === 'png') {
      return (
        <div className="w-full flex items-center justify-center p-4 bg-gray-900 h-full min-h-[85vh]">
          <img src={fileUrl} className="max-w-full shadow-2xl rounded-lg" alt="visual material" />
        </div>
      );
    }

    return null;
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      e.preventDefault();
      const newWidth = window.innerWidth - e.clientX;
      if (newWidth > 200 && newWidth < window.innerWidth * 0.7) {
        setPanelWidth(newWidth);
        scheduleWebviewBoundsUpdate();
      }
    };
    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = 'default';
    };
    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  if (!currentMaterial || !course) return <div>Loading...</div>;

  return (
    <div className={`flex flex-col h-full bg-[#F1F5F9] ${isFullscreen ? 'fixed inset-0 z-[100] h-screen w-screen' : 'h-[calc(100vh-120px)]'}`}>
      <div className="bg-white px-4 py-1.5 border-b shadow-sm z-[110] flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => navigate('/materials')} className="p-1.5 hover:bg-gray-100 rounded-full text-gray-400 transition-all flex-shrink-0"><ArrowLeft className="w-4 h-4" /></button>
          <div className="hidden sm:block truncate">
            <h1 className="font-bold text-xs text-gray-800 tracking-tight leading-none truncate max-w-[150px] mb-0.5">{currentMaterial?.title}</h1>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest">{course?.courseCode}</span>
              <span className="w-1 h-1 bg-gray-300 rounded-full" />
              <span className="text-[9px] text-[#2D6A4F] font-black uppercase tracking-widest">
                Slide {currentSlideIndex + 1} of {materialList.length}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex bg-gray-100 p-0.5 rounded-lg border border-gray-200">
            <button
              onClick={handleToggleAI}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-black text-[10px] transition-all ${activePanel === 'ai' && showAIPanel ? 'bg-[#2D6A4F] text-[#FFB703] shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              title={showAIPanel ? 'Hide AI panel' : 'Open AI panel'}
            >
              <MessageSquareIcon className="w-3.5 h-3.5" /> AI
              {pageCount > 0 && (
                <span className="text-[9px] font-bold text-current/70" data-testid="ai-scope-label">
                  {isPdf ? 'p' : 'slide'} {page}/{pageCount}
                </span>
              )}
            </button>
            <button
              onClick={handleToggleBrowser}
              title={showBrowserPanel ? 'Return to AI' : 'Open browser in side panel'}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-black text-[10px] transition-all ${activePanel === 'browser' && showBrowserPanel ? 'bg-[#2D6A4F] text-[#FFB703] shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
            >
              <Globe className="w-3.5 h-3.5" /> Browser
            </button>
          </div>

          <button
            onClick={handleToggleExpandReader}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-black text-[10px] transition-all ml-1 ${!showAIPanel && !showBrowserPanel ? 'bg-[#2D6A4F] text-[#FFB703] shadow-sm' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
            title={!showAIPanel && !showBrowserPanel ? 'Restore side panel' : 'Expand reader to full width'}
          >
            <Maximize2 className="w-3.5 h-3.5" /> Expand Reader
          </button>

          <button onClick={() => setIsFullscreen(!isFullscreen)} className="p-1.5 bg-gray-50 text-gray-400 rounded-full hover:bg-gray-100 transition-all ml-2">{isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}</button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden relative">
        <div className="flex flex-col bg-[#F8FAFC] min-w-0 relative group/viewer h-full overflow-hidden" style={{ flex: 1 }}>
          <div ref={scrollContainerRef} className="flex-1 overflow-y-auto flex flex-col items-center p-0 scrollbar-thin">
            {renderUniversalContent()}
          </div>

          <div className="absolute inset-y-0 left-0 w-16 flex items-center justify-center opacity-0 group-hover/viewer:opacity-100 transition-opacity z-50 pointer-events-none">
            <button
              onClick={handlePrev}
              className="w-10 h-10 bg-white/90 border border-gray-200 rounded-full flex items-center justify-center shadow-xl pointer-events-auto hover:scale-110 active:scale-95 disabled:opacity-50 transition-all text-gray-800"
              disabled={currentSlideIndex === 0}
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          </div>
          <div className="absolute inset-y-0 right-0 w-16 flex items-center justify-center opacity-0 group-hover/viewer:opacity-100 transition-opacity z-50 pointer-events-none">
            <button
              onClick={handleNext}
              className="w-10 h-10 bg-white/90 border border-gray-200 rounded-full flex items-center justify-center shadow-xl pointer-events-auto hover:scale-110 active:scale-95 disabled:opacity-50 transition-all text-gray-800"
              disabled={currentSlideIndex === materialList.length - 1}
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          </div>
        </div>

        {(showAIPanel || showBrowserPanel) && (
          <div
            className="w-1 cursor-col-resize flex-shrink-0 bg-gray-200 hover:bg-[#2D6A4F] active:bg-[#2D6A4F] transition-all z-[120] relative group"
            onMouseDown={() => setIsResizing(true)}
          >
            <div className="absolute inset-y-0 -left-1 -right-1 group-hover:block" />
          </div>
        )}

        {showAIPanel && (
          <div
            className="bg-white border-l flex flex-col shadow-2xl z-[110] flex-shrink-0 relative overflow-hidden"
            style={{ width: `${panelWidth}px` }}
          >
            <button
              onClick={() => setShowAIPanel(false)}
              className="absolute top-2 right-2 p-1.5 hover:bg-gray-100 rounded-full transition-all z-20"
              title="Close AI panel"
            >
              <X className="w-4 h-4 text-gray-400" />
            </button>
            {/* The panel talks to the AI engine, never to a provider: which
                provider/model answers is configuration, not UI. */}
            <AIChatPanel
              scope={aiScope}
              appState={state as unknown as AppStateLike}
              title={currentMaterial ? 'PharmaTRACK AI' : 'AI'}
              compact
              loadMaterialText={currentMaterial?.id ? (id) => loadSlideText(id) : undefined}
              quickTasks={
                // The Phase 11 action sets. A PDF page and a presentation slide
                // offer the same jobs; only the wording of "explain" differs.
                isPdf
                  ? ['explain-page', 'simplify', 'summarize', 'questions-from-material', 'flashcards', 'ask-material', 'key-concepts', 'mcq', 'mechanism']
                  : ['explain-slide', 'simplify', 'summarize', 'questions-from-material', 'flashcards', 'ask-material', 'key-concepts', 'mcq', 'mechanism']
              }
              onMessage={mirrorChatMessage}
            />
          </div>
        )}

        {showBrowserPanel && (
          <div className="bg-white border-l flex flex-col shadow-2xl z-[110] flex-shrink-0 relative overflow-hidden" style={{ width: `${panelWidth}px` }}>

            {/* Tab bar */}
            <div className="flex bg-gray-200 overflow-x-auto border-b border-gray-300 scrollbar-none h-9 flex-shrink-0">
              {browserTabs.map(tab => (
                <div
                  key={tab.id}
                  className={`flex items-center gap-2 px-3 py-1 cursor-pointer border-r border-gray-300 min-w-[100px] max-w-[150px] transition-all ${activeTabId === tab.id ? 'bg-white font-bold text-gray-900' : 'hover:bg-gray-100 text-gray-600'}`}
                  onClick={() => {
                    setActiveTabId(tab.id);
                    setUrlInput(tab.url);
                  }}
                >
                  <span className="text-xs truncate flex-1">{tab.title}</span>
                  {browserTabs.length > 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                      className="p-0.5 hover:bg-gray-200 rounded-sm"
                      title="Close tab"
                    >
                      <X className="w-3 h-3 text-gray-500" />
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={openNewTab}
                className="px-3 hover:bg-gray-300 flex items-center justify-center text-gray-600 font-black text-lg transition-colors"
                title="New tab"
              >
                +
              </button>
            </div>

            {/* Address bar + navigation controls */}
            <div className="p-2 border-b bg-gray-50 flex items-center gap-1.5 flex-shrink-0">
              <button onClick={handleBack} className="p-1.5 hover:bg-gray-200 rounded-lg text-gray-500 transition-colors" title="Back">
                <ArrowLeftCircle className="w-4 h-4" />
              </button>
              <button onClick={handleForward} className="p-1.5 hover:bg-gray-200 rounded-lg text-gray-500 transition-colors" title="Forward">
                <ArrowRightCircle className="w-4 h-4" />
              </button>
              <button onClick={handleReload} className="p-1.5 hover:bg-gray-200 rounded-lg text-gray-500 transition-colors" title="Reload">
                <RotateCw className="w-4 h-4" />
              </button>

              <div className="flex items-center gap-1.5 flex-1 bg-white border border-gray-200 rounded-lg px-2 py-1 shadow-sm min-w-0">
                <Globe className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') handleToggleBrowser();
                    if (e.key === 'Enter') handleAddressBarSubmit();
                  }}
                  className="flex-1 bg-transparent outline-none text-xs min-w-0"
                  placeholder="Search or enter URL..."
                />
              </div>

              {/* Pop-out external window button for users who explicitly want one */}
              <button
                onClick={() => openExternalWeb(browserTabs.find(t => t.id === activeTabId)?.url)}
                className="p-1.5 hover:bg-gray-200 rounded-lg text-gray-500 transition-colors"
                title="Open current page in external window"
              >
                <ExternalLink className="w-4 h-4" />
              </button>

              {/* Close Browser / Return to AI button */}
              <button
                onClick={handleToggleBrowser}
                className="p-1.5 hover:bg-gray-200 rounded-lg text-gray-500 transition-colors"
                title="Close browser and return to AI"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Quick study references bar */}
            <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 border-b overflow-x-auto text-[10px] scrollbar-none flex-shrink-0">
              <span className="text-gray-400 font-bold uppercase text-[9px] shrink-0">Study:</span>
              <button onClick={() => navigateActiveTab('https://en.m.wikipedia.org/wiki/Pharmacology')} className="px-2 py-0.5 bg-white rounded border border-gray-200 text-gray-700 hover:bg-gray-50 shrink-0 font-medium">📚 Wikipedia</button>
              <button onClick={() => navigateActiveTab('https://pubmed.ncbi.nlm.nih.gov/')} className="px-2 py-0.5 bg-white rounded border border-gray-200 text-gray-700 hover:bg-gray-50 shrink-0 font-medium">🔬 PubMed</button>
              <button onClick={() => navigateActiveTab('https://pubchem.ncbi.nlm.nih.gov/')} className="px-2 py-0.5 bg-white rounded border border-gray-200 text-gray-700 hover:bg-gray-50 shrink-0 font-medium">💊 PubChem</button>
              <button onClick={() => navigateActiveTab('https://dailymed.nlm.nih.gov/')} className="px-2 py-0.5 bg-white rounded border border-gray-200 text-gray-700 hover:bg-gray-50 shrink-0 font-medium">🧪 DailyMed</button>
              <button onClick={() => navigateActiveTab('https://duckduckgo.com')} className="px-2 py-0.5 bg-white rounded border border-gray-200 text-gray-700 hover:bg-gray-50 shrink-0 font-medium">🔍 DuckDuckGo</button>
            </div>

            {/* Native webview mounts here in desktop mode, or iframe in web mode */}
            <div ref={browserContainerRef} className="flex-1 overflow-hidden bg-white relative flex flex-col items-center justify-center">
              {detectRuntimeCapabilities().nativeWebview ? (
                !webviewReady && <Loader2 className="w-8 h-8 text-gray-300 animate-spin mb-4" />
              ) : (
                <div className="w-full h-full relative flex flex-col">
                  {(() => {
                    const currentTab = browserTabs.find(t => t.id === activeTabId) || browserTabs[0];
                    return currentTab && currentTab.url ? (
                      <iframe
                        key={`${currentTab.id}-${currentTab.url}`}
                        src={currentTab.url}
                        title={currentTab.title}
                        className="w-full flex-1 border-0 bg-white"
                        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                        allow="fullscreen"
                        onLoad={() => setWebviewReady(true)}
                      />
                    ) : (
                      <div className="flex-1 flex items-center justify-center text-gray-400 text-xs">
                        No URL loaded
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SlideReader;