import Foundation
import XCTest
@testable import SakuraCore

final class DownloadDestinationTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("Sakura downloads \(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    }

    override func tearDownWithError() throws {
        if let directory { try FileManager.default.removeItem(at: directory) }
        directory = nil
    }

    private func write(_ value: String, to url: URL) throws {
        try Data(value.utf8).write(to: url)
    }

    private func read(_ url: URL) throws -> String {
        String(decoding: try Data(contentsOf: url), as: UTF8.self)
    }

    func testStagingURLsAreUniqueNonexistentSiblings() throws {
        let destination = directory.appendingPathComponent("My Sakura backup.json")
        let first = try DownloadDestination(destination: destination)
        let second = try DownloadDestination(destination: destination)
        XCTAssertNotEqual(first.stagingURL, second.stagingURL)
        XCTAssertEqual(first.stagingURL.deletingLastPathComponent(), directory)
        XCTAssertTrue(first.stagingURL.lastPathComponent.hasPrefix(".sakura-download-"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.stagingURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.stagingURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    }

    func testFinishPublishesNewFileWithUnicodeSpacesAndPunctuation() throws {
        let destination = directory.appendingPathComponent("桜 Chapter 1 # notes?.cbz")
        let download = try DownloadDestination(destination: destination)
        try write("complete chapter", to: download.stagingURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        try download.finish()
        XCTAssertEqual(try read(destination), "complete chapter")
        XCTAssertFalse(FileManager.default.fileExists(atPath: download.stagingURL.path))
    }

    func testFinishReplacesExistingFileOnlyAfterStagingCompletes() throws {
        let destination = directory.appendingPathComponent("reader.json")
        try write("original backup", to: destination)
        let download = try DownloadDestination(destination: destination)
        XCTAssertEqual(try read(destination), "original backup")
        try write("new complete backup", to: download.stagingURL)
        XCTAssertEqual(try read(destination), "original backup")
        try download.finish()
        XCTAssertEqual(try read(destination), "new complete backup")
        XCTAssertFalse(FileManager.default.fileExists(atPath: download.stagingURL.path))
    }

    func testCancelPreservesExistingFileAndOtherDownloads() throws {
        let destination = directory.appendingPathComponent("reader.json")
        try write("original backup", to: destination)
        let first = try DownloadDestination(destination: destination)
        let second = try DownloadDestination(destination: destination)
        try write("partial first", to: first.stagingURL)
        try write("partial second", to: second.stagingURL)
        first.cancel()
        first.cancel()
        XCTAssertEqual(try read(destination), "original backup")
        XCTAssertEqual(try read(second.stagingURL), "partial second")
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.stagingURL.path))
    }

    func testCancelBeforeDownloadStartsDoesNotRemoveDestination() throws {
        let destination = directory.appendingPathComponent("reader.json")
        try write("original backup", to: destination)
        let download = try DownloadDestination(destination: destination)
        download.cancel()
        XCTAssertEqual(try read(destination), "original backup")
    }

    func testMissingStagingFileCannotDestroyExistingDestination() throws {
        let destination = directory.appendingPathComponent("reader.json")
        try write("original backup", to: destination)
        let download = try DownloadDestination(destination: destination)
        XCTAssertThrowsError(try download.finish())
        XCTAssertEqual(try read(destination), "original backup")
        download.cancel()
        XCTAssertEqual(try read(destination), "original backup")
    }

    func testFailedPublishPreservesDestinationDirectoryAndItsContents() throws {
        let destination = directory.appendingPathComponent("existing-folder", isDirectory: false)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
        let original = destination.appendingPathComponent("important.txt")
        try write("keep me", to: original)
        let download = try DownloadDestination(destination: destination)
        try write("new file", to: download.stagingURL)
        XCTAssertThrowsError(try download.finish())
        XCTAssertEqual(try read(original), "keep me")
        XCTAssertEqual(try read(download.stagingURL), "new file")
        download.cancel()
        XCTAssertEqual(try read(original), "keep me")
    }

    func testCancelAfterSuccessPreservesPublishedFile() throws {
        let destination = directory.appendingPathComponent("reader.json")
        let download = try DownloadDestination(destination: destination)
        try write("complete backup", to: download.stagingURL)
        try download.finish()
        download.cancel()
        XCTAssertEqual(try read(destination), "complete backup")
        XCTAssertThrowsError(try download.finish())
        XCTAssertEqual(try read(destination), "complete backup")
    }

    func testRejectsNonlocalFileAndNonfileURLs() throws {
        for raw in [
            "https://sakuraonseeker.com/app/reader.json",
            "file://remote.example/tmp/reader.json",
            "file:///tmp/reader.json?token=secret",
            "file:///tmp/reader.json#fragment",
            "file:///",
            "file:///tmp/",
        ] {
            XCTAssertThrowsError(try DownloadDestination(destination: XCTUnwrap(URL(string: raw))), raw)
        }
    }

    func testStagingSymlinkCannotPublishOrDeleteItsTarget() throws {
        let destination = directory.appendingPathComponent("reader.json")
        let unrelated = directory.appendingPathComponent("unrelated.txt")
        try write("original backup", to: destination)
        try write("unrelated data", to: unrelated)
        let download = try DownloadDestination(destination: destination)
        try FileManager.default.createSymbolicLink(at: download.stagingURL, withDestinationURL: unrelated)
        XCTAssertThrowsError(try download.finish())
        XCTAssertEqual(try read(destination), "original backup")
        download.cancel()
        XCTAssertEqual(try read(unrelated), "unrelated data")
    }
}
