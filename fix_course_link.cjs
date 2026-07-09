const fs = require('fs');
let code = fs.readFileSync('src/pages/Courses.tsx', 'utf8');

// 1. Wrap the entire card in a <Link>
const oldCardOuter = `<div
                key={course.id}
                className="bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
              >`;
const newCardOuter = `<Link
                to={\`/course/\${course.id}\`}
                key={course.id}
                className="bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md hover:border-blue-300 transition-all overflow-hidden block cursor-pointer"
              >`;
code = code.replace(oldCardOuter, newCardOuter);

// 2. Prevent the Edit/Delete buttons from triggering the card click
const oldEditBtn = `<button
                        onClick={() => openEditModal(course)}
                        className="p-1.5 text-gray-400 hover:text-[#2D6A4F] hover:bg-gray-100 rounded transition-colors"
                      >`;
const newEditBtn = `<button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); openEditModal(course); }}
                        className="p-1.5 text-gray-400 hover:text-[#2D6A4F] hover:bg-gray-100 rounded transition-colors"
                      >`;
code = code.replace(oldEditBtn, newEditBtn);

const oldDeleteBtn = `<button
                        onClick={() => handleDelete(course.id)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                      >`;
const newDeleteBtn = `<button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDelete(course.id); }}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                      >`;
code = code.replace(oldDeleteBtn, newDeleteBtn);

// 3. Update the inner "View Details" to a span (since it's now wrapped in a Link)
const oldBottomLink = `<Link
                      to={\`/courses/\${course.id}\`}
                      className="flex items-center gap-1 text-sm font-medium text-[#2D6A4F] hover:underline"
                    >
                      View Details
                      <ArrowRight className="w-4 h-4" />
                    </Link>`;
const newBottomLink = `<span
                      className="flex items-center gap-1 text-sm font-medium text-[#2D6A4F] group-hover:underline"
                    >
                      View Details
                      <ArrowRight className="w-4 h-4" />
                    </span>`;
code = code.replace(oldBottomLink, newBottomLink);

// 4. Close the Link tag instead of the div tag
const oldCardClose = `</div>
              </div>
            );`;
const newCardClose = `</div>
              </Link>
            );`;
code = code.replace(oldCardClose, newCardClose);

fs.writeFileSync('src/pages/Courses.tsx', code);
console.log('Courses link fixed!');

// Bump Version
let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.69';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.69';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(/v1\.1\.\d+/g, 'v1.1.69');
fs.writeFileSync('src/components/Layout.tsx', layout);
