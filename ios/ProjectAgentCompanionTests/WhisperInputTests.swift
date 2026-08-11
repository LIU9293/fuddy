import XCTest
@testable import ProjectAgentCompanion

final class WhisperInputTests: XCTestCase {
    @MainActor
    func testDownsamplesMicrophoneFramesToSixteenKilohertz() {
        let output = CompanionVoiceInput.downsample([0, 1, 0, -1], from: 32_000, to: 16_000)
        XCTAssertEqual(output, [0.5, -0.5])
    }
}
