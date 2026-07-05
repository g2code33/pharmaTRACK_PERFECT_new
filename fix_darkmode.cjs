const fs = require('fs');

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
const injection = `const Layout: React.FC = () => {
  const { state, dispatch } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'done'>('idle');
  const [appVersion, setAppVersion] = useState('1.1.11');
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => { document.documentElement.classList.toggle('dark', darkMode); }, [darkMode]);`;

layout = layout.replace(/const Layout: React\.FC = \(\) => \{[\s\S]*?useEffect\(\(\) => \{ getVersion\(\)/, injection + '\n  useEffect(() => { getVersion()');
fs.writeFileSync('src/components/Layout.tsx', layout);

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.12';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.12';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));
