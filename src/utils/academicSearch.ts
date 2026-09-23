/**
 * One academic search: current semester, archived semesters, and saved AI
 * chats. Ordinary search is offline and does not call an AI provider.
 *
 * The current semester is already in memory. Archives and conversation bodies
 * are read from catalogs built once, not on each keystroke.
 */
import type { AppState } from '../types';
import { searchAll, type SearchResult } from './search';
import { searchArchiveCatalog } from './archiveCatalog';
import { searchConversations } from './conversationSearch';

export type SearchScopeFilter = 'all' | 'current' | 'archive';

export interface AcademicSearchFilters {
  scope?: SearchScopeFilter;
  /** 'current' or an archive id. */
  semesterKey?: string;
  courseId?: string;
  topicId?: string;
  /**
   * pdf | pptx | docx | image | text | ocr | note | question | quiz |
   * insight | chat | objective | highlight | topic | course
   */
  materialType?: string;
  dateFrom?: string;
  dateTo?: string;
}

const day = (value?: string): string => (value ? value.slice(0, 10) : '');

export function matchesAcademicFilters(result: SearchResult, filters?: AcademicSearchFilters): boolean {
  if (!filters) return true;
  if (filters.scope === 'current' && result.scope === 'archive') return false;
  if (filters.scope === 'archive' && result.scope !== 'archive') return false;
  if (filters.semesterKey && result.semesterKey !== filters.semesterKey) return false;
  if (filters.courseId && result.courseId !== filters.courseId) return false;
  if (filters.topicId && result.topicId !== filters.topicId) return false;
  if (filters.materialType && !matchesType(result, filters.materialType)) return false;
  if (filters.dateFrom || filters.dateTo) {
    const when = day(result.date);
    if (!when) return false;
    if (filters.dateFrom && when < filters.dateFrom) return false;
    if (filters.dateTo && when > filters.dateTo) return false;
  }
  return true;
}

function matchesType(result: SearchResult, type: string): boolean {
  if (type === 'ocr') return !!result.ocr;
  if (type === 'pptx') return result.materialType === 'pptx' || result.materialType === 'ppt';
  if (type === 'note') return result.category === 'Note';
  if (type === 'question') return result.category === 'Question';
  if (type === 'quiz') return result.category === 'Quiz';
  if (type === 'insight') return result.category === 'Insight';
  if (type === 'chat') return result.category === 'Chat';
  if (type === 'objective') return result.category === 'Objective';
  if (type === 'highlight') return result.category === 'Highlight';
  if (type === 'topic') return result.category === 'Topic';
  if (type === 'course') return result.category === 'Course';
  return result.materialType === type;
}

export function searchAcademic(
  state: AppState,
  rawQuery: string,
  filters?: AcademicSearchFilters,
  limit = 40,
): SearchResult[] {
  const query = rawQuery.trim();
  if (query.length < 2) return [];

  const current = filters?.scope === 'archive' ? [] : searchAll(state, query, 80);
  const archived = filters?.scope === 'current' ? [] : searchArchiveCatalog(query, 40);
  const chats = filters?.scope === 'archive' ? [] : searchConversations(query, 16);

  return [...current, ...archived, ...chats]
    .filter((result) => matchesAcademicFilters(result, filters))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
