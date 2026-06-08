/**
 * Preload for the Phoenix Trade in-app browser window.
 * Exposes a narrow IPC bridge and injects a Sakura Wallet provider into the
 * page context so Phoenix can connect via Wallet Standard / legacy Solana API
 * instead of Phantom or Solflare.
 */
const { contextBridge, ipcRenderer } = require('electron');

const bridge = {
  invoke(method, params) {
    return ipcRenderer.invoke('phoenix:wallet', { method, params: params || {} });
  },
  getConfig() {
    return ipcRenderer.invoke('phoenix:get-config');
  },
};

contextBridge.exposeInMainWorld('__SAKURA_PHOENIX__', bridge);

const INJECT = `
(function () {
  if (window.__SAKURA_WALLET_INJECTED__) return;
  window.__SAKURA_WALLET_INJECTED__ = true;

  const BRIDGE = window.__SAKURA_PHOENIX__;
  if (!BRIDGE) return;

  function bytesToBase64(bytes) {
    let binary = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function makePublicKey(base58) {
    if (!base58) return null;
    return {
      toBase58: () => base58,
      toString: () => base58,
      equals: (other) => other && String(other) === base58,
    };
  }

  let _publicKey = null;
  let _publicKeyBytes = null;
  let _connected = false;
  const listeners = { connect: [], disconnect: [], accountChanged: [] };

  function emit(event, payload) {
    (listeners[event] || []).forEach((fn) => {
      try { fn(payload); } catch (_) {}
    });
  }

  async function connectInternal() {
    const result = await BRIDGE.invoke('connect', {});
    if (!result || !result.publicKey) throw new Error('Sakura wallet is not connected');
    _publicKey = makePublicKey(result.publicKey);
    _publicKeyBytes = result.publicKeyBytes ? base64ToBytes(result.publicKeyBytes) : null;
    _connected = true;
    provider.publicKey = _publicKey;
    emit('connect', _publicKey);
    emit('accountChanged', _publicKey);
    return { publicKey: _publicKey };
  }

  async function signSerializedTransaction(transaction, version) {
    const payload = {
      transaction: bytesToBase64(transaction),
      version: version || 'legacy',
    };
    const result = await BRIDGE.invoke('signTransaction', payload);
    if (!result || !result.transaction) throw new Error('Signing failed');
    return base64ToBytes(result.transaction);
  }

  const provider = {
    isSakura: true,
    isPhantom: false,
    isSolflare: false,
    name: 'Sakura Wallet',
    publicKey: null,
    get isConnected() { return _connected; },

    connect: connectInternal,

    disconnect: async () => {
      await BRIDGE.invoke('disconnect', {});
      _publicKey = null;
      _publicKeyBytes = null;
      _connected = false;
      provider.publicKey = null;
      emit('disconnect');
      emit('accountChanged', null);
    },

    signTransaction: async (transaction) => {
      if (!transaction || typeof transaction.serialize !== 'function') {
        throw new Error('Invalid transaction');
      }
      const versioned = 'version' in transaction;
      const serialized = versioned
        ? transaction.serialize()
        : transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
      const signedBytes = await signSerializedTransaction(serialized, versioned ? 'v0' : 'legacy');

      if (versioned && window.VersionedTransaction) {
        return window.VersionedTransaction.deserialize(signedBytes);
      }
      if (window.Transaction) {
        return window.Transaction.from(signedBytes);
      }
      return transaction;
    },

    signAllTransactions: async (transactions) => {
      const out = [];
      for (const tx of transactions) {
        out.push(await provider.signTransaction(tx));
      }
      return out;
    },

    signMessage: async (message, _display) => {
      const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
      const result = await BRIDGE.invoke('signMessage', {
        message: bytesToBase64(bytes),
      });
      if (!result || !result.signature) throw new Error('Message signing failed');
      return base64ToBytes(result.signature);
    },

    on: (event, handler) => {
      if (listeners[event]) listeners[event].push(handler);
    },
    off: (event, handler) => {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter((fn) => fn !== handler);
    },
  };

  window.sakura = provider;

  // Wallet Standard registration (Privy / modern Solana dApps).
  const registerWalletApi = window.navigator && window.navigator.wallets && window.navigator.wallets.register;
  if (typeof registerWalletApi === 'function') {
    registerWalletApi((api) => {
      api.register({
        version: '1.0.0',
        name: 'Sakura Wallet',
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHRleHQgeT0iMjQiIGZvbnQtc2l6ZT0iMjQiPvCfjYg8L3RleHQ+PC9zdmc+',
        chains: ['solana:mainnet', 'solana:devnet'],
        accounts: _publicKey
          ? [{
              address: _publicKey.toBase58(),
              publicKey: _publicKeyBytes || base64ToBytes(_publicKey.toBase58()),
              chains: ['solana:mainnet'],
              features: ['solana:signTransaction', 'solana:signMessage'],
            }]
          : [],
        features: {
          'standard:connect': {
            version: '1.0.0',
            connect: async () => {
              const { publicKey } = await connectInternal();
              const address = publicKey.toBase58();
              return {
                accounts: [{
                  address,
                  publicKey: _publicKeyBytes || base64ToBytes(address),
                  chains: ['solana:mainnet'],
                  features: ['solana:signTransaction', 'solana:signMessage'],
                }],
              };
            },
          },
          'standard:disconnect': {
            version: '1.0.0',
            disconnect: async () => {
              await provider.disconnect();
            },
          },
          'standard:events': {
            version: '1.0.0',
            on: (event, listener) => {
              if (event === 'change') {
                listeners.accountChanged.push((pk) => {
                  listener({ accounts: pk ? [{ address: pk.toBase58() }] : [] });
                });
              }
            },
          },
          'solana:signTransaction': {
            version: '1.0.0',
            signTransaction: async (input) => {
              const txBytes = input.transaction instanceof Uint8Array
                ? input.transaction
                : new Uint8Array(input.transaction);
              const signed = await signSerializedTransaction(txBytes, input.version === 'v0' ? 'v0' : 'legacy');
              return { signedTransaction: signed };
            },
          },
          'solana:signMessage': {
            version: '1.0.0',
            signMessage: async (input) => {
              const sig = await provider.signMessage(input.message);
              return { signedMessage: input.message, signature: sig };
            },
          },
        },
      });
    });
  }

  // If Sakura was already connected in the host app, pre-connect in Phoenix.
  BRIDGE.getConfig().then((cfg) => {
    if (cfg && cfg.publicKey && cfg.autoConnect) {
      connectInternal().catch(() => {});
    }
  }).catch(() => {});
})();
`;

function injectProvider() {
  try {
    const script = document.createElement('script');
    script.textContent = INJECT;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
  } catch (err) {
    console.error('[phoenix-preload] inject failed', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectProvider, { once: true });
} else {
  injectProvider();
}
