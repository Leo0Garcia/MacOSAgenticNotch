// Word-by-word text: a wrapping layout of one view per word, so each word can
// animate on its own (transcript `wordIn`, reply words 30% → 100% as spoken)
// without rebuilding the text every frame.

import SwiftUI

struct FlowLayout: Layout {
    var spacing: CGFloat = 5
    var lineHeight: CGFloat = 25

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let rows = arrange(subviews, width: width)
        let w = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? w, height: CGFloat(rows.count) * lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = arrange(subviews, width: bounds.width)
        for (r, row) in rows.enumerated() {
            var x = bounds.minX
            for i in row.indices {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: bounds.minY + CGFloat(r) * lineHeight + (lineHeight - size.height) / 2),
                                  proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [(indices: [Int], width: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat)] = []
        var cur: [Int] = []
        var x: CGFloat = 0
        for i in subviews.indices {
            let w = subviews[i].sizeThatFits(.unspecified).width
            if !cur.isEmpty, x + spacing + w > width {
                rows.append((cur, x))
                cur = []
                x = 0
            }
            x += (cur.isEmpty ? 0 : spacing) + w
            cur.append(i)
        }
        if !cur.isEmpty { rows.append((cur, x)) }
        return rows
    }
}

/// One spoken word: starts at 30% and comes up to 100% at `revealAt` (scheduler
/// time). A word already said shows at 100% straight away, so redrawing the
/// panel (hover, resize) doesn't replay the reading (Leo, 2026-10-22).
struct SpokenWord: View {
    var word: String
    var revealAt: Double
    var now: () -> Double
    var font: Font
    @State private var on = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(word)
            .font(font)
            .foregroundStyle(.white)
            .opacity(on ? 1 : 0.3)
            .onAppear {
                let wait = revealAt - now()
                if wait <= 0 || reduceMotion { on = true; return }
                withAnimation(.easeOut(duration: 0.16).delay(wait)) { on = true }
            }
    }
}

/// Transcript word with the blur-in (`wordIn`); unconfirmed words at 45% white.
struct TranscriptWord: View {
    var word: String
    var confirmed: Bool
    var font: Font
    var dim: Double

    var body: some View {
        Text(word)
            .font(font)
            .foregroundStyle(.white.opacity(confirmed ? 1 : dim))
            .animation(MotionToken.wordIn, value: confirmed)
    }
}
