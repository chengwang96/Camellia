import SwiftUI

/// Shared 24-unit paths from Android's LineIcon, with the same stroke weight.
struct MobileLineIcon: View {
    let name: String
    var size: CGFloat = 23

    var body: some View {
        Group {
            if MobileIconPath.names.contains(name) {
                MobileIconPath(name: name)
                    .stroke(style: StrokeStyle(lineWidth: 1.7 * size / 24, lineCap: .round, lineJoin: .round))
            } else {
                Image(systemName: name).font(.system(size: size))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct MobileIconPath: Shape {
    let name: String
    static let names: Set<String> = ["pencil", "edit", "checkmark.circle", "select", "pin",
        "arrow.triangle.branch", "branch", "trash", "delete", "key", "archivebox", "archive",
        "sun.max", "appearance", "globe", "language", "slider.horizontal.3", "gearshape", "settings",
        "chevron.left", "back", "chevron.right", "right", "chevron.down", "down", "xmark", "close",
        "magnifyingglass", "search", "folder", "checkmark", "check", "desktopcomputer", "computer",
        "iphone", "ipad", "phone", "doc", "file", "ellipsis", "more", "plus", "new",
        "checkmark.shield", "shield", "plus.bubble"]

    func path(in rect: CGRect) -> Path {
        var p = Path()
        func line(_ points: [(CGFloat, CGFloat)]) {
            guard let first = points.first else { return }
            p.move(to: CGPoint(x: first.0, y: first.1))
            for point in points.dropFirst() { p.addLine(to: CGPoint(x: point.0, y: point.1)) }
        }
        func ellipse(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) {
            p.addEllipse(in: CGRect(x: x, y: y, width: w, height: h))
        }
        func rounded(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) {
            p.addRoundedRect(in: CGRect(x: x, y: y, width: w, height: h),
                             cornerSize: CGSize(width: r, height: r))
        }
        switch name {
        case "pencil", "edit":
            line([(4,16),(16,4),(20,8),(8,20),(3,21)]); p.closeSubpath(); line([(14,6),(18,10)])
        case "checkmark.circle", "select":
            for row in 0..<3 {
                let y = CGFloat(5 + row * 7)
                line([(3,y),(5,y+2),(8,y-2)]); line([(12,y),(21,y)])
            }
        case "pin":
            line([(7,3),(17,3)]); line([(9,3),(9,9),(5,14),(19,14),(15,9),(15,3)])
            line([(12,14),(12,22)])
        case "arrow.triangle.branch", "branch":
            ellipse(4,2,4,4); ellipse(4,18,4,4); ellipse(16,2,4,4)
            line([(6,6),(6,18)]); line([(18,6),(18,9)])
            p.addQuadCurve(to: CGPoint(x:6,y:13), control: CGPoint(x:18,y:13))
        case "trash", "delete":
            line([(3,6),(21,6)]); line([(9,3),(15,3)]); line([(6,6),(7,21),(17,21),(18,6)])
            line([(10,10),(10,17)]); line([(14,10),(14,17)])
        case "key":
            ellipse(3.5,3.5,9,9); line([(11.5,11.5),(21,21)])
            line([(16,16),(19,13)]); line([(18.5,18.5),(21.5,15.5)])
        case "checkmark.shield", "shield":
            p.move(to: CGPoint(x:12,y:2)); p.addLine(to: CGPoint(x:21,y:6))
            p.addLine(to: CGPoint(x:20,y:15))
            p.addQuadCurve(to: CGPoint(x:12,y:23), control: CGPoint(x:18,y:20))
            p.addQuadCurve(to: CGPoint(x:4,y:15), control: CGPoint(x:6,y:20))
            p.addLine(to: CGPoint(x:3,y:6)); p.closeSubpath()
            line([(8,12),(11,15),(16,9)])
        case "archivebox", "archive":
            rounded(3,3,18,5,1.5); line([(5,8),(5,21),(19,21),(19,8)]); line([(9,12),(15,12)])
        case "sun.max", "appearance":
            ellipse(8,8,8,8)
            for index in 0..<8 {
                let angle = CGFloat(index) * .pi / 4
                line([(12 + cos(angle)*8,12 + sin(angle)*8),(12 + cos(angle)*10,12 + sin(angle)*10)])
            }
        case "globe", "language":
            ellipse(3,3,18,18); ellipse(8,3,8,18); line([(3,12),(21,12)])
        case "slider.horizontal.3", "gearshape", "settings":
            line([(3,6),(21,6)]); line([(3,12),(21,12)]); line([(3,18),(21,18)])
            ellipse(6,4,4,4); ellipse(14,10,4,4); ellipse(8,16,4,4)
        case "chevron.left", "back": line([(15,4),(7,12),(15,20)])
        case "chevron.right", "right": line([(9,6),(15,12),(9,18)])
        case "chevron.down", "down": line([(6,9),(12,15),(18,9)])
        case "xmark", "close": line([(6,6),(18,18)]); line([(18,6),(6,18)])
        case "magnifyingglass", "search": ellipse(4,4,13,13); line([(16,16),(21,21)])
        case "folder":
            line([(3,18),(3,7)]); p.addQuadCurve(to: CGPoint(x:5,y:5.2), control: CGPoint(x:3,y:5.2))
            p.addLine(to: CGPoint(x:10,y:5.2)); p.addLine(to: CGPoint(x:13,y:7.8)); p.addLine(to: CGPoint(x:19,y:7.8))
            p.addQuadCurve(to: CGPoint(x:21,y:9.5), control: CGPoint(x:21,y:7.8))
            line([(3,18),(6,10.3),(22,10.3),(19,18.8),(3,18.8)])
        case "checkmark", "check": line([(4,12),(9,17),(20,6)])
        case "desktopcomputer", "computer":
            rounded(4,3,16,12,2); line([(12,15),(12,20)]); line([(7,20),(17,20)])
        case "iphone", "ipad", "phone": rounded(6,2,12,20,3); line([(10,18),(14,18)])
        case "doc", "file":
            line([(5,2),(14,2),(20,8),(20,22),(5,22)]); p.closeSubpath()
            line([(14,2),(14,8),(20,8)]); line([(8,13),(16,13)]); line([(8,17),(14,17)])
        case "ellipsis", "more": ellipse(4.2,11.2,1.6,1.6); ellipse(11.2,11.2,1.6,1.6); ellipse(18.2,11.2,1.6,1.6)
        case "new", "plus.bubble":
            p.move(to: CGPoint(x: 5, y: 17))
            p.addCurve(to: CGPoint(x: 18, y: 5), control1: CGPoint(x: -1, y: 5), control2: CGPoint(x: 11, y: 0))
            p.addCurve(to: CGPoint(x: 10, y: 20), control1: CGPoint(x: 26, y: 12), control2: CGPoint(x: 20, y: 22))
            p.addLine(to: CGPoint(x: 3, y: 21)); p.closeSubpath()
            line([(9,12),(17,12)]); line([(13,8),(13,16)])
        default: line([(5,12),(19,12)]); line([(12,5),(12,19)])
        }
        return p.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24))
    }
}
