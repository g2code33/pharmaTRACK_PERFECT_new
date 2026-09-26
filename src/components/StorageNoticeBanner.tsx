import React, { useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { getStorageNotice, subscribeStorageNotice } from '../utils/storageManager';

/** Shown when a storage check had to stop and explain, instead of guessing. */
const StorageNoticeBanner: React.FC = () => {
  const notice = useSyncExternalStore(subscribeStorageNotice, getStorageNotice, getStorageNotice);
  if (!notice) return null;
  const error = notice.severity === 'error';
  return (
    <div
      role="alert"
      data-testid="storage-notice"
      className={`w-full px-4 py-2.5 text-sm flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center ${error ? 'bg-red-700 text-white' : 'bg-[#FFB703] text-slate-900'}`}
    >
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
      <span className="font-bold">{notice.title}.</span>
      <span className="font-medium opacity-90">{notice.explanation}</span>
      <Link to="/storage" className="underline font-bold">Open Storage</Link>
    </div>
  );
};

export default StorageNoticeBanner;
