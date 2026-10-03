import { Component, useLayoutEffect, useRef } from 'react';
import Sidebar from './components/Sidebar.jsx';
import { useRoute } from './lib/router';
import Library from './screens/Library/Library.jsx';
import Updates from './screens/Updates/Updates.jsx';
import History from './screens/History/History.jsx';
import { Catalogs, Browse } from './screens/Catalogs/Catalogs.jsx';
import Downloads from './screens/Downloads/Downloads.jsx';
import Novel from './screens/Library/Novel.jsx';
import Reader from './screens/Reader/Reader.jsx';
import Settings from './screens/Settings/Settings.jsx';
import { ErrorBox } from './components/ui.jsx';
import { useSettings } from './lib/settings.jsx';

class Boundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidUpdate(prev) { if (prev.routeKey !== this.props.routeKey && this.state.error) this.setState({ error: null }); }
  render() { return this.state.error ? <ErrorBox error={this.state.error} /> : this.props.children; }
}

const SCREENS = {
  library: Library, updates: Updates, history: History, catalogs: Catalogs, browse: Browse,
  downloads: Downloads, settings: Settings, novel: Novel, reader: Reader,
};

const libraryScroll = { top: 0 };

export default function App() {
  const route = useRoute();
  const mainRef = useRef(null);
  // <main> is one element shared by every screen, so its scroll offset used to leak between them (a novel page
  // opened half-way down). Library keeps its position; every other screen starts at the top.
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    el.scrollTop = route.name === 'library' ? libraryScroll.top : 0;
  }, [route.name, route.param]);
  const { settings } = useSettings();
  const Screen = SCREENS[route.name] ?? Library;
  const tab = { novel: 'library', browse: 'catalogs', reader: 'library' }[route.name] ?? route.name;
  const full = route.name === 'reader';
  // `dir` also flips on the shell so the sidebar and every pane lay out right-to-left together.
  return (
    <div dir={settings.language === 'ar' ? 'rtl' : 'ltr'} className={`shell ${full ? 'shell-full' : ''}`}>
      {!full && <Sidebar active={tab} />}
      <main
        ref={mainRef}
        className={full ? 'main-full' : 'main'}
        onScroll={(e) => {
          if (route.name === 'library') libraryScroll.top = e.currentTarget.scrollTop;
        }}
      >
        <Boundary routeKey={`${route.name}/${route.param}`}>
          <Screen key={`${route.name}/${route.param}`} param={route.param} />
        </Boundary>
      </main>
    </div>
  );
}
