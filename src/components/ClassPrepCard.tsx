import { Link } from 'react-router-dom';
import type { ClassSession, PrepLink } from '../utils/studyDashboard';

function Chain({ title, items }: { title: string; items: PrepLink[] }) {
  if (items.length === 0) return null;
  return (
    <div className="relative pl-4">
      <span className="absolute left-0 top-2 bottom-2 w-px bg-[#2D6A4F]/30" aria-hidden />
      <p className="text-[10px] font-black uppercase tracking-widest text-[#2D6A4F] mb-1">{title}</p>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id}>
            <Link to={item.href} className="block rounded-lg px-2 py-1.5 hover:bg-white">
              <span className={`text-sm font-semibold ${item.done ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{item.label}</span>
              {item.detail && <span className="block text-xs text-gray-500">{item.detail}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ClassPrepCard: React.FC<{ session: ClassSession; open?: boolean }> = ({ session, open = false }) => {
  const name = session.courseName || session.subject;
  return (
    <details open={open} className="bg-white rounded-2xl border border-gray-100 shadow-sm" data-testid="class-prep">
      <summary className="cursor-pointer list-none p-4 sm:p-5 [&::-webkit-details-marker]:hidden">
        <p className="text-xs font-black uppercase tracking-widest text-[#2D6A4F]">{session.whenLabel || 'Unscheduled'}</p>
        <h3 className="text-lg font-black text-gray-900 mt-1">{name}</h3>
        <p className="text-sm text-gray-500 mt-1">
          {session.location ? `${session.location} · ` : ''}
          {session.match === 'none' ? 'Not linked to a course' : session.match === 'linked' ? 'Linked course' : `Matched ${session.courseCode || ''}`.trim()}
        </p>
      </summary>
      <div className="px-4 sm:px-5 pb-5 space-y-3 border-t border-gray-50">
        <p className="sr-only">Relevant topics, materials, and preparation tasks</p>
        <Chain title="Relevant topics" items={session.topics} />
        <Chain title="Relevant materials" items={session.materials} />
        <Chain title="Study plans" items={session.plans} />
        <Chain title="Exams" items={session.exams} />
        <Chain title="Preparation tasks" items={session.tasks} />
      </div>
    </details>
  );
};

export default ClassPrepCard;
