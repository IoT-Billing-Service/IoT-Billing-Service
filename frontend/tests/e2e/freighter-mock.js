/**
 * Freighter Wallet E2E Mock
 *
 * Injected via Playwright's `page.addInitScript()` before the application
 * JavaScript runs.
 *
 * The real Freighter extension communicates via `window.postMessage` with
 * messages carrying `source: "FREIGHTER_EXTERNAL_MSG_REQUEST"`. The content
 * script responds with `source: "FREIGHTER_EXTERNAL_MSG_RESPONSE"` and the
 * same `messageId`.
 *
 * This mock intercepts those messages and returns deterministic responses.
 *
 * Activation:
 *   page.evaluate(() => { window.__ENABLE_FREIGHTER_MOCK__ = true; })
 *
 * Configuration (set before enabling):
 *   window.__MOCK_PUBLIC_KEY__     — public key  (default: GA7...H7)
 *   window.__MOCK_NETWORK__        — 'testnet' | 'mainnet' | 'futurenet'
 *   window.__MOCK_FREIGHTER_ERROR__ — getAddress rejects
 *   window.__MOCK_SIGN_ERROR__     — signMessage rejects
 *   window.__MOCK_TX_ERROR__       — signTransaction rejects
 *   window.__MOCK_FREIGHTER_DISCONNECTED__ — WatchWalletChanges reports null
 */

