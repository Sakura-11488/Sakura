// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SakuraMac",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "SakuraMac", targets: ["SakuraMac"])],
    dependencies: [.package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0")],
    targets: [
        .target(name: "SakuraCore"),
        .executableTarget(name: "SakuraMac", dependencies: ["SakuraCore", .product(name: "Sparkle", package: "Sparkle")],
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]),
        .testTarget(name: "SakuraCoreTests", dependencies: ["SakuraCore"]),
    ]
)
