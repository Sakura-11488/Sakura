import AppKit
import SakuraCore

@main
struct SakuraApplication {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--check-bundle") {
            do {
                _ = try AppConfiguration()
                guard Bundle.main.bundleIdentifier == "com.sakura.mac",
                      Bundle.main.object(forInfoDictionaryKey: "WKAppBoundDomains") is [String] else {
                    throw AppPolicy.ConfigurationError.invalidBaseURL
                }
                print("Sakura bundle OK")
                return
            } catch { fputs("Sakura bundle configuration failed\n", stderr); exit(1) }
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = SakuraApplicationDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class SakuraApplicationDelegate: NSObject, NSApplicationDelegate {
    private var mainWindow: SakuraWindow?
    private var updater: ShellUpdater?
    private var pendingURLs: [URL] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let window = SakuraWindow(configuration: try AppConfiguration())
            mainWindow = window
            updater = ShellUpdater()
            installMenus(window)
            window.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
            for url in pendingURLs { open(url) }; pendingURLs = []
        } catch {
            let alert = NSAlert(); alert.messageText = "Sakura’s address is not configured correctly"
            alert.informativeText = "This build must point to the secure Sakura /app/ website."
            alert.runModal(); NSApp.terminate(nil)
        }
    }
    func application(_ application: NSApplication, open urls: [URL]) {
        if mainWindow == nil { pendingURLs = Array(urls.prefix(5)); return }
        for url in urls.prefix(5) { open(url) }
    }
    private func open(_ url: URL) {
        guard let window = mainWindow, let target = window.browser.configuration.policy.deepLink(url) else { return }
        window.showWindow(nil); window.browser.navigate(target)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mainWindow?.showWindow(nil); return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let window = mainWindow, window.browser.activeDownloads > 0 else { return .terminateNow }
        let alert = NSAlert(); alert.messageText = "Files are still saving"
        alert.informativeText = "Quitting now will interrupt your downloads."
        alert.addButton(withTitle: "Keep Open"); alert.addButton(withTitle: "Quit Sakura")
        return alert.runModal() == .alertFirstButtonReturn ? .terminateCancel : .terminateNow
    }

    private func installMenus(_ window: SakuraWindow) {
        let bar = NSMenu(); NSApp.mainMenu = bar
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(); item.title = title
            let menu = NSMenu(title: title); item.submenu = menu; bar.addItem(item); return menu
        }
        @discardableResult
        func item(_ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String = "", _ target: AnyObject? = nil, _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.target = target; item.keyEquivalentModifierMask = modifiers; menu.addItem(item); return item
        }
        let app = submenu("Sakura")
        item(app, "About Sakura", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
        item(app, "Check for Mac App Updates…", #selector(ShellUpdater.checkForUpdates(_:)), "", updater)
        app.addItem(.separator())
        item(app, "Settings…", #selector(SakuraWindow.navigateFromMenu(_:)), ",", window).representedObject = "/app/settings"
        app.addItem(.separator())
        let services = NSMenu(title: "Services"); let servicesItem = NSMenuItem(); servicesItem.title = "Services"; servicesItem.submenu = services
        app.addItem(servicesItem); NSApp.servicesMenu = services
        app.addItem(.separator())
        item(app, "Hide Sakura", #selector(NSApplication.hide(_:)), "h")
        item(app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", nil, [.command, .option])
        item(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
        app.addItem(.separator()); item(app, "Quit Sakura", #selector(NSApplication.terminate(_:)), "q")

        let file = submenu("File")
        item(file, "Open in Browser", #selector(SakuraWindow.openInBrowser), "b", window, [.command, .shift])
        item(file, "Copy Page Link", #selector(SakuraWindow.copyLink), "l", window, [.command, .shift])
        item(file, "Share…", #selector(SakuraWindow.sharePage(_:)), "", window)
        file.addItem(.separator()); item(file, "Close Window", #selector(NSWindow.performClose(_:)), "w")

        let edit = submenu("Edit")
        item(edit, "Undo", Selector(("undo:")), "z")
        item(edit, "Redo", Selector(("redo:")), "z", nil, [.command, .shift])
        edit.addItem(.separator())
        item(edit, "Cut", #selector(NSText.cut(_:)), "x")
        item(edit, "Copy", #selector(NSText.copy(_:)), "c")
        item(edit, "Paste", #selector(NSText.paste(_:)), "v")
        item(edit, "Select All", #selector(NSText.selectAll(_:)), "a")

        let view = submenu("View")
        item(view, "Quick Navigation…", #selector(SakuraWindow.showPalette), "k", window)
        item(view, "Refresh Sakura", #selector(SakuraWindow.reloadPage), "r", window)
        view.addItem(.separator())
        item(view, "Zoom In", #selector(SakuraWindow.zoomIn), "+", window)
        item(view, "Zoom Out", #selector(SakuraWindow.zoomOut), "-", window)
        item(view, "Actual Size", #selector(SakuraWindow.resetZoom), "0", window)
        view.addItem(.separator())
        item(view, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", nil, [.command, .control])

        let go = submenu("Go")
        item(go, "Back", #selector(SakuraWindow.goBack), "[", window)
        item(go, "Forward", #selector(SakuraWindow.goForward), "]", window)
        go.addItem(.separator())
        for (index, destination) in SakuraDestination.all.enumerated() {
            let entry = item(go, destination.title, #selector(SakuraWindow.navigateFromMenu(_:)), index < 9 ? String(index + 1) : "", window)
            entry.representedObject = destination.path
            entry.image = NSImage(systemSymbolName: destination.symbol, accessibilityDescription: nil)
        }
        let windows = submenu("Window"); NSApp.windowsMenu = windows
        item(windows, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        item(windows, "Zoom", #selector(NSWindow.performZoom(_:)))
        item(windows, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)))
        let help = submenu("Help"); NSApp.helpMenu = help
        item(help, "Sakura Website", #selector(SakuraWindow.openInBrowser), "", window)
        item(help, "Reader Tools", #selector(SakuraWindow.navigateFromMenu(_:)), "", window).representedObject = "/app/reader-tools"
    }
}
