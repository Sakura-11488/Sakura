import React from 'react';
import { useWindowDimensions } from 'react-native';
import { useTheme } from '@/lib/theme';
import { useUnreadMessages } from '@/lib/unread-messages-context';
import { isWideWeb } from '@/constants/layout';
import { ShellIcon } from './WebSidebar.web';

type Props = { state: { index: number; routes: { name: string; key: string }[] }; navigation: { navigate: (name: never) => void; emit: (event: { type: 'tabPress' | 'tabLongPress'; target: string; canPreventDefault?: boolean }) => { defaultPrevented?: boolean } } };
const tabs = [
  { name: 'home', label: 'Manga', icon: 'manga' },
  { name: 'anime', label: 'Anime', icon: 'anime' },
  { name: 'search', label: 'Browse', icon: 'search' },
  { name: 'novel', label: 'Novels', icon: 'novel' },
  { name: 'library', label: 'Library', icon: 'library' },
  { name: 'profile', label: 'Profile', icon: 'profile' },
];
export default function CustomTabBar({ state, navigation }: Props) {
  const { width } = useWindowDimensions();
  const { isDark } = useTheme();
  const { unreadCount } = useUnreadMessages();
  if (isWideWeb(width)) return null;
  const current = state.routes[state.index]?.name;
  const openTab = (name: string) => {
    const route = state.routes.find(item => item.name === name);
    if (!route) return;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (name !== current && !event.defaultPrevented) navigation.navigate(name as never);
  };
  return <nav className={`sakura-web-tabs ${isDark ? '' : 'swt-light'}`} data-area={current} aria-label="Mobile navigation"><style>{styles}</style>{tabs.map(tab => <button key={tab.name} className={tab.name === current ? 'active' : ''} aria-current={tab.name === current ? 'page' : undefined} onClick={() => openTab(tab.name)} aria-label={tab.name === 'profile' && unreadCount > 0 ? `Profile, ${unreadCount} unread messages` : tab.label}><span className="swt-icon"><ShellIcon name={tab.icon} />{tab.name === 'profile' && unreadCount > 0 && <i aria-hidden="true" />}</span><span>{tab.label}</span></button>)}</nav>;
}
const styles = `.sakura-web-tabs{--shell-bg:#14151a;--tab-accent:#f49aa5;position:absolute;z-index:40;bottom:0;left:0;right:0;box-sizing:border-box;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));height:calc(68px + env(safe-area-inset-bottom,0px));padding:5px 8px calc(5px + env(safe-area-inset-bottom,0px));background:var(--shell-bg);border-top:1px solid #ffffff10}.sakura-web-tabs[data-area=anime]{--tab-accent:#ffa879}.sakura-web-tabs[data-area=novel]{--tab-accent:#d6bd85}.sakura-web-tabs.swt-light{--shell-bg:#fff;--tab-accent:#ad3856;border-color:#00000012}.sakura-web-tabs button{position:relative;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:9px;font-weight:550;color:#95919e;background:none;border:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;cursor:pointer;padding:5px 0;min-width:0;min-height:52px;touch-action:manipulation;transition:color .16s}.sakura-web-tabs button.active{color:var(--tab-accent)}.sakura-web-tabs button.active:before{content:'';position:absolute;top:3px;left:calc(50% - 22px);width:44px;height:30px;border-radius:8px;background:color-mix(in srgb,var(--tab-accent) 10%,transparent)}.swt-icon{position:relative;height:22px;display:flex;align-items:center}.swt-icon svg{width:21px;height:21px}.swt-icon i{position:absolute;right:-6px;top:0;width:5px;height:5px;border-radius:50%;background:#f49aa5}.sakura-web-tabs button:focus-visible{outline:2px solid var(--tab-accent);outline-offset:-3px;border-radius:6px}@media(prefers-reduced-motion:reduce){.sakura-web-tabs *{transition:none!important}}`;
