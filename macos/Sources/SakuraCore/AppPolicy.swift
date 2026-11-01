import Foundation

/// The native host owns only the configured Sakura /app/ origin. No remote page
/// receives filesystem, shell, wallet, or arbitrary JavaScript execution APIs.
public struct AppPolicy {
    public enum ConfigurationError: Error { case invalidBaseURL }
    public let baseURL: URL

    public init(baseURL: URL) throws {
        let local = ["localhost", "127.0.0.1", "[::1]"].contains(baseURL.host?.lowercased() ?? "")
        guard (baseURL.scheme == "https" || (local && baseURL.scheme == "http")),
              baseURL.host != nil, baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil,
              ["/app", "/app/"].contains(baseURL.path), Self.safePath(baseURL)
        else { throw ConfigurationError.invalidBaseURL }
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/app/"
        self.baseURL = components.url!
    }

    public func isInternal(_ url: URL) -> Bool {
        url.scheme?.lowercased() == baseURL.scheme?.lowercased() &&
        url.host?.lowercased() == baseURL.host?.lowercased() &&
        Self.port(url) == Self.port(baseURL) && url.user == nil && url.password == nil &&
        (url.path == "/app" || url.path.hasPrefix("/app/")) && Self.safePath(url)
    }

    public func route(_ path: String) -> URL? {
        guard path.hasPrefix("/app/" ) || path == "/app" || path.hasPrefix("/app?") || path.hasPrefix("/app#"),
              !path.contains("\\"), let relative = URL(string: path), Self.safePath(relative),
              let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              isInternal(url) else { return nil }
        return url
    }

    public func deepLink(_ url: URL) -> URL? {
        guard url.scheme?.lowercased() == "sakura-mac", url.user == nil, url.password == nil,
              url.port == nil, Self.safePath(url), let host = url.host, !host.isEmpty else { return nil }
        if host == "open" {
            guard url.path.isEmpty || url.path == "/",
                  let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  components.queryItems?.count == 1, components.queryItems?.first?.name == "url",
                  let raw = components.queryItems?.first?.value, let target = URL(string: raw),
                  isInternal(target) else { return nil }
            return target
        }
        // The custom scheme cannot select another host. The host is a route segment.
        guard host.range(of: "^[a-zA-Z0-9_-]+$", options: .regularExpression) != nil,
              let source = URLComponents(url: url, resolvingAgainstBaseURL: false),
              var target = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        target.percentEncodedPath = "/app/" + host + source.percentEncodedPath
        target.percentEncodedQuery = source.percentEncodedQuery
        target.percentEncodedFragment = source.percentEncodedFragment
        guard let result = target.url, isInternal(result) else { return nil }
        return result
    }

    public func permitsExternal(_ url: URL) -> Bool {
        guard url.user == nil, url.password == nil, !isInternal(url),
              let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "mailto" { return !url.path.isEmpty && !url.absoluteString.contains("\n") }
        return ["https", "http"].contains(scheme) && url.host != nil
    }

    private static func port(_ url: URL) -> Int { url.port ?? (url.scheme == "https" ? 443 : 80) }

    private static func safePath(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        var path = components.percentEncodedPath
        // Reject nested encodings too; proxies and routers must agree on boundaries.
        for _ in 0..<5 {
            if path.contains("\\") || path.contains("//") || path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) { return false }
            if path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) { return false }
            let lower = path.lowercased()
            if lower.contains("%2f") || lower.contains("%5c") { return false }
            guard let decoded = path.removingPercentEncoding else { return false }
            if decoded == path { return true }
            path = decoded
        }
        return false
    }
}

public struct SakuraDestination {
    public let title: String
    public let path: String
    public let symbol: String
    public init(_ title: String, _ path: String, _ symbol: String) {
        self.title = title; self.path = path; self.symbol = symbol
    }
    public static let all: [SakuraDestination] = [
        .init("Manga", "/app/home", "books.vertical"),
        .init("Anime", "/app/anime", "play.rectangle"),
        .init("Novels", "/app/novel", "book"),
        .init("Library", "/app/library", "square.stack"),
        .init("Sakura AI", "/app/ai", "sparkles"),
        .init("Shikigami", "/app/agent", "sparkle"),
        .init("Reading life", "/app/reading-life", "chart.bar"),
        .init("Sakura Studio", "/app/studio", "paintbrush.pointed"),
        .init("Downloads", "/app/downloads", "arrow.down.circle"),
        .init("Messages", "/app/messages", "bubble.left.and.bubble.right"),
        .init("Your space", "/app/profile", "person.crop.circle"),
        .init("Reader tools", "/app/reader-tools", "slider.horizontal.3"),
        .init("Settings", "/app/settings", "gearshape"),
    ]
}
