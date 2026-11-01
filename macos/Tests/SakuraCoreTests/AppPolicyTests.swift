import Foundation
import XCTest
@testable import SakuraCore

final class AppPolicyTests: XCTestCase {
    private let production = URL(string: "https://sakuraonseeker.com/app/")!

    private func policy() throws -> AppPolicy {
        try AppPolicy(baseURL: production)
    }

    private func url(_ value: String) -> URL {
        // These fixtures are parseable URLs, including hostile inputs that the
        // policy must reject rather than relying on Foundation to reject them.
        URL(string: value)!
    }

    func testProductionBaseRetainsTrustedAppRoot() throws {
        let subject = try policy()
        XCTAssertEqual(subject.baseURL, production)
        XCTAssertTrue(subject.isInternal(production))
        XCTAssertTrue(subject.isInternal(url("https://sakuraonseeker.com/app")))
        XCTAssertTrue(subject.isInternal(url("https://sakuraonseeker.com/app/anime/watch?id=show&ep=episode")))
    }

    func testBaseRejectsUnsafeSchemesCredentialsAndWrongPaths() {
        let invalid = [
            "http://sakuraonseeker.com/app/",
            "ftp://sakuraonseeker.com/app/",
            "file:///app/",
            "javascript:alert(1)",
            "https://user@sakuraonseeker.com/app/",
            "https://user:password@sakuraonseeker.com/app/",
            "https://sakuraonseeker.com/",
            "https://sakuraonseeker.com/application/",
            "https://sakuraonseeker.com/app/anime",
            "https://sakuraonseeker.com/app/../private",
            "https://sakuraonseeker.com/app/%2e%2e/private",
        ]
        for candidate in invalid {
            XCTAssertThrowsError(try AppPolicy(baseURL: url(candidate)), candidate)
        }
    }

    func testLoopbackDevelopmentBaseAllowsOnlyExplicitLoopbackHTTPHosts() throws {
        for candidate in ["http://localhost:8081/app/", "http://127.0.0.1:8081/app/"] {
            let subject = try AppPolicy(baseURL: url(candidate))
            XCTAssertTrue(subject.isInternal(url(candidate)), candidate)
        }
        for candidate in [
            "http://localhost.evil.example/app/",
            "http://127.0.0.1.evil.example/app/",
            "http://192.168.1.10/app/",
            "http://0.0.0.0/app/",
        ] {
            XCTAssertThrowsError(try AppPolicy(baseURL: url(candidate)), candidate)
        }
    }

    func testInternalRequiresExactOriginAndPathBoundary() throws {
        let subject = try policy()
        let invalid = [
            "http://sakuraonseeker.com/app/",
            "https://sakuraonseeker.com:8443/app/",
            "https://sakuraonseeker.com.evil.example/app/",
            "https://evil-sakuraonseeker.com/app/",
            "https://www.sakuraonseeker.com/app/",
            "https://sakuraonseeker.com@evil.example/app/",
            "https://evil.example@sakuraonseeker.com/app/",
            "https://sakuraonseeker.com/",
            "https://sakuraonseeker.com/api/catalog/",
            "https://sakuraonseeker.com/application/",
            "https://sakuraonseeker.com/app-other/",
            "https://sakuraonseeker.com/APP/",
        ]
        for candidate in invalid {
            XCTAssertFalse(subject.isInternal(url(candidate)), candidate)
        }
    }

    func testDevelopmentOriginDoesNotAcceptOtherPortsOrLoopbackAliases() throws {
        let subject = try AppPolicy(baseURL: url("http://localhost:8081/app/"))
        XCTAssertTrue(subject.isInternal(url("http://localhost:8081/app/novel/read?path=a")))
        XCTAssertFalse(subject.isInternal(url("http://localhost:8082/app/")))
        XCTAssertFalse(subject.isInternal(url("http://localhost/app/")))
        XCTAssertFalse(subject.isInternal(url("http://127.0.0.1:8081/app/")))
        XCTAssertFalse(subject.isInternal(url("https://localhost:8081/app/")))
    }

    func testInternalRejectsLiteralAndEncodedPathTraversal() throws {
        let subject = try policy()
        let invalid = [
            "/app/../private",
            "/app/./anime",
            "/app/anime/../library",
            "/app//anime",
            "/app/%2e%2e/private",
            "/app/%2E%2E/private",
            "/app/.%2e/private",
            "/app/%2e./private",
            "/app/%252e%252e/private",
            "/app/anime%2f..%2fprivate",
            "/app/anime%5c..%5cprivate",
            "/app/%2f%2fevil.example",
            "/app/%255cevil.example",
        ]
        for path in invalid {
            XCTAssertFalse(subject.isInternal(url("https://sakuraonseeker.com" + path)), path)
            XCTAssertNil(subject.route(path), path)
        }
    }

