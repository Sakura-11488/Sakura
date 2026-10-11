import React from 'react';
import { Link, usePathname, type Href } from 'expo-router';
import { useTheme } from '@/lib/theme';
import { useUnreadMessages } from '@/lib/unread-messages-context';
import WalletButton from '@/components/wallet/WalletButton';
import { SIDEBAR_WIDTH } from '@/constants/layout';

export function ShellIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    manga: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M10 3v18M10 10h10M4 15h6" /></>,
    anime: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3Z" /></>,
    novel: <><path d="M12 6c-3-3-7-3-10-2v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 2Z" /><path d="M12 6v15" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    library: <><path d="M4 4v16M8 4v16M12 4v16m4-15 4 14" /></>,
    profile: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    chat: <><path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a9 9 0 0 1 19 0Z" /><path d="M7 10h9M7 14h5" /></>,
    schedule: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 11h18M7 15h3M14 15h3" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="var(--shell-bg,#14151a)" /><circle cx="15" cy="17" r="3" fill="var(--shell-bg,#14151a)" /></>,
    creator: <><path d="m14 4 6 6M4 20l5-1L21 7l-4-4L5 15Z" /></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.manga}</svg>;
}
const groups = [
  { title: 'DISCOVER', links: [{ route: '/home', label: 'Manga', icon: 'manga' }, { route: '/anime', label: 'Anime', icon: 'anime' }, { route: '/novel', label: 'Novels', icon: 'novel' }, { route: '/search', label: 'Browse & search', icon: 'search' }] },
  { title: 'YOUR SPACE', links: [{ route: '/library', label: 'My library', icon: 'library' }, { route: '/anime/schedule', label: 'Release calendar', icon: 'schedule' }, { route: '/messages', label: 'Messages', icon: 'chat' }, { route: '/profile', label: 'My profile', icon: 'profile' }] },
];
export default function WebSidebar() {
  const { isDark } = useTheme();
  const { unreadCount } = useUnreadMessages();
  const pathname = usePathname();
  const scrollCurrentPage = (event: React.MouseEvent<HTMLAnchorElement>, route: string) => {
    if (pathname !== route || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const main = [...document.querySelectorAll<HTMLElement>('.ss-screen main')].find(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    main?.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  const area = pathname.startsWith('/anime') ? 'anime' : pathname.startsWith('/novel') ? 'novel' : 'manga';
  return <aside className={`sakura-web-sidebar ${isDark ? '' : 'sw-light'}`} data-area={area} style={{ width: SIDEBAR_WIDTH }}><style>{sidebarStyles}</style>
    <Link href="/home" asChild><a className="sw-brand" aria-label="Sakura home"><span>桜</span><b>sakura<i>.</i></b></a></Link>
    <p className="sw-tagline">A home for every story.</p>
    <nav className="sw-nav" aria-label="Main navigation">{groups.map(group => <div className="sw-group" key={group.title}><span className="sw-group-label">{group.title}</span>{group.links.map(link => <Link key={link.route} href={link.route as Href} asChild><a onClick={event => scrollCurrentPage(event, link.route)} className={`sw-link ${pathname === link.route ? 'active' : ''}`} aria-current={pathname === link.route ? 'page' : undefined}><ShellIcon name={link.icon} /><span>{link.label}</span>{link.route === '/messages' && unreadCount > 0 && <span className="sw-unread">{unreadCount > 99 ? '99+' : unreadCount}</span>}</a></Link>)}</div>)}</nav>
    <div className="sw-bottom"><Link href={'/creator-upload' as Href} asChild><a className="sw-create"><ShellIcon name="creator" /><span>Have a story to tell?<b>Create on Sakura ↗</b></span></a></Link><Link href="/settings" asChild><a className="sw-link"><ShellIcon name="settings" /><span>Settings</span></a></Link><div className="sw-wallet"><WalletButton /></div></div>
  </aside>;
}
export const sidebarStyles = `
.sakura-web-sidebar{--shell-bg:#14151a;--shell-text:#f4f0f3;--shell-muted:#9e9aa7;--shell-border:#ffffff0c;--shell-accent:#f49aa5;box-sizing:border-box;flex-shrink:0;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--shell-bg);border-right:1px solid var(--shell-border);color:var(--shell-text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:32px 20px 20px;overflow-y:auto;scrollbar-width:thin}
.sakura-web-sidebar[data-area=anime]{--shell-accent:#ffa879}.sakura-web-sidebar[data-area=novel]{--shell-accent:#d6bd85}.sakura-web-sidebar.sw-light{--shell-bg:#fff;--shell-text:#29232b;--shell-muted:#80757d;--shell-border:#29232b12;--shell-accent:#ad3856}.sw-brand{display:flex;align-items:center;gap:9px;text-decoration:none;color:var(--shell-text);padding:0 12px}.sw-brand>span{font-family:Georgia,serif;font-size:29px;color:#f49aa5}.sw-brand b{font-size:27px;letter-spacing:-1px;font-weight:700}.sw-brand i{font-style:normal;color:#f49aa5}.sw-tagline{color:var(--shell-muted);font-size:10px;margin:10px 12px 34px}.sw-nav{flex:1}.sw-group{margin-bottom:28px}.sw-group-label{display:block;font-size:8px;font-weight:600;letter-spacing:2px;color:var(--shell-muted);padding:0 13px 12px}.sw-link{display:flex;align-items:center;gap:12px;color:var(--shell-muted);text-decoration:none;min-height:44px;border-radius:7px;padding:0 13px;font-size:12px;margin:3px 0;transition:color .16s,background .16s}.sw-link>svg{flex-shrink:0;width:18px;height:18px}.sw-link:hover{color:var(--shell-text);background:color-mix(in srgb,var(--shell-text) 4%,transparent)}.sw-link.active{background:color-mix(in srgb,var(--shell-accent) 11%,transparent);color:var(--shell-accent);font-weight:650}.sw-unread{margin-left:auto;background:#ec7688;color:#24141c;font-size:9px;min-width:17px;border-radius:5px;text-align:center;padding:2px 4px}.sw-bottom{display:grid;gap:12px}.sw-create{padding:16px 12px;border:1px solid var(--shell-border);border-radius:8px;display:flex;gap:11px;align-items:center;text-decoration:none;color:var(--shell-muted);font-size:9px;line-height:1.8}.sw-create>svg{color:var(--shell-accent);width:18px}.sw-create b{font-size:11px;color:var(--shell-text);font-weight:500;display:block}.sw-wallet{border-top:1px solid var(--shell-border);padding:20px 8px 0}.sakura-web-sidebar a:focus-visible{outline:2px solid var(--shell-accent);outline-offset:3px}@media(prefers-reduced-motion:reduce){.sakura-web-sidebar *{transition:none!important}}
`;
