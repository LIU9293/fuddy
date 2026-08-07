import XCTest
@testable import ProjectAgentCompanion

final class SyncModelTests: XCTestCase {
    func testPairingPayloadDecodesMacPayload() throws {
        let payload = #"{"protocolVersion":1,"relayUrl":"https://relay.example.com","accountId":"account","pairingSecret":"secret"}"#
        let decoded = try JSONDecoder().decode(PairingPayload.self, from: Data(payload.utf8))
        XCTAssertEqual(decoded.protocolVersion, 1)
        XCTAssertEqual(decoded.accountId, "account")
    }

    func testGenericEventPayloadDecodesAgentRun() throws {
        let json = #"{"eventId":"e1","sequence":1,"protocolVersion":1,"type":"agent-run.updated","entityType":"agent-run","entityId":"r1","revision":1,"payload":{"id":"r1","projectId":null,"provider":"codex","title":"Test","status":"idle","workingDirectory":null,"summary":"Done","createdAt":"2026-08-07T00:00:00.000Z","updatedAt":"2026-08-07T00:00:00.000Z"},"sourceDeviceId":"mac","occurredAt":"2026-08-07T00:00:00.000Z"}"#
        let event = try JSONDecoder().decode(SyncEvent.self, from: Data(json.utf8))
        XCTAssertEqual(try event.payload.decode(AgentRun.self).title, "Test")
    }
}
