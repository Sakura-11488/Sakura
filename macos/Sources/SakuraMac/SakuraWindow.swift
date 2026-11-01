import AppKit
import SwiftUI
import SakuraCore

@MainActor
final class SakuraWindow: NSWindowController, NSToolbarDelegate, NSWindowDelegate {
    let browser: BrowserController
    private let progress = NSProgressIndicator()
    private let status = NSTextField(labelWithString: "")
    private var failureView: NSView?
    private var palette: NSPanel?
    private var toolbarButtons: [String: NSButton] = [:]

    init(configuration: AppConfiguration) {
        browser = BrowserController(configuration: configuration)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 900),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        super.init(window: window)
        window.title = "Sakura"
        window.subtitle = "For the love of stories."
        window.minSize = NSSize(width: 860, height: 600)
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unifiedCompact
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(red: 0.09, green: 0.075, blue: 0.10, alpha: 1)
        // Restore before enabling autosave; centering every launch discards the
        // user's saved position and can move the app off their chosen display.
        let restoredFrame = window.setFrameUsingName("SakuraMainWindow")
        window.setFrameAutosaveName("SakuraMainWindow")
        window.delegate = self
        if !restoredFrame {
            if let visibleFrame = NSScreen.main?.visibleFrame {
                var frame = window.frame
                frame.size.width = min(frame.width, visibleFrame.width)
                frame.size.height = min(frame.height, visibleFrame.height)
                window.setFrame(frame, display: false)
            }
            window.center()
        }

        let toolbar = NSToolbar(identifier: "SakuraToolbar")
        toolbar.delegate = self; toolbar.allowsUserCustomization = true
        toolbar.autosavesConfiguration = true; toolbar.displayMode = .iconOnly
        window.toolbar = toolbar

