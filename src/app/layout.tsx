import type { Metadata, Viewport } from "next";
import "./globals.css";
import AppProviders from "@/components/AppProviders";
import PersistentTopBar from "@/components/PersistentTopBar";
import Script from "next/script";

export const metadata: Metadata = {
  title: "UAI PUNCHLIST APP",
  description: "Construction inspection app for architects",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "UAI PUNCHLIST APP",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  viewportFit: "cover",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#242124" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="punchlist-build" content={process.env.NEXT_PUBLIC_OFFLINE_BUILD_ID} />
        <meta name="format-detection" content="telephone=no, date=no, email=no, address=no" />
        <Script id="theme-init" strategy="beforeInteractive">
          {`
            (function () {
              try {
                var root = document.documentElement;
                var useDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                root.dataset.themeMode = 'system';
                if (useDark) {
                  root.classList.add('dark');
                } else {
                  root.classList.remove('dark');
                }
                try { localStorage.removeItem('punchlist:theme-mode'); } catch (e) {}
              } catch (e) {}
            })();
          `}
        </Script>
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      </head>
      <body className="font-sans antialiased">
        <div className="app-shell">
          <AppProviders>
            <PersistentTopBar />
            {children}
          </AppProviders>
        </div>
      </body>
    </html>
  );
}
