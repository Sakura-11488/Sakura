import Foundation
import SakuraCore

struct AppConfiguration {
    let policy: AppPolicy
    let development: Bool
    init(bundle: Bundle = .main) throws {
        var raw = bundle.object(forInfoDictionaryKey: "SakuraAppURL") as? String ?? "https://sakuraonseeker.com/app/"
        var development = false
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["SAKURA_DEV_URL"] {
            raw = override; development = true
        }
        #endif
        guard let url = URL(string: raw), development || url.scheme == "https" else {
            throw AppPolicy.ConfigurationError.invalidBaseURL
        }
        policy = try AppPolicy(baseURL: url)
        self.development = development
    }
}
