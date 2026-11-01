import AppKit
import Sparkle

@MainActor
final class ShellUpdater: NSObject, NSMenuItemValidation {
    private var controller: SPUStandardUpdaterController?
    var configured: Bool { controller != nil }

    override init() {
        super.init()
        let bundle = Bundle.main
        guard let raw = bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String,
              let url = URL(string: raw), url.scheme == "https", url.host != nil,
              let key = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
              Data(base64Encoded: key)?.count == 32 else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    }

    @objc func checkForUpdates(_ sender: Any?) {
        guard let controller else {
            let alert = NSAlert()
            alert.messageText = "This is a local preview build"
            alert.informativeText = "Sakura’s web features update through the live website. Updates to the Mac app itself will be available after its signed release feed is configured."
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return
        }
        guard controller.updater.canCheckForUpdates else { return }
        controller.checkForUpdates(sender)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard menuItem.action == #selector(checkForUpdates(_:)) else { return true }
        // Keep the local-preview explanation accessible when no feed exists.
        return controller?.updater.canCheckForUpdates ?? true
    }
}
