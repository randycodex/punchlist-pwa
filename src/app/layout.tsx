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
    statusBarStyle: "black-translucent",
    title: "UAI PUNCHLIST APP",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#191c1f" },
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
        <Script id="pwa-cleanup" strategy="beforeInteractive">
          {`
            (function () {
              if (!('serviceWorker' in navigator) || !('localStorage' in window)) return;
              var cleanupKey = 'punchlist:pwa-cleanup-v2';
              try {
                if (localStorage.getItem(cleanupKey) === 'done') return;
              } catch (e) {}

              window.addEventListener('load', function () {
                var unregisterPromise = navigator.serviceWorker.getRegistrations().then(function (registrations) {
                  return Promise.all(
                    registrations.map(function (registration) {
                      return registration.unregister();
                    })
                  );
                });

                var cacheCleanupPromise = Promise.resolve();
                if ('caches' in window) {
                  cacheCleanupPromise = caches.keys().then(function (keys) {
                    var staleKeys = keys.filter(function (key) {
                      return key.indexOf('workbox') !== -1 || key.indexOf('precache') !== -1 || key.indexOf('runtime') !== -1;
                    });
                    return Promise.all(
                      staleKeys.map(function (key) {
                        return caches.delete(key);
                      })
                    );
                  });
                }

                Promise.all([unregisterPromise, cacheCleanupPromise]).finally(function () {
                  try {
                    localStorage.setItem(cleanupKey, 'done');
                  } catch (e) {}
                });
              });
            })();
          `}
        </Script>
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      </head>
      <body className="font-sans antialiased">
        <div className="safe-top-shim" />
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