        let root = NSView()
        window.contentView = root
        let webView = browser.webView
        webView.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(webView)
        progress.style = .bar; progress.isIndeterminate = false
        progress.minValue = 0; progress.maxValue = 1; progress.isHidden = true
        progress.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(progress)
        status.font = .systemFont(ofSize: 11)
        status.textColor = .secondaryLabelColor
        status.translatesAutoresizingMaskIntoConstraints = false
        status.isHidden = true
        root.addSubview(status)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            webView.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            progress.topAnchor.constraint(equalTo: webView.topAnchor),
            progress.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            progress.heightAnchor.constraint(equalToConstant: 2),
            status.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            status.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
        ])
        browser.stateChanged = { [weak self] in self?.refreshChrome() }
        webView.showQuickNavigation = { [weak self] in self?.showPalette() }
        browser.load()
    }
    required init?(coder: NSCoder) { fatalError("Use init(configuration:)") }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        let custom = ["back", "forward", "home", "search", "ai", "downloads", "share", "reload"].map { NSToolbarItem.Identifier($0) }
        return custom + [NSToolbarItem.Identifier.flexibleSpace, NSToolbarItem.Identifier.space]
    }
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [NSToolbarItem.Identifier("back"), NSToolbarItem.Identifier("forward"), .flexibleSpace,
         NSToolbarItem.Identifier("search"), NSToolbarItem.Identifier("ai"), NSToolbarItem.Identifier("downloads"),
         NSToolbarItem.Identifier("share"), NSToolbarItem.Identifier("reload")]
    }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let items: [String: (String, String, Selector)] = [
            "back": ("Back", "chevron.left", #selector(goBack)),
            "forward": ("Forward", "chevron.right", #selector(goForward)),
            "home": ("Home", "house", #selector(goHome)),
            "search": ("Quick navigation (⌘K)", "magnifyingglass", #selector(showPalette)),
            "ai": ("Sakura AI", "sparkles", #selector(openAI)),
            "downloads": ("Downloads", "arrow.down.circle", #selector(openDownloads)),
            "share": ("Share this page", "square.and.arrow.up", #selector(sharePage)),
            "reload": ("Refresh Sakura", "arrow.clockwise", #selector(reloadPage)),
        ]
        guard let (title, symbol, action) = items[id.rawValue] else { return nil }
        let item = NSToolbarItem(itemIdentifier: id)
        item.label = title; item.paletteLabel = title
        let button = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: title)!, target: self, action: action)
        button.bezelStyle = .texturedRounded; button.toolTip = title
        if id.rawValue == "ai" { button.contentTintColor = NSColor(red: 0.94, green: 0.62, blue: 0.74, alpha: 1) }
        item.view = button; toolbarButtons[id.rawValue] = button
        return item
    }

    private func refreshChrome() {
        toolbarButtons["back"]?.isEnabled = browser.webView.canGoBack
        toolbarButtons["forward"]?.isEnabled = browser.webView.canGoForward
        toolbarButtons["reload"]?.isEnabled = !browser.refreshing
        progress.isHidden = !browser.webView.isLoading
        progress.doubleValue = browser.webView.estimatedProgress
        let path = browser.webView.url?.path ?? ""
        let area = SakuraDestination.all.first { path == $0.path || path.hasPrefix($0.path + "/") }
        window?.subtitle = area?.title ?? "For the love of stories."
        status.stringValue = browser.activeDownloads > 0 ? "Saving \(browser.activeDownloads) file\(browser.activeDownloads == 1 ? "" : "s")…" : ""
        status.isHidden = browser.activeDownloads == 0
        if let failure = browser.failure, failureView == nil, let content = window?.contentView {
            let view = NSHostingView(rootView: LoadFailure(message: failure, retry: { [weak self] in self?.browser.reloadLatest() }))
            view.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(view)
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: browser.webView.leadingAnchor),
                view.trailingAnchor.constraint(equalTo: browser.webView.trailingAnchor),
                view.topAnchor.constraint(equalTo: browser.webView.topAnchor),
                view.bottomAnchor.constraint(equalTo: browser.webView.bottomAnchor),
            ])
            failureView = view
        } else if browser.failure == nil { failureView?.removeFromSuperview(); failureView = nil }
    }

    @objc func goBack() { browser.webView.goBack() }
    @objc func goForward() { browser.webView.goForward() }
    @objc func goHome() { browser.navigate("/app/home") }
    @objc func openAI() { browser.navigate("/app/ai") }
    @objc func openDownloads() { browser.navigate("/app/downloads") }
    @objc func reloadPage() { browser.reloadLatest() }
    @objc func zoomIn() { browser.webView.pageZoom = min(2, browser.webView.pageZoom + 0.1) }
    @objc func zoomOut() { browser.webView.pageZoom = max(0.7, browser.webView.pageZoom - 0.1) }
    @objc func resetZoom() { browser.webView.pageZoom = 1 }
    @objc func navigateFromMenu(_ sender: NSMenuItem) { if let route = sender.representedObject as? String { browser.navigate(route) } }
    @objc func openInBrowser() { if let url = browser.webView.url, browser.configuration.policy.isInternal(url) { NSWorkspace.shared.open(url) } }
    @objc func copyLink() {
        guard let url = browser.webView.url, browser.configuration.policy.isInternal(url) else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }
    @objc func sharePage(_ sender: Any?) {
        guard let url = browser.webView.url, browser.configuration.policy.isInternal(url) else { return }
        let anchor = (sender as? NSView) ?? browser.webView
        NSSharingServicePicker(items: [url]).show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY)
    }
    @objc func showPalette() {
        guard palette == nil, let window else { return }
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 530), styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        panel.titleVisibility = .hidden; panel.titlebarAppearsTransparent = true
        panel.contentView = NSHostingView(rootView: NavigationPalette(select: { [weak self] path in
            self?.closePalette(); self?.browser.navigate(path)
        }, close: { [weak self] in self?.closePalette() }))
        palette = panel
        window.beginSheet(panel)
    }
    private func closePalette() {
        guard let palette else { return }; window?.endSheet(palette); palette.orderOut(nil); self.palette = nil
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if browser.activeDownloads > 0 {
            let alert = NSAlert(); alert.messageText = "Files are still saving"
            alert.informativeText = "Keep Sakura open until downloads finish."
            alert.addButton(withTitle: "Keep Open"); alert.addButton(withTitle: "Close Window")
            return alert.runModal() != .alertFirstButtonReturn
        }
        return true
    }
}

