"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSakuraWalletModal } from "./SakuraWalletModal";
import { useSakuraAI } from "./SakuraAIModal";
import { useWallet } from "@solana/wallet-adapter-react";
import LottieIcon from "./LottieIcon";

interface NavItem {
  href: string;
  label: string;
  lottieFile: string;
  activePrefix?: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", lottieFile: "/icons/wired-outline-1652-mortgage-loan-hover-pinch.json" },
  { href: "/manga", label: "Manga", lottieFile: "/icons/wired-outline-1384-page-view-array-hover-pinch.json" },
  { href: "/comics", label: "Comics", lottieFile: "/icons/wired-outline-779-books-hover-hit.json" },
  { href: "/novel", label: "Novel", lottieFile: "/icons/wired-outline-471-ebook-reader-hover-pinch.json" },
  { href: "/anime", label: "Anime", lottieFile: "/icons/wired-outline-2440-goku-hover-pinch.json" },
  { href: "/library", label: "Library", lottieFile: "/icons/wired-outline-3140-book-open-hover-pinch.json" },
  { href: "/history", label: "History", lottieFile: "/icons/wired-outline-24-approved-checked-hover-loading.json" },
  { href: "/downloads", label: "Downloads", lottieFile: "/icons/wired-outline-199-download-2-hover-pointing.json" },
  { href: "/creator/apply", label: "Creator", lottieFile: "/icons/wired-outline-674-painter-hover-pinch.json", activePrefix: "/creator" },
  { href: "/settings", label: "Settings", lottieFile: "/icons/wired-outline-39-cog-hover-mechanic.json" },
];

const HIDDEN_PATHS = ["/chapter", "/anime/watch", "/novel/read"];

const PINK_FILTER = "invert(52%) sepia(74%) saturate(1057%) hue-rotate(308deg)";
const DIM_FILTER = "invert(1) opacity(0.35)";

export default function Sidebar() {
  const pathname = usePathname();
  const { setVisible } = useSakuraWalletModal();
  const { setVisible: setSakuraAiVisible } = useSakuraAI();
  const { publicKey } = useWallet();

  if (HIDDEN_PATHS.some(p => pathname.startsWith(p))) {
    return null;
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <Link href="/" className="sidebar-logo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/sakura.png" alt="Sakura" width={32} height={32} />
        </Link>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => {
          const matchPrefix = item.activePrefix || item.href;
          const isActive = matchPrefix === "/"
            ? pathname === "/"
            : pathname.startsWith(matchPrefix);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`sidebar-nav-item ${isActive ? "active" : ""}`}
            >
              {isActive && <span className="sidebar-active-bar" />}
              <LottieIcon
                src={item.lottieFile}
                size={22}
                colorFilter={isActive ? PINK_FILTER : DIM_FILTER}
                {...(isActive ? { replayIntervalMs: 3000, autoplay: true } : { playOnMount: true })}
              />
              <span className="sidebar-tooltip">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        <button
          type="button"
          className="sidebar-nav-item"
          onClick={() => setSakuraAiVisible(true)}
          aria-label="Open Sakura AI"
        >
          <LottieIcon
            src="/icons/wired-outline-145-envelope-mail-hover-pinch.json"
            size={22}
            colorFilter={DIM_FILTER}
            playOnMount
          />
          <span className="sidebar-tooltip">Sakura AI</span>
        </button>
        <button
          className={`sidebar-nav-item sidebar-wallet-btn ${publicKey ? "active" : ""}`}
          onClick={() => setVisible(true)}
        >
          <LottieIcon
            src="/icons/wired-outline-421-wallet-purse-hover-pinch.json"
            size={22}
            colorFilter={publicKey ? PINK_FILTER : DIM_FILTER}
            playOnMount
          />
          <span className="sidebar-tooltip">
            {publicKey ? "Wallet" : "Sign Up / Login"}
          </span>
        </button>
      </div>
    </aside>
  );
}
