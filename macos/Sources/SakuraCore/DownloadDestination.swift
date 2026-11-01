import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Downloads into a unique sibling before publishing a complete file at the
/// user-selected destination. An existing file remains untouched until finish.
public struct DownloadDestination {
    public enum DestinationError: Error {
        case invalidDestinationURL
        case invalidStagingFile
    }

    public let stagingURL: URL
    private let destination: URL

    public init(destination: URL) throws {
        guard destination.isFileURL,
              destination.host == nil || destination.host == "" || destination.host == "localhost",
              destination.user == nil, destination.password == nil,
              destination.query == nil, destination.fragment == nil,
              destination.path.hasPrefix("/"), !destination.hasDirectoryPath,
              !destination.path.unicodeScalars.contains(where: { $0.value == 0 }),
              !["", ".", "..", "/"].contains(destination.lastPathComponent)
        else { throw DestinationError.invalidDestinationURL }

        self.destination = destination.standardizedFileURL
        let parent = self.destination.deletingLastPathComponent()
        var candidate: URL
        repeat {
            candidate = parent.appendingPathComponent(".sakura-download-\(UUID().uuidString)", isDirectory: false)
        } while FileManager.default.fileExists(atPath: candidate.path)
        stagingURL = candidate
    }

    public func finish() throws {
        // In particular, a missing or substituted staging file must never
        // remove the existing destination. WKDownload writes a regular file.
        let values = try stagingURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw DestinationError.invalidStagingFile
        }

        // Both files have the same parent, so rename publishes the complete
        // file atomically on that filesystem. It also replaces an existing
        // destination atomically; failure leaves that destination untouched.
        let result = stagingURL.withUnsafeFileSystemRepresentation { source in
            destination.withUnsafeFileSystemRepresentation { target in
                guard let source, let target else { return Int32(-1) }
                return rename(source, target)
            }
        }
        if result != 0 {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSFilePathErrorKey: destination.path])
        }
    }

    public func cancel() {
        // Only this download's unique staging path is ever removed. Never
        // remove the selected destination, including after a failed finish.
        try? FileManager.default.removeItem(at: stagingURL)
    }
}