(function () {
  if (window.__FREIGHTER_MOCK_INSTALLED__) return;

  var DEFAULT_PK = 'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7';
  var mockEnabled = false;

  Object.defineProperty(window, '__ENABLE_FREIGHTER_MOCK__', {
    set: function (val) {
      mockEnabled = Boolean(val);
      if (mockEnabled) installMock();
    },
    get: function () { return mockEnabled; },
    configurable: true,
  });

  function getPublicKey() {
    return window.__MOCK_PUBLIC_KEY__ || DEFAULT_PK;
  }

  function getNetwork() {
    return window.__MOCK_NETWORK__ || 'testnet';
  }

  function getNetworkDetails() {
    var net = getNetwork();
    var passphrases = {
      testnet: 'Test SDF Network ; September 2015',
      mainnet: 'Public Global Stellar Network ; September 2015',
      futurenet: 'Test SDF Future Network ; October 2022',
    };
    return {
      network: net,
      networkName: net.charAt(0).toUpperCase() + net.slice(1),
      networkUrl: net === 'mainnet'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org',
      networkPassphrase: passphrases[net] || passphrases.testnet,
      sorobanRpcUrl: net === 'mainnet'
        ? 'https://soroban-rpc.stellar.org'
        : 'https://soroban-testnet.stellar.org',
    };
  }

  function installMock() {
    if (window.__FREIGHTER_MOCK_INSTALLED__) return;
    window.__FREIGHTER_MOCK_INSTALLED__ = true;

    // ── Intercept postMessage requests from freighter-api ────────────
    window.addEventListener('message', function (event) {
      if (!mockEnabled) return;
      // Only handle messages sent by the freighter-api SDK
      if (!event.data || event.data.source !== 'FREIGHTER_EXTERNAL_MSG_REQUEST') return;

      var msg = event.data;
      var messageId = msg.messageId;
      var type = msg.type;
      var responsePayload;

      switch (type) {
        // getAddress() uses this
        case 'REQUEST_PUBLIC_KEY': {
          if (window.__MOCK_FREIGHTER_ERROR__) {
            responsePayload = { publicKey: '', apiError: { message: 'Freighter connection rejected' } };
          } else {
            responsePayload = { publicKey: getPublicKey() };
          }
          break;
        }

        // getNetwork() / getNetworkDetails() use this
        case 'REQUEST_NETWORK_DETAILS': {
          responsePayload = { networkDetails: getNetworkDetails() };
          break;
        }

        // isConnected() uses this
        case 'REQUEST_CONNECTION_STATUS': {
          responsePayload = { isConnected: true, publicKey: getPublicKey() };
          break;
        }

        // isAllowed() uses this
        case 'REQUEST_ALLOWED_STATUS': {
          responsePayload = { isAllowed: true };
          break;
        }

        // setAllowed() uses this
        case 'SET_ALLOWED_STATUS': {
          responsePayload = { isAllowed: true };
          break;
        }

        // requestAccess() uses this
        case 'REQUEST_ACCESS': {
          responsePayload = { publicKey: getPublicKey() };
          break;
        }

        // signMessage() uses this (type = SUBMIT_BLOB)
        case 'SUBMIT_BLOB': {
          if (window.__MOCK_SIGN_ERROR__) {
            responsePayload = { signedBlob: null, signerAddress: '', apiError: { message: 'Signing rejected by user' } };
          } else {
            responsePayload = { signedBlob: '0x' + 'ab'.repeat(32), signerAddress: getPublicKey() };
          }
          break;
        }

        // signTransaction() uses this
        case 'SUBMIT_TRANSACTION': {
          if (window.__MOCK_TX_ERROR__) {
            responsePayload = { signedTransaction: '', signerAddress: '', apiError: { message: 'Transaction signing rejected' } };
          } else {
            responsePayload = { signedTransaction: msg.transactionXdr || 'AAAA...', signerAddress: getPublicKey() };
          }
          break;
        }

        // signAuthEntry() uses this
        case 'SUBMIT_AUTH_ENTRY': {
          responsePayload = { signedAuthEntry: 'AAAA...', signerAddress: getPublicKey() };
          break;
        }

        // addToken() uses this
        case 'SUBMIT_TOKEN': {
          responsePayload = { contractId: msg.contractId || '' };
          break;
        }

        default: {
          // Unknown request — return a generic success
          responsePayload = {};
        }
      }

      // Respond with the same protocol the extension uses
      window.postMessage(
        {
          source: 'FREIGHTER_EXTERNAL_MSG_RESPONSE',
          messagedId: messageId,
          ...responsePayload,
        },
        window.location.origin,
      );
    }, false);

    // ── WatchWalletChanges mock ─────────────────────────────────────
    // The real class polls getAddress + getNetworkDetails periodically.
    window.WatchWalletChanges = (function () {
      function WatchWalletChanges(intervalMs) {
        this.intervalMs = intervalMs || 1000;
        this._timer = null;
        this._callback = null;
        this._currentAddress = '';
        this._currentNetwork = '';
        this._isRunning = false;
      }

      WatchWalletChanges.prototype.watch = function (callback) {
        this._callback = callback;
        this._isRunning = true;

        // Store on window for test triggers
        window.__FREIGHTER_WATCH_CALLBACK__ = (event) => {
          if (this._callback) this._callback(event);
        };

        const poll = () => {
          if (!this._isRunning) return;
          var addr = getPublicKey();
          var net = getNetwork();

          if (window.__MOCK_FREIGHTER_DISCONNECTED__) {
            addr = '';
          }

          if (addr !== this._currentAddress || net !== this._currentNetwork) {
            this._currentAddress = addr;
            this._currentNetwork = net;
            var details = getNetworkDetails();
            if (this._callback) {
              this._callback({
                address: addr || null,
                network: net,
                networkPassphrase: details.networkPassphrase,
              });
            }
          }

          this._timer = setTimeout(poll, this.intervalMs);
        };

        poll();
      };

      WatchWalletChanges.prototype.stop = function () {
        this._isRunning = false;
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        window.__FREIGHTER_WATCH_CALLBACK__ = null;
      };

      return WatchWalletChanges;
    })();

    // ── Also provide the old-style window.freighter global ─────────
    window.freighter = {
      getAddress: function () {
        if (window.__MOCK_FREIGHTER_ERROR__) throw new Error('Freighter connection rejected');
        return getPublicKey();
      },
      getNetwork: function () { return getNetwork(); },
      signMessage: function () {
        if (window.__MOCK_SIGN_ERROR__) throw new Error('Signing rejected');
        return '0x' + 'ab'.repeat(32);
      },
    };
  }
})();
