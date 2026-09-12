import Testing
import Foundation
@testable import SwiftOpenAPICheck
import OpenAPIRuntime

@Suite("Swift OpenAPI Generator Contract Compatibility Tests")
struct SwiftOpenAPICheckTests {

    @Test("GrowthRecord decodes correctly with null optional field and decimal strings")
    func testGrowthRecordDecoding() throws {
        let json = """
        {
            "id": "123e4567-e89b-12d3-a456-426614174000",
            "babyId": "test_baby_01",
            "familyId": "test_family_01",
            "heightCm": "76.5",
            "weightKg": "9.40",
            "headCircumferenceCm": null,
            "recordedAt": "2026-09-11T16:00:00.000Z",
            "version": "1"
        }
        """.data(using: .utf8)!

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let record = try decoder.decode(Components.Schemas.GrowthRecord.self, from: json)

        #expect(record.id == "123e4567-e89b-12d3-a456-426614174000")
        #expect(record.babyId == "test_baby_01")
        #expect(record.familyId == "test_family_01")
        #expect(record.heightCm == "76.5")
        #expect(record.weightKg == "9.40")
        #expect(record.headCircumferenceCm == nil)
        #expect(record.version == "1")
    }

    @Test("TimelineEvent discriminated union decodes feeding and diaper events")
    func testTimelineEventDecoding() throws {
        let feedingJson = """
        {
            "kind": "feeding",
            "id": "feed_01",
            "volumeMl": 150
        }
        """.data(using: .utf8)!

        let diaperJson = """
        {
            "kind": "diaper",
            "id": "diaper_01",
            "wet": true,
            "dirty": false
        }
        """.data(using: .utf8)!

        let decoder = JSONDecoder()
        let feedEvent = try decoder.decode(Components.Schemas.TimelineEvent.self, from: feedingJson)
        let diaperEvent = try decoder.decode(Components.Schemas.TimelineEvent.self, from: diaperJson)

        switch feedEvent {
        case .feeding(let feeding):
            #expect(feeding.id == "feed_01")
            #expect(feeding.volumeMl == 150)
        default:
            Issue.record("Expected feeding event")
        }

        switch diaperEvent {
        case .diaper(let diaper):
            #expect(diaper.id == "diaper_01")
            #expect(diaper.wet == true)
            #expect(diaper.dirty == false)
        default:
            Issue.record("Expected diaper event")
        }
    }

    @Test("Standard ApiError envelope decodes correctly")
    func testApiErrorEnvelopeDecoding() throws {
        let errorJson = """
        {
            "error": {
                "code": "RECORD_NOT_FOUND",
                "message": "The requested record was not found",
                "requestId": "req_test_123"
            }
        }
        """.data(using: .utf8)!

        let decoder = JSONDecoder()
        let errEnvelope = try decoder.decode(Components.Schemas.ApiErrorEnvelope.self, from: errorJson)

        #expect(errEnvelope.error.code == "RECORD_NOT_FOUND")
        #expect(errEnvelope.error.message == "The requested record was not found")
        #expect(errEnvelope.error.requestId == "req_test_123")
    }

    @Test("API response envelope for timeline event decodes directly into Components.Schemas.TimelineEvent")
    func testTimelineResponseEnvelopeDecoding() throws {
        let responseJson = """
        {
            "data": {
                "kind": "feeding",
                "id": "feed_resp_01",
                "volumeMl": 200
            }
        }
        """.data(using: .utf8)!

        let decoder = JSONDecoder()
        let envelope = try decoder.decode(Operations.createTimelineEvent.Output.Ok.Body.jsonPayload.self, from: responseJson)

        switch envelope.data {
        case .feeding(let feeding):
            #expect(feeding.id == "feed_resp_01")
            #expect(feeding.volumeMl == 200)
        default:
            Issue.record("Expected feeding event in response envelope")
        }
    }

    @Test("Fastify 400 validation error response decodes into Components.Schemas.ApiErrorEnvelope matching createTimelineEvent 400 response")
    func testTimelineBadRequestEnvelopeDecoding() throws {
        // Real 400 payload produced by Fastify setErrorHandler on invalid payload
        let badRequestJson = """
        {
            "error": {
                "code": "VALIDATION_FAILED",
                "message": "body must have required property 'volumeMl', body must have required property 'wet', body must have required property 'durationMinutes', body must match a schema in anyOf",
                "requestId": "req_sample_test_01"
            }
        }
        """.data(using: .utf8)!

        let decoder = JSONDecoder()
        let envelope = try decoder.decode(Components.Schemas.ApiErrorEnvelope.self, from: badRequestJson)

        #expect(envelope.error.code == "VALIDATION_FAILED")
        #expect(envelope.error.message.contains("must match a schema in anyOf"))
        #expect(envelope.error.requestId == "req_sample_test_01")

        // Verify it directly constructs the Operation Output BadRequest body
        let badRequestOutput = Operations.createTimelineEvent.Output.BadRequest(body: .json(envelope))
        switch badRequestOutput.body {
        case .json(let err):
            #expect(err.error.code == "VALIDATION_FAILED")
        }
    }
}
