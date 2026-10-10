import SwiftUI

@main
struct ReaderApp: App {
    private let controller = ReaderViewController()

    var body: some Scene {
        WindowGroup {
            ReaderContainer(controller: controller)
                .ignoresSafeArea()
                .onOpenURL { controller.importBook(at: $0) }
        }
    }
}

private struct ReaderContainer: UIViewControllerRepresentable {
    let controller: ReaderViewController

    func makeUIViewController(context: Context) -> ReaderViewController { controller }
    func updateUIViewController(_ controller: ReaderViewController, context: Context) {}
}
