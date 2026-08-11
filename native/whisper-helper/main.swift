import Foundation
import whisper

private struct HelperOutput: Codable {
    let text: String
    let durationMilliseconds: Int
}

private enum HelperError: LocalizedError {
    case invalidArguments
    case invalidWave(String)
    case modelLoadFailed
    case transcriptionFailed

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "用法：whisper-helper --model <path> --input <16k-mono-pcm16.wav> [--language auto] [--prompt text]"
        case .invalidWave(let reason):
            return "WAV 格式无效：\(reason)"
        case .modelLoadFailed:
            return "Whisper 模型加载失败。"
        case .transcriptionFailed:
            return "Whisper 转写失败。"
        }
    }
}

private func argument(_ name: String, in arguments: [String], fallback: String? = nil) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return fallback
    }
    return arguments[index + 1]
}

private func readUInt16(_ data: Data, at offset: Int) throws -> UInt16 {
    guard offset >= 0, offset + 2 <= data.count else { throw HelperError.invalidWave("文件被截断") }
    return UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
}

private func readUInt32(_ data: Data, at offset: Int) throws -> UInt32 {
    guard offset >= 0, offset + 4 <= data.count else { throw HelperError.invalidWave("文件被截断") }
    return UInt32(data[offset])
        | (UInt32(data[offset + 1]) << 8)
        | (UInt32(data[offset + 2]) << 16)
        | (UInt32(data[offset + 3]) << 24)
}

private func pcmSamples(from url: URL) throws -> [Float] {
    let data = try Data(contentsOf: url, options: .mappedIfSafe)
    guard data.count >= 44,
          String(data: data[0..<4], encoding: .ascii) == "RIFF",
          String(data: data[8..<12], encoding: .ascii) == "WAVE" else {
        throw HelperError.invalidWave("仅支持 RIFF/WAVE")
    }

    var format: (audioFormat: UInt16, channels: UInt16, sampleRate: UInt32, bits: UInt16)?
    var audioRange: Range<Int>?
    var offset = 12
    while offset + 8 <= data.count {
        let identifier = String(data: data[offset..<(offset + 4)], encoding: .ascii) ?? ""
        let chunkSize = Int(try readUInt32(data, at: offset + 4))
        let contentStart = offset + 8
        let contentEnd = contentStart + chunkSize
        guard contentEnd <= data.count else { throw HelperError.invalidWave("区块长度越界") }
        if identifier == "fmt " {
            guard chunkSize >= 16 else { throw HelperError.invalidWave("fmt 区块过短") }
            format = (
                try readUInt16(data, at: contentStart),
                try readUInt16(data, at: contentStart + 2),
                try readUInt32(data, at: contentStart + 4),
                try readUInt16(data, at: contentStart + 14)
            )
        } else if identifier == "data" {
            audioRange = contentStart..<contentEnd
        }
        offset = contentEnd + (chunkSize % 2)
    }

    guard let format else { throw HelperError.invalidWave("缺少 fmt 区块") }
    guard format.audioFormat == 1, format.channels == 1, format.sampleRate == 16_000, format.bits == 16 else {
        throw HelperError.invalidWave("需要 16kHz、单声道、PCM16")
    }
    guard let audioRange else { throw HelperError.invalidWave("缺少 data 区块") }
    guard audioRange.count % 2 == 0 else { throw HelperError.invalidWave("PCM 数据长度不是偶数") }

    var samples = [Float]()
    samples.reserveCapacity(audioRange.count / 2)
    var sampleOffset = audioRange.lowerBound
    while sampleOffset < audioRange.upperBound {
        let raw = UInt16(data[sampleOffset]) | (UInt16(data[sampleOffset + 1]) << 8)
        samples.append(Float(Int16(bitPattern: raw)) / 32_768.0)
        sampleOffset += 2
    }
    return samples
}

private func transcribe(modelPath: String, inputPath: String, language: String, prompt: String) throws -> HelperOutput {
    var contextParameters = whisper_context_default_params()
    contextParameters.use_gpu = true
    contextParameters.flash_attn = true
    guard let context = whisper_init_from_file_with_params(modelPath, contextParameters) else {
        throw HelperError.modelLoadFailed
    }
    defer { whisper_free(context) }

    let samples = try pcmSamples(from: URL(fileURLWithPath: inputPath))
    var parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
    parameters.print_realtime = false
    parameters.print_progress = false
    parameters.print_timestamps = false
    parameters.print_special = false
    parameters.translate = false
    parameters.n_threads = Int32(max(1, min(8, ProcessInfo.processInfo.processorCount - 2)))
    parameters.no_context = true
    parameters.single_segment = false

    let started = ContinuousClock.now
    let status = language.withCString { languagePointer in
        prompt.withCString { promptPointer in
            parameters.language = languagePointer
            parameters.initial_prompt = prompt.isEmpty ? nil : promptPointer
            return samples.withUnsafeBufferPointer { buffer in
                whisper_full(context, parameters, buffer.baseAddress, Int32(buffer.count))
            }
        }
    }
    guard status == 0 else { throw HelperError.transcriptionFailed }

    var text = ""
    for index in 0..<whisper_full_n_segments(context) {
        text += String(cString: whisper_full_get_segment_text(context, index))
    }
    let elapsed = started.duration(to: .now)
    let components = elapsed.components
    let milliseconds = Int(components.seconds * 1_000) + Int(components.attoseconds / 1_000_000_000_000_000)
    return HelperOutput(text: text.trimmingCharacters(in: .whitespacesAndNewlines), durationMilliseconds: milliseconds)
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let modelPath = argument("--model", in: arguments),
          let inputPath = argument("--input", in: arguments) else {
        throw HelperError.invalidArguments
    }
    let output = try transcribe(
        modelPath: modelPath,
        inputPath: inputPath,
        language: argument("--language", in: arguments, fallback: "auto") ?? "auto",
        prompt: argument("--prompt", in: arguments, fallback: "") ?? ""
    )
    let encoded = try JSONEncoder().encode(output)
    print(String(decoding: encoded, as: UTF8.self))
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
