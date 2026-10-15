import 'product_measurement.dart';

/// The phone's onboarding after sign-in, as fixed flows that hand over to each other: waiting for a
/// computer → opening its session → the first message sent there → the notification prompt.
///
/// Counts and duration buckets only, through [ProductMeasurement]: no account, computer, session,
/// message or answer text, and nothing at all unless the account shares product usage.
///
/// Each flow runs once per sign-in ([reset] on sign-out). A step that starts before the account's
/// sharing choice has loaded — right after sign-in — waits here, and is counted from when it really
/// started once sharing is confirmed; a step that ends before then is never counted.
class OnboardingMeasurement {
  OnboardingMeasurement(this._usage) {
    _usage.addListener(_admit);
  }

  final ProductMeasurement _usage;
  final _waiting = <ProductFlow, Stopwatch>{};
  final _running = <ProductFlow, void Function(ProductOutcome)>{};
  final _seen = <ProductFlow>{};

  /// Starts [flow] the first time it is asked for in this sign-in; build methods may call it on
  /// every frame.
  void start(ProductFlow flow) {
    if (!_seen.add(flow)) return;
    _waiting[flow] = Stopwatch()..start();
    _admit();
  }

  /// Ends [flow] with [outcome] if it is running; otherwise nothing.
  void end(ProductFlow flow, ProductOutcome outcome) {
    _waiting.remove(flow);
    _running.remove(flow)?.call(outcome);
  }

  /// Asks the OS for notifications through [ask], counting the answer: allowed is `ok`, refused is
  /// `cancelled`, no answer is `unknown`.
  Future<void> askNotifications(Future<bool?> Function() ask) async {
    start(ProductFlow.notifyPermission);
    final allowed = await ask();
    end(ProductFlow.notifyPermission, switch (allowed) {
      true => ProductOutcome.ok,
      false => ProductOutcome.cancelled,
      null => ProductOutcome.unknown,
    });
  }

  /// Signed out: whatever was still running was abandoned, and the next sign-in starts afresh.
  void reset() {
    for (final flow in [..._running.keys]) {
      end(flow, ProductOutcome.cancelled);
    }
    _waiting.clear();
    _seen.clear();
  }

  void _admit() {
    if (!_usage.sharing || _waiting.isEmpty) return;
    for (final MapEntry(key: flow, value: watch) in [..._waiting.entries]) {
      _waiting.remove(flow);
      _running[flow] = _usage.begin(flow, elapsed: watch.elapsed);
    }
  }

  void dispose() {
    _usage.removeListener(_admit);
    _waiting.clear();
    _running.clear();
  }
}