private struct LoadFailure: View {
    let message: String
    let retry: () -> Void
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "wifi.exclamationmark").font(.system(size: 38)).foregroundStyle(.pink)
            Text("Your stories are still here.").font(.system(size: 24, weight: .semibold, design: .rounded))
            Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 420)
            Button("Try Again", action: retry).buttonStyle(.borderedProminent).tint(.pink).controlSize(.large)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(.background)
    }
}

private struct NavigationPalette: View {
    let select: (String) -> Void
    let close: () -> Void
    @State private var query = ""
    @State private var selectedIndex = 0
    @FocusState private var focused: Bool
    private var matches: [SakuraDestination] {
        query.isEmpty ? SakuraDestination.all : SakuraDestination.all.filter { $0.title.localizedCaseInsensitiveContains(query) }
    }
    private var hasSearch: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var rowCount: Int { matches.count + (hasSearch ? 1 : 0) }
    private let searchRowID = "sakura-search-action"
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass").foregroundStyle(.pink)
                TextField("Where would you like to go?", text: $query).textFieldStyle(.plain).font(.title3).focused($focused)
                    .onSubmit { if matches.indices.contains(selectedIndex) { select(matches[selectedIndex].path) } else if hasSearch { search() } }
                Button(action: close) { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }.buttonStyle(.plain).help("Close")
            }.padding(22)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 4) {
                        ForEach(Array(matches.enumerated()), id: \.element.path) { index, destination in
                            Button { select(destination.path) } label: {
                                HStack(spacing: 14) {
                                    Image(systemName: destination.symbol).font(.system(size: 18)).foregroundStyle(.pink).frame(width: 28)
                                    Text(destination.title).foregroundStyle(.primary)
                                    Spacer()
                                    if index == selectedIndex { Image(systemName: "return").font(.caption).foregroundStyle(.tertiary) }
                                }.padding(.horizontal, 14).padding(.vertical, 11)
                                    .background(index == selectedIndex ? Color.pink.opacity(0.09) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                                    .contentShape(Rectangle())
                            }.buttonStyle(.plain).id(destination.path)
                        }
                        if hasSearch {
                            Button(action: search) {
                                HStack {
                                    Label("Search Sakura for “\(query)”", systemImage: "magnifyingglass")
                                    Spacer()
                                    if selectedIndex == matches.count { Image(systemName: "return").font(.caption).foregroundStyle(.tertiary) }
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
                                    .background(selectedIndex == matches.count ? Color.pink.opacity(0.09) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                                    .contentShape(Rectangle())
                            }.buttonStyle(.plain).foregroundStyle(.pink).id(searchRowID)
                        }
                    }.padding(10)
                }
                .onChange(of: selectedIndex) { _, index in
                    let row = matches.indices.contains(index) ? matches[index].path : searchRowID
                    proxy.scrollTo(row)
                }
                .onChange(of: query) { _, _ in
                    proxy.scrollTo(matches.first?.path ?? searchRowID, anchor: .top)
                }
            }
            Divider()
            HStack { Text("SAKURA FOR MAC").tracking(1.4); Spacer(); Text("esc to close") }
                .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary).padding(16)
        }.frame(width: 520, height: 530).background(.regularMaterial)
            .onAppear { focused = true }.onExitCommand(perform: close)
            .onChange(of: query) { _, _ in selectedIndex = 0 }
            .onKeyPress(.downArrow) { selectedIndex = min(max(0, rowCount - 1), selectedIndex + 1); return .handled }
            .onKeyPress(.upArrow) { selectedIndex = max(0, selectedIndex - 1); return .handled }
    }
    private func search() {
        var components = URLComponents(); components.path = "/app/search"
        components.queryItems = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "focus", value: "mac")]
        select(components.string ?? "/app/search")
    }
}
