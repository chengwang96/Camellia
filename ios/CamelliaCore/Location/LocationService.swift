import CoreLocation
import Foundation

/// One approximate location, asked for once, with no tracking behind it.
///
/// The iOS counterpart of Android's `LocationConsent.locate()`, and the parts
/// that do not translate are worth naming:
///
/// * Android picks the network provider, which is coarse by construction. iOS
///   has one provider and the coarseness is asked for instead, through
///   `desiredAccuracy` — so the fix here is as near a match as the platform
///   offers rather than the same mechanism.
/// * Android asks for `ACCESS_COARSE_LOCATION`, a permission the user can grant
///   while leaving precise location refused. iOS has no such split before iOS 14
///   (`NSLocationDefaultAccuracyReduced`, which an app cannot request on its
///   own behalf), so this asks for when-in-use and keeps the fix coarse by
///   choice. The note it produces claims 2 km whatever the platform reports,
///   which is what keeps the difference from reaching the model as a false
///   precision.
///
/// The completion always carries the text to append — the location note, or the
/// note saying there is none. A caller never has to decide what an empty answer
/// meant.
public final class LocationService: NSObject {
    public typealias Completion = (String) -> Void

    /// How long to wait before giving up, matching the dialog Android shows.
    public static let timeout: TimeInterval = 10

    private enum Phase {
        case idle
        case awaitingPermission
        case fetching
    }

    private let lock = NSLock()
    private let manager: CLLocationManager
    private var pending: Completion?
    private var phase: Phase = .idle
    /// Bumped on every cancel, so a callback already on its way lands nowhere.
    private var ticket = 0
    private var deadline: DispatchWorkItem?

    public override init() {
        manager = CLLocationManager()
        super.init()
        manager.delegate = self
        // A kilometre rather than the default best-effort: the phone is asked
        // for the coarsest fix it will give, and the person is told so before
        // anything is read.
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    /// Whether an answer is still outstanding.
    public var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return pending != nil
    }

    /// Asks for one fix, then calls back on the main queue with the note.
    ///
    /// A second request while one is outstanding is dropped rather than queued,
    /// which is what Android's `if (pending != null) return` does: two consent
    /// sheets for one message would mean answering the same question twice.
    public func request(_ completion: @escaping Completion) {
        lock.lock()
        guard pending == nil else {
            lock.unlock()
            return
        }
        ticket += 1
        let mine = ticket
        pending = completion
        phase = .idle
        lock.unlock()

        let status = manager.authorizationStatus
        switch status {
        case .notDetermined:
            lock.lock()
            if mine == ticket, pending != nil { phase = .awaitingPermission }
            lock.unlock()
            arm(ticket: mine)
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            start(ticket: mine)
        default:
            finish(LocationContext.unavailable, ticket: mine)
        }
    }

    /// Abandons an outstanding request, leaving the caller to carry on without a
    /// location. Nothing is delivered afterwards, which is the difference
    /// between "no location" and "no answer" — the caller is mid-dialog and will
    /// say which it wants.
    public func cancel() {
        lock.lock()
        pending = nil
        phase = .idle
        ticket += 1
        let work = deadline
        deadline = nil
        lock.unlock()
        work?.cancel()
    }

    // MARK: - Plumbing

    private func start(ticket mine: Int) {
        lock.lock()
        guard mine == ticket, pending != nil else {
            lock.unlock()
            return
        }
        phase = .fetching
        lock.unlock()
        arm(ticket: mine)
        manager.requestLocation()
    }

    /// Arms the ten-second give-up, replacing any earlier one.
    private func arm(ticket mine: Int) {
        let work = DispatchWorkItem { [weak self] in
            self?.finish(LocationContext.unavailable, ticket: mine)
        }
        lock.lock()
        deadline?.cancel()
        deadline = work
        lock.unlock()
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeout, execute: work)
    }

    private func finish(_ note: String, ticket mine: Int) {
        lock.lock()
        guard mine == ticket, let completion = pending else {
            lock.unlock()
            return
        }
        pending = nil
        phase = .idle
        let work = deadline
        deadline = nil
        lock.unlock()
        work?.cancel()
        DispatchQueue.main.async { completion(note) }
    }

    private var currentTicket: Int {
        lock.lock()
        defer { lock.unlock() }
        return ticket
    }
}

extension LocationService: CLLocationManagerDelegate {
    /// The answer to the permission prompt, and to any later change of it.
    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        lock.lock()
        let waiting = phase == .awaitingPermission
        lock.unlock()
        guard waiting else { return }
        switch manager.authorizationStatus {
        case .notDetermined:
            // Still deciding; the deadline stays armed.
            return
        case .authorizedWhenInUse, .authorizedAlways:
            start(ticket: currentTicket)
        default:
            finish(LocationContext.unavailable, ticket: currentTicket)
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        lock.lock()
        let fetching = phase == .fetching
        lock.unlock()
        guard fetching else { return }
        guard let location = locations.last else {
            finish(LocationContext.unavailable, ticket: currentTicket)
            return
        }
        // Read against the fix's own timestamp rather than the clock at hand:
        // a location the manager had already cached is exactly the past fix
        // Android refuses to use, and the age test is what catches it.
        let note = LocationContext.note(latitude: location.coordinate.latitude,
                                        longitude: location.coordinate.longitude,
                                        accuracy: location.horizontalAccuracy,
                                        age: -location.timestamp.timeIntervalSinceNow)
        finish(note, ticket: currentTicket)
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        lock.lock()
        let fetching = phase == .fetching || phase == .awaitingPermission
        lock.unlock()
        guard fetching else { return }
        finish(LocationContext.unavailable, ticket: currentTicket)
    }
}
