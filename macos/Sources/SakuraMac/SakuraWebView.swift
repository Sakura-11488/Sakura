import AppKit
import WebKit

@MainActor
final class SakuraWebView: WKWebView {
    var showQuickNavigation: (() -> Void)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // The shared website uses Cmd-K for search. The desktop host owns this
        // shortcut so its native palette remains reachable while a page is focused.
        let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
        if modifiers == .command, event.charactersIgnoringModifiers?.lowercased() == "k",
           let showQuickNavigation {
            showQuickNavigation()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}
