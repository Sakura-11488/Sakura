import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

/**
 * NOTE: the web build uses `output: 'single'` (SPA), and Expo generates
 * dist/index.html from its own built-in template — this file is NOT used there.
 * PWA/iOS head tags therefore live in `web/scripts/inject-pwa-tags.mjs`, which
 * runs after `expo export`. Keep this in sync only if web output ever moves to
 * static rendering.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <title>Sakura</title>
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: 'input,textarea,select{font-size:16px}' }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
