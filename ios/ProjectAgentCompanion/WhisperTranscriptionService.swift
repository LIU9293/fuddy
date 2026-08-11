import AVFoundation
import Combine
import Foundation
import whisper

enum CompanionVoiceInputState: Equatable {
    case idle
    case recording
    case transcribing
}

enum CompanionWhisperError: LocalizedError {
    case modelMissing
    case modelLoadFailed
    case transcriptionFailed
    case emptyRecording

    var errorDescription: String? {
        switch self {
        case .modelMissing: "预置的 Whisper 模型不存在，请重新安装 App。"
        case .modelLoadFailed: "Whisper 模型加载失败。"
        case .transcriptionFailed: "Whisper 转写失败，请再试一次。"
        case .emptyRecording: "录音太短，请再说一次。"
        }
    }
}

actor CompanionWhisperContext {
    static let shared = CompanionWhisperContext()
    private var context: OpaquePointer?

    func transcribe(samples: [Float], prompt: String) throws -> String {
        guard samples.count >= 4_000 else { throw CompanionWhisperError.emptyRecording }
        let context = try loadContext()
        var parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
        parameters.print_realtime = false
        parameters.print_progress = false
        parameters.print_timestamps = false
        parameters.print_special = false
        parameters.translate = false
        parameters.no_context = true
        parameters.single_segment = false
        parameters.n_threads = Int32(max(1, min(6, ProcessInfo.processInfo.processorCount - 2)))

        let result = "zh".withCString { languagePointer in
            prompt.withCString { promptPointer in
                parameters.language = languagePointer
                parameters.initial_prompt = prompt.isEmpty ? nil : promptPointer
                return samples.withUnsafeBufferPointer { buffer in
                    whisper_full(context, parameters, buffer.baseAddress, Int32(buffer.count))
                }
            }
        }
        guard result == 0 else { throw CompanionWhisperError.transcriptionFailed }
        let text = (0..<whisper_full_n_segments(context)).reduce(into: "") { output, index in
            if let segment = whisper_full_get_segment_text(context, index) {
                output += String(cString: segment)
            }
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func loadContext() throws -> OpaquePointer {
        if let context { return context }
        guard let modelURL = Bundle.main.urls(forResourcesWithExtension: "bin", subdirectory: nil)?
            .first(where: { $0.lastPathComponent == "ggml-large-v3-turbo-q5_0.bin" }) else {
            throw CompanionWhisperError.modelMissing
        }
        var parameters = whisper_context_default_params()
        parameters.use_gpu = true
        parameters.flash_attn = true
        guard let loaded = whisper_init_from_file_with_params(modelURL.path, parameters) else {
            throw CompanionWhisperError.modelLoadFailed
        }
        context = loaded
        return loaded
    }
}

@MainActor
final class CompanionVoiceInput: ObservableObject, @unchecked Sendable {
    @Published private(set) var state: CompanionVoiceInputState = .idle
    @Published private(set) var error: String?

    private let engine = AVAudioEngine()
    private let sampleLock = NSLock()
    private var sampleChunks: [[Float]] = []
    private var inputSampleRate = 48_000.0

    func start() async {
        error = nil
        guard await requestPermission() else {
            error = "需要麦克风权限才能使用语音输入。"
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            sampleLock.withLock { sampleChunks.removeAll(keepingCapacity: true) }
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            inputSampleRate = format.sampleRate
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 4_096, format: format) { [weak self] buffer, _ in
                guard let self, let channel = buffer.floatChannelData?.pointee else { return }
                let chunk = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
                self.sampleLock.withLock { self.sampleChunks.append(chunk) }
            }
            engine.prepare()
            try engine.start()
            state = .recording
        } catch {
            self.error = error.localizedDescription
            stopEngine()
        }
    }

    func stopAndTranscribe(prompt: String) async -> String? {
        guard state == .recording else { return nil }
        stopEngine()
        state = .transcribing
        let source = sampleLock.withLock { sampleChunks.flatMap { $0 } }
        let samples = Self.downsample(source, from: inputSampleRate, to: 16_000)
        do {
            let text = try await CompanionWhisperContext.shared.transcribe(samples: samples, prompt: prompt)
            state = .idle
            return text
        } catch {
            self.error = error.localizedDescription
            state = .idle
            return nil
        }
    }

    private func stopEngine() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if state == .recording { state = .idle }
    }

    private func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { allowed in continuation.resume(returning: allowed) }
        }
    }

    static func downsample(_ input: [Float], from inputRate: Double, to outputRate: Double) -> [Float] {
        guard inputRate > outputRate else { return input }
        let ratio = inputRate / outputRate
        let count = Int(Double(input.count) / ratio)
        return (0..<count).map { index in
            let start = Int(Double(index) * ratio)
            let end = min(input.count, Int(Double(index + 1) * ratio))
            guard end > start else { return input[min(start, input.count - 1)] }
            return input[start..<end].reduce(0, +) / Float(end - start)
        }
    }
}