    func testRoutePreservesFunctionalQueryAndFragment() throws {
        let subject = try policy()
        let path = "/app/anime/watch?id=show%2Fspecial&ep=ep%3A12&room=a%2Bb&empty=&tag=one&tag=two#player"
        let result = try XCTUnwrap(subject.route(path))
        XCTAssertEqual(result.absoluteString, "https://sakuraonseeker.com" + path)
        XCTAssertEqual(URLComponents(url: result, resolvingAgainstBaseURL: false)?.queryItems?.filter { $0.name == "tag" }.map(\.value), ["one", "two"])
        XCTAssertEqual(subject.route("/app"), url("https://sakuraonseeker.com/app"))
        XCTAssertEqual(subject.route("/app/"), production)
    }

    func testRouteRejectsAbsoluteSchemeRelativeAndOutsideAppInputs() throws {
        let subject = try policy()
        for path in [
            "", "anime", "/anime", "/application", "/app-other", "//evil.example/app/",
            "https://sakuraonseeker.com/app/anime", "https://evil.example/app/",
            "file:///app/anime", "javascript:alert(1)", "/app\\anime", "/app/\nprivate",
        ] {
            XCTAssertNil(subject.route(path), path)
        }
    }

    func testDirectDeepLinkMapsRouteAndPreservesEpisodeSourceAndRoom() throws {
        let subject = try policy()
        let result = try XCTUnwrap(subject.deepLink(url("sakura-mac://anime/watch?id=show%2Fspecial&ep=ep%3A12&source=hianime&room=a%2Bb#player")))
        XCTAssertEqual(result.absoluteString, "https://sakuraonseeker.com/app/anime/watch?id=show%2Fspecial&ep=ep%3A12&source=hianime&room=a%2Bb#player")
        XCTAssertEqual(subject.deepLink(url("sakura-mac://chapter/chapter-42?p=8&source=comics&offline=1")), url("https://sakuraonseeker.com/app/chapter/chapter-42?p=8&source=comics&offline=1"))
    }

    func testOpenDeepLinkAcceptsOnlyEmbeddedTrustedAppURL() throws {
        let subject = try policy()
        let target = "https://sakuraonseeker.com/app/novel/read?path=series%2Fchapter&offset=120#text"
        var components = URLComponents()
        components.scheme = "sakura-mac"
        components.host = "open"
        components.queryItems = [URLQueryItem(name: "url", value: target)]
        XCTAssertEqual(subject.deepLink(try XCTUnwrap(components.url)), url(target))
    }

    func testOpenDeepLinkRejectsUntrustedTargetsAndAmbiguousURLArguments() throws {
        let subject = try policy()
        for target in [
            "https://evil.example/app/", "https://sakuraonseeker.com:8443/app/",
            "https://sakuraonseeker.com/api/catalog/", "https://user@sakuraonseeker.com/app/",
            "https://sakuraonseeker.com/app/%2e%2e/private", "file:///etc/passwd",
            "javascript:alert(1)", "//sakuraonseeker.com/app/", "/app/anime",
        ] {
            var components = URLComponents(string: "sakura-mac://open")!
            components.queryItems = [URLQueryItem(name: "url", value: target)]
            XCTAssertNil(subject.deepLink(try XCTUnwrap(components.url)), target)
        }
        XCTAssertNil(subject.deepLink(url("sakura-mac://open")))
        XCTAssertNil(subject.deepLink(url("sakura-mac://open?url=")))
        var duplicate = URLComponents(string: "sakura-mac://open")!
        duplicate.queryItems = [URLQueryItem(name: "url", value: production.absoluteString), URLQueryItem(name: "url", value: "https://evil.example/app/")]
        XCTAssertNil(subject.deepLink(try XCTUnwrap(duplicate.url)))
    }

    func testDeepLinkRejectsWrongSchemesCredentialsPortsAndTraversal() throws {
        let subject = try policy()
        for candidate in [
            "sakura://anime/watch?id=show&ep=one",
            "https://sakuraonseeker.com/app/anime",
            "file:///app/anime", "javascript:alert(1)",
            "sakura-mac://user@anime/watch", "sakura-mac://anime:99/watch",
            "sakura-mac://anime/../private", "sakura-mac://anime/%2e%2e/private",
            "sakura-mac://anime/%252e%252e/private", "sakura-mac://anime/%2fprivate",
            "sakura-mac://anime/%5cprivate",
        ] {
            XCTAssertNil(subject.deepLink(url(candidate)), candidate)
        }
    }

    func testExternalAllowsWebAndMailButNeverFileScriptOrCredentialURLs() throws {
        let subject = try policy()
        for candidate in ["https://anilist.co/api/v2/oauth/authorize?client_id=123", "http://example.org/help", "mailto:help@example.org?subject=Sakura"] {
            XCTAssertTrue(subject.permitsExternal(url(candidate)), candidate)
        }
        for candidate in [
            production.absoluteString, "https://sakuraonseeker.com/app/anime",
            "https://user:password@example.org/help", "http://user@example.org/",
            "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello",
            "ftp://example.org/app", "sakura-mac://anime/watch", "sakura://anime/watch",
        ] {
            XCTAssertFalse(subject.permitsExternal(url(candidate)), candidate)
        }
    }
}
