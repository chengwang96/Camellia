import Foundation
import Tailnet

/// The interface list handed to the embedded network.
///
/// Ported from `EmbeddedNetwork.registerInterfaces`. Android injects this list
/// because Android 11 blocks the netlink socket tsnet would otherwise use to
/// enumerate interfaces; the JSON shape below is the one `SetInterfaces` in
/// `bridge.go` unmarshals, so the field names are fixed by that contract:
///
/// ```json
/// [{"Name":"en0","Index":6,"MTU":1500,"Up":true,"Loopback":false,
///   "Addresses":["192.168.1.24/24"]}]
/// ```
///
/// On iOS the injection is expected to be unnecessary, because Darwin backs
/// `net.Interfaces()` with `getifaddrs` and the sandbox permits it. It is
/// implemented anyway so that a device where the default discovery fails has a
/// way out, and so that the two platforms share one documented shape.
final class InterfaceSnapshot: NSObject, TailnetInterfacesProtocol {
    enum Failure: LocalizedError {
        case enumeration(Int32)

        var errorDescription: String? {
            switch self {
            case .enumeration(let code):
                return "Cannot enumerate network interfaces: \(String(cString: strerror(code)))"
            }
        }
    }

    func snapshot(_ error: NSErrorPointer) -> String {
        do {
            return try encode()
        } catch let failure {
            error?.pointee = failure as NSError
            return "[]"
        }
    }

    /// Builds the list, in the order the kernel reports the interfaces.
    func encode() throws -> String {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0 else { throw Failure.enumeration(errno) }
        guard let first = head else { return "[]" }
        defer { freeifaddrs(head) }

        var order: [String] = []
        var seen = Set<String>()
        var flags: [String: UInt32] = [:]
        var mtu: [String: Int] = [:]
        var addresses: [String: [String]] = [:]

        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = cursor {
            let record = entry.pointee
            let name = String(cString: record.ifa_name)

            if seen.insert(name).inserted {
                order.append(name)
                flags[name] = record.ifa_flags
                addresses[name] = []
            }

            // Only the AF_LINK record carries if_data, which is where the MTU
            // lives. Reading it off any other family would reinterpret a
            // different struct.
            if let data = record.ifa_data,
               let address = record.ifa_addr,
               Int32(address.pointee.sa_family) == AF_LINK {
                mtu[name] = Int(data.assumingMemoryBound(to: if_data.self).pointee.ifi_mtu)
            }

            if let address = record.ifa_addr {
                let family = Int32(address.pointee.sa_family)
                if family == AF_INET || family == AF_INET6, let host = Self.numericHost(address) {
                    addresses[name, default: []].append("\(host)/\(Self.prefixLength(record.ifa_netmask))")
                }
            }

            cursor = record.ifa_next
        }

        let entries: [[String: Any]] = order.map { name in
            let value = flags[name] ?? 0
            return [
                "Name": name,
                "Index": Int(if_nametoindex(name)),
                "MTU": mtu[name] ?? 0,
                "Up": (value & UInt32(IFF_UP)) != 0,
                "Loopback": (value & UInt32(IFF_LOOPBACK)) != 0,
                "Addresses": addresses[name] ?? [],
            ]
        }
        let data = try JSONSerialization.data(withJSONObject: entries, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    /// Renders one sockaddr as a bare numeric host.
    ///
    /// The zone suffix is stripped: Android does the same, and `net.ParseCIDR`
    /// on the Go side would reject `fe80::1%en0/64`.
    private static func numericHost(_ address: UnsafeMutablePointer<sockaddr>) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let length = socklen_t(address.pointee.sa_len)
        guard getnameinfo(address, length, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 else {
            return nil
        }
        let text = String(cString: buffer)
        guard let zone = text.firstIndex(of: "%") else { return text }
        return String(text[text.startIndex..<zone])
    }

    /// Counts the set bits of a netmask to get the prefix length.
    private static func prefixLength(_ mask: UnsafeMutablePointer<sockaddr>?) -> Int {
        guard let mask else { return 0 }
        switch Int32(mask.pointee.sa_family) {
        case AF_INET:
            return UnsafeRawPointer(mask).assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr.s_addr.nonzeroBitCount
        case AF_INET6:
            let value = UnsafeRawPointer(mask).assumingMemoryBound(to: sockaddr_in6.self).pointee.sin6_addr
            var count = 0
            withUnsafeBytes(of: value) { raw in
                for byte in raw { count += byte.nonzeroBitCount }
            }
            return count
        default:
            return 0
        }
    }
}
