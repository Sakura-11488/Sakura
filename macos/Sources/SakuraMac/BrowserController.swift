import AppKit
import WebKit
import SakuraCore

/// A single persistent WebKit view keeps playback, navigation and the site's
/// existing storage alive. Remote content gets no privileged native bridge.
@MainActor
final class BrowserController: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let configuration: AppConfiguration
    let webView: SakuraWebView
    var stateChanged: (() -> Void)?
    var failure: String?
    var activeDownloads = 0
    private(set) var refreshing = false
    private var observations: [NSKeyValueObservation] = []
    private var downloadLocations: [ObjectIdentifier: DownloadDestination] = [:]
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var webProcessRecoveries = 0

    init(configuration: AppConfiguration, websiteDataStore: WKWebsiteDataStore? = nil) {
        self.configuration = configuration
        let settings = WKWebViewConfiguration()
        settings.websiteDataStore = websiteDataStore ?? .default()
        settings.preferences.isElementFullscreenEnabled = true
        settings.preferences.javaScriptCanOpenWindowsAutomatically = false
        settings.mediaTypesRequiringUserActionForPlayback = [.audio]
        settings.applicationNameForUserAgent = "SakuraMac/0.1"
        // Required for app-bound WebKit capabilities, including service workers.
        settings.limitsNavigationsToAppBoundDomains = !configuration.development
        webView = SakuraWebView(frame: .zero, configuration: settings)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.underPageBackgroundColor = NSColor(red: 0.078, green: 0.071, blue: 0.086, alpha: 1)
        #if DEBUG
        webView.isInspectable = true
        #endif
        observations = [
            webView.observe(\.isLoading, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.stateChanged?() } },
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.stateChanged?() } },
            webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.stateChanged?() } },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.stateChanged?() } },
            webView.observe(\.url, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.stateChanged?() } },
        ]
    }

    func load(_ url: URL? = nil) {
        let target = url ?? configuration.policy.baseURL
        guard configuration.policy.isInternal(target) else { return }
        failure = nil
        webView.load(URLRequest(url: target))
        stateChanged?()
    }

    func navigate(_ path: String) {
        guard let target = configuration.policy.route(path) else { return }
        navigate(target)
    }

    func navigate(_ target: URL) {
        guard configuration.policy.isInternal(target) else { return }
        // Ask Expo to navigate without replacing the document and its stores.
        // Older web releases can still use an anchor or a full navigation.
        guard let current = webView.url, configuration.policy.isInternal(current), !webView.isLoading else { load(target); return }
        let encoded = String(data: try! JSONEncoder().encode(target.absoluteString), encoding: .utf8)!
        webView.evaluateJavaScript("""
        (() => {
          const href = \(encoded);
          const request = new CustomEvent('sakura:mac:navigate', { cancelable: true, detail: { href } });
          document.dispatchEvent(request);
          if (request.defaultPrevented) return true;
          const link = [...document.querySelectorAll('a[href]')].find(a => a.href === href);
          if (!link) return false;
          link.click(); return true;
        })()
        """) { [weak self] result, _ in
            if (result as? Bool) != true { self?.load(target) }
        }
    }

    func reloadLatest() {
        guard !refreshing else { return }
        failure = nil
        guard let url = webView.url, configuration.policy.isInternal(url) else { load(); return }
        // Do not clear website data: it includes wallets and offline downloads.
        refreshing = true
        stateChanged?()
        webView.callAsyncJavaScript("""
        await Promise.race([
          new Promise(resolve => setTimeout(resolve, 20000)),
          (async () => {
            const registration = await navigator.serviceWorker?.getRegistration('/app/');
            if (!registration) return;
            await registration.update();
            const worker = registration.installing || registration.waiting;
            if (!worker || ['activated', 'redundant'].includes(worker.state)) return;
            await new Promise(resolve => worker.addEventListener('statechange', () => {
              if (['activated', 'redundant'].includes(worker.state)) resolve();
            }));
          })().catch(() => {})
        ]);
        return true;
        """, arguments: [:], in: nil, in: .page) { [weak self] _ in
            guard let self else { return }
            self.refreshing = false
            self.webView.reloadFromOrigin()
            self.stateChanged?()
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        // Third-party iframes never get a native bridge; keep web media/payment
        // frames working. Top-level navigation stays at the trusted origin.
        if let frame = action.targetFrame, !frame.isMainFrame {
            decisionHandler(["https", "http", "about", "blob"].contains(url.scheme ?? "") ? .allow : .cancel)
            return
        }
        if action.shouldPerformDownload && (configuration.policy.isInternal(webView.url ?? configuration.policy.baseURL)) &&
            (configuration.policy.isInternal(url) || ["https", "blob", "data"].contains(url.scheme ?? "")) {
            decisionHandler(.download); return
        }
        if configuration.policy.isInternal(url) { decisionHandler(.allow); return }
        // Never dispatch arbitrary custom schemes from a page. Only a direct
        // link gesture opens an external website or mail composer.
        if action.navigationType == .linkActivated && configuration.policy.permitsExternal(url) {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let attachment = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
        decisionHandler(!response.canShowMIMEType || attachment ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        failure = nil; webProcessRecoveries = 0
        stateChanged?()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showFailure(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showFailure(error) }
    private func showFailure(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        failure = "Sakura could not load. Check your connection and try again. Your saved app data has not been cleared."
        stateChanged?()
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webProcessRecoveries < 1 { webProcessRecoveries += 1; webView.reload() }
        else { failure = "The page stopped responding. Reload to continue."; stateChanged?() }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if self.configuration.policy.isInternal(url) { load(url) }
        else if self.configuration.policy.permitsExternal(url) {
            // WKUIDelegate has no reliable user-gesture flag for window.open.
            // Native confirmation keeps scripted ad popups from opening apps.
            let alert = NSAlert()
            alert.messageText = "Open \(url.host ?? "link") in your browser?"
            alert.informativeText = "This link leaves Sakura."
            alert.addButton(withTitle: "Open in Browser"); alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    private func dialog(_ frame: WKFrameInfo, message: String) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = frame.request.url?.host ?? "Website"
        alert.informativeText = String(message.prefix(8_000))
        return alert
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = dialog(frame, message: message); alert.addButton(withTitle: "OK")
        alert.runModal(); completionHandler()
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = dialog(frame, message: message)
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = dialog(frame, message: prompt)
        let input = NSTextField(string: defaultText ?? ""); input.frame.size = NSSize(width: 320, height: 26)
        alert.accessoryView = input; alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = input
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? input.stringValue : nil)
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.begin { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard let topURL = webView.url, configuration.policy.isInternal(topURL), let url = frame.request.url else { decisionHandler(.deny); return }
        let trustedMainFrame = frame.isMainFrame && configuration.policy.isInternal(url)
        let transakFrame = origin.protocol == "https" && ["global.transak.com", "global-stg.transak.com"].contains(origin.host) && [0, 443].contains(origin.port)
        guard trustedMainFrame || transakFrame else { decisionHandler(.deny); return }
        decisionHandler(.prompt)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { track(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { track(download) }
    private func track(_ download: WKDownload) {
        downloads[ObjectIdentifier(download)] = download; download.delegate = self
        activeDownloads = downloads.count; stateChanged?()
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.title = "Save from Sakura"
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.canCreateDirectories = true
        panel.begin { [weak self] result in
            guard result == .OK, let url = panel.url else {
                completionHandler(nil); self?.finish(download); return
            }
            do {
                let destination = try DownloadDestination(destination: url)
                self?.downloadLocations[ObjectIdentifier(download)] = destination
                completionHandler(destination.stagingURL)
            } catch { completionHandler(nil); self?.finish(download) }
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        do { try downloadLocations[ObjectIdentifier(download)]?.finish() }
        catch {
            let alert = NSAlert(); alert.messageText = "The file could not be saved at that location"
            alert.informativeText = "Your existing file was kept. Choose another location and try again."
            alert.runModal()
        }
        finish(download)
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        finish(download)
        if (error as NSError).code == NSURLErrorCancelled { return }
        let alert = NSAlert(); alert.messageText = "Download did not finish"
        alert.informativeText = "Try saving this file again from Sakura."
        alert.runModal()
    }
    private func finish(_ download: WKDownload) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        downloadLocations.removeValue(forKey: ObjectIdentifier(download))?.cancel()
        activeDownloads = downloads.count; stateChanged?()
    }
}
