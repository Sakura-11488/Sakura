import React from 'react';
import type WalletModalComponent from './WalletModal';

/**
 * WalletModal, loaded when a screen first renders it rather than with the
 * screen's own code.
 *
 * The sheet brings its bottom sheet, QR renderer and wallet helpers. Several
 * screens render it closed (profile, pass, ai, become-creator), and a static
 * import from any one of them made Expo's web build hoist all of that into
 * the shared chunk every lazily loaded screen waits for. Going through one
 * import() keeps it in a chunk of its own. WalletButton does the same.
 */
const WalletModal = React.lazy(() => import('./WalletModal'));

export default function LazyWalletModal(props: React.ComponentProps<typeof WalletModalComponent>) {
  return (
    <React.Suspense fallback={null}>
      <WalletModal {...props} />
    </React.Suspense>
  );
}
