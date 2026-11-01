#!/usr/bin/env swift
import CryptoKit
import Foundation

// Verify the exact archive against the public key embedded in the application.
// A generated but unsigned/mismatched appcast must never look release-ready.
final class EnclosureReader: NSObject, XMLParserDelegate {
    struct Item {
        var enclosures: [[String: String]] = []
        var version = ""
        var shortVersion = ""
    }
    var items: [Item] = []
    private var current: Item?
    private var field: String?
    private var text = ""
    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String: String]) {
        if elementName == "item" { current = Item() }
        if elementName == "enclosure" { current?.enclosures.append(attributeDict) }
        if elementName == "sparkle:version" || elementName == "sparkle:shortVersionString" {
            field = elementName
            text = ""
        }
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if field != nil { text += string }
    }
    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        if elementName == field {
            if field == "sparkle:version" { current?.version = text.trimmingCharacters(in: .whitespacesAndNewlines) }
            if field == "sparkle:shortVersionString" { current?.shortVersion = text.trimmingCharacters(in: .whitespacesAndNewlines) }
            field = nil
        }
        if elementName == "item", let item = current {
            items.append(item)
            current = nil
        }
    }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("Error: \(message)\n".utf8))
    exit(1)
}

guard CommandLine.arguments.count == 5 else {
    fail("Usage: verify-update.swift APPCAST ARCHIVE APP_BUNDLE DOWNLOAD_BASE_URL")
}
do {
    let feedURL = URL(fileURLWithPath: CommandLine.arguments[1])
    let archiveURL = URL(fileURLWithPath: CommandLine.arguments[2])
    let appURL = URL(fileURLWithPath: CommandLine.arguments[3])
    guard let downloadBase = URL(string: CommandLine.arguments[4]), downloadBase.scheme == "https",
          downloadBase.host != nil, downloadBase.user == nil, downloadBase.password == nil,
          downloadBase.query == nil, downloadBase.fragment == nil else {
        fail("Expected an HTTPS download directory without credentials, query or fragment.")
    }
    let expectedURL = downloadBase.appendingPathComponent(archiveURL.lastPathComponent)
    let plistData = try Data(contentsOf: appURL.appendingPathComponent("Contents/Info.plist"))
    guard let plist = try PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any],
          let publicKey = plist["SUPublicEDKey"] as? String,
          let keyData = Data(base64Encoded: publicKey),
          let expectedVersion = plist["CFBundleVersion"] as? String,
          let expectedShortVersion = plist["CFBundleShortVersionString"] as? String else {
        fail("Missing embedded update public key or application version.")
    }
    let reader = EnclosureReader()
    guard let parser = XMLParser(contentsOf: feedURL) else { fail("Cannot open generated appcast.") }
    parser.delegate = reader
    parser.shouldResolveExternalEntities = false
    guard parser.parse() else { fail("Generated appcast is invalid XML.") }
    guard reader.items.count == 1, let item = reader.items.first,
          item.version == expectedVersion, item.shortVersion == expectedShortVersion else {
        fail("Appcast must contain exactly this application's build and display version.")
    }
    guard item.enclosures.count == 1, let enclosure = item.enclosures.first,
          let value = enclosure["url"], URL(string: value) == expectedURL,
          let signatureString = enclosure["sparkle:edSignature"],
          let signature = Data(base64Encoded: signatureString) else {
        fail("Expected one signed archive enclosure at the configured download URL.")
    }
    let archiveData = try Data(contentsOf: archiveURL, options: .mappedIfSafe)
    guard enclosure["length"] == String(archiveData.count) else { fail("Appcast archive length mismatch.") }
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: keyData)
    guard key.isValidSignature(signature, for: archiveData) else {
        fail("Update signature does not match the public key embedded in Sakura.")
    }
    print("Verified update archive signature against Sakura's embedded public key.")
} catch {
    fail("Update verification failed: \(error.localizedDescription)")
}
