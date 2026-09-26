/**
 * Material Library catalogue.
 *
 * Built from the slides already in app state. It does not load file bytes.
 */
import type { AppState, Slide } from '../types';
import {
  inferMaterialKind,
  isPresentationKind,
  typeLabel,
  type MaterialKind,
  type OcrStatus,
  type VisualStatus,
} from './materialKind';

export interface LibraryItem {
  id: string;
  title: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  topicId: string;
  topicName: string;
  semester: string;
  kind: MaterialKind;
  typeLabel: string;
  uploadDate: string;
  fileSize?: number;
  pageCount?: number;
  ocrStatus: OcrStatus;
  lastOpenedAt?: string;
  lastPosition?: number;
  favorite: boolean;
  tags: string[];
  visualStatus: VisualStatus;
  /** Opens the reader on the last page/slide when we know it. */
  openLink: string;
  positionUnit: 'Slide' | 'Page';
}

/** saveState keeps only this much of contentText in localStorage. */
const PREVIEW_CAP = 2000;

function inferPageCount(slide: Slide, kind: MaterialKind): number | undefined {
  if (slide.pageCount && slide.pageCount > 0) return slide.pageCount;
  const text = slide.contentText ?? '';
  // A truncated preview only proves a lower bound. Don't present that as the count.
  if (text.length >= PREVIEW_CAP) return undefined;
  const marks = [...text.matchAll(/--- (?:Slide|Page) (\d+) ---/g)]
    .map((m) => parseInt(m[1], 10))
    .filter((n) => n > 0);
  if (marks.length) return Math.max(...marks);
  if (text.trim() && !isPresentationKind(kind)) return 1;
  return undefined;
}

export function buildLibrary(state: AppState): LibraryItem[] {
  const topicById = new Map(state.topics.map((t) => [t.id, t]));
  const courseById = new Map(state.courses.map((c) => [c.id, c]));
  const fallbackSemester = state.student?.semester || '';

  return state.slides.map((slide) => {
    const topic = topicById.get(slide.topicId);
    const course = topic ? courseById.get(topic.courseId) : undefined;
    const kind = inferMaterialKind(slide);
    const presentation = isPresentationKind(kind);
    const last = slide.lastPosition && slide.lastPosition > 0 ? slide.lastPosition : undefined;
    const pageQuery = last ? `&page=${last}` : '';
    return {
      id: slide.id,
      title: slide.title || 'Untitled',
      courseId: course?.id ?? '',
      courseCode: course?.courseCode ?? '',
      courseName: course?.courseName ?? '',
      topicId: slide.topicId,
      topicName: topic?.topicName ?? 'Unknown topic',
      semester: course?.semester || fallbackSemester || '—',
      kind,
      typeLabel: typeLabel(kind),
      uploadDate: slide.createdAt || '',
      fileSize: slide.fileSize,
      pageCount: inferPageCount(slide, kind),
      ocrStatus: slide.ocrStatus ?? 'unknown',
      lastOpenedAt: slide.lastOpenedAt,
      lastPosition: last,
      favorite: Boolean(slide.favorite),
      tags: slide.tags ?? [],
      visualStatus: slide.visualStatus ?? 'unknown',
      openLink: `/read/${slide.topicId}?material=${encodeURIComponent(slide.id)}${pageQuery}`,
      positionUnit: presentation ? 'Slide' : 'Page',
    };
  });
}

export type LibrarySort = 'recent' | 'uploaded' | 'title' | 'size' | 'course';

export interface LibraryQuery {
  query: string;
  kind: 'all' | 'presentation' | MaterialKind;
  courseId: string;
  semester: string;
  favoritesOnly: boolean;
  recentOnly: boolean;
  sort: LibrarySort;
}

export const EMPTY_LIBRARY_QUERY: LibraryQuery = {
  query: '',
  kind: 'all',
  courseId: '',
  semester: '',
  favoritesOnly: false,
  recentOnly: false,
  sort: 'uploaded',
};

function matchesKind(item: LibraryItem, kind: LibraryQuery['kind']): boolean {
  if (kind === 'all') return true;
  if (kind === 'presentation') return item.kind === 'pptx' || item.kind === 'ppt';
  return item.kind === kind;
}

export function filterLibrary(items: LibraryItem[], q: LibraryQuery): LibraryItem[] {
  const terms = q.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = items.filter((item) => {
    if (!matchesKind(item, q.kind)) return false;
    if (q.courseId && item.courseId !== q.courseId) return false;
    if (q.semester && item.semester !== q.semester) return false;
    if (q.favoritesOnly && !item.favorite) return false;
    if (q.recentOnly && !item.lastOpenedAt) return false;
    if (!terms.length) return true;
    const hay = [
      item.title,
      item.courseCode,
      item.courseName,
      item.topicName,
      item.semester,
      item.typeLabel,
      item.tags.join(' '),
    ].join('\n').toLowerCase();
    return terms.every((term) => hay.includes(term));
  });

  const byTime = (iso?: string) => {
    const n = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  const sorted = [...filtered];
  sorted.sort((a, b) => {
    if (q.sort === 'title') return a.title.localeCompare(b.title) || a.courseCode.localeCompare(b.courseCode);
    if (q.sort === 'course') return a.courseCode.localeCompare(b.courseCode) || a.title.localeCompare(b.title);
    if (q.sort === 'size') return (b.fileSize ?? -1) - (a.fileSize ?? -1) || a.title.localeCompare(b.title);
    if (q.sort === 'recent') {
      return byTime(b.lastOpenedAt) - byTime(a.lastOpenedAt) || byTime(b.uploadDate) - byTime(a.uploadDate);
    }
    return byTime(b.uploadDate) - byTime(a.uploadDate) || a.title.localeCompare(b.title);
  });
  return sorted;
}

export function recentLibrary(items: LibraryItem[], limit = 8): LibraryItem[] {
  return [...items]
    .filter((item) => item.lastOpenedAt)
    .sort((a, b) => Date.parse(b.lastOpenedAt!) - Date.parse(a.lastOpenedAt!))
    .slice(0, limit);
}

/**
 * Window of rows to paint. Callers with a short list should render everything
 * and skip this. `viewport` 0 still returns a first window so a list is never
 * blank before layout.
 */
export function visibleRange(
  count: number,
  scrollTop: number,
  viewport: number,
  row: number,
  overscan = 4,
): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 };
  const height = Math.max(row, viewport || row * 4);
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / row) - overscan);
  const end = Math.min(count, Math.ceil((Math.max(0, scrollTop) + height) / row) + overscan);
  return { start, end: Math.max(start, end) };
}
