import React from 'react';
import { useWindowDimensions } from 'react-native';
import { Link, usePathname } from 'expo-router';
import { useTheme } from '@/lib/theme';
import { useUnreadMessages } from '@/lib/unread-messages-context';
import { MAX_CONTENT_WIDTH, MAX_CONTENT_WIDTH_DESKTOP, isWideWeb } from '@/constants/layout';
import WebSidebar, { ShellIcon } from './WebSidebar.web';
import WalletButton from '@/components/wallet/WalletButton';

export default function WebAppShell({ children }: { children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const { isDark, colors } = useTheme();
  const { unreadCount } = useUnreadMessages();
  const pathname = usePathname();
  const desktop = isWideWeb(width);
  const discovery = ['/home', '/anime', '/novel', '/search', '/'].includes(pathname);
  return <div className={`sakura-responsive-shell ${desktop ? 'ss-desktop' : 'ss-mobile'} ${isDark ? '' : 'ss-light'}`} style={{ background: isDark ? '#101115' : colors.background }}><style>{styles}</style>
    {desktop && <WebSidebar />}
    <div className="ss-content-outer"><div className="ss-content" style={{ maxWidth: desktop ? MAX_CONTENT_WIDTH_DESKTOP : MAX_CONTENT_WIDTH }}>
      {!desktop && discovery && <header className="ss-mobile-header"><Link href="/home" asChild><a className="ss-brand" aria-label="Sakura home"><span>桜</span><b>sakura.</b></a></Link><div className="ss-header-actions"><Link href="/messages" asChild><a className="ss-message-link" aria-label={unreadCount ? `Messages, ${unreadCount} unread` : 'Messages'}><ShellIcon name="chat" />{unreadCount > 0 && <i />}</a></Link><WalletButton /></div></header>}
      <div className="ss-screen">{children}</div>
    </div></div>
  </div>;
}
const styles = `.sakura-responsive-shell{display:flex;flex:1;min-height:0;min-width:0;height:100%;overflow:hidden}.ss-content-outer{display:flex;flex:1;justify-content:center;min-width:0;min-height:0}.ss-content{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;width:100%;position:relative}.ss-screen{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;position:relative}.ss-mobile-header{--shell-bg:#14151a;min-height:calc(62px + env(safe-area-inset-top,0px));box-sizing:border-box;padding:env(safe-area-inset-top,0px) 20px 0;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;background:var(--shell-bg);border-bottom:1px solid #ffffff0c;gap:14px;z-index:20}.ss-light .ss-mobile-header{--shell-bg:#fff;border-color:#0000000c}.ss-brand{display:flex;align-items:center;gap:8px;text-decoration:none;color:#f4f0f3;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;flex-shrink:0}.ss-brand>span{font-family:Georgia,serif;font-size:26px;color:#f49aa5}.ss-brand b{font-size:23px;letter-spacing:-1px}.ss-light .ss-brand{color:#28222a}.ss-header-actions{display:flex;align-items:center;gap:12px}.ss-message-link{color:#a8a2b1;position:relative;display:grid;place-items:center;width:32px;min-height:44px}.ss-message-link i{position:absolute;top:8px;right:2px;width:5px;height:5px;background:#f49aa5;border-radius:50%}.ss-mobile-header a:focus-visible{outline:2px solid #f49aa5;outline-offset:3px}@media(max-width:360px){.ss-mobile-header{padding-inline:14px;gap:8px}.ss-header-actions{gap:4px}.ss-brand b{font-size:20px}.ss-brand{gap:5px}.ss-message-link{width:26px}}`;
