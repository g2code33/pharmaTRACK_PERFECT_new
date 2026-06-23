sed -i 's/n.title.toLowerCase()/n.noteText.toLowerCase()/g' src/components/Layout.tsx
sed -i 's/n.content.toLowerCase()/n.noteText.toLowerCase()/g' src/components/Layout.tsx
sed -i 's/title: n.title/title: n.noteText.substring(0, 30) + "..."/g' src/components/Layout.tsx
sed -i 's/<FileText/<File/g' src/pages/SlideReader.tsx
