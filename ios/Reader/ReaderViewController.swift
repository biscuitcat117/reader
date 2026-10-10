import UIKit
import WebKit

/// Hosts the reader, which is the web app from the repository root bundled
/// into the app as `web/` and served over the private `reader://` scheme.
final class ReaderViewController: UIViewController {
    private static let scheme = "reader"
    private static let home = URL(string: "\(scheme)://app/index.html")!

    private var webView: ReaderWebView!
    private var isReady = false
    private var importFiles: [String: URL] = [:]
    private var pendingImports: [(id: String, name: String)] = []

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(self, forURLScheme: Self.scheme)
        config.userContentController.add(self, name: "reader")

        webView = ReaderWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.onMenuAction = { [weak self] kind in self?.call("readerAction", kind) }
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.allowsLinkPreview = false
        webView.backgroundColor = .systemBackground
        #if DEBUG
        webView.isInspectable = true
        #endif
        view = webView

        installNativeConfig()
        webView.load(URLRequest(url: Self.home))
    }

    /// Tells the page it is running inside the app and hands it the API key.
    private func installNativeConfig() {
        let native: [String: Any] = ["key": Keychain.apiKey ?? "", "menu": true]
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(
            source: "window.readerNative = \(Self.json(native));",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
    }

    private static func json(_ value: Any) -> String {
        let data = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "null"
    }

    private func call(_ function: String, _ arguments: String...) {
        let list = arguments.map(Self.json).joined(separator: ", ")
        webView.evaluateJavaScript("window.\(function)?.(\(list))")
    }

    // MARK: Opening books from Files and the share sheet

    func importBook(at url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        let id = UUID().uuidString
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("\(id).epub")
        guard (try? FileManager.default.copyItem(at: url, to: copy)) != nil else { return }
        // iPadOS leaves a copy of each opened document in Documents/Inbox.
        if url.path.contains("/Inbox/") { try? FileManager.default.removeItem(at: url) }

        importFiles[id] = copy
        pendingImports.append((id, url.lastPathComponent))
        flushImports()
    }

    private func flushImports() {
        guard isReady else { return }
        for item in pendingImports {
            call("readerImport", "import/\(item.id)", item.name)
        }
        pendingImports.removeAll()
    }
}

// MARK: - Messages from the page

extension ReaderViewController: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            isReady = true
            flushImports()
            #if DEBUG
            if let script = ProcessInfo.processInfo.environment["READER_DEBUG_JS"] {
                webView.evaluateJavaScript(script)
            }
            #endif
        case "setKey":
            Keychain.apiKey = body["value"] as? String
            installNativeConfig()
        default:
            break
        }
    }
}

// MARK: - Serving the bundled web app

extension ReaderViewController: WKURLSchemeHandler {
    private static let mimeTypes = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "png": "image/png", "svg": "image/svg+xml",
        "epub": "application/epub+zip", "json": "application/json",
    ]

    private func file(for url: URL) -> URL? {
        let path = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path
        if path.hasPrefix("/import/") { return importFiles[String(path.dropFirst("/import/".count))] }
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("web").standardizedFileURL else { return nil }
        let candidate = root.appendingPathComponent(path).standardizedFileURL
        return candidate.path.hasPrefix(root.path + "/") ? candidate : nil
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let data = file(for: url).flatMap { try? Data(contentsOf: $0) }
        let type = Self.mimeTypes[url.pathExtension.lowercased()] ?? "application/octet-stream"
        let response = HTTPURLResponse(
            url: url,
            statusCode: data == nil ? 404 : 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": type, "Content-Length": "\(data?.count ?? 0)", "Cache-Control": "no-store"]
        )!
        task.didReceive(response)
        task.didReceive(data ?? Data())
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: - Navigation and dialogs

extension ReaderViewController: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if ["http", "https"].contains(url.scheme) {
            await UIApplication.shared.open(url)
            return .cancel
        }
        return .allow
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        isReady = false
        webView.load(URLRequest(url: Self.home))
    }

    // Links in books open in Safari rather than a new web view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme) {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: "Remove", style: .destructive) { _ in continuation.resume(returning: true) })
            present(alert, animated: true)
        }
    }
}

// MARK: - Web view with Explain and Highlight in the selection menu

final class ReaderWebView: WKWebView {
    var onMenuAction: ((String) -> Void)?

    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard builder.system == .context else { return }
        let explain = UIAction(title: "Explain") { [weak self] _ in self?.onMenuAction?("explain") }
        let highlight = UIAction(title: "Highlight") { [weak self] _ in self?.onMenuAction?("highlight") }
        let note = UIAction(title: "Note") { [weak self] _ in self?.onMenuAction?("note") }
        let menu = UIMenu(options: .displayInline, children: [explain, highlight, note])
        builder.insertSibling(menu, beforeMenu: .standardEdit)
    }
}
