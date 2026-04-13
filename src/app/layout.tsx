import type { Metadata, Viewport } from "next";
import dynamic from "next/dynamic";
import "./globals.css";

import SolanaProvider from "@/components/WalletProvider";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "桜 Sakura — Manga on Solana",
  description: "Read manga, collect chapters, own your library. A Solana-powered manga reading platform with beautiful Japanese aesthetics.",
};

import MobileNavHandler from "@/components/MobileNavHandler";
import BottomNav from "@/components/BottomNav";
import FloatingTradeWidget from "@/components/FloatingTradeWidget";
import CloudSyncProvider from "@/components/CloudSyncProvider";
import TermsGate from "@/components/TermsGate";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {/* SVG Glass Distortion Filter */}
        <svg style={{ display: 'none' }} aria-hidden="true">
          <filter id="glass-distortion" x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox">
            <feTurbulence type="fractalNoise" baseFrequency="0.001 0.005" numOctaves="1" seed="17" result="turbulence" />
            <feComponentTransfer in="turbulence" result="mapped">
              <feFuncR type="gamma" amplitude="1" exponent="10" offset="0.5" />
              <feFuncG type="gamma" amplitude="0" exponent="1" offset="0" />
              <feFuncB type="gamma" amplitude="0" exponent="1" offset="0.5" />
            </feComponentTransfer>
            <feGaussianBlur in="turbulence" stdDeviation="3" result="softMap" />
            <feSpecularLighting in="softMap" surfaceScale="5" specularConstant="1" specularExponent="100" lightingColor="white" result="specLight">
              <fePointLight x="-200" y="-200" z="300" />
            </feSpecularLighting>
            <feComposite in="specLight" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="litImage" />
            <feDisplacementMap in="SourceGraphic" in2="softMap" scale="200" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>

        {/* Background */}
        <div className="app-background">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/background.png" alt="" />
        </div>

        {/* Sakura Petals */}
        <div className="sakura-petals">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="petal" />
          ))}
        </div>

        <SolanaProvider>
          <TermsGate>
            <CloudSyncProvider />
            <MobileNavHandler />
            {children}
            <FloatingTradeWidget />
            <BottomNav />
          </TermsGate>
        </SolanaProvider>
      </body>
    </html>
  );
}
