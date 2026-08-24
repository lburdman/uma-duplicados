// Word-level OCR through Apple's Vision framework.
//
// Reads a rasterized page and prints one JSON object per run, with a bounding box per
// WORD — not per line. The rest of this pipeline reconstructs the billing grid from
// word geometry (see ADR 0001), so an OCR fallback that only returned lines would be
// a different kind of input and would need a different table reader. Word boxes let
// the exact same reconstruction code run on top of it.
//
// Coordinates come out of Vision normalized, origin bottom-left. They are converted
// here to PDF points with origin top-left, which is what poppler emits — so the two
// extractors are interchangeable behind the TextExtractor port.
//
// usage: vision-ocr <image-path> <page-width-pt> <page-height-pt> [languages]

import Foundation
import Vision
import CoreGraphics
import ImageIO

struct OcrWord: Encodable {
  let text: String
  let x0: Double
  let y0: Double
  let x1: Double
  let y1: Double
  let confidence: Double
}

struct OcrPage: Encodable {
  let words: [OcrWord]
  let engine: String
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(("vision-ocr: " + message + "\n").data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 4 else { fail("usage: vision-ocr <image> <width-pt> <height-pt> [languages]") }

let imagePath = args[1]
guard let pageWidth = Double(args[2]), let pageHeight = Double(args[3]) else {
  fail("width and height must be numbers")
}
let languages = args.count > 4 ? args[4].split(separator: ",").map(String.init) : ["es-ES", "en-US"]

guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: imagePath) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  fail("could not read image at \(imagePath)")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
// The grid holds codes, dates and amounts. Language correction "fixes" 340213 into
// something friendlier, which is the opposite of what an audit trail needs.
request.usesLanguageCorrection = false
request.recognitionLanguages = languages

let handler = VNImageRequestHandler(cgImage: image, options: [:])
do {
  try handler.perform([request])
} catch {
  fail("recognition failed: \(error)")
}

var words: [OcrWord] = []

for observation in (request.results ?? []) {
  guard let candidate = observation.topCandidates(1).first else { continue }
  let text = candidate.string

  // Walk the recognized string token by token and ask Vision for each token's own box.
  var cursor = text.startIndex
  while cursor < text.endIndex {
    guard let tokenStart = text[cursor...].firstIndex(where: { !$0.isWhitespace }) else { break }
    let tokenEnd = text[tokenStart...].firstIndex(where: { $0.isWhitespace }) ?? text.endIndex
    let range = tokenStart..<tokenEnd
    let token = String(text[range])
    cursor = tokenEnd

    if token.isEmpty { continue }

    // boundingBox(for:) can return nil for a range Vision cannot localize; falling back
    // to the whole observation would invent a position, so the token is dropped and the
    // caller sees a shorter word list rather than a wrong one.
    guard let box = try? candidate.boundingBox(for: range) else { continue }
    let rect = box.boundingBox

    words.append(OcrWord(
      text: token,
      x0: rect.minX * pageWidth,
      // Vision's origin is bottom-left; poppler's is top-left. Flip Y.
      y0: (1.0 - rect.maxY) * pageHeight,
      x1: rect.maxX * pageWidth,
      y1: (1.0 - rect.minY) * pageHeight,
      confidence: Double(candidate.confidence)
    ))
  }
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let payload = OcrPage(words: words, engine: "apple-vision")
FileHandle.standardOutput.write(try! encoder.encode(payload))
